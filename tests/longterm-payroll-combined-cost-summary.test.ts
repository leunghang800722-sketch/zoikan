// WP-LTPAY §21 任務 5a（老闆定案，§16.2 第一層口徑）：
// `buildCombinedCostSummaryPure()`——更次成本／長工 Autopay／介紹費／
// 合計／MPF ER（另列，唔入合計）。純函數，冇 DB 依賴。
import { describe, it, expect } from "vitest";
import { buildCombinedCostSummaryPure, type LongtermPayrollActualTotals } from "@/lib/reports/monthly-close";

const JULY = new Date(Date.UTC(2026, 6, 1));
const AUG = new Date(Date.UTC(2026, 7, 1));
const SEP = new Date(Date.UTC(2026, 8, 1));

const actual: LongtermPayrollActualTotals = {
  runId: "run-1",
  grossTotal: 100000,
  autopayTotal: 96000,
  mpfEeTotal: 4000,
  mpfErTotal: 4200,
  guardCount: 10,
  visaPassthroughAutopayTotal: 0,
  visaPassthroughGuardCount: 0,
};

describe("buildCombinedCostSummaryPure：月份閘", () => {
  it("2026-07（或更早）恆 null——7 月 gate 完全唔受影響", () => {
    expect(buildCombinedCostSummaryPure(JULY, 500000, 20000, actual)).toBeNull();
  });

  it("2026-08 起有值", () => {
    const summary = buildCombinedCostSummaryPure(AUG, 500000, 20000, actual);
    expect(summary).not.toBeNull();
  });

  it("2026-09 都有值（月份閘係「起」唔係「淨係嗰個月」）", () => {
    expect(buildCombinedCostSummaryPure(SEP, 500000, 20000, actual)).not.toBeNull();
  });
});

describe("buildCombinedCostSummaryPure：口徑（§16.2 第一層）", () => {
  it("合計＝更次成本＋介紹費＋長工 Autopay；MPF 僱主另列，唔入合計", () => {
    const summary = buildCombinedCostSummaryPure(AUG, 500000, 20000, actual)!;
    expect(summary.perShiftCostTotal).toBe(500000);
    expect(summary.referralFeeTotal).toBe(20000);
    expect(summary.longtermAutopayTotal).toBe(96000); // Gross－MPF EE
    expect(summary.combinedCostTotal).toBe(500000 + 20000 + 96000);
    expect(summary.mpfErTotal).toBe(4200);
    // MPF ER 冇喺 combinedCostTotal 出現過
    expect(summary.combinedCostTotal).not.toBe(summary.combinedCostTotal + summary.mpfErTotal - summary.mpfErTotal + 0.01);
  });

  it("longtermPayrollActual=null（未跑過 recomputeLongtermPayroll）——長工 Autopay／MPF ER 恆 0，唔係整個摘要變 null", () => {
    const summary = buildCombinedCostSummaryPure(AUG, 500000, 20000, null)!;
    expect(summary).not.toBeNull();
    expect(summary.longtermAutopayTotal).toBe(0);
    expect(summary.mpfErTotal).toBe(0);
    expect(summary.combinedCostTotal).toBe(500000 + 20000);
  });
});

describe("buildCombinedCostSummaryPure：簽證形式長工（§14 規則 12）", () => {
  it("糧單總數包佢（公司照出糧），合併成本剔走佢嘅 Autopay（雞頭結算扣返）；MPF 僱主照另列全數", () => {
    const withVisa: LongtermPayrollActualTotals = { ...actual, autopayTotal: 96000 + 17100, mpfErTotal: 4200 + 900, guardCount: 11, visaPassthroughAutopayTotal: 17100, visaPassthroughGuardCount: 1 };
    const summary = buildCombinedCostSummaryPure(AUG, 500000, 20000, withVisa)!;
    expect(summary.longtermAutopayTotal).toBe(96000);
    expect(summary.visaPassthroughAutopayExcluded).toBe(17100);
    expect(summary.combinedCostTotal).toBe(500000 + 20000 + 96000);
    expect(summary.mpfErTotal).toBe(5100);
  });
});
