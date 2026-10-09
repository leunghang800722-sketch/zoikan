// WP-ONE-CLICK-AUTO（§31.3 E）：報告「自動處理摘要」＋「要你睇」。
import { prisma } from "@/lib/db";
import { monthRange } from "@/lib/reports/money";
import type { AutoCollector } from "./context";
import { upsertMonthCloseTriage } from "./triage";
import type { AutoReport, AutoSummary, ReviewItem } from "./types";

/** 本月更數（shift_records，非 cancelled，record_type=shift）分三堆：客戶自己人（external）／公司兵／其餘（計數更次）。 */
export async function computeShiftCounts(month: Date): Promise<AutoSummary["counts"]> {
  const { start, end } = monthRange(month);
  const rows = await prisma.shiftRecord.findMany({
    where: { recordType: "shift", status: { not: "cancelled" }, workDate: { gte: start, lte: end } },
    select: { isExternal: true, settlementBroker: { select: { kind: true } } },
  });
  let external = 0;
  let internalCash = 0;
  let countable = 0;
  for (const r of rows) {
    if (r.isExternal || r.settlementBroker?.kind === "external") external++;
    else {
      countable++;
      if (r.settlementBroker?.kind === "internal_cash") internalCash++;
    }
  }
  return { countable, external, internalCash };
}

/** 收尾：數更數、開／刷新分診 session（擁有人＝撳一鍵嗰個人），砌 `report.auto`。 */
export async function buildAutoReport(ctx: AutoCollector, month: Date, runId: string): Promise<AutoReport> {
  ctx.summary.counts = await computeShiftCounts(month);
  const triage = await upsertMonthCloseTriage(runId, ctx.actorUserId, ctx.questions, ctx.ip);
  let ids = new Map<string, string>();
  if (triage.sessionId) {
    const qs = await prisma.triageQuestion.findMany({ where: { sessionId: triage.sessionId, status: "open" }, select: { id: true, groupKey: true } });
    ids = new Map(qs.map((q) => [q.groupKey, q.id]));
  }
  const review: ReviewItem[] = ctx.questions.map((d) => ({ kind: d.kind, text: d.evidence.summary, confidence: d.evidence.confidence, questionId: ids.get(d.groupKey) ?? null }));
  return { summary: ctx.summary, autoLines: ctx.autoLines, review, triageSessionId: triage.sessionId, undone: false, undoneAt: null };
}
