// WP-AI-OPS §28.4：分診題目／影響預覽嘅回應 DTO（snake_case；遮罩跟「安員個人資料」欄位組權限）。
// 冇「安員個人資料:view」：hkid／電話／地址只俾遮罩版本（同批量導入 preview 一致），出生日期剝走。
import type { TriageQuestion } from "@prisma/client";
import { prisma } from "@/lib/db";
import { canonicalHkid } from "@/lib/guards/identity";
import type { PersonResult, WriteChange } from "@/lib/guards/import/apply";
import { fieldValue, type PackagePerson } from "@/lib/guards/import/package";
import { maskAddressImport, maskHkidImport, maskTelImport } from "@/lib/guards/import/text";
import { hasPermission, type AuthedSession } from "@/lib/rbac/requirePermission";
import { KIND_LABEL, REVIEW_FIELD_LABEL, type QuestionEvidence, type QuestionKind, type QuestionOption } from "./types";

export interface ViewerCaps {
  /** 「安員個人資料:view」 */
  pii: boolean;
  /** 「安員個人資料:update」：冇就唔准覆蓋現有唔同嘅 PII */
  piiUpdate: boolean;
}
export async function viewerCaps(actor: AuthedSession): Promise<ViewerCaps> {
  const [pii, piiUpdate] = await Promise.all([hasPermission(actor, "安員個人資料", "view"), hasPermission(actor, "安員個人資料", "update")]);
  return { pii, piiUpdate };
}

const mHkid = (v: string | null, c: ViewerCaps) => (v ? (c.pii ? v : maskHkidImport(canonicalHkid(v) ?? v)) : null);
const mTel = (v: string | null, c: ViewerCaps) => (v ? (c.pii ? v : maskTelImport(v)) : null);
const mAddr = (v: string | null, c: ViewerCaps) => (v ? (c.pii ? v : maskAddressImport(v)) : null);
const mDob = (v: string | null, c: ViewerCaps) => (v ? (c.pii ? v : null) : null);

function personView(p: PackagePerson, c: ViewerCaps) {
  const f = (x: { value: string | null; status: string }) => ({ value: fieldValue(x as never), status: x.status });
  return {
    key: p.key,
    hkid: { ...f(p.hkid), value: mHkid(fieldValue(p.hkid), c) },
    name_zh: f(p.nameZh),
    name_en: f(p.nameEn),
    date_of_birth: { ...f(p.dateOfBirth), value: mDob(fieldValue(p.dateOfBirth), c) },
    phone: { ...f(p.phone), value: mTel(fieldValue(p.phone), c) },
    address: { ...f(p.address), value: mAddr(fieldValue(p.address), c) },
    staff_numbers: p.staffNumbers.map((n) => n.number),
    rating: p.rating,
  };
}

interface CandidateRow {
  guard_id: string;
  name_zh: string;
  name_en: string | null;
  hkid: string | null;
  date_of_birth: string | null;
  tels: string[];
  staff_numbers: string[];
  recent_sites: { name: string; last_date: string }[];
}

/** 候選安員卡（live 讀，批量 query，唔 N+1）。 */
export async function loadCandidateCards(ids: string[], c: ViewerCaps): Promise<Map<string, CandidateRow>> {
  const out = new Map<string, CandidateRow>();
  if (ids.length === 0) return out;
  const [guards, phones, nos, recent] = await Promise.all([
    prisma.guard.findMany({ where: { id: { in: ids } }, select: { id: true, nameZh: true, nameEn: true, hkid: true, dateOfBirth: true, tel: true } }),
    prisma.guardPhone.findMany({ where: { guardId: { in: ids } }, select: { guardId: true, tel: true } }),
    prisma.guardStaffNumber.findMany({ where: { guardId: { in: ids } }, select: { guardId: true, number: true } }),
    prisma.$queryRaw<{ guard_id: string; name: string; last_date: Date }[]>`
      SELECT DISTINCT ON (r.guard_id, r.site_id) r.guard_id, s.canonical_name AS name, r.work_date AS last_date
      FROM shift_records r JOIN sites s ON s.id = r.site_id
      WHERE r.guard_id = ANY(${ids}::text[]) AND r.status <> 'cancelled'
      ORDER BY r.guard_id, r.site_id, r.work_date DESC`,
  ]);
  for (const g of guards) {
    const tels = [...new Set([...phones.filter((p) => p.guardId === g.id).map((p) => p.tel), ...(g.tel ? [g.tel] : [])])];
    const sites = recent
      .filter((r) => r.guard_id === g.id)
      .sort((a, b) => b.last_date.getTime() - a.last_date.getTime())
      .slice(0, 3)
      .map((r) => ({ name: r.name, last_date: r.last_date.toISOString().slice(0, 10) }));
    out.set(g.id, {
      guard_id: g.id,
      name_zh: g.nameZh,
      name_en: g.nameEn,
      hkid: mHkid(canonicalHkid(g.hkid), c),
      date_of_birth: mDob(g.dateOfBirth ? g.dateOfBirth.toISOString().slice(0, 10) : null, c),
      tels: tels.map((t) => mTel(t, c)!).filter(Boolean),
      staff_numbers: nos.filter((n) => n.guardId === g.id).map((n) => n.number),
      recent_sites: sites,
    });
  }
  return out;
}

export interface QuestionView {
  id: string;
  session_id: string;
  kind: QuestionKind;
  kind_label: string;
  title: string;
  sort: number;
  status: string;
  options: QuestionOption[];
  evidence: {
    pii_visible: boolean;
    pii_update: boolean;
    person: ReturnType<typeof personView>;
    reasons: string[];
    candidates: CandidateRow[];
    review_fields: { field: string; label: string; check: string }[];
  };
  answer: { option: string; guard_id?: string } | null;
  answered_by: string | null;
  answered_at: Date | null;
  impact: unknown;
}

export async function questionViews(rows: TriageQuestion[], c: ViewerCaps): Promise<QuestionView[]> {
  const ev = rows.map((r) => r.evidenceJson as unknown as QuestionEvidence);
  const guardIds = [...new Set(ev.flatMap((e) => [...e.candidate_guard_ids, ...(e.guard_id ? [e.guard_id] : [])]))];
  const cards = await loadCandidateCards(guardIds, c);
  return rows.map((r, i) => {
    const e = ev[i]!;
    const ans = r.answerJson as { option?: string; guard_id?: string } | null;
    const candIds = e.candidate_guard_ids.length ? e.candidate_guard_ids : e.guard_id ? [e.guard_id] : [];
    return {
      id: r.id,
      session_id: r.sessionId,
      kind: r.kind as QuestionKind,
      kind_label: KIND_LABEL[r.kind as QuestionKind] ?? r.kind,
      title: r.title,
      sort: r.sort,
      status: r.status,
      options: r.optionsJson as unknown as QuestionOption[],
      evidence: {
        pii_visible: c.pii,
        pii_update: c.piiUpdate,
        person: personView(e.person, c),
        reasons: e.reasons,
        candidates: candIds.map((id) => cards.get(id)).filter((x): x is CandidateRow => !!x),
        // 逐欄 check 反映現有 DB 值嘅比較結果：冇「安員個人資料:view」就剝走（免得變成探測現值嘅 oracle）
        review_fields: (e.review_fields ?? []).map((f) => ({ field: f.field, label: REVIEW_FIELD_LABEL[f.field], check: c.pii || f.field === "nameZh" || f.field === "nameEn" ? f.check : "hidden" })),
      },
      // 答案內容（可能含輸入嘅身份證號）唔回傳，淨回選項
      answer: ans?.option ? { option: ans.option, ...(ans.guard_id ? { guard_id: ans.guard_id } : {}) } : null,
      answered_by: r.answeredBy,
      answered_at: r.answeredAt,
      // impact_json 存原始結構化值（唔分讀者），每次讀取先按「讀者」嘅 caps 重新砌＋遮罩
      impact: storedImpactView(r.impactJson, c),
    };
  });
}

// ---------------------------------------------------------------------------
// 影響預覽 DTO（由 dry-run 嘅 WriteChange 砌；遮罩同上）
// ---------------------------------------------------------------------------
const GUARD_FIELD_LABEL: Record<string, string> = {
  nameZh: "中文姓名",
  nameEn: "英文姓名",
  hkid: "身份證",
  dateOfBirth: "出生日期",
  identityReviewFields: "待核對欄",
  siaPermitExpiry: "牌照到期（衍生）",
  siaPermitType: "牌照類別（衍生）",
};
const FIELD_OUTCOME_LABEL: Record<string, string> = {
  written: "會寫入",
  same: "同現值一樣，唔郁",
  conflict: "同現值唔同，唔覆蓋",
  skipped: "略過",
  not_confirmed: "未確認，唔寫",
  invalid: "值唔合法，唔寫",
  invalid_date: "日期唔合法，唔寫",
  not_stored: "系統唔儲存",
};
const FIELD_NAME_LABEL: Record<string, string> = { hkid: "身份證", nameZh: "中文姓名", nameEn: "英文姓名", dateOfBirth: "出生日期", sex: "性別", phone: "電話", address: "地址" };
const REASON_LABEL: Record<string, string> = {
  name_not_confirmed: "姓名未確認，唔會自動建人",
  create_hkid_not_confirmed: "身份證號未確認，唔會建人",
  guard_hkid_differs: "該安員已有另一個身份證號",
  hkid_belongs_to_other_guard: "呢個身份證號已屬於另一個安員",
  forced_guard_missing: "揀咗嘅安員已經唔存在",
  staffno_belongs_to_other: "有工號屬於另一個安員，已跳過",
  staffno_scheme_has_other_current: "有工號同現有工號類別重複，已跳過",
  staffno_invalid: "有工號格式唔合法，已跳過",
};

function fmt(key: string, v: unknown, c: ViewerCaps): string {
  if (v === null || v === undefined || v === "") return "（空）";
  if (Array.isArray(v)) return v.length ? (key === "identityReviewFields" ? "姓名待核對" : v.join("、")) : "（冇）";
  const s = typeof v === "string" ? v : String(v);
  if (key === "hkid") return mHkid(s, c) ?? "（空）";
  if (key === "dateOfBirth") return c.pii ? s.slice(0, 10) : "（冇權限睇）";
  if (key === "siaPermitExpiry" || key === "siaPermitType") return c.pii ? s.slice(0, 10) : "（冇權限睇）";
  return s;
}

/** 存入 DB 嘅影響來源（原始值，只留顯示用白名單欄；讀取時再按讀者遮罩）。 */
export interface ImpactSource {
  result: Pick<PersonResult, "outcome" | "fields" | "reasons" | "staff_numbers_added" | "phones_added" | "addresses_added">;
  changes: WriteChange[];
}

const KEEP_COLS: Record<string, string[]> = {
  guards: Object.keys(GUARD_FIELD_LABEL),
  guard_staff_numbers: ["number"],
  guard_phones: ["tel"],
  guard_addresses: ["address"],
};

export function toImpactSource(result: PersonResult, changes: readonly WriteChange[]): ImpactSource {
  const pick = (table: string, row: unknown) => {
    if (!row || typeof row !== "object") return null;
    const o = row as Record<string, unknown>;
    return Object.fromEntries((KEEP_COLS[table] ?? []).filter((k) => k in o).map((k) => [k, o[k]]));
  };
  const slim = changes
    .filter((c) => c.table in KEEP_COLS)
    .map((c) => ({ table: c.table, action: c.action, rowId: c.action === "update" ? c.rowId : "", before: pick(c.table, c.before), after: pick(c.table, c.after) }));
  const r = result;
  return JSON.parse(JSON.stringify({ result: { outcome: r.outcome, fields: r.fields, reasons: r.reasons, staff_numbers_added: r.staff_numbers_added, phones_added: r.phones_added, addresses_added: r.addresses_added }, changes: slim })) as ImpactSource;
}

function storedImpactView(raw: unknown, c: ViewerCaps): ImpactView | null {
  const src = raw as Partial<ImpactSource> | null;
  if (!src || !src.result || !Array.isArray(src.changes)) return null;
  return buildImpact(src.result as PersonResult, src.changes, c);
}

export interface ImpactView {
  can_confirm: boolean;
  summary: string[];
  changes: { table: string; action: "create" | "update"; label: string; guard_id: string | null; fields: { label: string; from: string | null; to: string }[] }[];
  field_outcomes: { field: string; label: string; outcome: string }[];
  notes: string[];
}

export function buildImpact(result: PersonResult, changes: readonly WriteChange[], c: ViewerCaps): ImpactView {
  const norm = JSON.parse(JSON.stringify(changes)) as WriteChange[];
  const out: ImpactView["changes"] = [];
  for (const ch of norm) {
    const before = (ch.before ?? {}) as Record<string, unknown>;
    const after = (ch.after ?? {}) as Record<string, unknown>;
    if (ch.table === "guards") {
      const keys = Object.keys(GUARD_FIELD_LABEL);
      const fields = keys
        .filter((k) => ch.action === "create" ? !(after[k] == null || (Array.isArray(after[k]) && (after[k] as unknown[]).length === 0)) : JSON.stringify(before[k] ?? null) !== JSON.stringify(after[k] ?? null))
        .map((k) => ({ label: GUARD_FIELD_LABEL[k]!, from: ch.action === "create" ? null : fmt(k, before[k], c), to: fmt(k, after[k], c) }));
      out.push({ table: "guards", action: ch.action as "create" | "update", label: ch.action === "create" ? "新增安員" : "更新安員資料", guard_id: ch.action === "update" && c.pii ? ch.rowId : null, fields });
    } else if (ch.table === "guard_staff_numbers") {
      out.push({ table: ch.table, action: "create", label: "新增工號", guard_id: null, fields: [{ label: "工號", from: null, to: String(after.number ?? "") }] });
    } else if (ch.table === "guard_phones") {
      out.push({ table: ch.table, action: "create", label: "新增電話", guard_id: null, fields: [{ label: "電話", from: null, to: c.pii ? String(after.tel ?? "") : (maskTelImport(String(after.tel ?? "")) ?? "") }] });
    } else if (ch.table === "guard_addresses") {
      out.push({ table: ch.table, action: "create", label: "新增地址", guard_id: null, fields: [{ label: "地址", from: null, to: c.pii ? String(after.address ?? "") : (maskAddressImport(String(after.address ?? "")) ?? "") }] });
    }
  }
  const written = result.outcome === "created" || result.outcome === "linked";
  const summary: string[] = [];
  if (result.outcome === "created") summary.push("新增 1 個安員");
  if (result.outcome === "linked") summary.push(out.some((x) => x.table === "guards" && x.action === "update") ? "連去現有安員，補填／更新佢嘅資料" : "連去現有安員（本身冇欄位需要更新）");
  if (result.staff_numbers_added) summary.push(`新增工號 ${result.staff_numbers_added} 個`);
  if (result.phones_added) summary.push(`新增電話 ${result.phones_added} 個`);
  if (result.addresses_added) summary.push(`新增地址 ${result.addresses_added} 個`);
  if (!written) summary.push("照呢個答案，仍然唔會寫入任何資料（要揀其他選項，或者跳過）");
  const notes = [...new Set(result.reasons)].map((r) => REASON_LABEL[r] ?? `原因碼：${r}`);
  return {
    can_confirm: written,
    summary,
    changes: out,
    field_outcomes: Object.entries(result.fields)
      .filter(([, v]) => !!v)
      .map(([f, v]) => ({ field: f, label: FIELD_NAME_LABEL[f] ?? f, outcome: FIELD_OUTCOME_LABEL[v as string] ?? String(v) })),
    notes,
  };
}
