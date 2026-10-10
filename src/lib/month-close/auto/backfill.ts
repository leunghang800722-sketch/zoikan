// WP-POSTORDER-FREE（§34 A）：由 Postorder／一鍵自動卡一次過補齊正式價目卡。
//
// `backfillFromPostorder(month)` 掃該月：
//   (a) 仍然生效嘅 `auto:one-click:*` 價卡（一鍵結算自動建、未經人確認，下個月唔當來源）→ 每張卡（盤×更種×雞頭）一條題，
//       預填卡值，依據「一鍵自動卡」；
//   (b) 仍未定價、而 Postorder（本月最新已解析上載）有同盤同崗位價嘅組合 → 一條題，預填 Postorder 價，依據「Postorder 第 N 行」。
// 全部放入一個 triage session（source_type=postorder_backfill，source_ref=YYYY-MM），題型沿用 month_close_pricing
// （前端 MonthCloseTriageDialog 唔使改）。**唔自動寫入任何價**：答題確認先建卡（見 triage.ts 嘅 pricing_backfill）。
// 冪等：同組合已有（open／answered／skipped）題、或者已有非 auto 生效卡 → 唔出。
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { writeAuditTx } from "@/lib/audit";
import { BadRequest, Conflict } from "@/lib/api/errors";
import { monthRange } from "@/lib/reports/money";
import { LONGTERM_REFERRAL_AUTOCOMPUTE_FROM } from "@/lib/pricing/resolve-rate";
import { numOrNull } from "@/lib/pricing/reprice";
import { refreshSessionStatus } from "@/lib/triage/session";
import { AutoCollector } from "./context";
import { buildEnv, collectUnpricedGroups, describeValues, findPriceSource } from "./pricing";
import { optionsFor } from "./triage";
import type { McCandidate, McQuestionDraft, PriceValues, PricingGroupRef } from "./types";

export const BACKFILL_SOURCE_TYPE = "postorder_backfill";
const AUTO_PREFIX = "auto:one-click:";

export const backfillGroupKey = (ref: { siteId: string; shiftTypeId: string; brokerId: string | null }): string => `backfill:${ref.siteId}:${ref.shiftTypeId}:${ref.brokerId ?? "none"}`;
export const monthKeyOf = (month: Date): string => month.toISOString().slice(0, 7);

export interface BackfillResult {
  sessionId: string | null;
  /** 新出（或者由 superseded 重開）嘅題數。 */
  created: number;
  /** 組合已經有題（open／已答／已跳過）而唔重出。 */
  skippedExisting: number;
  /** 組合已有非 auto 生效卡而唔出。 */
  skippedHasCard: number;
  /** 一鍵自動卡但本月冇更次用，唔出。 */
  skippedNoRecords: number;
  fromAutoCards: number;
  fromPostorder: number;
  hasPostorder: boolean;
}

const sameBroker = (a: string | null, b: string | null): boolean => (a ?? null) === (b ?? null);

export async function backfillFromPostorder(ownerUserId: string, month: Date, ip: string | null): Promise<BackfillResult> {
  const { start, end } = monthRange(month);
  if (start < LONGTERM_REFERRAL_AUTOCOMPUTE_FROM) throw BadRequest("2026-08 之前嘅月份唔做價目卡補齊");
  const locked = await prisma.monthClose.findUnique({ where: { month: start } });
  if (locked?.lockedAt) throw Conflict("本月已鎖定，唔可以補齊價目卡（要改先由老闆解鎖）", { status: "locked" });

  const monthIso = start.toISOString().slice(0, 10);
  const ctx = new AutoCollector(null, start, ownerUserId, ip);
  const ev = await ctx.postorder();
  const out: BackfillResult = { sessionId: null, created: 0, skippedExisting: 0, skippedHasCard: 0, skippedNoRecords: 0, fromAutoCards: 0, fromPostorder: 0, hasPostorder: !!ev };

  const overlap: Prisma.RateCardWhereInput = { effectiveFrom: { lte: end }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: start } }] };
  const autoCards = await prisma.rateCard.findMany({
    where: { source: { startsWith: AUTO_PREFIX }, voidedAt: null, guardId: null, shiftTypeId: { not: null }, ...overlap },
    orderBy: [{ siteId: "asc" }, { createdAt: "asc" }],
  });
  const aggs = (await collectUnpricedGroups(month)).filter((a) => a.ref.brokerId !== null);
  const siteIds = [...new Set([...autoCards.map((c) => c.siteId), ...aggs.map((a) => a.ref.siteId)])];
  const [sites, shiftTypes, brokers, humanCardsRaw, recGroups] = await Promise.all([
    prisma.site.findMany({ where: { id: { in: siteIds } }, select: { id: true, canonicalName: true } }),
    prisma.shiftType.findMany({ where: { siteId: { in: siteIds } }, select: { id: true, code: true } }),
    ctx.brokers(),
    prisma.rateCard.findMany({ where: { siteId: { in: siteIds }, voidedAt: null, guardId: null, shiftTypeId: { not: null }, ...overlap }, select: { siteId: true, shiftTypeId: true, brokerId: true, source: true } }),
    prisma.shiftRecord.groupBy({ by: ["siteId", "shiftTypeId", "settlementBrokerId", "recordType"], where: { siteId: { in: siteIds }, status: { not: "cancelled" }, workDate: { gte: start, lte: end } }, _count: { _all: true } }),
  ]);
  const siteName = new Map(sites.map((s) => [s.id, s.canonicalName]));
  const stCode = new Map(shiftTypes.map((s) => [s.id, s.code]));
  const brokerCode = (id: string | null): string => brokers.find((b) => b.id === id)?.code ?? "?";
  const humanCards = humanCardsRaw.filter((c) => !(c.source ?? "").startsWith(AUTO_PREFIX));
  const hasHumanCard = (ref: { siteId: string; shiftTypeId: string; brokerId: string | null }): boolean => humanCards.some((c) => c.siteId === ref.siteId && c.shiftTypeId === ref.shiftTypeId && sameBroker(c.brokerId, ref.brokerId));
  const recCount = (siteId: string, stId: string, brokerId: string | null, recordType: string): number =>
    recGroups.filter((g) => g.siteId === siteId && g.shiftTypeId === stId && g.recordType === recordType && (brokerId === null || g.settlementBrokerId === brokerId)).reduce((a, g) => a + g._count._all, 0);

  const drafts: McQuestionDraft[] = [];
  const have = new Set<string>();
  const push = (d: McQuestionDraft): void => {
    if (have.has(d.groupKey)) return;
    have.add(d.groupKey);
    drafts.push(d);
  };

  // (a) 一鍵自動卡
  for (const c of autoCards) {
    if (c.billingModel !== null && c.billingModel !== "per_shift") continue;
    const stId = c.shiftTypeId!;
    const shiftN = recCount(c.siteId, stId, c.brokerId, "shift");
    const otN = recCount(c.siteId, stId, c.brokerId, "ot");
    const ot = otN > 0 && shiftN === 0;
    const count = ot ? otN : shiftN;
    const ref: PricingGroupRef = { siteId: c.siteId, shiftTypeId: stId, brokerId: c.brokerId, ot };
    if (count === 0) {
      out.skippedNoRecords++;
      continue;
    }
    if (hasHumanCard(ref)) {
      out.skippedHasCard++;
      continue;
    }
    const values: PriceValues = { clientRate: numOrNull(c.clientRate), guardWage: numOrNull(c.guardWage), brokerFee: numOrNull(c.brokerFee), payoutRate: numOrNull(c.payoutRate) };
    const needClient = values.clientRate !== null;
    const needPayout = values.guardWage !== null || values.brokerFee !== null || values.payoutRate !== null;
    const step = /次序\s*(\d)/.exec(c.note ?? "")?.[1];
    const evidence = `一鍵自動卡 ${c.id.slice(0, 8)}${step ? `（次序 ${step}）` : ""}：${(c.evidence ?? "").slice(0, 160)}`;
    const cand: McCandidate = { id: "c0", label: "一鍵自動卡嘅價", values, evidence };
    const site = siteName.get(c.siteId) ?? "";
    const code = stCode.get(stId) ?? stId.slice(0, 8);
    push({
      kind: "month_close_pricing",
      groupKey: backfillGroupKey(ref),
      sort: 30,
      title: `盤「${site}」${ot ? "OT " : ""}更種「${code}」${c.brokerId ? `雞頭 ${brokerCode(c.brokerId)}` : "（通用）"}：補齊價目卡（${count} 更，一鍵自動卡）`,
      evidence: {
        v: 1,
        mc: true,
        runId: "",
        month: monthIso,
        kind: "month_close_pricing",
        summary: `呢張價卡係一鍵結算自動建嘅（未經人確認，下個月唔會當來源）；確認後成為正式價目卡（本月 1 號起、無限期）並作廢自動卡，${count} 更價錢維持不變`,
        suggestion: `一鍵自動卡嘅價：${describeValues(values)}`,
        confidence: "propose",
        action: { type: "pricing", group: ref, needClient, needPayout, count, backfill: { source: "auto_card", autoCardId: c.id } },
        candidates: [cand],
        prefillCandidateId: cand.id,
      },
    });
    out.fromAutoCards++;
  }

  // (b) 未定價而 Postorder 有價
  if (ev && aggs.length > 0) {
    const env = await buildEnv(ctx, month, aggs);
    for (const a of aggs) {
      const key = backfillGroupKey(a.ref);
      if (have.has(key)) continue;
      if (hasHumanCard(a.ref)) {
        out.skippedHasCard++;
        continue;
      }
      const found = await findPriceSource(ctx, env, a.ref, a.need);
      const po = found.auto?.step === 2 ? found.auto : (found.proposals.find((p) => p.step === 2) ?? null);
      if (!po) continue;
      const cand: McCandidate = { id: "c0", label: "Postorder 價", values: po.values, evidence: po.evidence };
      const site = siteName.get(a.ref.siteId) ?? "";
      const code = stCode.get(a.ref.shiftTypeId) ?? a.ref.shiftTypeId.slice(0, 8);
      const needLabel = a.need.client && a.need.payout ? "客價＋出街價" : a.need.client ? "客價" : "出街價";
      push({
        kind: "month_close_pricing",
        groupKey: key,
        sort: 31,
        title: `盤「${site}」${a.ref.ot ? "OT " : ""}更種「${code}」雞頭 ${brokerCode(a.ref.brokerId)}：補齊價目卡（${a.recordIds.length} 更未定${needLabel}，Postorder 有價）`,
        evidence: {
          v: 1,
          mc: true,
          runId: "",
          month: monthIso,
          kind: "month_close_pricing",
          summary: `${a.recordIds.length} 更未定${needLabel}，Postorder 有同盤同崗位價（${po.evidence}）；確認後建正式價目卡（本月 1 號起、無限期）並補價`,
          suggestion: `Postorder 價：${describeValues(po.values)}`,
          confidence: "propose",
          action: { type: "pricing", group: a.ref, needClient: a.need.client, needPayout: a.need.payout, count: a.recordIds.length, backfill: { source: "postorder", autoCardId: null } },
          candidates: [cand],
          prefillCandidateId: cand.id,
        },
      });
      out.fromPostorder++;
    }
  }

  // session：一個月一個（source_ref=YYYY-MM）。
  const sourceRef = monthKeyOf(start);
  let session = await prisma.triageSession.findUnique({ where: { sourceType_sourceRef: { sourceType: BACKFILL_SOURCE_TYPE, sourceRef } } });
  if (!session && drafts.length === 0) return out;
  let createdSession = false;
  if (!session) {
    try {
      session = await prisma.triageSession.create({ data: { sourceType: BACKFILL_SOURCE_TYPE, sourceRef, ownerUserId, createdBy: ownerUserId, statsJson: {} } });
      createdSession = true;
    } catch (e) {
      if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002")) throw e;
      session = await prisma.triageSession.findUniqueOrThrow({ where: { sourceType_sourceRef: { sourceType: BACKFILL_SOURCE_TYPE, sourceRef } } });
    }
  }
  const prior = await prisma.triageQuestion.findMany({ where: { sessionId: session.id } });
  const priorByKey = new Map(prior.map((q) => [q.groupKey, q]));
  // 冇未答題嘅 session，再跑嘅人接手做擁有人（老闆照樣睇全部）。
  if (!createdSession && session.ownerUserId !== ownerUserId && !prior.some((q) => q.status === "open") && drafts.length > 0) {
    session = await prisma.triageSession.update({ where: { id: session.id }, data: { ownerUserId } });
  }
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
      out.created++;
    } else if (old.status === "superseded") {
      await prisma.triageQuestion.update({ where: { id: old.id }, data: { ...data, status: "open" } });
      out.created++;
    } else {
      out.skippedExisting++;
    }
  }
  const byKind: Record<string, number> = {};
  for (const g of await prisma.triageQuestion.groupBy({ by: ["kind"], where: { sessionId: session.id, status: { not: "superseded" } }, _count: { _all: true } })) byKind[g.kind] = g._count._all;
  const total = Object.values(byKind).reduce((a, b) => a + b, 0);
  await prisma.triageSession.update({ where: { id: session.id }, data: { statsJson: { total, by_kind: byKind }, lastAppliedAt: new Date() } });
  await refreshSessionStatus(session.id);
  if (createdSession) {
    await prisma.$transaction(async (tx) => {
      await writeAuditTx(tx, { actorUserId: ownerUserId, tableName: "triage_sessions", rowId: session!.id, action: "triage_session_create", after: { source_type: BACKFILL_SOURCE_TYPE, source_ref: sourceRef, owner_user_id: ownerUserId, new_questions: out.created, total_questions: total, by_kind: byKind }, ip });
    });
  }
  out.sessionId = session.id;
  return out;
}

/** 月結頁用：該月補齊 session 狀態（冇 session＝null）。 */
export async function backfillStatus(month: Date): Promise<{ sessionId: string; open: number; answered: number; skipped: number; total: number } | null> {
  const s = await prisma.triageSession.findUnique({ where: { sourceType_sourceRef: { sourceType: BACKFILL_SOURCE_TYPE, sourceRef: monthKeyOf(monthRange(month).start) } } });
  if (!s) return null;
  const g = await prisma.triageQuestion.groupBy({ by: ["status"], where: { sessionId: s.id }, _count: { _all: true } });
  const n = (st: string): number => g.find((x) => x.status === st)?._count._all ?? 0;
  return { sessionId: s.id, open: n("open"), answered: n("answered"), skipped: n("skipped"), total: n("open") + n("answered") + n("skipped") };
}
