// WP-AI-DIAG（§37.3）：`GET /api/month-close/one-click` 背後嘅讀取邏輯抽出嚟，route 同助手 `one_click_status` 工具共用
// （route 行為不變：同樣 where／orderBy／take 20）。純讀。
// P3-1.6：加摘要版（唔讀 steps_json／report_json）同單一 run 版；`oneClickRunToDTO` 係舊版列表每個 run 嘅完整 shape。
import { prisma } from "@/lib/db";
import type { MonthCloseRun } from "@prisma/client";
import { monthCloseRunStalled } from "@/lib/month-close/one-click";

export async function findOneClickRuns(month: Date | null, take = 20) {
  return prisma.monthCloseRun.findMany({
    where: month ? { month } : undefined,
    orderBy: { startedAt: "desc" },
    take,
  });
}

export async function findOneClickRunById(id: string) {
  return prisma.monthCloseRun.findUnique({ where: { id } });
}

/** 舊版（`include=full`）每個 run 嘅 shape——key／次序不變。 */
export function oneClickRunToDTO(r: MonthCloseRun) {
  return {
    id: r.id,
    month: r.month.toISOString().slice(0, 10),
    status: r.status,
    started_at: r.startedAt.toISOString(),
    finished_at: r.finishedAt?.toISOString() ?? null,
    current_step: r.currentStep,
    stalled: monthCloseRunStalled(r),
    steps: r.stepsJson,
    report: r.reportJson,
    error_message: r.errorMessage,
  };
}

interface SummaryRow {
  id: string;
  month: Date;
  status: MonthCloseRun["status"];
  startedAt: Date;
  finishedAt: Date | null;
  applyStartedAt: Date | null;
  currentStep: string | null;
  errorMessage: string | null;
  stepsTotal: number | null;
  stepsDone: number | null;
  totalsRevenue: string | null;
  totalsCost: string | null;
  totalsGrossMargin: string | null;
}

/** 摘要版：唔讀整份 steps_json／report_json，jsonb 運算喺 DB 側做。 */
export async function findOneClickRunSummaries(month: Date | null, take = 20): Promise<SummaryRow[]> {
  const rows = await prisma.$queryRaw<
    Array<{
      id: string;
      month: Date;
      status: MonthCloseRun["status"];
      started_at: Date;
      finished_at: Date | null;
      apply_started_at: Date | null;
      current_step: string | null;
      error_message: string | null;
      steps_total: number | null;
      steps_done: number | null;
      totals_revenue: string | null;
      totals_cost: string | null;
      totals_gross_margin: string | null;
    }>
  >`
    SELECT id, month, status::text AS status, started_at, finished_at, apply_started_at, current_step, error_message,
      CASE WHEN jsonb_typeof(steps_json) = 'array' THEN jsonb_array_length(steps_json) ELSE 0 END AS steps_total,
      CASE WHEN jsonb_typeof(steps_json) = 'array'
        THEN (SELECT count(*)::int FROM jsonb_array_elements(steps_json) s WHERE s->>'status' IN ('done', 'skipped'))
        ELSE 0 END AS steps_done,
      report_json->'totals'->>'revenue' AS totals_revenue,
      report_json->'totals'->>'cost' AS totals_cost,
      report_json->'totals'->>'gross_margin' AS totals_gross_margin
    FROM month_close_runs
    WHERE (${month}::date IS NULL OR month = ${month}::date)
    ORDER BY started_at DESC
    LIMIT ${take}
  `;
  return rows.map((r) => ({
    id: r.id,
    month: r.month,
    status: r.status,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    applyStartedAt: r.apply_started_at,
    currentStep: r.current_step,
    errorMessage: r.error_message,
    stepsTotal: r.steps_total,
    stepsDone: r.steps_done,
    totalsRevenue: r.totals_revenue,
    totalsCost: r.totals_cost,
    totalsGrossMargin: r.totals_gross_margin,
  }));
}

const num = (v: string | null): number | null => (v === null || v === undefined ? null : Number(v));

/** 摘要欄：id、month、status、current_step、started_at、finished_at、stalled、error_message，
 * 另加 steps_total／steps_done 同 totals（revenue／cost／gross_margin，無報告時 null）。 */
export function oneClickRunSummaryToDTO(r: SummaryRow) {
  return {
    id: r.id,
    month: r.month.toISOString().slice(0, 10),
    status: r.status,
    started_at: r.startedAt.toISOString(),
    finished_at: r.finishedAt?.toISOString() ?? null,
    current_step: r.currentStep,
    stalled: monthCloseRunStalled({ status: r.status, applyStartedAt: r.applyStartedAt }),
    error_message: r.errorMessage,
    steps_total: r.stepsTotal ?? 0,
    steps_done: r.stepsDone ?? 0,
    totals: r.totalsRevenue === null && r.totalsCost === null && r.totalsGrossMargin === null ? null : { revenue: num(r.totalsRevenue), cost: num(r.totalsCost), gross_margin: num(r.totalsGrossMargin) },
  };
}
