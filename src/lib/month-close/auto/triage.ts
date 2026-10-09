// WP-ONE-CLICK-AUTO（§31.3 E）：一鍵結算 propose／unknown 項目 → 分診題（month_close_*）。
//   - session：source_type=month_close，source_ref=run id，擁有人＝撳一鍵嗰個人；
//   - 題目預填建議答案，一撳（mc_accept）確認＝寫入；寫入全部經呢度，預覽（dry）→ 確認兩步，
//     preview_hash 綁住題目＋答案＋當刻狀態指紋，資料中途變咗就 409；
//   - 答題人要有「一鍵結算:create」（老闆／會計），因為會建價卡／加別名／改結算；
//   - 確認寫入嘅 audit 帶 `auto_source=triage:<題目 id>`，唔屬 auto（用戶明確確認），undo-auto 唔會還原。
import { createHmac } from "node:crypto";
import type { Prisma, TriageQuestion, TriageSession } from "@prisma/client";
import { prisma } from "@/lib/db";
import { writeAuditTx } from "@/lib/audit";
import { ApiError, BadRequest, Conflict, Forbidden } from "@/lib/api/errors";
import { hasPermission, type AuthedSession } from "@/lib/rbac/requirePermission";
import { monthRange } from "@/lib/reports/money";
import { assertMonthNotLocked } from "@/lib/month-lock";
import { assignRosterUploadSite, reparseRosterUpload } from "@/lib/roster-upload/service";
import { reconcileUpload } from "@/lib/roster-upload/reconcile";
import { applyReconcileDecisions } from "@/lib/roster-upload/reconcile-apply";
import { recomputeSettlement } from "@/lib/roster-upload/settlement-resync";
import { answerSchema, KIND_LABEL, type QuestionKind, type QuestionOption, type TriageAnswer } from "@/lib/triage/types";
import { refreshSessionStatus } from "@/lib/triage/session";
import { AutoCollector, SimpleWriter } from "./context";
import { addSiteAlias, createSiteFromUploadForTriage } from "./site-setup";
import { collectUnpricedGroups, createCardAndPrice, describeValues } from "./pricing";
import { setSettlementBatch } from "./settlement";
import { linkIdentityToGuard } from "./guard-match";
import { MC_KINDS, type McEvidence, type McKind, type McQuestionDraft, type PriceValues, type PricingGroupRef } from "./types";

/** applying 超過呢個時間（寫入中途程式死咗）當卡死，容許重新 claim。 */
const APPLYING_STALE_MS = 10 * 60 * 1000;

export const isMcKind = (kind: string): kind is McKind => (MC_KINDS as readonly string[]).includes(kind);

type QRowWithSession = TriageQuestion & { session: TriageSession };

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

// ---------------------------------------------------------------------------
// 開 session／題目
// ---------------------------------------------------------------------------
function optionsFor(d: McQuestionDraft): QuestionOption[] {
  const ev = d.evidence;
  const out: QuestionOption[] = [];
  if (ev.prefillCandidateId) out.push({ id: "mc_accept", label: ev.suggestion ? `一撳確認：${ev.suggestion}` : "一撳確認建議答案" });
  if (ev.candidates.length > 1 || (ev.candidates.length === 1 && !ev.prefillCandidateId)) out.push({ id: "mc_pick", label: "揀另一個候選" });
  if (ev.kind === "month_close_site_alias") out.push({ id: "mc_new", label: "唔係，當新盤（自動建更種）" });
  if (ev.kind === "month_close_pricing" || ev.kind === "month_close_site_new") out.push({ id: "mc_price", label: "自己輸入價錢", hint: "客價／工資／雞頭費（元／更）" });
  if (ev.kind === "month_close_settlement" && !out.some((o) => o.id === "mc_pick")) out.push({ id: "mc_pick", label: "揀其他結算雞頭" });
  if (ev.kind === "month_close_shift_variance" || (ev.action.type === "site_new" && ev.action.groups.length === 0)) out.push({ id: "mc_ack", label: "我已處理／已覆核" });
  out.push({ id: "skip", label: "跳過，留返人手" });
  return out;
}

/** 開（或者刷新）呢個 run 嘅分診 session。重新執行同一個 run：已答／已跳過嘅題保留，open 題刷新，唔再出現嘅 open 題作廢。 */
export async function upsertMonthCloseTriage(runId: string, ownerUserId: string, drafts: readonly McQuestionDraft[], ip: string | null, monthIso: string): Promise<{ sessionId: string | null; created: number; total: number }> {
  // 新 run：同月份其他 run 嘅 open month_close_* 題一律作廢（跟 §28：以最新一次運行嘅題為準）。
  {
    const month = monthIso;
    const others = await prisma.triageSession.findMany({ where: { sourceType: "month_close", sourceRef: { not: runId } }, select: { id: true } });
    if (others.length) {
      const olds = await prisma.triageQuestion.findMany({ where: { sessionId: { in: others.map((o) => o.id) }, status: "open" }, select: { id: true, evidenceJson: true } });
      const stale = olds.filter((o) => (o.evidenceJson as { month?: string }).month === month).map((o) => o.id);
      if (stale.length) await prisma.triageQuestion.updateMany({ where: { id: { in: stale } }, data: { status: "superseded" } });
      for (const o of others) await refreshSessionStatus(o.id);
    }
  }
  const existing = await prisma.triageSession.findUnique({ where: { sourceType_sourceRef: { sourceType: "month_close", sourceRef: runId } } });
  if (!existing && drafts.length === 0) return { sessionId: null, created: 0, total: 0 };
  const session =
    existing ??
    (await prisma.triageSession.create({
      data: { sourceType: "month_close", sourceRef: runId, ownerUserId, createdBy: ownerUserId, statsJson: {} },
    }));
  let created = 0;
  const keep = new Set(drafts.map((d) => d.groupKey));
  const prior = await prisma.triageQuestion.findMany({ where: { sessionId: session.id } });
  const priorByKey = new Map(prior.map((q) => [q.groupKey, q]));
  for (const d of drafts) {
    const old = priorByKey.get(d.groupKey);
    const data = {
      kind: d.kind,
      sort: d.sort,
      title: d.title,
      evidenceJson: JSON.parse(JSON.stringify(d.evidence)) as Prisma.InputJsonValue,
      optionsJson: JSON.parse(JSON.stringify(optionsFor(d))) as Prisma.InputJsonValue,
    };
    if (!old) {
      await prisma.triageQuestion.create({ data: { sessionId: session.id, groupKey: d.groupKey, ...data } });
      created++;
    } else if (old.status === "open" || old.status === "superseded") {
      await prisma.triageQuestion.update({ where: { id: old.id }, data: { ...data, status: "open" } });
    }
  }
  await prisma.triageQuestion.updateMany({ where: { sessionId: session.id, status: "open", groupKey: { notIn: [...keep] } }, data: { status: "superseded" } });
  const byKind: Record<string, number> = {};
  for (const g of await prisma.triageQuestion.groupBy({ by: ["kind"], where: { sessionId: session.id, status: { not: "superseded" } }, _count: { _all: true } })) byKind[g.kind] = g._count._all;
  const total = Object.values(byKind).reduce((a, b) => a + b, 0);
  await prisma.triageSession.update({ where: { id: session.id }, data: { statsJson: { total, by_kind: byKind }, lastAppliedAt: new Date() } });
  await refreshSessionStatus(session.id);
  if (!existing) {
    await prisma.$transaction(async (tx) => {
      await writeAuditTx(tx, { actorUserId: ownerUserId, tableName: "triage_sessions", rowId: session.id, action: "triage_session_create", after: { source_type: "month_close", owner_user_id: ownerUserId, new_questions: created, total_questions: total, by_kind: byKind, run_id: runId }, ip });
    });
  }
  return { sessionId: session.id, created, total };
}

// ---------------------------------------------------------------------------
// 讀（DTO）
// ---------------------------------------------------------------------------
export interface McQuestionView {
  id: string;
  session_id: string;
  kind: QuestionKind;
  kind_label: string;
  title: string;
  sort: number;
  status: string;
  options: QuestionOption[];
  mc: {
    summary: string;
    suggestion: string | null;
    confidence: "propose" | "unknown";
    action_type: string;
    count: number | null;
    candidates: Array<{ id: string; label: string; evidence: string | null; values: PriceValues | null; values_text: string | null }>;
    prefill_candidate_id: string | null;
    needs_price_input: boolean;
    needs_broker_pick: boolean;
    broker_options: Array<{ id: string; code: string }>;
    /** 安員配對題：更表身份（姓名）淨係有「安員個人資料:view」先顯示。 */
    identity_label: string | null;
    pii_visible: boolean;
  };
  answer: { option: string; candidate_id?: string } | null;
  answered_by: string | null;
  answered_at: Date | null;
  impact: unknown;
}

export async function mcQuestionViews(rows: TriageQuestion[], caps: { pii: boolean }): Promise<McQuestionView[]> {
  const needBrokers = rows.some((r) => r.kind === "month_close_settlement");
  const brokers = needBrokers ? await prisma.broker.findMany({ where: { status: "active" }, select: { id: true, code: true }, orderBy: { code: "asc" } }) : [];
  return rows.map((r) => {
    const ev = r.evidenceJson as unknown as McEvidence;
    const ans = r.answerJson as { option?: string; candidate_id?: string } | null;
    const action = ev.action;
    const count = action.type === "pricing" || action.type === "settlement" ? action.count : action.type === "guard_match" ? action.cellCount : null;
    return {
      id: r.id,
      session_id: r.sessionId,
      kind: r.kind as QuestionKind,
      kind_label: KIND_LABEL[r.kind as QuestionKind] ?? r.kind,
      title: r.title,
      sort: r.sort,
      status: r.status,
      options: r.optionsJson as unknown as QuestionOption[],
      mc: {
        summary: ev.summary,
        suggestion: ev.suggestion,
        confidence: ev.confidence,
        action_type: action.type,
        count,
        candidates: ev.candidates.map((c) => ({ id: c.id, label: c.label, evidence: c.evidence ?? null, values: c.values ?? null, values_text: c.values ? describeValues(c.values) : null })),
        prefill_candidate_id: ev.prefillCandidateId,
        needs_price_input: ev.kind === "month_close_pricing" || (ev.kind === "month_close_site_new" && !(ev.action.type === "site_new" && ev.action.groups.length === 0)),
        needs_broker_pick: ev.kind === "month_close_settlement",
        broker_options: ev.kind === "month_close_settlement" ? brokers : [],
        identity_label: action.type === "guard_match" ? (caps.pii ? action.identity.nameRaw : null) : null,
        pii_visible: caps.pii,
      },
      answer: ans?.option ? { option: ans.option, ...(ans.candidate_id ? { candidate_id: ans.candidate_id } : {}) } : null,
      answered_by: r.answeredBy,
      answered_at: r.answeredAt,
      impact: r.impactJson,
    };
  });
}

// ---------------------------------------------------------------------------
// 答（預覽＋確認）
// ---------------------------------------------------------------------------
export interface McImpact {
  can_confirm: boolean;
  summary: string[];
  changes: Array<{ table: string; action: string; label: string; fields: Array<{ label: string; from: string | null; to: string }> }>;
  field_outcomes: Array<{ field: string; label: string; outcome: string }>;
  notes: string[];
}

type Plan =
  | { type: "skip" }
  | { type: "ack" }
  | { type: "site_alias"; siteId: string | null; createNew: boolean }
  | { type: "pricing"; values: PriceValues; evidence: string; groups: Array<{ ref: PricingGroupRef; needClient: boolean; needPayout: boolean }> }
  | { type: "settlement"; brokerId: string }
  | { type: "guard_match"; guardId: string };

async function assertCanAnswer(actor: AuthedSession, q: QRowWithSession): Promise<void> {
  if (q.status === "answered") throw Conflict("呢條問題已經答過，唔可以重複套用");
  if (q.status === "superseded") throw Conflict("呢條問題已經唔適用（改動已還原或者較新一次一鍵結算取代）");
  if (q.status === "applying" && Date.now() - q.updatedAt.getTime() < APPLYING_STALE_MS) throw Conflict("呢條問題而家有人處理緊，等佢完成");
  if (!(await hasPermission(actor, "一鍵結算", "create"))) throw Forbidden("要有「一鍵結算」權限嘅同事（老闆／會計）先可以答呢類問題");
}

function parseAnswer(raw: unknown): TriageAnswer {
  const r = answerSchema.safeParse(raw);
  if (!r.success) {
    const i = r.error.issues[0];
    throw BadRequest(`答案格式唔啱（${i ? i.path.join(".") : "unknown"}）`);
  }
  return r.data;
}

function priceFromAnswer(a: TriageAnswer): PriceValues {
  const p = a.price;
  if (!p) throw BadRequest("請輸入價錢");
  const wage = p.guard_wage ?? null;
  const fee = p.broker_fee ?? null;
  return { clientRate: p.client_rate ?? null, guardWage: wage, brokerFee: fee, payoutRate: wage !== null || fee !== null ? (wage ?? 0) + (fee ?? 0) : null };
}

async function resolvePlan(q: QRowWithSession, answer: TriageAnswer): Promise<{ plan: Plan; fingerprint: string; impact: McImpact }> {
  const ev = q.evidenceJson as unknown as McEvidence;
  const impact: McImpact = { can_confirm: true, summary: [], changes: [], field_outcomes: [], notes: [] };
  const allowed = new Set((q.optionsJson as unknown as QuestionOption[]).map((o) => o.id));
  if (!allowed.has(answer.option)) throw BadRequest("呢個選項唔屬於呢條問題");
  if (answer.option === "skip") {
    impact.summary.push("跳過：唔寫任何資料，呢條留返人手處理");
    return { plan: { type: "skip" }, fingerprint: "skip", impact };
  }
  const month = new Date(`${ev.month}T00:00:00.000Z`);
  const locked = await prisma.monthClose.findUnique({ where: { month } });
  if (locked?.lockedAt) throw Conflict("本月已鎖定，唔可以再改");

  const candId = answer.option === "mc_accept" ? ev.prefillCandidateId : answer.candidate_id;
  const cand = ev.candidates.find((c) => c.id === candId);
  if ((answer.option === "mc_accept" || answer.option === "mc_pick") && !cand && ev.kind !== "month_close_settlement") throw BadRequest("請揀一個候選");

  switch (ev.action.type) {
    case "shift_variance": {
      impact.summary.push("確認已覆核：唔會改任何資料，只係記低你睇過");
      return { plan: { type: "ack" }, fingerprint: "ack", impact };
    }
    case "site_alias": {
      const up = await prisma.rosterUpload.findUnique({ where: { id: ev.action.uploadId }, select: { siteId: true, status: true } });
      if (!up || up.status === "voided" || up.status === "superseded") throw Conflict("呢個上載已經唔存在或者被取代");
      if (up.siteId) throw Conflict("呢個上載已經歸咗盤");
      if (answer.option === "mc_new") {
        impact.summary.push(`當新盤「${ev.action.siteNameRaw}」：自動建盤、由更表代號＋時段建更種、套用本月更次`);
        impact.notes.push("價錢要重新撳一鍵結算先會自動定價");
        return { plan: { type: "site_alias", siteId: null, createNew: true }, fingerprint: `new:${up.status}`, impact };
      }
      const siteId = cand?.refId ?? null;
      if (!siteId) throw BadRequest("請揀一個候選盤");
      const site = await prisma.site.findUnique({ where: { id: siteId }, select: { canonicalName: true } });
      if (!site) throw Conflict("候選盤已經唔存在");
      impact.summary.push(`將「${ev.action.siteNameRaw}」加做盤「${site.canonicalName}」嘅別名，上載歸入呢個盤，套用本月更次`);
      impact.changes.push({ table: "sites", action: "update", label: "新增盤別名", fields: [{ label: "別名", from: null, to: ev.action.siteNameRaw }] });
      return { plan: { type: "site_alias", siteId, createNew: false }, fingerprint: `alias:${siteId}:${up.status}`, impact };
    }
    case "pricing":
    case "site_new": {
      if (ev.action.type === "site_new" && ev.action.groups.length === 0) {
        if (answer.option !== "mc_ack") throw BadRequest("呢題淨係可以揀「我已處理」或者跳過");
        impact.summary.push("確認已處理：唔會改任何資料");
        return { plan: { type: "ack" }, fingerprint: "ack", impact };
      }
      const groupsAll = await collectUnpricedGroups(month);
      const wanted = ev.action.type === "pricing" ? [ev.action.group] : ev.action.groups;
      const groups = wanted
        .map((ref) => groupsAll.find((g) => g.ref.siteId === ref.siteId && g.ref.shiftTypeId === ref.shiftTypeId && g.ref.brokerId === ref.brokerId && g.ref.ot === ref.ot))
        .filter((g): g is NonNullable<typeof g> => !!g)
        .map((g) => ({ ref: g.ref, needClient: g.need.client, needPayout: g.need.payout }));
      if (groups.length === 0) throw Conflict("呢組更而家已經有價（可能已經處理）");
      let values: PriceValues;
      let evidenceText: string;
      if (answer.option === "mc_price") {
        values = priceFromAnswer(answer);
        evidenceText = "用戶喺分診題輸入嘅價錢";
      } else {
        if (!cand?.values) throw BadRequest("候選冇價錢");
        values = cand.values;
        evidenceText = `分診一撳確認候選價：${cand.label}（${cand.evidence ?? ""}）`;
      }
      const total = groups.reduce((a, g) => a + (groupsAll.find((x) => x.ref === g.ref)?.recordIds.length ?? 0), 0);
      impact.summary.push(`建價卡（${describeValues(values)}），補 ${total} 更未定價記錄`);
      impact.changes.push({ table: "rate_cards", action: "create", label: "新增價卡（本月 1 號起至月尾）", fields: [{ label: "價錢", from: null, to: describeValues(values) }] });
      if (groups.some((g) => g.needClient) && values.clientRate === null) impact.notes.push("有客價未定嘅更，但呢個答案冇客價，客價部分仍然未定");
      if (groups.some((g) => g.needPayout) && values.guardWage === null && values.brokerFee === null && values.payoutRate === null) impact.notes.push("有出街價未定嘅更，但呢個答案冇出街價，出街價部分仍然未定");
      return { plan: { type: "pricing", values, evidence: evidenceText, groups }, fingerprint: `pricing:${groups.length}:${total}:${JSON.stringify(values)}`, impact };
    }
    case "settlement": {
      let brokerId: string | null = cand?.refId ?? null;
      if (answer.option === "mc_pick" && !cand && answer.value) brokerId = answer.value;
      if (!brokerId) throw BadRequest("請揀結算雞頭");
      const b = await prisma.broker.findUnique({ where: { id: brokerId }, select: { code: true, kind: true } });
      if (!b) throw BadRequest("揀咗嘅雞頭唔存在");
      const n = await prisma.shiftRecord.count({ where: { settlementBrokerId: null, status: { not: "cancelled" }, siteId: ev.action.siteId, guardId: ev.action.guardId, workDate: { gte: monthRange(month).start, lte: monthRange(month).end } } });
      if (n === 0) throw Conflict("呢批更已經有結算雞頭（可能已經處理）");
      impact.summary.push(`${n} 更歸 ${b.code}`);
      impact.changes.push({ table: "shift_records", action: "update", label: "補結算雞頭", fields: [{ label: "結算雞頭", from: "（冇）", to: b.code }] });
      impact.notes.push("要重新撳一鍵結算先會按新雞頭自動定價");
      return { plan: { type: "settlement", brokerId }, fingerprint: `settle:${n}:${brokerId}`, impact };
    }
    case "guard_match": {
      const guardId = cand?.refId ?? null;
      if (!guardId) throw BadRequest("請揀一個候選安員");
      const g = await prisma.guard.findUnique({ where: { id: guardId }, select: { id: true } });
      if (!g) throw Conflict("候選安員已經唔存在");
      impact.summary.push(`將呢個更表身份（${ev.action.siteLabel}，${ev.action.cellCount} 格）配對到所選安員：加更表用名做別名，登記（未被佔用嘅）工號，之後重新對數套用更次`);
      impact.changes.push({ table: "guards", action: "update", label: "安員配對（別名／工號）", fields: [] });
      return { plan: { type: "guard_match", guardId }, fingerprint: `guard:${guardId}`, impact };
    }
  }
}

export interface McPreviewOutput {
  preview_hash: string;
  writes: boolean;
  impact: McImpact;
}

export async function previewMcAnswer(actor: AuthedSession, q: QRowWithSession, rawAnswer: unknown): Promise<McPreviewOutput> {
  await assertCanAnswer(actor, q);
  const answer = parseAnswer(rawAnswer);
  const { plan, fingerprint, impact } = await resolvePlan(q, answer);
  return { preview_hash: hashOf(q.id, answer, fingerprint), writes: plan.type !== "skip" && plan.type !== "ack", impact };
}

async function reconcileApplyOne(uploadId: string, actorUserId: string, ip: string | null): Promise<number> {
  await recomputeSettlement(uploadId, actorUserId);
  const { items } = await reconcileUpload(uploadId);
  const keys = items.filter((i) => i.category === "roster_only" || i.category === "settlement_diff").map((i) => i.key);
  let applied = 0;
  for (let i = 0; i < keys.length; i += 2000) {
    const res = await applyReconcileDecisions({ uploadId, actions: keys.slice(i, i + 2000).map((key) => ({ key, action: "apply_roster" as const, reason: "一鍵結算分診一撳確認後套用本月更次" })), actorUserId, ip });
    applied += res.results.filter((r) => r.ok).length;
  }
  return applied;
}

export interface McAnswerOutput {
  status: "answered" | "skipped";
  impact: McImpact | null;
  session_status: "open" | "done";
  open_remaining: number;
  result: Record<string, unknown>;
}

export async function submitMcAnswer(actor: AuthedSession, q: QRowWithSession, rawAnswer: unknown, previewHash: string | undefined, ip: string | null): Promise<McAnswerOutput> {
  await assertCanAnswer(actor, q);
  const answer = parseAnswer(rawAnswer);
  const ev = q.evidenceJson as unknown as McEvidence;
  const month = new Date(`${ev.month}T00:00:00.000Z`);
  const now = new Date();

  if (answer.option === "skip") {
    await prisma.$transaction(async (tx) => {
      const n = await tx.triageQuestion.updateMany({ where: { id: q.id, status: { in: ["open", "skipped"] } }, data: { status: "skipped", answerJson: { option: "skip" }, answeredBy: actor.userId, answeredAt: now } });
      if (n.count !== 1) throw Conflict("呢條問題已經答過，唔可以重複套用");
      await writeAuditTx(tx, { actorUserId: actor.userId, tableName: "triage_questions", rowId: q.id, action: "triage_answer", after: { session_id: q.sessionId, kind: q.kind, option: "skip", writes: false }, ip });
    });
    const session_status = await refreshSessionStatus(q.sessionId);
    return { status: "skipped", impact: null, session_status, open_remaining: await prisma.triageQuestion.count({ where: { sessionId: q.sessionId, status: "open" } }), result: {} };
  }

  if (!previewHash) throw BadRequest("要先預覽影響，再帶返 preview_hash 確認");
  await assertMonthNotLocked({ workDate: month, actorUserId: actor.userId, tableName: "triage_questions", rowId: q.id, ip });
  const { plan, fingerprint, impact } = await resolvePlan(q, answer);
  if (hashOf(q.id, answer, fingerprint) !== previewHash) throw new ApiError(409, "conflict", "資料喺預覽之後有變，請重新預覽再確認");
  const writer = new SimpleWriter(`triage:${q.id}`, actor.userId, ip);
  const result: Record<string, unknown> = {};

  // 先 claim（open／skipped／卡死嘅 applying → applying），並發淨係一個攞到；寫失敗退返 open，retry 安全
  //（建卡係冪等：同來源已有卡唔重複建）。
  const claimed = await prisma.triageQuestion.updateMany({
    where: { id: q.id, OR: [{ status: { in: ["open", "skipped"] } }, { status: "applying", updatedAt: { lt: new Date(Date.now() - APPLYING_STALE_MS) } }] },
    data: { status: "applying" },
  });
  if (claimed.count !== 1) throw Conflict("呢條問題已經有人處理緊或者答咗，唔可以重複套用");
  try {
  switch (plan.type) {
    case "ack":
      break;
    case "site_alias": {
      const a = ev.action;
      if (a.type !== "site_alias") break;
      const collector = new AutoCollector(null, month, actor.userId, ip, `triage:${q.id}`);
      let siteId = plan.siteId;
      if (plan.createNew) {
        siteId = (await createSiteFromUploadForTriage(collector, { id: a.uploadId, siteNameRaw: a.siteNameRaw })).siteId;
      } else if (siteId) {
        await addSiteAlias(writer, siteId, a.siteNameRaw, { uploadId: a.uploadId });
      }
      if (!siteId) throw BadRequest("搵唔到目標盤");
      await assignRosterUploadSite(a.uploadId, siteId);
      await reparseRosterUpload(a.uploadId, { autoResolveSite: false });
      result.applied = await reconcileApplyOne(a.uploadId, actor.userId, ip);
      result.site_id = siteId;
      break;
    }
    case "pricing": {
      let priced = 0;
      const cards: string[] = [];
      for (const g of plan.groups) {
        const need = { client: g.needClient && plan.values.clientRate !== null, payout: g.needPayout && (plan.values.guardWage !== null || plan.values.brokerFee !== null || plan.values.payoutRate !== null) };
        if (!need.client && !need.payout) continue;
        const res = await createCardAndPrice(writer, { month, group: g.ref, need, values: plan.values, evidence: plan.evidence, note: `分診一撳確認（題目 ${q.id.slice(0, 8)}）：${plan.evidence}`, confidence: "confirmed" });
        priced += res.recordsPriced;
        cards.push(res.cardId);
      }
      result.records_priced = priced;
      result.cards = cards.length;
      if (cards.length === 0) throw new ApiError(422, "unprocessable", "呢個答案冇齊所需價錢，唔會建卡");
      break;
    }
    case "settlement": {
      const a = ev.action;
      if (a.type !== "settlement") break;
      const { start, end } = monthRange(month);
      const recs = await prisma.shiftRecord.findMany({ where: { settlementBrokerId: null, status: { not: "cancelled" }, siteId: a.siteId, guardId: a.guardId, workDate: { gte: start, lte: end } }, select: { id: true } });
      result.records_settled = await setSettlementBatch(writer, recs.map((r) => r.id), plan.brokerId, "分診一撳確認");
      break;
    }
    case "guard_match": {
      const a = ev.action;
      if (a.type !== "guard_match") break;
      const res = await linkIdentityToGuard(writer, { staffNoRaw: a.identity.staffNoNorm, nameRaw: a.identity.nameRaw }, plan.guardId);
      result.alias_added = res.aliasAdded;
      result.staff_no_added = res.staffNoAdded;
      const uploads = await prisma.rosterUpload.findMany({ where: { month, status: { in: ["parsed", "confirmed"] } }, select: { id: true } });
      let applied = 0;
      for (const u of uploads) {
        const hit = await prisma.rosterUploadRow.count({ where: { uploadId: u.id, nameRaw: a.identity.nameRaw, guardMatch: { in: ["unmatched", "ambiguous"] } } });
        if (hit === 0) continue;
        await reparseRosterUpload(u.id, { autoResolveSite: false });
        applied += await reconcileApplyOne(u.id, actor.userId, ip);
      }
      result.applied = applied;
      break;
    }
    default:
      break;
  }
  } catch (e) {
    await prisma.triageQuestion.updateMany({ where: { id: q.id, status: "applying" }, data: { status: "open" } });
    throw e;
  }

  await prisma.$transaction(async (tx) => {
    const n = await tx.triageQuestion.updateMany({
      where: { id: q.id, status: "applying" },
      data: { status: "answered", answerJson: JSON.parse(JSON.stringify(answer)), answeredBy: actor.userId, answeredAt: now, impactJson: JSON.parse(JSON.stringify(impact)), applyResultJson: JSON.parse(JSON.stringify(result)) },
    });
    if (n.count !== 1) throw Conflict("呢條問題已經答過，唔可以重複套用");
    await writeAuditTx(tx, { actorUserId: actor.userId, tableName: "triage_questions", rowId: q.id, action: "triage_answer", after: { session_id: q.sessionId, kind: q.kind, option: answer.option, writes: true, run_id: ev.runId, auto_source: `triage:${q.id}`, ...result }, ip });
  });
  const session_status = await refreshSessionStatus(q.sessionId);
  return { status: "answered", impact, session_status, open_remaining: await prisma.triageQuestion.count({ where: { sessionId: q.sessionId, status: "open" } }), result };
}
