// P19b：離職者平均工資待確認——讀最新未作廢 run 嘅離職者糧線（al_daily_rate_basis／al_adw_json，原生 SQL），
// 揀出「系統用咗月薪÷當月日數（fallback_monthly），或 EO 自動計但歷史唔齊」而會計仲未輸入平均工資嘅人。
// 唯讀。含姓名／工號（只喺頁面用）；通知／precheck 只用數字。
import { prisma } from "@/lib/db";
import { monthRange, monthLabel, round2 } from "@/lib/reports/money";
import type { LeaverAdwInfo } from "./aggregate";

const LEAVER_ADW_SOURCE_PREFILL = "終止僱傭合約薪酬計算表";

interface LeaverAdwPendingItem {
  guard_id: string;
  guard_name: string;
  guard_staff_no: string | null;
  month: string;
  leave_date: string;
  basis: string;
  /** 系統用咗嘅日薪（月薪÷當月日數）。 */
  daily_rate_used: number | null;
  /** 按條例補入缺失月份後嘅建議平均工資（參考，唔係已確認）。 */
  suggested_adw: number | null;
  history_incomplete: boolean;
  /** 有冇做過條例自動計（日薪制為 false）。 */
  eo_computed: boolean;
  months_missing: string[];
  balance_days: number;
  /** 該月已有 guard_avg_wages 記錄但仲未重算本月套用。 */
  saved_awaiting_recompute: boolean;
  saved_avg_daily_wage: number | null;
  advice: string;
}

export interface LeaverAdwPendingResult {
  month: string;
  items: LeaverAdwPendingItem[];
  /** 待輸入（未有 guard_avg_wages 記錄）人數。 */
  pending_count: number;
  /** 已輸入平均工資、等重算套用人數。 */
  awaiting_recompute_count: number;
  source_prefill: string;
}

interface Row {
  guard_id: string;
  basis: string;
  adw: LeaverAdwInfo | null;
  name_zh: string;
  staff_no: string | null;
  staff_no_mw: string | null;
}

export async function listLeaverAdwPending(month: Date): Promise<LeaverAdwPendingResult> {
  const { start } = monthRange(month);
  const label = monthLabel(start);
  const run = await prisma.longtermPayrollRun.findFirst({ where: { month: start, voidedAt: null, status: { not: "void" } }, orderBy: { createdAt: "desc" }, select: { id: true } });
  const empty: LeaverAdwPendingResult = { month: label, items: [], pending_count: 0, awaiting_recompute_count: 0, source_prefill: LEAVER_ADW_SOURCE_PREFILL };
  if (!run) return empty;
  const rows = await prisma.$queryRaw<Row[]>`
    SELECT l.guard_id AS guard_id, l.al_daily_rate_basis AS basis, l.al_adw_json AS adw, g.name_zh AS name_zh, g.staff_no AS staff_no, g.staff_no_mw AS staff_no_mw
    FROM longterm_payroll_lines l JOIN guards g ON g.id = l.guard_id
    WHERE l.run_id = ${run.id} AND l.al_daily_rate_basis IN ('fallback_monthly', 'computed_eo')
    ORDER BY l.created_at ASC`;
  const candidates = rows.filter((r) => r.adw?.needsConfirm);
  if (!candidates.length) return empty;
  const saved = await prisma.guardAvgWage.findMany({ where: { guardId: { in: candidates.map((r) => r.guard_id) }, month: start, voidedAt: null }, select: { guardId: true, avgDailyWage: true } });
  const savedByGuard = new Map(saved.map((s) => [s.guardId, Number(s.avgDailyWage)]));
  const items: LeaverAdwPendingItem[] = candidates.map((r) => {
    const adw = r.adw!;
    const savedWage = savedByGuard.get(r.guard_id) ?? null;
    return {
      guard_id: r.guard_id,
      guard_name: r.name_zh,
      guard_staff_no: r.staff_no ?? r.staff_no_mw ?? null,
      month: label,
      leave_date: adw.leaveDate,
      basis: r.basis,
      daily_rate_used: adw.rateUsed != null ? round2(adw.rateUsed) : null,
      suggested_adw: adw.eo && adw.eo.daysCounted > 0 && adw.eo.adw > 0 ? adw.eo.adw : null,
      history_incomplete: !!adw.eo?.historyIncomplete,
      eo_computed: !!adw.eo,
      months_missing: adw.eo?.monthsMissing ?? [],
      balance_days: adw.balanceDays,
      saved_awaiting_recompute: savedWage != null,
      saved_avg_daily_wage: savedWage,
      advice: savedWage != null ? "已輸入平均工資，撳「重算本月」套用" : "用「終止僱傭合約薪酬計算表」嘅平均工資輸入，再重算本月",
    };
  });
  return {
    month: label,
    items,
    pending_count: items.filter((i) => !i.saved_awaiting_recompute).length,
    awaiting_recompute_count: items.filter((i) => i.saved_awaiting_recompute).length,
    source_prefill: LEAVER_ADW_SOURCE_PREFILL,
  };
}
