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
import { deleteMediaEvidence } from "./media";
import { leaveRowShiftType } from "./leave-row";
import { evaluateCancelState, evaluateCoverState, evaluateWaState, type WaEffective } from "./triage-eval";
import { buildDraft, insertWaQuestions, refreshWaSession } from "./triage";
import { maxRoundsOf, type WaEvidence, type WaHuman } from "./triage-types";

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
    existing: Array<{ id: string; site_name: string; shift_code: string; record_type: string; leave_code: string | null; status: string; work_date: string }>;
    /** W4：替更題——被替者（已配對／候選）＋當日該更記錄 */
    cover: {
      worker: { guard_id: string | null; name: string | null };
      replaced: { guard_id: string | null; name: string | null };
      replaced_candidates: Array<{ guard_id: string; name_zh: string; name_en: string | null; staff_numbers: string[]; recent_sites: Array<{ name: string; last_date: string }>; recent_here: boolean }>;
      replaced_records: Array<{ id: string; site_name: string; shift_code: string; work_date: string; status: string }>;
    } | null;
    /** W4：確認後會被取消嘅記錄（「會取消 10 月 18 日 N 更」）；撞更題／取消題／替更題 */
    cancel_preview: string[];
    /** WA-8：工卡相辨識結果（工號／姓名／圖片 id 只畀有「保安員:view」嘅人） */
    card: { media_url: string | null; staff_no: string | null; name_zh: string | null; name_en: string | null; votes: number; index: number; total: number; arbiter: boolean; candidates: string[]; others: Array<{ staff_no: string | null; status: "confirmed" | "review" }>; none: "expired" | "not_card" | "unreadable" | null } | null;
    can_remember_alias: boolean;
    manual_href: string | null;
  };
  answer: { option: string } | null;
  answered_by: string | null;
  answered_at: Date | null;
  impact: unknown;
}


type RecLite = { guardId: string; workDate: Date; recordType: string; leaveCode: string | null; shiftType: { code: string }; site: { canonicalName: string } };
const dayLabel = (d: Date): string => `${d.getUTCMonth() + 1} 月 ${d.getUTCDate()} 日`;
const recLabel = (x: RecLite): string => `${dayLabel(x.workDate)} ${x.recordType === "leave" ? `請假 ${x.leaveCode ?? ""}` : `${x.shiftType.code} 更`}（${x.site.canonicalName}）`;

/** 確認後會被取消嘅記錄文字（撞更題「以 WhatsApp 為準」／取消題／替更題）。names＝null 代表冇權睇姓名。 */
function cancelPreviewOf(kind: string, ev: WaEvidence, recBy: Map<string, RecLite & { id: string }>, names: Map<string, { nameZh: string }> | null): string[] {
  const out: string[] = [];
  const lines = (ids: string[], who: (guardId: string) => string) => {
    for (const id of ids) {
      const x = recBy.get(id);
      if (x) out.push(`會取消 ${who(x.guardId)}${recLabel(x)}`);
    }
  };
  const none = () => "";
  const named = (gid: string) => (names?.get(gid)?.nameZh ? `${names.get(gid)!.nameZh} ` : "");
  if (kind === "wa_cancel") lines(ev.candidates.existing_record_ids, none);
  else if (kind === "wa_shift_conflict" && ev.reasons.some((r) => r === "conflict_leave" || r === "conflict_other_shift" || r === "conflict_shift_vs_leave")) lines(ev.candidates.existing_record_ids, none);
  else if (kind === "wa_cover") {
    lines(ev.cover?.replaced_record_ids ?? [], named);
    if (ev.reasons.some((r) => r === "conflict_leave" || r === "conflict_other_shift")) lines(ev.candidates.existing_record_ids, named);
  }
  return out;
}

export async function waQuestionViews(rows: TriageQuestion[], caps: WaCaps): Promise<WaQuestionView[]> {
  const evs = rows.map(evOf);
  const guardIds = new Set<string>();
  const siteIds = new Set<string>();
  const recordIds = new Set<string>();
  const msgIds = new Set<string>();
  for (const e of evs) {
    for (const g of [...e.candidates.guard_ids, ...(e.cover?.replaced_candidate_ids ?? [])]) guardIds.add(g);
    for (const x of [e.intent.guard_id, e.human.guard_id, e.sender.guard_id, e.cover?.replaced_guard_id, e.human.replaced_guard_id]) if (x) guardIds.add(x);
    for (const s of [...e.candidates.site_ids, e.intent.site_id, e.human.site_id]) if (s) siteIds.add(s);
    for (const r of [...e.candidates.existing_record_ids, ...(e.cover?.replaced_record_ids ?? [])]) recordIds.add(r);
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
    recordIds.size ? prisma.shiftRecord.findMany({ where: { id: { in: [...recordIds] } }, select: { id: true, guardId: true, siteId: true, workDate: true, shiftTypeId: true, recordType: true, leaveCode: true, status: true, shiftType: { select: { code: true } }, site: { select: { canonicalName: true } } } }) : Promise.resolve([]),
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
    const candOf = (gid: string, hereSite: string | null) => {
      const g = guardBy.get(gid);
      if (!g) return [];
      const rs = recent.filter((x) => x.guard_id === gid).sort((a, b) => b.last_date.getTime() - a.last_date.getTime());
      return [{ guard_id: gid, name_zh: g.nameZh, name_en: g.nameEn, staff_numbers: nos.filter((n) => n.guardId === gid).map((n) => n.number), recent_sites: rs.slice(0, 3).map((x) => ({ name: x.name, last_date: x.last_date.toISOString().slice(0, 10) })), recent_here: !!hereSite && rs.some((x) => x.site_id === hereSite) }];
    };
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
        guard_candidates: caps.canSee ? ev.candidates.guard_ids.slice(0, 8).flatMap((gid) => candOf(gid, siteIdForLink)) : [],
        site_options: siteOptions,
        date_candidates: ev.candidates.dates,
        existing: ev.candidates.existing_record_ids.flatMap((id) => {
          const x = recBy.get(id);
          return x ? [{ id, site_name: x.site.canonicalName, shift_code: x.shiftType.code, record_type: x.recordType, leave_code: x.leaveCode, status: x.status, work_date: x.workDate.toISOString().slice(0, 10) }] : [];
        }),
        cover:
          ev.intent.kind === "cover"
            ? {
                worker: { guard_id: caps.canSee ? (ev.human.guard_id ?? ev.intent.guard_id) : null, name: caps.canSee && effGuard ? effGuard.nameZh : null },
                replaced: {
                  guard_id: caps.canSee ? (ev.human.replaced_guard_id ?? ev.cover?.replaced_guard_id ?? null) : null,
                  name: caps.canSee ? (guardBy.get(ev.human.replaced_guard_id ?? ev.cover?.replaced_guard_id ?? "")?.nameZh ?? null) : null,
                },
                replaced_candidates: caps.canSee ? (ev.cover?.replaced_candidate_ids ?? []).slice(0, 8).flatMap((gid) => candOf(gid, siteIdForLink)) : [],
                replaced_records: (ev.cover?.replaced_record_ids ?? []).flatMap((id) => {
                  const x = recBy.get(id);
                  return x ? [{ id, site_name: x.site.canonicalName, shift_code: x.shiftType.code, work_date: x.workDate.toISOString().slice(0, 10), status: x.status }] : [];
                }),
              }
            : null,
        cancel_preview: cancelPreviewOf(r.kind, ev, recBy, caps.canSee ? guardBy : null),
        card: ev.card
          ? {
              media_url: caps.canSee && ev.card.media_id && r.status === "open" ? `/api/whatsapp/media/${ev.card.media_id}` : null,
              staff_no: caps.canSee ? ev.card.staff_no_read : null,
              name_zh: caps.canSee ? ev.card.name_zh_read : null,
              name_en: caps.canSee ? ev.card.name_en_read : null,
              votes: ev.card.votes,
              index: ev.card.index,
              total: ev.card.total,
              arbiter: ev.card.arbiter,
              candidates: caps.canSee ? ev.card.candidates : [],
              others: caps.canSee ? (ev.card.others ?? []) : [],
              none: ev.card.none ?? null,
            }
          : null,
        can_remember_alias: caps.canSee && (r.kind === "wa_person_ambiguous" || r.kind === "wa_person_unknown") && ev.intent.kind !== "cancel" && !!ev.src.person_raw,
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
  | { type: "write"; evidence: WaEvidence; eff: WaEffective; code: string; shiftTypeId: string; cancelIds: string[]; alias: { guardId: string; raw: string } | null }
  | { type: "blocked"; message: string }
  | { type: "cover"; siteId: string; workDate: string; shiftTypeId: string; code: string; workerId: string; replacedId: string | null; cancelReplacedIds: string[]; cancelWorkerIds: string[] }
  | { type: "cancel"; guardId: string; ids: string[]; toLeave: { siteId: string; shiftTypeId: string; code: string; workDate: string } | null };

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
  } else if (a.option === "wa_cancel_to_leave") {
    if (!a.value || !WA_LEAVE_CODES.includes(a.value)) throw BadRequest("請揀請假碼（AL／SL／NL／RD／SH）");
  }
  // W4：替更題——替更者／被替者只可以喺未配對時揀；揀嘅人要喺候選入面（候選為空＝搜尋揀，要存在）
  if (evOf(q).intent.kind === "cover" && (a.option === "wa_cover_confirm" || a.option === "wa_cover_add_only" || a.option === "wa_use_whatsapp")) {
    const ev = evOf(q);
    const check = async (id: string | undefined, resolved: string | null, cands: string[], what: string) => {
      if (!id) return;
      if (resolved && id !== resolved) throw BadRequest(`${what}已經配對好，唔使再揀`);
      if (cands.length > 0 && !cands.includes(id)) throw BadRequest(`${what}唔屬於候選`);
      if (!(await prisma.guard.findUnique({ where: { id }, select: { id: true } }))) throw BadRequest(`揀咗嘅${what}唔存在`);
    };
    await check(a.guard_id, ev.human.guard_id ?? ev.intent.guard_id, ev.candidates.guard_ids, "替更者");
    await check(a.replaced_guard_id, ev.human.replaced_guard_id ?? ev.cover?.replaced_guard_id ?? null, ev.cover?.replaced_candidate_ids ?? [], "被替者");
  }
}

const WA_LEAVE_CODES = ["AL", "SL", "NL", "RD", "SH"];

async function loadWordMap(groupId: string): Promise<Record<string, string>> {
  const g = await prisma.whatsappGroup.findUnique({ where: { id: groupId }, select: { shiftWordMap: true } });
  const m = g?.shiftWordMap;
  return (m && typeof m === "object" && !Array.isArray(m) ? m : {}) as Record<string, string>;
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

  if (ev.intent.kind === "cover") return resolveCoverPlan(actor, q, answer, impact);
  if (ev.intent.kind === "cancel") return resolveCancelPlan(actor, q, answer, impact);

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
    shiftTypeId = await leaveRowShiftType(prisma, eff.siteId, eff.guardId);
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
  if (evaluated.reasons.length === 0 && ev.reasons.some((r) => r === "daily_cap" || r === "auto_disabled")) impact.notes.push("自動寫入被安全閥擋住（每日上限／總開關），已由你確認");
  const fingerprint = JSON.stringify({ w: [eff.siteId, eff.guardId, eff.workDate, shiftTypeId, code], c: cancelIds, a: alias ? [alias.guardId, alias.raw] : null, ex: evaluated.existing.map((r) => `${r.id}:${r.status}`).sort() });
  return { plan: { type: "write", evidence: ev2, eff, code, shiftTypeId: shiftTypeId!, cancelIds, alias }, fingerprint, impact };
}

// ---------------------------------------------------------------------------
// W4：替更（cover）／取消（cancel）——首階段一律 Triage，由人確認。
// ---------------------------------------------------------------------------
type PlanOut = { plan: WaPlan; fingerprint: string; impact: WaImpact };
const fmtDay = (iso: string): string => `${Number(iso.slice(5, 7))} 月 ${Number(iso.slice(8, 10))} 日`;

/** 取消記錄嘅風險提示（已確認／已完成／已開單／已結算）。 */
async function riskNotes(ids: string[]): Promise<{ rows: Array<{ id: string; status: string; billed: boolean; paid: boolean }>; note: string | null }> {
  const rows = ids.length ? await prisma.shiftRecord.findMany({ where: { id: { in: ids } }, select: { id: true, status: true, billed: true, paid: true } }) : [];
  const risky = rows.filter((x) => x.status === "confirmed" || x.status === "completed" || x.billed || x.paid).length;
  return { rows, note: risky > 0 ? `⚠ 會取消已確認／已結算記錄（${risky} 條）——請確認 WhatsApp 先係啱嘅` : null };
}

/** 下一輪題（盤／日子等未齊，或取消冇目標）。 */
function nextPlan(ev: WaEvidence, ev2: WaEvidence, evaluatedReasons: string[], extra: Partial<WaEvidence>, impact: WaImpact, ts: Date): PlanOut {
  const next: WaEvidence = { ...ev2, ...extra, round: ev.round + 1, reasons: evaluatedReasons };
  const kind = buildDraft(next, { label: ev.group.label }, ts).kind;
  impact.summary.push(`收到答案，下一步：${KIND_LABEL[kind]}（會開下一條題）`);
  if (next.round > maxRoundsOf(ev.intent.kind)) impact.notes.push("已經問過好多輪，下一條會轉做「人手處理」");
  return { plan: { type: "next", evidence: next }, fingerprint: `next:${evaluatedReasons.join(",")}:${next.round}`, impact };
}

async function resolveCoverPlan(actor: AuthedSession, q: QRowWithSession, answer: TriageAnswer, impact: WaImpact): Promise<PlanOut> {
  const ev = evOf(q);
  const human: WaHuman = { ...ev.human };
  const confirmish = answer.option === "wa_cover_confirm" || answer.option === "wa_cover_add_only" || answer.option === "wa_use_whatsapp";
  if (answer.option === "wa_pick_site") human.site_id = answer.site_id;
  else if (answer.option === "wa_set_date") human.work_date = answer.value;
  else if (confirmish) {
    if (answer.guard_id) human.guard_id = answer.guard_id;
    if (answer.replaced_guard_id) human.replaced_guard_id = answer.replaced_guard_id;
  } else throw BadRequest("唔支援嘅選項");
  const ev2: WaEvidence = { ...ev, human };
  const ts = new Date(ev.sent_at);
  const useWhatsapp = answer.option === "wa_use_whatsapp";
  const ce = await evaluateCoverState(ev2, { ts, repo: createPrismaResolveRepo(), wordMap: await loadWordMap(ev.group.id), useWhatsapp });
  if (ce.reasons.includes("month_locked")) throw BadRequest(WA_LOCKED_MSG);
  const structural = ce.reasons.filter((r) => r !== "person_unknown" && r !== "conflict_leave" && r !== "conflict_other_shift");
  if (!confirmish || structural.length > 0) {
    return nextPlan(ev, ev2, ce.reasons, { candidates: { ...ev.candidates, shift_type_ids: ce.candidates.shift_type_ids, existing_record_ids: ce.conflictIds }, cover: { replaced_guard_id: ev.cover?.replaced_guard_id ?? null, replaced_candidate_ids: ev.cover?.replaced_candidate_ids ?? [], replaced_record_ids: ce.replacedRecordIds } }, impact, ts);
  }
  const { workerId, replacedId, siteId, workDate, shiftTypeId } = ce.effective;
  if (!workerId) throw BadRequest("要揀替更者");
  if (!siteId || !workDate || !shiftTypeId) throw BadRequest("資料唔齊，唔可以入更");
  const addOnly = answer.option === "wa_cover_add_only";
  if (!addOnly && !replacedId) throw BadRequest("要揀被替者；或者改用「只加替更者」");
  if (replacedId && replacedId === workerId) throw BadRequest("替更者同被替者唔可以係同一個人");
  const [guards, site, st] = await Promise.all([
    prisma.guard.findMany({ where: { id: { in: [workerId, ...(replacedId ? [replacedId] : [])] } }, select: { id: true, nameZh: true } }),
    prisma.site.findUnique({ where: { id: siteId }, select: { canonicalName: true } }),
    prisma.shiftType.findUnique({ where: { id: shiftTypeId }, select: { code: true, siteId: true, voidedAt: true } }),
  ]);
  if (!st || st.siteId !== siteId || st.voidedAt) throw BadRequest("更種唔屬於呢個盤，唔可以入更");
  const nameOf = (id: string | null) => guards.find((g) => g.id === id)?.nameZh ?? "";
  if (ce.conflictIds.length > 0 && !useWhatsapp) {
    impact.can_confirm = false;
    impact.summary.push(`替更者 ${nameOf(workerId)} 喺 ${fmtDay(workDate)} 已經有其他更／請假，唔可以自動入更；請改用「人手處理」`);
    return { plan: { type: "blocked", message: "替更者同日已有其他記錄，請人手處理" }, fingerprint: `blocked:${ce.conflictIds.sort().join(",")}`, impact };
  }
  const cancelReplacedIds = addOnly ? [] : [...ce.replacedRecordIds].sort();
  const cancelWorkerIds = useWhatsapp ? [...ce.conflictIds].sort() : [];
  const allCancel = [...cancelReplacedIds, ...cancelWorkerIds];
  if (allCancel.length > 0 && !(await hasPermission(actor, "更表", "void"))) throw Forbidden("取消舊記錄要有「更表」作廢權限嘅同事（老闆／主管）處理");
  const targetRow = await prisma.shiftRecord.findUnique({ where: { guardId_workDate_shiftTypeId: { guardId: workerId, workDate: isoToDbDate(workDate), shiftTypeId } }, select: { id: true } });
  if (targetRow && !(await hasPermission(actor, "更表", "update"))) throw Forbidden("呢格已有記錄，要有「更表」修改權限嘅同事處理");
  const risk = await riskNotes(allCancel);
  if (ce.workerHasShift) impact.notes.push(`${nameOf(workerId)} 喺 ${fmtDay(workDate)} 已經有 ${st.code} 更，唔會重覆入`);
  else impact.summary.push(`替更者入更（待批核，來源 WhatsApp）：${nameOf(workerId)}｜${site?.canonicalName ?? ""}｜${workDate}｜${st.code}`);
  if (!addOnly && replacedId) {
    if (cancelReplacedIds.length > 0) impact.summary.push(`被替者 ${nameOf(replacedId)} 嘅 ${fmtDay(workDate)} ${st.code} 更會取消（原因：被 WhatsApp 替更）`);
    else impact.notes.push(`被替者 ${nameOf(replacedId)} 喺 ${fmtDay(workDate)} 冇呢一更（可能本身冇排），只會加替更者嘅更`);
  }
  if (addOnly) impact.summary.push("只加替更者，唔改被替者嘅記錄");
  if (cancelWorkerIds.length > 0) impact.summary.push(`同時取消替更者同日 ${cancelWorkerIds.length} 條原有記錄`);
  if (risk.note) impact.notes.unshift(risk.note);
  if (!ce.workerHasShift) impact.changes.push({ table: "shift_records", action: "create", label: "新增排更記錄（待批核）", fields: [{ label: "日期", from: null, to: workDate }, { label: "更別", from: null, to: st.code }] });
  if (allCancel.length > 0) impact.changes.push({ table: "shift_records", action: "void", label: "取消舊記錄", fields: [{ label: "記錄數", from: String(allCancel.length), to: "取消" }] });
  const fingerprint = JSON.stringify({ w: [siteId, workerId, workDate, shiftTypeId], r: replacedId, o: answer.option, cr: cancelReplacedIds, cw: cancelWorkerIds, st: risk.rows.map((x) => `${x.id}:${x.status}`).sort(), has: ce.workerHasShift });
  return { plan: { type: "cover", siteId, workDate, shiftTypeId, code: st.code, workerId, replacedId: addOnly ? null : replacedId, cancelReplacedIds, cancelWorkerIds }, fingerprint, impact };
}

async function resolveCancelPlan(actor: AuthedSession, q: QRowWithSession, answer: TriageAnswer, impact: WaImpact): Promise<PlanOut> {
  const ev = evOf(q);
  const human: WaHuman = { ...ev.human };
  const apply = answer.option === "wa_cancel_apply" || answer.option === "wa_cancel_to_leave";
  if (answer.option === "wa_pick_guard") human.guard_id = answer.guard_id;
  else if (answer.option === "wa_set_date") human.work_date = answer.value;
  else if (!apply) throw BadRequest("唔支援嘅選項");
  const ev2: WaEvidence = { ...ev, human };
  const ts = new Date(ev.sent_at);
  const ce = await evaluateCancelState(ev2, { ts, repo: createPrismaResolveRepo() });
  if (ce.reasons.includes("month_locked")) throw BadRequest(WA_LOCKED_MSG);
  if (!apply || ce.reasons.length > 0) return nextPlan(ev, ev2, ce.reasons, { candidates: { ...ev.candidates, existing_record_ids: ce.targets.map((r) => r.id) } }, impact, ts);
  const { guardId, workDate } = ce.effective;
  if (!guardId || !workDate) throw BadRequest("資料唔齊，唔可以取消");
  const ids = ce.targets.map((r) => r.id).sort();
  if (!(await hasPermission(actor, "更表", "void"))) throw Forbidden("取消記錄要有「更表」作廢權限嘅同事（老闆／主管）處理");
  const [guard, recs] = await Promise.all([
    prisma.guard.findUnique({ where: { id: guardId }, select: { nameZh: true } }),
    prisma.shiftRecord.findMany({ where: { id: { in: ids } }, select: { id: true, status: true, recordType: true, leaveCode: true, siteId: true, shiftTypeId: true, billed: true, paid: true, site: { select: { canonicalName: true } }, shiftType: { select: { code: true } } } }),
  ]);
  const label = (x: (typeof recs)[number]) => `${x.site.canonicalName}｜${x.recordType === "leave" ? `請假 ${x.leaveCode ?? ""}` : `${x.shiftType.code} 更`}`;
  let toLeave: { siteId: string; shiftTypeId: string; code: string; workDate: string } | null = null;
  if (answer.option === "wa_cancel_to_leave") {
    const code = answer.value!;
    if (recs.some((x) => x.recordType === "leave" && x.leaveCode === code)) {
      impact.summary.push("呢日已經係呢個請假碼，唔使再改；呢條當處理咗");
      return { plan: { type: "exists", ids: recs.filter((x) => x.recordType === "leave" && x.leaveCode === code).map((x) => x.id) }, fingerprint: `exists:${ids.join(",")}`, impact };
    }
    const siteId = ce.effective.siteId ?? recs[0]!.siteId;
    const shiftTypeId = await leaveRowShiftType(prisma, siteId, guardId);
    if (!shiftTypeId) throw BadRequest("呢個盤冇可用更種，請人手處理");
    const targetRow = await prisma.shiftRecord.findUnique({ where: { guardId_workDate_shiftTypeId: { guardId, workDate: isoToDbDate(workDate), shiftTypeId } }, select: { id: true } });
    if (targetRow && !(await hasPermission(actor, "更表", "update"))) throw Forbidden("呢格已有記錄，要有「更表」修改權限嘅同事處理");
    toLeave = { siteId, shiftTypeId, code, workDate };
  }
  const risk = await riskNotes(ids);
  impact.summary.push(`取消 ${guard?.nameZh ?? ""} ${fmtDay(workDate)} 嘅記錄：${recs.map(label).join("、")}（原因：WhatsApp 取消）`);
  if (toLeave) impact.summary.push(`改為請假 ${toLeave.code}（待批核，來源 WhatsApp）`);
  if (risk.note) impact.notes.unshift(risk.note);
  impact.changes.push({ table: "shift_records", action: "void", label: "取消記錄", fields: [{ label: "記錄數", from: String(ids.length), to: "取消" }] });
  if (toLeave) impact.changes.push({ table: "shift_records", action: "create", label: "新增請假記錄（待批核）", fields: [{ label: "日期", from: null, to: workDate }, { label: "請假", from: null, to: toLeave.code }] });
  const fingerprint = JSON.stringify({ g: guardId, d: workDate, c: ids, o: answer.option, v: answer.value ?? null, st: risk.rows.map((x) => `${x.id}:${x.status}`).sort(), l: toLeave ? [toLeave.siteId, toLeave.shiftTypeId] : null });
  return { plan: { type: "cancel", guardId, ids, toLeave }, fingerprint, impact };
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
  return { preview_hash: hashOf(q.id, answer, fingerprint), writes: plan.type === "write" || plan.type === "cover" || plan.type === "cancel", impact };
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

  if (plan.type === "blocked") throw Conflict(plan.message);
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
        } else if (plan.type === "cover" || plan.type === "cancel") {
          // W4：取消 + 寫入同一個 tx（鎖月：先 assertMonthNotLockedTx，writeShiftCells 開頭再 FOR SHARE 一次）
          const dateIso = plan.type === "cover" ? plan.workDate : (plan.toLeave?.workDate ?? null);
          const day = dateIso ? isoToDbDate(dateIso) : null;
          const cancelIdsAll = plan.type === "cover" ? [...plan.cancelReplacedIds, ...plan.cancelWorkerIds] : plan.ids;
          if (cancelIdsAll.length > 0) {
            const anyRow = await tx.shiftRecord.findFirstOrThrow({ where: { id: { in: cancelIdsAll } }, select: { workDate: true } });
            await assertMonthNotLockedTx(tx, { workDate: anyRow.workDate, actorUserId: actor.userId, tableName: "shift_records", rowId: "whatsapp", ip });
          }
          let cancelled = 0;
          if (plan.type === "cover") {
            if (plan.cancelReplacedIds.length > 0) cancelled += await cancelShiftRecordsTx(tx, { ids: plan.cancelReplacedIds, actorUserId: actor.userId, ip, reason: "covered_by_whatsapp" });
            if (plan.cancelWorkerIds.length > 0) cancelled += await cancelShiftRecordsTx(tx, { ids: plan.cancelWorkerIds, actorUserId: actor.userId, ip, reason: "whatsapp:use_whatsapp" });
          } else {
            cancelled += await cancelShiftRecordsTx(tx, { ids: plan.ids, actorUserId: actor.userId, ip, reason: "cancelled_by_whatsapp" });
          }
          result.cancelled = cancelled;
          const cell =
            plan.type === "cover"
              ? { siteId: plan.siteId, guardId: plan.workerId, shiftTypeId: plan.shiftTypeId, code: plan.code }
              : plan.toLeave
                ? { siteId: plan.toLeave.siteId, guardId: plan.guardId, shiftTypeId: plan.toLeave.shiftTypeId, code: plan.toLeave.code }
                : null;
          let recordIds: string[] = [];
          if (cell && day) {
            const w = await writeShiftCells(tx, {
              siteId: cell.siteId,
              month: day,
              cells: [{ guard_id: cell.guardId, shift_type_id: cell.shiftTypeId, work_date: day, code: cell.code }],
              actor: { userId: actor.userId },
              ip,
              source: "whatsapp",
              provenance: { message_id: ev.message.message_id, revision: ev.message.revision, intent_idx: ev.message.idx, triage_question_id: q.id, ...(plan.type === "cover" ? { cover: { replaced_guard_id: plan.replacedId } } : { cancel_to_leave: true }) },
              statusPolicy: "pending_approval",
              overwriteActive: false,
            });
            autoCardUses.push(...w.autoCardUses);
            recordIds = w.results.map((r) => r.id);
            result.shift_record_ids = recordIds;
            result.records = w.results.map((r) => r.action);
            if (w.noSettlementCount > 0) note = "呢條記錄搵唔到結算單位，糧單暫時唔會出現，請到排更頁補返";
            else if (w.pricing.unpriced > 0) note = "呢條記錄未有價目，請到排更頁／價目卡補價";
          }
          applyResult = { plan: plan.type, shift_record_ids: recordIds, cancelled };
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
  // WA-8：工卡相答完即刪加密暫存圖（同一訊息冇其他 open 題先刪；跳過／下一輪題照留，TTL 7 日自動清）
  if (ev.card?.media_id && plan.type !== "skip" && plan.type !== "next") {
    const left = await prisma.triageQuestion.count({ where: { status: "open", session: { sourceType: "whatsapp" }, evidenceJson: { path: ["message", "message_id"], equals: ev.message.message_id } } });
    if (left === 0) await deleteMediaEvidence([ev.message.message_id]).catch(() => 0);
  }
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
