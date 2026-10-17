// W2：WhatsApp 分診題（sourceType="whatsapp"）嘅讀取 DTO＋答題（預覽 → 確認）。
//  - 答案 → 補足 intent（guard／盤／日子）→ 重跑阻擋評估（triage-eval.ts，唔再叫 LLM）→
//      · 全齊 ＝ 經共用 write service（writeShiftCells）寫入 pending_approval、source=whatsapp、provenance；
//      · 仍有阻擋 ＝ 開下一輪題（同一 intent 最多 2 輪，之後 wa_unparsed）；
//      · 「以 WhatsApp 為準」＝同一 tx 取消舊記錄再寫新；
//      · alias 學習（勾「記住呢個花名」）＝同一 tx 加 Guard.nameAliases＋audit。
//  - 預覽（dry，唔寫）→ preview_hash（HMAC：題目＋答案＋當刻狀態指紋）→ 確認時重算，資料中途變咗就 409。
//  - 鎖月：預覽／確認都擋，400 固定字串，題保持 open（tx 內 assertMonthNotLockedTx 再擋一次）。
//  - 答題人要有「導入分診:update」（route 層）＋「保安員:view」＋「更表:create」；evidence（原話／姓名）只俾有「保安員:view」嘅人睇。
import { createHmac } from "node:crypto";
import type { TriageQuestion, TriageSession } from "@prisma/client";
import { prisma } from "@/lib/db";
import { writeAuditTx } from "@/lib/audit";
import { assertMonthNotLockedTx } from "@/lib/month-lock";
import { ApiError, BadRequest, Conflict, Forbidden } from "@/lib/api/errors";
import { hasPermission, type AuthedSession } from "@/lib/rbac/requirePermission";
import { journalAutoCardUsesSafe } from "@/lib/pricing/auto-card-journal";
import { cancelShiftRecordsTx, writeShiftCells } from "@/lib/shift-records/write";
import { answerSchema, KIND_LABEL, type QuestionKind, type QuestionOption, type TriageAnswer } from "@/lib/triage/types";
import { TRIAGE_LOCK } from "@/lib/triage/session";
import { addDays, hkDateOf, isoToDbDate } from "./dates";
import { createPrismaResolveRepo } from "./repo";
import { evaluateWaState, type WaEffective } from "./triage-eval";
import { buildDraft, insertWaQuestions, refreshWaSession } from "./triage";
import type { WaEvidence, WaHuman } from "./triage-types";

type QRowWithSession = TriageQuestion & { session: TriageSession };

/** 鎖月固定回應（答題時 400，題保持 open）。 */
export const WA_LOCKED_MSG = "呢個月已鎖定，唔可以入更，請人手處理";
const RECENT_DAYS = 60;

function hmacKey(): string {
  const k = process.env.SESSION_SECRET;
  if (!k || k.length < 32) throw new Error("SESSION_SECRET 未設定或長度不足 32 字符");
  return k;
}
function canon(a: TriageAnswer): string {
  const o = a as unknown as Record<string, unknown>;
  return JSON.stringify(Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]])));
}
const hashOf = (qid: string, a: TriageAnswer, fp: string): string => createHmac("sha256", hmacKey()).update(`${qid}|${canon(a)}|${fp}`).digest("hex");

function parseAnswer(raw: unknown): TriageAnswer {
  const r = answerSchema.safeParse(raw);
  if (!r.success) {
    const i = r.error.issues[0];
    throw BadRequest(`答案格式唔啱（${i ? i.path.join(".") : "unknown"}）`);
  }
  return r.data;
}

const evOf = (q: Pick<TriageQuestion, "evidenceJson">): WaEvidence => q.evidenceJson as unknown as WaEvidence;
const optsOf = (q: Pick<TriageQuestion, "optionsJson">): QuestionOption[] => q.optionsJson as unknown as QuestionOption[];

export interface WaCaps {
  /** 「保安員:view」——睇原話／姓名 */
  canSee: boolean;
  /** 「更表:create」——可以寫入 */
  canWrite: boolean;
}
export async function waCaps(actor: AuthedSession): Promise<WaCaps> {
  const [canSee, canWrite] = await Promise.all([hasPermission(actor, "安員", "view"), hasPermission(actor, "更表", "create")]);
  return { canSee, canWrite };
}

// ---------------------------------------------------------------------------
// 讀（DTO）
// ---------------------------------------------------------------------------
export interface WaQuestionView {
  id: string;
  session_id: string;
  kind: QuestionKind;
  kind_label: string;
  title: string;
  sort: number;
  status: string;
  options: QuestionOption[];
  /** 冇「保安員:view」或「更表:create」→ true（要有權限嘅同事處理） */
  restricted: boolean;
  wa: {
    round: number;
    text: string | null;
    text_redacted: boolean;
    group_label: string;
    sent_at: string;
    sender: string;
    source_changed: boolean;
    source_revoked: boolean;
    reasons: string[];
    notes: string[];
    intent: { kind: string; work_date: string | null; site_name: string | null; guard_name: string | null; shift_code: string | null; leave_code: string | null; confidence: number | null };
    raw: { person: string | null; site: string | null; date: string | null; shift: string | null; leave: string | null } | null;
    guard_candidates: Array<{ guard_id: string; name_zh: string; name_en: string | null; staff_numbers: string[]; recent_sites: Array<{ name: string; last_date: string }>; recent_here: boolean }>;
    site_options: Array<{ id: string; name: string }>;
    date_candidates: string[];
    existing: Array<{ id: string; site_name: string; shift_code: string; record_type: string; leave_code: string | null; status: string }>;
    can_remember_alias: boolean;
    manual_href: string | null;
  };
  answer: { option: string } | null;
  answered_by: string | null;
  answered_at: Date | null;
  impact: unknown;
}

export async function waQuestionViews(rows: TriageQuestion[], caps: WaCaps): Promise<WaQuestionView[]> {
  const evs = rows.map(evOf);
  const guardIds = new Set<string>();
  const siteIds = new Set<string>();
  const recordIds = new Set<string>();
  const msgIds = new Set<string>();
  for (const e of evs) {
    for (const g of e.candidates.guard_ids) guardIds.add(g);
    for (const x of [e.intent.guard_id, e.human.guard_id, e.sender.guard_id]) if (x) guardIds.add(x);
    for (const s of [...e.candidates.site_ids, e.intent.site_id, e.human.site_id]) if (s) siteIds.add(s);
    for (const r of e.candidates.existing_record_ids) recordIds.add(r);
    msgIds.add(e.message.message_id);
  }
  const recentSince = addDays(hkDateOf(new Date()), -RECENT_DAYS);
  const needAllSites = rows.some((r) => r.kind === "wa_site_ambiguous");
  const [guards, nos, sites, allSites, shiftTypes, records, msgs, recent] = await Promise.all([
    caps.canSee && guardIds.size ? prisma.guard.findMany({ where: { id: { in: [...guardIds] } }, select: { id: true, nameZh: true, nameEn: true } }) : Promise.resolve([]),
    caps.canSee && guardIds.size ? prisma.guardStaffNumber.findMany({ where: { guardId: { in: [...guardIds] } }, select: { guardId: true, number: true } }) : Promise.resolve([]),
    siteIds.size ? prisma.site.findMany({ where: { id: { in: [...siteIds] } }, select: { id: true, canonicalName: true } }) : Promise.resolve([]),
    needAllSites ? prisma.site.findMany({ where: { status: { in: ["active", "paused"] } }, select: { id: true, canonicalName: true }, orderBy: { canonicalName: "asc" }, take: 300 }) : Promise.resolve([]),
    prisma.shiftType.findMany({ where: { siteId: { in: [...siteIds] } }, select: { id: true, code: true } }),
    recordIds.size ? prisma.shiftRecord.findMany({ where: { id: { in: [...recordIds] } }, select: { id: true, siteId: true, shiftTypeId: true, recordType: true, leaveCode: true, status: true } }) : Promise.resolve([]),
    prisma.whatsappMessage.findMany({ where: { messageId: { in: [...msgIds] } }, select: { messageId: true, revision: true, revokedAt: true, redactedAt: true } }),
    caps.canSee && guardIds.size
      ? prisma.$queryRaw<{ guard_id: string; site_id: string; name: string; last_date: Date }[]>`
          SELECT DISTINCT ON (r.guard_id, r.site_id) r.guard_id, r.site_id, s.canonical_name AS name, r.work_date AS last_date
          FROM shift_records r JOIN sites s ON s.id = r.site_id
          WHERE r.guard_id = ANY(${[...guardIds]}::text[]) AND r.status <> 'cancelled' AND r.work_date >= ${recentSince}::date
          ORDER BY r.guard_id, r.site_id, r.work_date DESC`
      : Promise.resolve([]),
  ]);
  const guardBy = new Map(guards.map((g) => [g.id, g]));
  const siteBy = new Map([...sites, ...allSites].map((s) => [s.id, s.canonicalName]));
  const typeBy = new Map(shiftTypes.map((t) => [t.id, t.code]));
  const recBy = new Map(records.map((r) => [r.id, r]));
  const msgBy = new Map(msgs.map((m) => [m.messageId, m]));

  return rows.map((r, i) => {
    const ev = evs[i]!;
    const msg = msgBy.get(ev.message.message_id);
    const ans = r.answerJson as { option?: string } | null;
    const siteIdForLink = ev.human.site_id ?? ev.intent.site_id ?? null;
    const workDate = ev.human.work_date ?? ev.intent.work_date;
    const month = (workDate ?? ev.sent_at.slice(0, 10)).slice(0, 7);
    const guardIdForLink = ev.human.guard_id ?? ev.intent.guard_id;
    const effGuard = guardIdForLink ? guardBy.get(guardIdForLink) : undefined;
    const senderG = ev.sender.guard_id ? guardBy.get(ev.sender.guard_id) : undefined;
    const sitePool = new Set<string>([...ev.candidates.site_ids, ...(ev.intent.site_id ? [ev.intent.site_id] : [])]);
    const siteOptions = r.kind === "wa_site_ambiguous" ? (sitePool.size > 0 ? [...sitePool].map((id) => ({ id, name: siteBy.get(id) ?? "（未知盤）" })) : allSites.map((s) => ({ id: s.id, name: s.canonicalName }))) : [];
    return {
      id: r.id,
      session_id: r.sessionId,
      kind: r.kind as QuestionKind,
      kind_label: KIND_LABEL[r.kind as QuestionKind] ?? r.kind,
      title: r.title,
      sort: r.sort,
      status: r.status,
      options: optsOf(r),
      restricted: !caps.canSee || !caps.canWrite,
      wa: {
        round: ev.round,
        text: caps.canSee ? (msg?.redactedAt ? null : ev.text) : null,
        text_redacted: !!msg?.redactedAt,
        group_label: ev.group.label || "（未命名群組）",
        sent_at: ev.sent_at,
        sender: caps.canSee && senderG ? senderG.nameZh : ev.sender.tel_tail4 ? `…${ev.sender.tel_tail4}` : "未知",
        source_changed: !!msg && msg.revision > ev.message.revision,
        source_revoked: !!msg?.revokedAt,
        reasons: ev.reasons,
        notes: ev.notes,
        intent: {
          kind: ev.intent.kind,
          work_date: workDate,
          site_name: siteIdForLink ? (siteBy.get(siteIdForLink) ?? null) : null,
          guard_name: caps.canSee && effGuard ? effGuard.nameZh : null,
          shift_code: ev.intent.shift_type_id ? (typeBy.get(ev.intent.shift_type_id) ?? null) : null,
          leave_code: ev.intent.leave_code,
          confidence: ev.intent.confidence,
        },
        raw: caps.canSee ? { person: ev.src.person_raw, site: ev.src.site_raw, date: ev.src.date_raw, shift: ev.src.shift_raw, leave: ev.src.leave_raw } : null,
        guard_candidates: caps.canSee
          ? ev.candidates.guard_ids.slice(0, 8).flatMap((gid) => {
              const g = guardBy.get(gid);
              if (!g) return [];
              const rs = recent.filter((x) => x.guard_id === gid).sort((a, b) => b.last_date.getTime() - a.last_date.getTime());
              return [{ guard_id: gid, name_zh: g.nameZh, name_en: g.nameEn, staff_numbers: nos.filter((n) => n.guardId === gid).map((n) => n.number), recent_sites: rs.slice(0, 3).map((x) => ({ name: x.name, last_date: x.last_date.toISOString().slice(0, 10) })), recent_here: !!siteIdForLink && rs.some((x) => x.site_id === siteIdForLink) }];
            })
          : [],
        site_options: siteOptions,
        date_candidates: ev.candidates.dates,
        existing: ev.candidates.existing_record_ids.flatMap((id) => {
          const x = recBy.get(id);
          return x ? [{ id, site_name: siteBy.get(x.siteId) ?? "", shift_code: typeBy.get(x.shiftTypeId) ?? "", record_type: x.recordType, leave_code: x.leaveCode, status: x.status }] : [];
        }),
        can_remember_alias: caps.canSee && (r.kind === "wa_person_ambiguous" || r.kind === "wa_person_unknown") && !!ev.src.person_raw,
        manual_href: siteIdForLink ? `/roster/${siteIdForLink}/${month}${workDate || guardIdForLink ? `?${[workDate ? `date=${workDate}` : "", guardIdForLink ? `guard=${guardIdForLink}` : ""].filter(Boolean).join("&")}` : ""}` : null,
      },
      answer: ans?.option ? { option: ans.option } : null,
      answered_by: r.answeredBy,
      answered_at: r.answeredAt,
      impact: r.impactJson,
    };
  });
}

// ---------------------------------------------------------------------------
// 答（預覽＋確認）
// ---------------------------------------------------------------------------
interface WaImpact {
  can_confirm: boolean;
  summary: string[];
  changes: Array<{ table: string; action: string; label: string; fields: Array<{ label: string; from: string | null; to: string }> }>;
  field_outcomes: Array<{ field: string; label: string; outcome: string }>;
  notes: string[];
}

type WaPlan =
  | { type: "skip" }
  | { type: "ignore"; why: "ignore" | "keep_old" }
  | { type: "manual" }
  | { type: "exists"; ids: string[] }
  | { type: "next"; evidence: WaEvidence }
  | { type: "write"; evidence: WaEvidence; eff: WaEffective; code: string; shiftTypeId: string; cancelIds: string[]; alias: { guardId: string; raw: string } | null };

async function assertCanAnswer(actor: AuthedSession, q: QRowWithSession): Promise<void> {
  if (q.status === "answered") throw Conflict("呢條問題已經答過，唔可以重複套用");
  if (q.status === "superseded") throw Conflict("呢條問題已經唔適用（原訊息已被修改／撤回，或者已有新題）");
  const c = await waCaps(actor);
  if (!c.canSee) throw Forbidden("要有「保安員」查看權限嘅同事先可以答呢類問題");
  if (!c.canWrite) throw Forbidden("要有「更表」新增權限嘅同事（老闆／主管／會計）先可以答呢類問題");
  const ev = evOf(q);
  const msg = await prisma.whatsappMessage.findUnique({ where: { messageId: ev.message.message_id }, select: { revision: true, revokedAt: true } });
  if (msg && (msg.revokedAt || msg.revision > ev.message.revision)) throw Conflict("原訊息已被修改或撤回，請等系統更新題目後再答");
}

const isIsoDate = (s: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};

/** 答案必須屬於題目選項（候選 guard／盤／日子，或有對應輸入嘅選項）。 */
async function validateAnswerAgainstOptions(q: QRowWithSession, a: TriageAnswer): Promise<void> {
  const opts = optsOf(q);
  const same = opts.filter((o) => o.id === a.option);
  if (same.length === 0) throw BadRequest("呢個選項唔屬於呢條問題");
  if (a.option === "wa_pick_guard") {
    if (!a.guard_id) throw BadRequest("要揀邊個保安員");
    const viaCand = same.some((o) => o.guard_id === a.guard_id);
    const viaSearch = same.some((o) => o.input === "guard_search");
    if (!viaCand && !viaSearch) throw BadRequest("呢位保安員唔屬於候選");
    if (!(await prisma.guard.findUnique({ where: { id: a.guard_id }, select: { id: true } }))) throw BadRequest("揀咗嘅保安員唔存在");
  } else if (a.option === "wa_pick_site") {
    if (!a.site_id || !same.some((o) => o.site_id === a.site_id)) throw BadRequest("請揀候選盤口");
  } else if (a.option === "wa_set_date") {
    const v = a.value ?? "";
    if (!isIsoDate(v)) throw BadRequest("日期要係 YYYY-MM-DD 而且係真實日子");
    if (!same.some((o) => o.date === v) && !same.some((o) => o.input === "date")) throw BadRequest("呢個日子唔屬於候選");
  }
}

async function loadWordMap(groupId: string): Promise<Record<string, string>> {
  const g = await prisma.whatsappGroup.findUnique({ where: { id: groupId }, select: { shiftWordMap: true } });
  const m = g?.shiftWordMap;
  return (m && typeof m === "object" && !Array.isArray(m) ? m : {}) as Record<string, string>;
}

/** 洗唔到 DB 嘅 leave 格：揀返呢個保安員喺該盤最近用過嘅更種，冇就該盤第一個更種。 */
async function leaveRowShiftType(siteId: string, guardId: string): Promise<string | null> {
  const last = await prisma.shiftRecord.findFirst({ where: { guardId, siteId, status: { not: "cancelled" }, recordType: "shift", shiftType: { voidedAt: null, code: { not: "PR" } } }, orderBy: { workDate: "desc" }, select: { shiftTypeId: true } });
  if (last) return last.shiftTypeId;
  const first = await prisma.shiftType.findFirst({ where: { siteId, voidedAt: null, code: { not: "PR" } }, orderBy: [{ code: "asc" }, { id: "asc" }], select: { id: true } });
  return first?.id ?? null;
}

const normAlias = (s: string): string => s.normalize("NFKC").trim();

async function resolveWaPlan(actor: AuthedSession, q: QRowWithSession, answer: TriageAnswer): Promise<{ plan: WaPlan; fingerprint: string; impact: WaImpact }> {
  const impact: WaImpact = { can_confirm: true, summary: [], changes: [], field_outcomes: [], notes: [] };
  const ev = evOf(q);
  if (answer.option === "skip") {
    impact.summary.push("跳過：唔寫任何資料，呢條留返人手處理");
    return { plan: { type: "skip" }, fingerprint: "skip", impact };
  }
  await validateAnswerAgainstOptions(q, answer);
  switch (answer.option) {
    case "wa_ignore":
      impact.summary.push("忽略：唔入更，呢條當處理咗");
      return { plan: { type: "ignore", why: "ignore" }, fingerprint: "ignore", impact };
    case "wa_keep_old":
      impact.summary.push("保留舊記錄：唔入更，呢條當處理咗");
      return { plan: { type: "ignore", why: "keep_old" }, fingerprint: "keep_old", impact };
    case "wa_manual":
      impact.summary.push("人手處理：呢條當處理咗，請到排更頁自己入／改");
      return { plan: { type: "manual" }, fingerprint: "manual", impact };
  }

  const human: WaHuman = { ...ev.human };
  let aliasFor: string | null = null;
  switch (answer.option) {
    case "wa_pick_guard":
      human.guard_id = answer.guard_id;
      if (answer.remember_alias) aliasFor = answer.guard_id ?? null;
      break;
    case "wa_pick_site":
      human.site_id = answer.site_id;
      break;
    case "wa_set_date":
      human.work_date = answer.value;
      break;
    case "wa_accept":
    case "wa_force_write":
      human.force = true;
      break;
    case "wa_use_whatsapp":
      break;
    default:
      throw BadRequest("唔支援嘅選項");
  }
  const ev2: WaEvidence = { ...ev, human };
  const repo = createPrismaResolveRepo();
  const wordMap = await loadWordMap(ev.group.id);
  const ts = new Date(ev.sent_at);
  const evaluated = await evaluateWaState(ev2, { ts, repo, wordMap, useWhatsapp: answer.option === "wa_use_whatsapp" });
  if (evaluated.reasons.includes("month_locked")) throw BadRequest(WA_LOCKED_MSG);

  // 同更／同請假已存在：唔使再入
  if (evaluated.alreadyExistsIds.length > 0) {
    impact.summary.push("呢更／請假已經喺排更表入面，唔使再入；呢條當處理咗");
    return { plan: { type: "exists", ids: evaluated.alreadyExistsIds }, fingerprint: `exists:${[...evaluated.alreadyExistsIds].sort().join(",")}`, impact };
  }

  if (evaluated.reasons.length > 0) {
    const next: WaEvidence = {
      ...ev2,
      round: ev.round + 1,
      reasons: evaluated.reasons,
      candidates: { ...ev.candidates, shift_type_ids: evaluated.candidates.shift_type_ids, existing_record_ids: evaluated.existing.filter((r) => r.recordType !== "ot").map((r) => r.id) },
    };
    const kind = buildDraft(next, { label: ev.group.label }, ts).kind;
    impact.summary.push(`收到答案，但仲有一樣要確認：${KIND_LABEL[kind]}（會開下一條題）`);
    if (next.round > 2) impact.notes.push("已經問過兩輪，下一條會轉做「人手處理」");
    return { plan: { type: "next", evidence: next }, fingerprint: `next:${evaluated.reasons.join(",")}:${next.round}`, impact };
  }

  // ---- 全齊 → 寫入
  const eff = evaluated.effective;
  if (!eff.siteId || !eff.guardId || !eff.workDate) throw BadRequest("資料唔齊，唔可以入更");
  let shiftTypeId = eff.shiftTypeId;
  let code: string;
  if (eff.kind === "shift") {
    if (!shiftTypeId) throw BadRequest("搵唔到對應更種，唔可以入更");
    const st = await prisma.shiftType.findUnique({ where: { id: shiftTypeId }, select: { code: true, siteId: true } });
    if (!st || st.siteId !== eff.siteId) throw BadRequest("更種唔屬於呢個盤，唔可以入更");
    code = st.code;
  } else {
    if (!eff.leaveCode) throw BadRequest("請假碼唔明，唔可以入更");
    shiftTypeId = await leaveRowShiftType(eff.siteId, eff.guardId);
    if (!shiftTypeId) throw BadRequest("呢個盤冇可用更種，請人手處理");
    code = eff.leaveCode;
  }
  let alias: { guardId: string; raw: string } | null = null;
  if (aliasFor && ev.src.person_raw) {
    const g = await prisma.guard.findUnique({ where: { id: aliasFor }, select: { nameZh: true, nameAliases: true } });
    const raw = normAlias(ev.src.person_raw);
    if (g && raw && raw !== normAlias(g.nameZh) && !g.nameAliases.some((x) => normAlias(x) === raw) && !/^(我|本人|自己|小弟|小妹|in)$/i.test(raw)) alias = { guardId: aliasFor, raw };
  }
  const cancelIds = [...evaluated.conflictRecordIds].sort();
  // S1：取消舊記錄要「更表:void」；目標格已有行（含已取消重用）要「更表:update」——preview／submit 都檢查
  if (cancelIds.length > 0 && !(await hasPermission(actor, "更表", "void"))) throw Forbidden("取消舊記錄要有「更表」作廢權限嘅同事（老闆／主管）處理");
  const targetRow = await prisma.shiftRecord.findUnique({ where: { guardId_workDate_shiftTypeId: { guardId: eff.guardId, workDate: isoToDbDate(eff.workDate), shiftTypeId: shiftTypeId! } }, select: { id: true } });
  if (targetRow && !(await hasPermission(actor, "更表", "update"))) throw Forbidden("呢格已有記錄，要有「更表」修改權限嘅同事處理");
  const cancelRows = cancelIds.length ? await prisma.shiftRecord.findMany({ where: { id: { in: cancelIds } }, select: { status: true, billed: true, paid: true } }) : [];
  const [guard, site] = await Promise.all([prisma.guard.findUnique({ where: { id: eff.guardId }, select: { nameZh: true } }), prisma.site.findUnique({ where: { id: eff.siteId }, select: { canonicalName: true } })]);
  impact.summary.push(`入更（待批核，來源 WhatsApp）：${guard?.nameZh ?? ""}｜${site?.canonicalName ?? ""}｜${eff.workDate}｜${code}`);
  impact.changes.push({ table: "shift_records", action: "create", label: "新增排更記錄（待批核）", fields: [{ label: "日期", from: null, to: eff.workDate }, { label: eff.kind === "shift" ? "更別" : "請假", from: null, to: code }] });
  if (cancelIds.length > 0) {
    impact.summary.push(`同時取消 ${cancelIds.length} 條舊記錄`);
    const risky = cancelRows.filter((x) => x.status === "confirmed" || x.status === "completed" || x.billed || x.paid).length;
    if (risky > 0) impact.notes.unshift(`⚠ 會取消已確認／已結算記錄（${risky} 條）——請確認 WhatsApp 先係啱嘅`);
    impact.changes.push({ table: "shift_records", action: "void", label: "取消舊記錄", fields: [{ label: "記錄數", from: String(cancelIds.length), to: "取消" }] });
  }
  if (alias) {
    impact.summary.push("記住呢個花名（之後同一個叫法直接對到佢）");
    impact.changes.push({ table: "guards", action: "update", label: "新增保安員別名", fields: [{ label: "別名", from: null, to: alias.raw }] });
  }
  if (evaluated.reasons.length === 0 && ev.reasons.includes("low_confidence")) impact.notes.push("AI 對呢條嘅信心偏低，已由你確認");
  const fingerprint = JSON.stringify({ w: [eff.siteId, eff.guardId, eff.workDate, shiftTypeId, code], c: cancelIds, a: alias ? [alias.guardId, alias.raw] : null, ex: evaluated.existing.map((r) => `${r.id}:${r.status}`).sort() });
  return { plan: { type: "write", evidence: ev2, eff, code, shiftTypeId: shiftTypeId!, cancelIds, alias }, fingerprint, impact };
}

export interface WaPreviewOutput {
  preview_hash: string;
  writes: boolean;
  impact: WaImpact;
}

export async function previewWaAnswer(actor: AuthedSession, q: QRowWithSession, rawAnswer: unknown): Promise<WaPreviewOutput> {
  await assertCanAnswer(actor, q);
  const answer = parseAnswer(rawAnswer);
  const { plan, fingerprint, impact } = await resolveWaPlan(actor, q, answer);
  return { preview_hash: hashOf(q.id, answer, fingerprint), writes: plan.type === "write", impact };
}

export interface WaAnswerOutput {
  status: "answered" | "skipped";
  impact: WaImpact | null;
  session_status: "open" | "done";
  open_remaining: number;
  result: Record<string, unknown>;
  note: string | null;
}

export async function submitWaAnswer(actor: AuthedSession, q: QRowWithSession, rawAnswer: unknown, previewHash: string | undefined, ip: string | null, meta?: { batchId?: string }): Promise<WaAnswerOutput> {
  await assertCanAnswer(actor, q);
  const answer = parseAnswer(rawAnswer);
  const ev = evOf(q);
  const now = new Date();
  const noWrite = answer.option === "skip" || answer.option === "wa_ignore" || answer.option === "wa_keep_old" || answer.option === "wa_manual";

  const { plan, fingerprint, impact } = await resolveWaPlan(actor, q, answer);
  if (!noWrite) {
    if (!previewHash) throw BadRequest("要先預覽影響，再帶返 preview_hash 確認");
    if (hashOf(q.id, answer, fingerprint) !== previewHash) throw new ApiError(409, "conflict", "資料喺預覽之後有變，請重新預覽再確認");
  }

  const result: Record<string, unknown> = {};
  let note: string | null = null;
  const autoCardUses: Awaited<ReturnType<typeof writeShiftCells>>["autoCardUses"] = [];
  try {
    await prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${TRIAGE_LOCK}))`;
        const cur = await tx.triageQuestion.findUnique({ where: { id: q.id }, select: { status: true } });
        if (!cur || cur.status === "answered") throw Conflict("呢條問題已經答過，唔可以重複套用");
        if (cur.status === "superseded") throw Conflict("呢條問題已經唔適用（原訊息已被修改／撤回，或者已有新題）");
        const nextStatus = plan.type === "skip" ? "skipped" : "answered";
        let applyResult: Record<string, unknown> = { plan: plan.type };

        if (plan.type === "write") {
          let aliasBefore: string[] = [];
          let aliasAfter: string[] = [];
          if (plan.alias) {
            const before = await tx.guard.findUniqueOrThrow({ where: { id: plan.alias.guardId }, select: { nameAliases: true } });
            const next = [...new Set([...before.nameAliases, plan.alias.raw])];
            aliasBefore = before.nameAliases;
            aliasAfter = next;
            await tx.guard.update({ where: { id: plan.alias.guardId }, data: { nameAliases: next } });
            await writeAuditTx(tx, { actorUserId: actor.userId, tableName: "guards", rowId: plan.alias.guardId, action: "update", before: { id: plan.alias.guardId, nameAliases: aliasBefore }, after: { id: plan.alias.guardId, alias_added: true, nameAliases: aliasAfter, via: "whatsapp_triage", question_id: q.id }, ip });
            result.alias_added = true;
          }
          const day = isoToDbDate(plan.eff.workDate!);
          // 取消舊記錄＋寫新記錄同一個 tx（鎖月由 writeShiftCells 開頭 FOR SHARE 檢查；取消喺鎖月檢查之後做）
          if (plan.cancelIds.length > 0) {
            await assertMonthNotLockedTx(tx, { workDate: day, actorUserId: actor.userId, tableName: "shift_records", rowId: "whatsapp", ip });
            const n = await cancelShiftRecordsTx(tx, { ids: plan.cancelIds, actorUserId: actor.userId, ip, reason: "whatsapp:use_whatsapp" });
            result.cancelled = n;
          }
          const w = await writeShiftCells(tx, {
            siteId: plan.eff.siteId!,
            month: day,
            cells: [{ guard_id: plan.eff.guardId!, shift_type_id: plan.shiftTypeId, work_date: day, code: plan.code }],
            actor: { userId: actor.userId },
            ip,
            source: "whatsapp",
            provenance: { message_id: ev.message.message_id, revision: ev.message.revision, intent_idx: ev.message.idx, triage_question_id: q.id },
            statusPolicy: "pending_approval",
            overwriteActive: false,
          });
          autoCardUses.push(...w.autoCardUses);
          result.shift_record_ids = w.results.map((r) => r.id);
          result.records = w.results.map((r) => r.action);
          applyResult = { plan: "write", shift_record_ids: result.shift_record_ids, cancelled: result.cancelled ?? 0, alias_added: result.alias_added ?? false };
          if (w.noSettlementCount > 0) note = "呢條記錄搵唔到結算單位，糧單暫時唔會出現，請到排更頁補返";
          else if (w.pricing.unpriced > 0) note = "呢條記錄未有價目，請到排更頁／價目卡補價";
        } else if (plan.type === "next") {
          const draft = buildDraft(plan.evidence, { label: ev.group.label }, new Date(ev.sent_at));
          const { created, existing } = await insertWaQuestions(tx, q.sessionId, [draft]);
          const nextId = created[0]?.id ?? existing.get(draft.groupKey) ?? null;
          if (nextId) await tx.whatsappIntent.update({ where: { id: ev.message.intent_id }, data: { resultRef: nextId } });
          result.next_question_id = nextId;
          result.next_kind = draft.kind;
          applyResult = { plan: "next", next_question_id: nextId, next_kind: draft.kind, round: plan.evidence.round };
        } else if (plan.type === "exists") {
          applyResult = { plan: "exists", record_ids: plan.ids };
        }

        const n = await tx.triageQuestion.updateMany({
          where: { id: q.id, status: { in: ["open", "skipped"] } },
          data: {
            status: nextStatus,
            answerJson: JSON.parse(JSON.stringify(plan.type === "skip" ? { option: "skip" } : answer)),
            answeredBy: actor.userId,
            answeredAt: now,
            ...(plan.type === "skip" ? {} : { impactJson: JSON.parse(JSON.stringify(impact)), applyResultJson: JSON.parse(JSON.stringify(applyResult)) }),
          },
        });
        if (n.count !== 1) throw Conflict("呢條問題已經答過，唔可以重複套用");
        await writeAuditTx(tx, {
          actorUserId: actor.userId,
          tableName: "triage_questions",
          rowId: q.id,
          action: "triage_answer",
          after: { session_id: q.sessionId, kind: q.kind, option: answer.option, writes: plan.type === "write", plan: plan.type, round: ev.round, ...(meta?.batchId ? { batch_id: meta.batchId } : {}) },
          ip,
        });
        await refreshWaSession(tx, q.sessionId);
      },
      { timeout: 60_000, maxWait: 10_000 },
    );
  } catch (e) {
    // 鎖月（tx 內再擋一次）→ 同一個固定 400 字串，題保持 open
    if (e instanceof ApiError && e.code === "month_locked") throw BadRequest(WA_LOCKED_MSG);
    if (e && typeof e === "object" && "code" in e && (e as { code?: string }).code === "P2002") throw Conflict("呢更已經有記錄（同一保安員、同一日、同一更別），請重新預覽");
    throw e;
  }
  await journalAutoCardUsesSafe(autoCardUses);
  const open_remaining = await prisma.triageQuestion.count({ where: { sessionId: q.sessionId, status: "open" } });
  const session_status = open_remaining === 0 ? "done" : "open";
  const skipped = plan.type === "skip";
  return { status: skipped ? "skipped" : "answered", impact: skipped ? null : impact, session_status, open_remaining, result: { ...result, ...(plan.type === "manual" ? { manual: true } : {}) }, note };
}


/**
 * 批量接受白名單（batch-accept.ts 用）：
 *  - wa_person_ambiguous：候選入面剛好一位「近 60 日（由訊息日起計）喺同一個盤有更」→ 揀佢；
 *  - wa_shift_conflict：撞更／撞請假 → 預設「保留舊記錄」（唔入更）。
 * 其餘一律 null（要逐題人手答）。
 */
export async function waSuggestedAnswer(q: Pick<TriageQuestion, "kind" | "evidenceJson" | "optionsJson">): Promise<{ answer: TriageAnswer; label: string } | null> {
  const ev = evOf(q);
  if (q.kind === "wa_person_ambiguous") {
    const siteId = ev.human.site_id ?? ev.intent.site_id;
    if (!siteId || ev.candidates.guard_ids.length < 2) return null;
    const since = addDays(hkDateOf(new Date(ev.sent_at)), -RECENT_DAYS);
    const rows = await prisma.shiftRecord.groupBy({ by: ["guardId"], where: { siteId, guardId: { in: ev.candidates.guard_ids }, status: { not: "cancelled" }, recordType: "shift", workDate: { gte: isoToDbDate(since) } } });
    if (rows.length !== 1) return null;
    return { answer: { option: "wa_pick_guard", guard_id: rows[0]!.guardId }, label: "揀近 60 日喺同一個盤有更嗰位" };
  }
  if (q.kind === "wa_shift_conflict") {
    const hard = ev.reasons.some((r) => r === "conflict_leave" || r === "conflict_other_shift" || r === "conflict_shift_vs_leave");
    if (hard && optsOf(q).some((o) => o.id === "wa_keep_old")) return { answer: { option: "wa_keep_old" }, label: "保留舊記錄（唔入更）" };
  }
  return null;
}
