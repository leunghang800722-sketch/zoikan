// WP-MIXED-BILLING（Opus 5.5 驗收）：開盤 plan／verify 共用嘅「月費盤逐更
// 收客卡」規則——同 src/lib/reports/mixed-billing.ts 報表口徑配套。
//
// 報表口徑：有 flat 收入嘅盤，淨係「逐更另收」嘅 per_shift 更種（有
// effective_from>=2026-08-01 嘅逐更收客卡）先加落收入。所以開盤 plan 唔可
// 以喺 flat 收入盤上面起「月費÷更數」倒算出嚟嘅逐更收客卡（8 月試算 E 值：
// IFC 853.66＝35,000÷41、淺水灣道11號蔚峰園 935.48＝29,000÷31、創富廠IC
// 1,050＝25,200÷24、九龍企業大廈 822.58、恆星樓 806.45）——否則 8 月會
// flat＋逐更雙重計。**唯一例外**係老闆明確拍板「月費＋逐更」嘅盤（見
// MIXED_BILLING_SITES）。
//
// 呢份名單要老闆拍板先加——唔可以因為試算 E 值 <5000 就當逐更另收。
export const MIXED_BILLING_SITES: ReadonlySet<string> = new Set([
  "控制室", // 老闆 2026-09-24 方案 (a)：月薪崗月費 22,000＋日薪崗逐更 840
]);

/** flat 收入盤判斷（開盤用，對某一日 `asOf`）：盤級 flat 卡覆蓋 `asOf`，或者 monthly_fixed＋monthly_fee（pro-rata fallback）。 */
export function siteHasFlatRevenue(
  site: { billingModel: string | null; monthlyFee: unknown },
  flatCards: { effectiveFrom: Date; effectiveTo: Date | null }[],
  asOf: Date,
): boolean {
  if (site.billingModel === "monthly_fixed" && site.monthlyFee !== null && site.monthlyFee !== undefined && Number(site.monthlyFee) > 0) return true;
  return flatCards.some((c) => c.effectiveFrom <= asOf && (c.effectiveTo === null || c.effectiveTo >= asOf));
}
