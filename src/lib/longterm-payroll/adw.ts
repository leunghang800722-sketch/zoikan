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

export interface EoAdwResult {
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
      wages += d.wages * factor;
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
