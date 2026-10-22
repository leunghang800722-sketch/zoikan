// WP-AI-OPS §28.4：分診題目／影響預覽嘅回應 DTO（snake_case；遮罩跟「保安員個人資料」欄位組權限）。
// 冇「保安員個人資料:view」：hkid／電話／地址只俾遮罩版本（同批量導入 preview 一致），出生日期剝走。
import type { TriageQuestion } from "@prisma/client";
import { prisma } from "@/lib/db";
import { canonicalHkid } from "@/lib/guards/identity";
import { maskAccountNo, type PersonResult, type WriteChange } from "@/lib/guards/import/apply";
import { EXT_OUTCOME_LABEL, SCALARS, bankLeaves, contactsOf, extLabel, isBankKey, isEmergencyKey, staffHiresOf } from "@/lib/guards/import/ext";
import { NAME_REASONS } from "@/lib/guards/import/project";
import { fieldValue, type PackagePerson } from "@/lib/guards/import/package";
import { maskAddressImport, maskHkidImport, maskTelImport, normZh, sameNameStrict } from "@/lib/guards/import/text";
import { hasPermission, type AuthedSession } from "@/lib/rbac/requirePermission";
import { HKICL_BANK_OPTIONS } from "@/lib/longterm-payroll/hkicl-bank-codes";
import { BANK_KINDS, KIND_LABEL, REVIEW_FIELD_LABEL, type QuestionEvidence, type QuestionKind, type QuestionOption } from "./types";

export interface ViewerCaps {
  /** 「保安員個人資料:view」 */
  pii: boolean;
  /** 「保安員個人資料:update」：冇就唔准覆蓋現有唔同嘅 PII */
  piiUpdate: boolean;
  /** 「保安員:update」：冇就唔准經導入改寫現有保安員姓名 */
  guardUpdate: boolean;
  /** 「保安員銀行資料:view」：冇就銀行戶口／收款人／現有戶口比較一律 generic */
  bankView: boolean;
  /** 「保安員銀行資料:update」：冇就唔准睇銀行題內容／作答 */
  bankUpdate: boolean;
}
export async function viewerCaps(actor: AuthedSession): Promise<ViewerCaps> {
  const [pii, piiUpdate, guardUpdate, bankView, bankUpdate] = await Promise.all([
    hasPermission(actor, "安員個人資料", "view"),
    hasPermission(actor, "安員個人資料", "update"),
    hasPermission(actor, "安員", "update"),
    hasPermission(actor, "安員銀行資料", "view"),
    hasPermission(actor, "安員銀行資料", "update"),
  ]);
  return { pii, piiUpdate, guardUpdate, bankView, bankUpdate };
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
    doc_info: p.docInfo ? { page_count: p.docInfo.pageCount, pages_by_kind: p.docInfo.pagesByKind, file_ext: p.docInfo.fileExts ?? [] } : null,
    rating: p.rating,
    ext: extView(p, c),
  };
}

/** v3 新欄顯示（牌照／平安咭／QAS／入職日期＝「保安員」module，唔遮罩；緊急聯絡人跟 PII；銀行跟銀行資料 view）。 */
function extView(p: PackagePerson, c: ViewerCaps) {
  const scalars = SCALARS.flatMap((s) => {
    const l = s.get(p);
    const v = l ? fieldValue(l) : null;
    return l && v ? [{ key: s.key, label: extLabel(s.key), value: v, status: l.status }] : [];
  });
  const bl = bankLeaves(p);
  const bank = bl
    ? c.bankView
      ? { status: bl.status, code: bl.code, name: bl.name, account_masked: maskAccountNo(bl.accountNo), account_full: bl.accountNo, payee_name: bl.payee }
      : { status: bl.status, hidden: true as const }
    : null;
  const contacts = contactsOf(p).map((x) => ({
    key: `emergency.${x.slot}`,
    label: extLabel(`emergency.${x.slot}`),
    status: x.status,
    name: c.pii ? x.name : x.name ? "（冇權限睇）" : null,
    relationship: c.pii ? x.relationship : x.relationship ? "（冇權限睇）" : null,
    tel: x.tel ? (c.pii ? x.tel : maskTelImport(x.tel)) : null,
  }));
  const hires = staffHiresOf(p).map((h) => ({ key: `staffHire.${h.number}`, label: extLabel(`staffHire.${h.number}`), value: h.value, status: h.status }));
  if (scalars.length === 0 && !bank && contacts.length === 0 && hires.length === 0) return null;
  return { scalars, bank, emergency_contacts: contacts, staff_hires: hires };
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
  /** 冇「保安員個人資料:view」而呢個候選係經身份證號對中、姓名同導入包唔同：唔回名 */
  name_hidden?: boolean;
  /** 內部用（唔出街） */
  hkid_canon?: string | null;
  /** bank_identity_unknown 用：目標保安員有冇戶口（尾 4 位淨係有「保安員銀行資料:view」先回） */
  bank?: { has: boolean; tail4: string | null };
}

/** 候選保安員卡（live 讀，批量 query，唔 N+1）。 */
async function loadCandidateCards(ids: string[], c: ViewerCaps): Promise<Map<string, CandidateRow>> {
  const out = new Map<string, CandidateRow>();
  if (ids.length === 0) return out;
  const [guards, phones, nos, recent] = await Promise.all([
    prisma.guard.findMany({ where: { id: { in: ids } }, select: { id: true, nameZh: true, nameEn: true, hkid: true, dateOfBirth: true, tel: true, bankAccountNo: true } }),
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
      hkid_canon: canonicalHkid(g.hkid),
      hkid: mHkid(canonicalHkid(g.hkid), c),
      date_of_birth: mDob(g.dateOfBirth ? g.dateOfBirth.toISOString().slice(0, 10) : null, c),
      tels: tels.map((t) => mTel(t, c)!).filter(Boolean),
      staff_numbers: nos.filter((n) => n.guardId === g.id).map((n) => n.number),
      recent_sites: sites,
      // 冇「保安員銀行資料:view」：唔回「已有銀行戶口」（否則變 oracle）
      ...(c.bankView ? { bank: { has: !!g.bankAccountNo, tail4: g.bankAccountNo ? g.bankAccountNo.replace(/\D/g, "").slice(-4) || null : null } } : {}),
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
  /** 銀行題而讀者冇「保安員銀行資料:update」：內容全部收埋，淨係話要有權限嘅同事處理 */
  restricted?: boolean;
  evidence: {
    pii_visible: boolean;
    pii_update: boolean;
    guard_update: boolean;
    bank_view: boolean;
    bank_update: boolean;
    person: ReturnType<typeof personView> | null;
    reasons: string[];
    candidates: CandidateRow[];
    review_fields: { field: string; label: string; check: string }[];
    /** TE-7：來源檔案線索（file_name 可能含人名，冇「保安員個人資料:view」＝null） */
    doc_ref: { file_name: string | null; page_count: number; pages_by_kind: Record<string, number> } | null;
    ext_review: { key: string; label: string; check: string; status: string; held?: "longterm_hire_date" | "identity" | "bank" }[];
    /** TE-13：staffno_shared／dup_tel 題——共用嘅工號（工號唔係 PII）＋共用嘅其他人（姓名冇「保安員個人資料:view」＝null；只有狀態同工號，冇 HKID／電話值） */
    shared_staff_numbers: string[];
    shared_with: Array<{ person_key: string; name_zh: string | null; name_en: string | null; name_hidden?: boolean; hkid_status: string; has_docs: boolean; doc_count: number; staff_numbers: string[]; tel_status: string; question_id: string | null }>;
    /** bank_identity_unknown：戶口（遮罩；全號淨係有銀行資料 view 先回） */
    unassigned: { bank_code: string; bank_name: string | null; account_masked: string | null; account_full: string | null; payee_name: string | null; hidden?: boolean } | null;
  };
  answer: { option: string; guard_id?: string; source?: "ocr_reread" } | null;
  answered_by: string | null;
  answered_at: Date | null;
  impact: unknown;
}

function bankNameOf(code: string): string | null {
  return HKICL_BANK_OPTIONS.find((b) => b.code === code)?.nameZhShort ?? null;
}

export async function questionViews(rows: TriageQuestion[], c: ViewerCaps): Promise<QuestionView[]> {
  const ev = rows.map((r) => r.evidenceJson as unknown as QuestionEvidence);
  const guardIds = [...new Set(ev.flatMap((e) => [...e.candidate_guard_ids, ...(e.guard_id ? [e.guard_id] : [])]))];
  const cards = await loadCandidateCards(guardIds, c);
  // TE-13：共用嘅其他人 → 同 session 同 kind 嘅題 id（「去嗰條題」連結）
  const sharedKeys = [...new Set(ev.flatMap((e) => (e.shared_with ?? []).map((s) => s.person_key)))];
  const sharedKinds = ["staffno_shared_by_persons", "dup_tel_across_persons"];
  const siblingQs = sharedKeys.length
    ? await prisma.triageQuestion.findMany({ where: { sessionId: { in: [...new Set(rows.map((r) => r.sessionId))] }, personKey: { in: sharedKeys }, kind: { in: sharedKinds } }, select: { id: true, sessionId: true, personKey: true, kind: true } })
    : [];
  const sibling = new Map(siblingQs.map((q) => [`${q.sessionId}|${q.personKey}|${q.kind}`, q.id]));
  return rows.map((r, i) => {
    const e = ev[i]!;
    const ans = r.answerJson as { option?: string; guard_id?: string; source?: string } | null;
    if (((BANK_KINDS as readonly string[]).includes(r.kind) && !c.bankUpdate) || (r.kind === "ext_identity_check" && !(c.pii && c.guardUpdate))) {
      return {
        id: r.id,
        session_id: r.sessionId,
        kind: r.kind as QuestionKind,
        kind_label: KIND_LABEL[r.kind as QuestionKind] ?? r.kind,
        title: r.kind === "ext_identity_check" ? "要有保安員個人資料查看＋保安員修改權限嘅同事處理" : "要有保安員銀行資料權限嘅同事處理",
        sort: r.sort,
        status: r.status,
        options: [],
        restricted: true,
        evidence: { pii_visible: c.pii, pii_update: c.piiUpdate, guard_update: c.guardUpdate, bank_view: c.bankView, bank_update: false, person: null, reasons: [], candidates: [], review_fields: [], doc_ref: null, ext_review: [], shared_staff_numbers: [], shared_with: [], unassigned: null },
        answer: ans?.option ? { option: ans.option } : null,
        answered_by: r.answeredBy,
        answered_at: r.answeredAt,
        impact: null,
      } satisfies QuestionView;
    }
    const candIds = e.candidate_guard_ids.length ? e.candidate_guard_ids : e.guard_id ? [e.guard_id] : [];
    const pkgHkid = canonicalHkid(fieldValue(e.person.hkid));
    const pkgName = fieldValue(e.person.nameZh);
    const candidates = candIds
      .map((id) => cards.get(id))
      .filter((x): x is CandidateRow => !!x)
      .map((card) => {
        // 經身份證號對中嘅現有保安員，姓名同導入包唔同 → 冇 PII view 嘅人唔俾睇名（否則可以用 hkid 查名）
        const hide = !c.pii && !!pkgHkid && card.hkid_canon === pkgHkid && !sameNameStrict(card.name_zh, pkgName);
        const { hkid_canon: _omit, ...rest } = card;
        void _omit;
        return hide ? { ...rest, name_zh: "", name_en: null, name_hidden: true } : rest;
      });
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
        guard_update: c.guardUpdate,
        bank_view: c.bankView,
        bank_update: c.bankUpdate,
        person: personView(e.person, c),
        reasons: c.pii ? e.reasons : e.reasons.filter((x) => !NAME_REASONS.has(x)),
        candidates,
        doc_ref: e.doc_ref ? { file_name: c.pii ? e.doc_ref.file_name : null, page_count: e.doc_ref.page_count, pages_by_kind: e.doc_ref.pages_by_kind } : null,
        // 逐欄 check 反映現有 DB 值嘅比較結果：冇「保安員個人資料:view」就剝走（免得變成探測現值嘅 oracle）
        review_fields: (e.review_fields ?? []).map((f) => ({ field: f.field, label: REVIEW_FIELD_LABEL[f.field], check: c.pii || !["same", "differs", "conflict"].includes(f.check) ? f.check : "hidden" })),
        shared_staff_numbers: e.shared_staff_numbers ?? [],
        shared_with: (e.shared_with ?? []).map((s) => ({
          person_key: s.person_key,
          name_zh: c.pii ? s.name_zh : null,
          name_en: c.pii ? s.name_en : null,
          ...(c.pii ? {} : { name_hidden: true as const }),
          hkid_status: s.hkid_status,
          has_docs: s.has_docs,
          doc_count: s.doc_count,
          staff_numbers: s.staff_numbers,
          tel_status: s.tel_status,
          question_id: sibling.get(`${r.sessionId}|${s.person_key}|${r.kind}`) ?? null,
        })),
        ext_review: (e.ext_review ?? []).map((f) => {
          const hide = isBankKey(f.key) ? !c.bankView : isEmergencyKey(f.key) ? !c.pii : false;
          // held 原因 code（generic，冇值）：longterm_hire_date／identity／bank
          const held = f.held === "longterm" ? "longterm_hire_date" : f.held === "identity" || f.held === "bank" ? f.held : undefined;
          return { key: f.key, label: extLabel(f.key), check: hide && ["same", "differs", "conflict"].includes(f.check) ? "hidden" : f.check, status: f.status, ...(held ? { held } : {}) };
        }),
        unassigned: e.unassigned
          ? c.bankView
            ? { bank_code: e.unassigned.bankCode, bank_name: bankNameOf(e.unassigned.bankCode), account_masked: maskAccountNo(e.unassigned.accountNo), account_full: e.unassigned.accountNo, payee_name: e.unassigned.payeeName }
            : { bank_code: "", bank_name: null, account_masked: null, account_full: null, payee_name: null, hidden: true }
          : null,
      },
      // 答案內容（可能含輸入嘅身份證號）唔回傳，淨回選項
      answer: ans?.option ? { option: ans.option, ...(ans.guard_id ? { guard_id: ans.guard_id } : {}), ...(ans.source === "ocr_reread" ? { source: "ocr_reread" as const } : {}) } : null,
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
  siaPermitNo: "保安人員許可證號碼",
  siaPermitAExpiry: "許可證甲類屆滿日",
  siaPermitBExpiry: "許可證乙類屆滿日",
  safetyCardNo: "平安咭號碼",
  safetyCardExpiry: "平安咭屆滿日",
  qasIssueDate: "QAS 簽發日",
  qasExpiryDate: "QAS 屆滿日",
  hireDate: "入職日期",
  bankCode: "銀行編號",
  bankName: "銀行名稱",
  bankAccountNo: "銀行戶口",
  bankPayeeName: "收款人",
};
const BANK_KEYS = new Set(["bankCode", "bankName", "bankAccountNo", "bankPayeeName"]);
const DATE_KEYS = new Set(["siaPermitExpiry", "siaPermitAExpiry", "siaPermitBExpiry", "safetyCardExpiry", "qasIssueDate", "qasExpiryDate", "hireDate"]);
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
  guard_hkid_differs: "該保安員已有另一個身份證號",
  hkid_belongs_to_other_guard: "呢個身份證號已屬於另一個保安員",
  forced_guard_missing: "揀咗嘅保安員已經唔存在",
  staffno_belongs_to_other: "有工號屬於另一個保安員，已跳過",
  staffno_scheme_has_other_current: "有工號同現有工號類別重複，已跳過",
  staffno_invalid: "有工號格式唔合法，已跳過",
  bank_acct_belongs_to_other: "呢個戶口已屬於另一位保安員，唔會寫入",
};

const PII_OUTCOME_FIELDS = new Set(["hkid", "dateOfBirth", "phone", "address", "nameEn", "nameZh"]);
/** 冇 PII view：呢幾隻欄只分「會補上（原本空）」同「冇寫入（已有資料）」，same／conflict 唔可以分得出。 */
function outcomeLabel(field: string, v: string, c: ViewerCaps): string {
  if (!c.pii && PII_OUTCOME_FIELDS.has(field)) {
    if (v === "written") return field === "nameEn" || field === "nameZh" ? "會寫入" : "會補上（原本空）";
    if (v === "same" || v === "conflict" || v === "not_written") return "冇寫入（已有資料）";
  }
  return FIELD_OUTCOME_LABEL[v] ?? String(v);
}

function fmt(key: string, v: unknown, c: ViewerCaps): string {
  if (v === null || v === undefined || v === "") return "（空）";
  if (Array.isArray(v)) return v.length ? (key === "identityReviewFields" ? "姓名待核對" : v.join("、")) : "（冇）";
  const s = typeof v === "string" ? v : String(v);
  if (key === "hkid") return mHkid(s, c) ?? "（空）";
  if (key === "dateOfBirth") return c.pii ? s.slice(0, 10) : "（冇權限睇）";
  if (key === "siaPermitExpiry" || key === "siaPermitType") return c.pii ? s.slice(0, 10) : "（冇權限睇）";
  if (BANK_KEYS.has(key)) return !c.bankView ? "（冇權限睇）" : key === "bankAccountNo" ? (maskAccountNo(s) ?? "（空）") : s;
  if (DATE_KEYS.has(key)) return s.slice(0, 10);
  return s;
}

/** 存入 DB 嘅影響來源（原始值，只留顯示用白名單欄；讀取時再按讀者遮罩）。 */
export interface ImpactSource {
  result: Pick<PersonResult, "outcome" | "fields" | "reasons" | "staff_numbers_added" | "phones_added" | "addresses_added"> & Partial<Pick<PersonResult, "ext" | "contacts_added">>;
  changes: WriteChange[];
}

const KEEP_COLS: Record<string, string[]> = {
  guards: Object.keys(GUARD_FIELD_LABEL),
  guard_staff_numbers: ["number", "validFrom"],
  guard_emergency_contacts: ["name", "tel", "relationship"],
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
  return JSON.parse(JSON.stringify({ result: { outcome: r.outcome, fields: r.fields, reasons: r.reasons, staff_numbers_added: r.staff_numbers_added, phones_added: r.phones_added, addresses_added: r.addresses_added, ...(r.ext ? { ext: r.ext } : {}), ...(r.contacts_added ? { contacts_added: r.contacts_added } : {}) }, changes: slim })) as ImpactSource;
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
  /** TE-3：can_confirm=false 時嘅人話原因（取代只有原因碼）＋下一步 */
  reason_text?: string;
  /** TE-3：補咗呢啲資料就可以過（UI 喺同一張卡展開輸入框）；required=false 嘅欄可以留空 */
  needs_fields?: { field: "name_zh" | "name_en"; label: string; required: boolean }[];
  /** TE-5：系統有同名現有保安員，淨姓名對唔夠硬——要人決定「連結」定「建新人」 */
  /** TE-9.1：資料異常（例如同一身份證號屬多位保安員）→ 導航卡：去邊度處理（href 唔帶任何個人資料）；只對有「個人資料:view」者回 */
  nav?: { label: string; href: string };
  needs_decision?: { reason: "name_only_candidate" | "same_name_different_dob" | "name_multi_candidate" | "hkid_matches_existing_guard"; candidates: DecisionCandidate[]; options: ("link" | "create_new" | "skip")[]; /** 同名者多過 5 位，只列頭 5 位 */ truncated?: boolean };
}

export interface DecisionCandidate {
  guard_id: string;
  name_zh: string;
  /** 英文名跟「保安員個人資料:view」 */
  name_en: string | null;
  has_hkid: boolean;
  has_dob: boolean;
  staff_numbers: string[];
  /** 冇「保安員個人資料:view」就遮罩 */
  phone_masked: string | null;
  created_at: string;
  /** 最近出更月份（YYYY-MM；冇更＝null） */
  last_shift_month: string | null;
  active: boolean;
  /** TE-9：身份證號同導入／輸入嘅號碼相同 */
  same_hkid?: boolean;
}

/** TE-5：需要人決定連結／建新人嘅原因碼 */
export const DECISION_REASONS = ["name_only_candidate", "same_name_different_dob", "name_multi_candidate"] as const;
export const DUP_HKID_TEXT = "呢個身份證號喺系統內屬於多位保安員（資料異常），請先處理重複保安員先再答";
export const HKID_OWNER_TEXT = "呢個身份證號已屬於系統內一位保安員，確認係同一人就連結";
export const DECISION_TEXT = "系統已有一位同名保安員，請確認係咪同一人：係＝連結並補資料；唔係＝建新人";

type GuardRow = { id: string; name_zh: string; name_en: string | null; has_hkid: boolean; has_dob: boolean; tel: string | null; created_at: Date; status: string };

async function decisionCards(same: readonly GuardRow[], c: ViewerCaps, sameHkid = false): Promise<DecisionCandidate[]> {
  const ids = same.map((g) => g.id);
  if (ids.length === 0) return [];
  const [phones, nos, last] = await Promise.all([
    prisma.guardPhone.findMany({ where: { guardId: { in: ids } }, select: { guardId: true, tel: true } }),
    prisma.guardStaffNumber.findMany({ where: { guardId: { in: ids } }, select: { guardId: true, number: true } }),
    prisma.$queryRaw<{ guard_id: string; last_date: Date }[]>`SELECT guard_id, max(work_date) AS last_date FROM shift_records WHERE guard_id = ANY(${ids}::text[]) AND status <> 'cancelled' GROUP BY guard_id`,
  ]);
  return same.map((g) => {
    const tel = phones.find((p) => p.guardId === g.id)?.tel ?? g.tel ?? null;
    const ld = last.find((r) => r.guard_id === g.id)?.last_date ?? null;
    return {
      guard_id: g.id,
      name_zh: g.name_zh,
      name_en: c.pii ? g.name_en : null,
      has_hkid: g.has_hkid,
      has_dob: g.has_dob,
      staff_numbers: nos.filter((n) => n.guardId === g.id).map((n) => n.number),
      phone_masked: tel ? (c.pii ? tel : maskTelImport(tel)) : null,
      created_at: g.created_at.toISOString().slice(0, 10),
      last_shift_month: ld ? ld.toISOString().slice(0, 7) : null,
      active: g.status === "active",
      ...(sameHkid ? { same_hkid: true } : {}),
    };
  });
}

/** 同名（normZh 相同）現有保安員候選卡（live 讀，欄位級權限過濾）。S3：只 select 需要嘅欄（身份證號／出生日期淨攞「有冇」），SQL 層限制行數；最多回 5 位，多過 5 位 truncated=true。 */
const DECISION_MAX_CANDIDATES = 5;
export async function loadDecisionCandidates(nameZh: string, c: ViewerCaps): Promise<{ candidates: DecisionCandidate[]; truncated: boolean }> {
  const want = normZh(nameZh);
  if (!want) return { candidates: [], truncated: false };
  const rows = await prisma.$queryRaw<GuardRow[]>`
    SELECT id, name_zh, name_en, (hkid IS NOT NULL) AS has_hkid, (date_of_birth IS NOT NULL) AS has_dob, tel, created_at, status::text AS status
    FROM guards WHERE position(${want[0]!} in name_zh) > 0 ORDER BY created_at LIMIT 200`;
  const all = rows.filter((g) => normZh(g.name_zh) === want);
  return { candidates: await decisionCards(all.slice(0, DECISION_MAX_CANDIDATES), c), truncated: all.length > DECISION_MAX_CANDIDATES };
}

/** TE-9：身份證號相同嘅現有保安員（唯一一位）候選卡，標 same_hkid。 */
export async function loadHkidOwnerCard(guardId: string, c: ViewerCaps): Promise<DecisionCandidate[]> {
  const rows = await prisma.$queryRaw<GuardRow[]>`
    SELECT id, name_zh, name_en, (hkid IS NOT NULL) AS has_hkid, (date_of_birth IS NOT NULL) AS has_dob, tel, created_at, status::text AS status FROM guards WHERE id = ${guardId} LIMIT 1`;
  return decisionCards(rows, c, true);
}

/** TE-3：令 can_confirm=false 嘅原因碼 → 人話＋下一步（唔再淨係「原因碼」）。 */
export const BLOCK_TEXT: Record<string, string> = {
  create_no_name: "呢位保安員冇姓名，要一併輸入先可以建立",
  name_not_confirmed: "姓名未確認，要輸入／確認中文姓名先可以建立",
  create_hkid_not_confirmed: "身份證號未確認，唔可以建立：請揀「輸入身份證號」並輸入合法號碼",
  hkid_not_confirmed_no_other_key: "身份證號未確認，又冇工號／電話可以對上現有保安員：請輸入身份證號",
  guard_has_other_hkid_unconfirmed: "同名現有保安員已有另一個身份證號：請核對身份證號，或者揀「連去現有保安員」",
  extract_fail: "證件讀取失敗：請輸入身份證號",
  tel_only_candidate: "淨係電話對到現有保安員：請揀「連去」嗰位，或者核對資料",
  name_only_candidate: "淨係姓名對到現有保安員，冇硬證據：請揀「連去」嗰位，或者輸入身份證號",
  name_multi_candidate: "有幾個同名嘅現有保安員：請揀其中一位連去",
  same_name_different_dob: "同名現有保安員，但出生日期唔同：請核對後揀「連去」或者「新開」",
  staffno_shared_by_persons: "同一個工號出現喺導入包內多個人：請揀邊個先係真正用呢個工號",
  dup_tel_across_persons: "同一個電話出現喺導入包內多個人：請揀邊個先係真正用呢個電話",
  group_name_differs: "同一個身份證喺唔同檔案嘅姓名唔一致：請核對姓名",
  duplicate_hkid_in_package: "導入包內有重複身份證：請核對後處理",
  duplicate_key_in_package: "導入包內有重複記錄：請核對後處理",
  hkid_multi_guard: "多個現有保安員用同一個身份證號：請先處理重複保安員",
  staffno_multi_guard: "工號對到多個現有保安員：請先處理工號重複",
  hkid_vs_staffno_differ: "身份證同工號指向唔同嘅現有保安員：請核對，揀其中一位連去",
  guard_hkid_differs: "該保安員已有另一個身份證號：請核對身份證號",
  tel_belongs_to_other_guard: "電話屬於另一位現有保安員：請核對電話或者揀「連去」嗰位",
  tel_guard_has_other_hkid: "電話對到嘅現有保安員有另一個身份證號：請核對",
  tel_multi_guard: "電話對到多位現有保安員：請核對電話",
  name_differs_from_guard: "姓名同現有保安員紀錄唔同：請核對",
  same_name_different_hkid: "同名但現有保安員嘅身份證號唔同：請核對，唔好亂連",
  forced_guard_missing: "揀咗嘅保安員已經唔存在：請重新載入再揀",
  hkid_belongs_to_other_guard: "呢個身份證號已屬於另一位保安員：請核對身份證號，或者改揀「連去現有保安員」",
  apply_failed: "套用失敗：請稍後再試，仍然唔得就跳過留返人手",
  overwrite_forbidden: "要有保安員個人資料／保安員修改權限嘅同事處理（你冇權覆蓋現有資料）",
  longterm_hire_via_triage: "長工入職日期會影響長工糧：要喺分診題逐條確認，唔可以批量",
  staffno_belongs_to_other: "有工號屬於另一個保安員：請先處理另一題",
  staffno_scheme_has_other_current: "有工號同現有工號類別重複：請先處理另一題",
  staffno_invalid: "有工號格式唔合法：請核對工號",
  bank_incomplete: "銀行資料四欄唔齊：只可以跳過，唔准砌半套戶口",
  bank_acct_belongs_to_other: "呢個戶口已屬於另一位保安員：請先處理另一題",
  bank_acct_shared_by_persons: "同一個戶口出現喺導入包內多個人：請先處理另一題",
};
const NAME_REASONS_NEEDING_INPUT = new Set(["create_no_name", "name_not_confirmed"]);

/**
 * TE-3：can_confirm=false 時嘅解釋。reasons＝applyOnePerson 結果嘅原因碼；optionId＝今次揀嘅選項。
 * 缺姓名類原因而且選項容許補姓名（extraOptions）→ 回 needs_fields（中文姓名必填、英文姓名可選）。
 */
export function explainBlocked(reasons: readonly string[], optionId: string, extraOptions: readonly string[], alreadyGaveName = false): Pick<ImpactView, "reason_text" | "needs_fields"> {
  const uniq = [...new Set(reasons)];
  const texts = uniq.map((r) => BLOCK_TEXT[r]).filter((x): x is string => !!x);
  const unknown = uniq.filter((r) => !BLOCK_TEXT[r]);
  const needs = !alreadyGaveName && extraOptions.includes(optionId) && uniq.some((r) => NAME_REASONS_NEEDING_INPUT.has(r));
  const parts = [...texts, ...(unknown.length ? ["照呢個答案暫時未能寫入：請揀其他選項，或者跳過留返人手處理"] : [])];
  return {
    reason_text: parts.length ? parts.join("；") : "照呢個答案唔會寫入任何資料：請揀其他選項，或者跳過留返人手處理",
    ...(needs ? { needs_fields: [{ field: "name_zh" as const, label: "中文姓名", required: true }, { field: "name_en" as const, label: "英文姓名", required: false }] } : {}),
  };
}

export function buildImpact(result: PersonResult, changes: readonly WriteChange[], c: ViewerCaps): ImpactView {
  const norm = JSON.parse(JSON.stringify(changes)) as WriteChange[];
  const out: ImpactView["changes"] = [];
  // 冇「保安員銀行資料:view」：銀行相關結果一律 generic（唔准視乎現值：寫入／同現值一樣／衝突睇落要一樣）
  const bankHidden = !c.bankView && (result.ext ?? []).some((x) => isBankKey(x.key));
  for (const ch of norm) {
    const before = (ch.before ?? {}) as Record<string, unknown>;
    const after = (ch.after ?? {}) as Record<string, unknown>;
    if (ch.table === "guards") {
      const keys = Object.keys(GUARD_FIELD_LABEL);
      const fields = keys
        .filter((k) => !(bankHidden && BANK_KEYS.has(k)))
        .filter((k) => ch.action === "create" ? !(after[k] == null || (Array.isArray(after[k]) && (after[k] as unknown[]).length === 0)) : JSON.stringify(before[k] ?? null) !== JSON.stringify(after[k] ?? null))
        .map((k) => {
          const to = fmt(k, after[k], c);
          let from = ch.action === "create" ? null : fmt(k, before[k], c);
          // 冇 PII view：現有姓名只喺同新值一樣時顯示，否則唔洩露
          if (!c.pii && from !== null && (k === "nameZh" || k === "nameEn") && from !== to) from = "（同導入包唔同，冇權限睇）";
          return { label: GUARD_FIELD_LABEL[k]!, from, to };
        });
      if (bankHidden && ch.action === "update" && fields.length === 0) continue;
      out.push({ table: "guards", action: ch.action as "create" | "update", label: ch.action === "create" ? "新增保安員" : "更新保安員資料", guard_id: ch.action === "update" && c.pii ? ch.rowId : null, fields });
    } else if (ch.table === "guard_staff_numbers" && ch.action === "update") {
      out.push({ table: ch.table, action: "update", label: "補工號入職日期", guard_id: null, fields: [{ label: `入職日期（${String(after.number ?? "")}）`, from: fmt("hireDate", before.validFrom, c), to: fmt("hireDate", after.validFrom, c) }] });
    } else if (ch.table === "guard_emergency_contacts") {
      out.push({
        table: ch.table,
        action: "create",
        label: "新增緊急聯絡人",
        guard_id: null,
        fields: [
          { label: "姓名", from: null, to: after.name ? (c.pii ? String(after.name) : "（冇權限睇）") : "（空）" },
          { label: "關係", from: null, to: after.relationship ? (c.pii ? String(after.relationship) : "（冇權限睇）") : "（空）" },
          { label: "電話", from: null, to: after.tel ? (c.pii ? String(after.tel) : (maskTelImport(String(after.tel)) ?? "")) : "（空）" },
        ],
      });
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
  if (result.outcome === "created") summary.push("新增 1 個保安員");
  if (result.outcome === "linked") summary.push(bankHidden ? "連去現有保安員（銀行資料部分你冇權限睇結果）" : out.some((x) => x.table === "guards" && x.action === "update") ? "連去現有保安員，補填／更新佢嘅資料" : "連去現有保安員（本身冇欄位需要更新）");
  if (result.staff_numbers_added) summary.push(`新增工號 ${result.staff_numbers_added} 個`);
  if (result.phones_added) summary.push(`新增電話 ${result.phones_added} 個`);
  if (result.addresses_added) summary.push(`新增地址 ${result.addresses_added} 個`);
  if (result.contacts_added) summary.push(`新增緊急聯絡人 ${result.contacts_added} 位`);
  if (!written) summary.push("照呢個答案，仍然唔會寫入任何資料（要揀其他選項，或者跳過）");
  // 「姓名同現有保安員唔同」呢類 reason 冇 PII view 唔回（同 import project.ts 一致）
  const notes = [...new Set(result.reasons)].filter((r) => (c.pii || r !== "name_differs_from_guard") && (c.bankView || r !== "bank_acct_belongs_to_other")).map((r) => REASON_LABEL[r] ?? `原因碼：${r}`);
  return {
    can_confirm: written,
    summary,
    changes: out,
    field_outcomes: [
      ...Object.entries(result.fields)
        .filter(([, v]) => !!v)
        .map(([f, v]) => ({ field: f, label: FIELD_NAME_LABEL[f] ?? f, outcome: outcomeLabel(f, v as string, c) })),
      ...(result.ext ?? []).map(({ key: k, outcome: v }) => {
        const hide = (isBankKey(k) && !c.bankView) || (isEmergencyKey(k) && !c.pii);
        if (isBankKey(k) && !c.bankView) return { field: k, label: extLabel(k), outcome: v === "skipped" ? EXT_OUTCOME_LABEL.skipped! : "（冇權限睇結果）" };
        return { field: k, label: extLabel(k), outcome: hide && (v === "same" || v === "conflict" || v === "not_written") ? "冇寫入（已有資料）" : (EXT_OUTCOME_LABEL[v] ?? String(v)) };
      }),
    ],
    notes,
  };
}
