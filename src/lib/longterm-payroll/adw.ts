// P19b（老闆 2026-10-15）：離職月年假補償嘅「平均工資」（ADW）——按《僱傭條例》第 2(3) 條自動計，純函數（冇 DB）。
//
// 期間＝離職日前 12 個月（離職日當日計入，即 離職日-12 個月+1 日 → 離職日）；服務期短過 12 個月就由服務起點計。
// 分子＝期間內工資（net_basic＋OT＋津貼，已扣走無薪假／無薪法定假／病假日嘅工資；唔計年假補償、4/5 病假津貼、人手扣款）；
// 分母＝期間日曆日 − 不獲全薪日子（NPL／NPSH／病假日）。
// 期間內有月份系統冇糧線 → 該月用「合約月薪（全月）／日曆日」補入，並標 historyIncomplete（呢個情況下實際年假補償仍用月薪÷當月日數，見 resolveAlDailyRate）。
import { addMonths, daysInMonth, diffDaysInclusive } from "./compute";
import { round2 } from "@/lib/reports/money";

type AdwBasis = "imported" | "computed_eo" | "fallback_monthly";
/** 持久化到 longterm_payroll_lines.al_daily_rate_basis 嘅值（manual_amount＝會計人手輸入整筆年假補償金額，唔經平均工資）。 */
export type AlDailyRateBasis = AdwBasis | "manual_amount";

export interface AdwMonthData {
  /** 該月工資（已扣走不獲全薪日子嘅工資；唔含年假補償、病假津貼、人手扣款）。 */
  wages: number;
  /** 其中加班費（已包含喺 wages 入面；P19b.4 按勞工處口徑決定整體計唔計）。 */
  ot?: number;
  /** 該月不獲全薪日子（NPL／NPSH／病假日）。 */
  disregardedDays: number;
}

export interface EoAdwInput {
  serviceStart: Date;
  leaveDate: Date;
  /** key＝YYYY-MM（月份）；冇 key＝系統冇該月糧線。 */
  monthData: Record<string, AdwMonthData | undefined>;
  /** 糧線缺失月份補入用：該月合約月薪（全月）。 */
  monthlySalaryForMonth: (monthStart: Date) => number;
}

/** 加班費計入規則（勞工處平均工資定義）：固定性質（期內每月都有）或每月平均 ≥ 同期每月平均工資（不含加班費）20% → 全部計入，否則全部剔除。 */
export interface OtRule {
  included: boolean;
  reason: "constant" | "ge_20pct" | "excluded";
  avgOt: number;
  avgWagesExOt: number;
  /** 不含 OT 工資 ≤0 時 null（無法計算比率）。 */
  ratio: number | null;
  monthsWithOt: number;
  monthsCounted: number;
}

/** entries＝期間內有糧線嘅月份；factor＝該月喺期間內日子比例（邊界月 <1）；periodMonths＝期間日數÷(365/12)。 */
export function evaluateOtRule(entries: Array<{ wages: number; ot?: number; factor?: number }>, periodMonths?: number): OtRule {
  const rows = entries.map((e) => ({ f: e.factor ?? 1, ot: Math.max(0, e.ot ?? 0), wages: e.wages })).filter((e) => e.f > 0);
  const monthsCounted = rows.length;
  const denom = periodMonths && periodMonths > 0 ? periodMonths : monthsCounted;
  const totalOt = rows.reduce((a, m) => a + m.ot * m.f, 0);
  const totalExOt = rows.reduce((a, m) => a + (m.wages - m.ot) * m.f, 0);
  const monthsWithOt = rows.filter((m) => m.ot > 0).length;
  const avgOt = denom ? totalOt / denom : 0;
  const avgWagesExOt = denom ? totalExOt / denom : 0;
  const ratio = avgWagesExOt > 0 ? avgOt / avgWagesExOt : null;
  // 固定性質：期間內每個有糧線月份都有加班費；只得 1 個月唔判固定（規劃者保守取捨，待老闆確認），仍可按 20% 計。
  const constant = monthsCounted >= 2 && monthsWithOt === monthsCounted;
  const ge20 = avgOt > 0 && (ratio === null || ratio >= 0.2 - 1e-9);
  const reason: OtRule["reason"] = constant ? "constant" : ge20 ? "ge_20pct" : "excluded";
  return { included: reason !== "excluded", reason, avgOt: round2(avgOt), avgWagesExOt: round2(avgWagesExOt), ratio: ratio === null ? null : Math.round(ratio * 10000) / 10000, monthsWithOt, monthsCounted };
}

export interface EoAdwResult {
  otRule: OtRule;
  adw: number;
  basis: AdwBasis;
  periodFrom: string;
  periodTo: string;
  /** 分母（期間日曆日 − 不獲全薪日子）。 */
  daysCounted: number;
  disregardedDays: number;
  wages: number;
  historyIncomplete: boolean;
  monthsMissing: string[];
}

const DAY = 86400000;
const isoDay = (d: Date): string => d.toISOString().slice(0, 10);
const monthKey = (d: Date): string => d.toISOString().slice(0, 7);
const maxDate = (a: Date, b: Date): Date => (a.getTime() >= b.getTime() ? a : b);
const minDate = (a: Date, b: Date): Date => (a.getTime() <= b.getTime() ? a : b);

/** 期間起點：離職日 −12 個月 +1 日；短過 12 個月就由服務起點。 */
export function eoPeriodFrom(serviceStart: Date, leaveDate: Date): Date {
  const twelve = new Date(addMonths(leaveDate, -12).getTime() + DAY);
  return maxDate(twelve, serviceStart);
}

/** 期間內有幾多個（日曆）月份要糧線；供 loader 決定查邊幾個月。 */
export function eoPeriodMonths(serviceStart: Date, leaveDate: Date): Date[] {
  const from = eoPeriodFrom(serviceStart, leaveDate);
  const out: Date[] = [];
  let cur = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1));
  while (cur.getTime() <= leaveDate.getTime()) {
    out.push(cur);
    cur = new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth() + 1, 1));
  }
  return out;
}

export function computeEoAdw(input: EoAdwInput): EoAdwResult {
  const { serviceStart, leaveDate } = input;
  const from = eoPeriodFrom(serviceStart, leaveDate);
  const otEntries: Array<{ wages: number; ot?: number; factor: number }> = [];
  let periodDays = 0;
  for (const ms of eoPeriodMonths(serviceStart, leaveDate)) {
    const dim = daysInMonth(ms.getUTCFullYear(), ms.getUTCMonth() + 1);
    const empStart = maxDate(ms, serviceStart);
    const empEnd = minDate(new Date(Date.UTC(ms.getUTCFullYear(), ms.getUTCMonth(), dim)), leaveDate);
    if (empStart.getTime() > empEnd.getTime()) continue;
    const clipDays = diffDaysInclusive(maxDate(empStart, from), empEnd);
    periodDays += clipDays;
    const d = input.monthData[monthKey(ms)];
    if (d) otEntries.push({ wages: d.wages, ot: d.ot, factor: clipDays / diffDaysInclusive(empStart, empEnd) });
  }
  const otRule = evaluateOtRule(otEntries, periodDays / (365 / 12));
  let wages = 0;
  let disregarded = 0;
  let calendarDays = 0;
  const monthsMissing: string[] = [];
  for (const ms of eoPeriodMonths(serviceStart, leaveDate)) {
    const dim = daysInMonth(ms.getUTCFullYear(), ms.getUTCMonth() + 1);
    const monthEnd = new Date(Date.UTC(ms.getUTCFullYear(), ms.getUTCMonth(), dim));
    // 該月在職日子（服務起點／離職日截斷）；期間邊界月再截斷一次，工資按日比例攤。
    const empStart = maxDate(ms, serviceStart);
    const empEnd = minDate(monthEnd, leaveDate);
    if (empStart.getTime() > empEnd.getTime()) continue;
    const clipStart = maxDate(empStart, from);
    const employedDays = diffDaysInclusive(empStart, empEnd);
    const clipDays = diffDaysInclusive(clipStart, empEnd);
    const factor = clipDays / employedDays;
    calendarDays += clipDays;
    const key = monthKey(ms);
    const d = input.monthData[key];
    if (d) {
      wages += (d.wages - (d.ot ?? 0) + (otRule.included ? Math.max(0, d.ot ?? 0) : 0)) * factor;
      disregarded += d.disregardedDays * factor;
    } else {
      monthsMissing.push(key);
      wages += (input.monthlySalaryForMonth(ms) * clipDays) / dim; // 合約月薪（全月）按日曆日比例補入
    }
  }
  const daysCounted = round2(calendarDays - disregarded);
  const incomplete = monthsMissing.length > 0;
  const adw = daysCounted > 0 ? round2(wages / daysCounted) : 0;
  return {
    otRule,
    adw,
    basis: incomplete ? "fallback_monthly" : "computed_eo",
    periodFrom: isoDay(from),
    periodTo: isoDay(leaveDate),
    daysCounted,
    disregardedDays: round2(disregarded),
    wages: round2(wages),
    historyIncomplete: incomplete,
    monthsMissing,
  };
}

export interface AlDailyRateResolution {
  /** 年假補償用嘅日薪；manual_amount 時為 null（整筆金額人手輸入）。 */
  rate: number | null;
  basis: AlDailyRateBasis;
  /** 需要會計確認（導航卡）：用咗月薪÷當月日數，或 EO 自動計但歷史唔齊。 */
  needsConfirm: boolean;
}

/**
 * 優先次序：人手金額 ＞ guard_avg_wages 該月記錄 ＞ EO 自動計（期間完整先用）＞ 月薪÷當月日數。
 * EO 結果歷史唔齊（或無法計，null）→ 維持現行月薪÷當月日數，要出導航卡。
 */
export function resolveAlDailyRate(input: { manualAmount: number | null | undefined; imported: number | null | undefined; eo: EoAdwResult | null; monthlyFallback: number }): AlDailyRateResolution {
  if (input.manualAmount != null) return { rate: null, basis: "manual_amount", needsConfirm: false };
  if (input.imported != null) return { rate: input.imported, basis: "imported", needsConfirm: false };
  if (input.eo && !input.eo.historyIncomplete && input.eo.daysCounted > 0 && input.eo.adw > 0) return { rate: input.eo.adw, basis: "computed_eo", needsConfirm: false };
  return { rate: input.monthlyFallback, basis: "fallback_monthly", needsConfirm: true };
}
