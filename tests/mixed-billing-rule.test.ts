// WP-MIXED-BILLING（Opus 5.5 驗收）：src/lib/reports/mixed-billing.ts 純函數
// ＋ unpriced.ts 對月費盤 per_shift 更種嘅「逐更另收／包喺月費」判斷。
import { describe, it, expect } from "vitest";
import { buildMixedBillingSiteInfo, isExplicitPerShiftClientCard, isExplicitPerShiftType, isMixedBillingMonth } from "@/lib/reports/mixed-billing";
import { computeUnpricedSummary, includedInSiteFlatFee, type UnpricedLookups } from "@/lib/pricing/unpriced";

const AUG1 = new Date(Date.UTC(2026, 7, 1));
const AUG31 = new Date(Date.UTC(2026, 7, 31));
const JUL1 = new Date(Date.UTC(2026, 6, 1));

function card(p: Partial<{ shiftTypeId: string | null; clientRate: number | null; billingModel: string | null; effectiveFrom: Date; effectiveTo: Date | null }>) {
  return { shiftTypeId: "st-n", clientRate: 840, billingModel: "per_shift", effectiveFrom: AUG1, effectiveTo: null, ...p };
}

describe("isExplicitPerShiftClientCard", () => {
  it("8 月起、client 非 null、per_shift 卡 → true", () => {
    expect(isExplicitPerShiftClientCard(card({}), AUG1, AUG31)).toBe(true);
    expect(isExplicitPerShiftClientCard(card({ billingModel: null }), AUG1, AUG31)).toBe(true);
  });
  it("7 月匯入／派生卡（effective_from=2026-07-01）→ false", () => {
    expect(isExplicitPerShiftClientCard(card({ effectiveFrom: JUL1 }), AUG1, AUG31)).toBe(false);
  });
  it("client null（淨係出街价卡）→ false", () => {
    expect(isExplicitPerShiftClientCard(card({ clientRate: null }), AUG1, AUG31)).toBe(false);
  });
  it("flat／special 卡 → false", () => {
    expect(isExplicitPerShiftClientCard(card({ billingModel: "monthly_fixed" }), AUG1, AUG31)).toBe(false);
    expect(isExplicitPerShiftClientCard(card({ billingModel: "special" }), AUG1, AUG31)).toBe(false);
  });
  it("唔覆蓋該月（已到期／未生效）→ false", () => {
    expect(isExplicitPerShiftClientCard(card({ effectiveTo: new Date(Date.UTC(2026, 6, 31)) }), AUG1, AUG31)).toBe(false);
    expect(isExplicitPerShiftClientCard(card({ effectiveFrom: new Date(Date.UTC(2026, 8, 1)) }), AUG1, AUG31)).toBe(false);
  });
  it("月份閘", () => {
    expect(isMixedBillingMonth(JUL1)).toBe(false);
    expect(isMixedBillingMonth(AUG1)).toBe(true);
  });
});

describe("buildMixedBillingSiteInfo／includedInSiteFlatFee", () => {
  it("控制室：flat 卡＋N 8 月 840 卡 → N 逐更另收、N-IC／其他更種包喺月費", () => {
    const info = buildMixedBillingSiteInfo({ billingModel: "per_shift", monthlyFee: null }, true, [card({})], AUG1, AUG31);
    expect(info.hasFlatRevenue).toBe(true);
    expect(isExplicitPerShiftType(info, "st-n")).toBe(true);
    expect(includedInSiteFlatFee(info, "st-n")).toBe(false);
    expect(includedInSiteFlatFee(info, "st-other")).toBe(true);
  });
  it("IFC：flat 卡、冇 8 月逐更收客卡 → 所有 per_shift 更種包喺月費", () => {
    const info = buildMixedBillingSiteInfo({ billingModel: "monthly_fixed", monthlyFee: 35000 }, true, [card({ effectiveFrom: JUL1, clientRate: 853.66 })], AUG1, AUG31);
    expect(includedInSiteFlatFee(info, "st-n")).toBe(true);
  });
  it("純逐更盤（冇 flat）→ 永遠唔包喺月費", () => {
    const info = buildMixedBillingSiteInfo({ billingModel: "per_shift", monthlyFee: null }, false, [], AUG1, AUG31);
    expect(info.hasFlatRevenue).toBe(false);
    expect(includedInSiteFlatFee(info, "st-n")).toBe(false);
  });
  it("monthly_fixed＋monthly_fee（pro-rata fallback）都算 flat 收入", () => {
    const info = buildMixedBillingSiteInfo({ billingModel: "monthly_fixed", monthlyFee: 17800 }, false, [], AUG1, AUG31);
    expect(info.hasFlatRevenue).toBe(true);
  });
  it("盤級通用（shift_type=null）8 月逐更收客卡 → 全部 per_shift 更種逐更另收", () => {
    const info = buildMixedBillingSiteInfo({ billingModel: "monthly_fixed", monthlyFee: null }, true, [card({ shiftTypeId: null })], AUG1, AUG31);
    expect(includedInSiteFlatFee(info, "anything")).toBe(false);
  });
});

describe("computeUnpricedSummary：8 月月費盤 per_shift 更種", () => {
  const rec = (siteId: string, shiftTypeId: string, client: number | null) => ({
    id: `${siteId}-${shiftTypeId}-${Math.random()}`,
    siteId,
    shiftTypeId,
    settlementBrokerId: "b-y",
    status: "confirmed",
    recordType: "shift",
    guardWageSnapshot: 800,
    brokerFeeSnapshot: 0,
    clientRateSnapshot: client,
    isExternal: false,
  });
  const lookups: UnpricedLookups = {
    brokerKindById: new Map([["b-y", "broker"]]),
    brokerCodeById: new Map([["b-y", "Y"]]),
    siteNameById: new Map([
      ["s-cr", "控制室"],
      ["s-ifc", "IFC"],
    ]),
    siteBillingModelById: new Map([
      ["s-cr", "per_shift"],
      ["s-ifc", "monthly_fixed"],
    ]),
    shiftTypeCodeById: new Map([
      ["st-n", "N"],
      ["st-d", "D"],
    ]),
    shiftTypeBillingGroupById: new Map([
      ["st-n", "per_shift"],
      ["st-d", "per_shift"],
    ]),
    siteGuardsPaidByClientById: new Map(),
    mixedBillingInfoBySiteId: new Map([
      ["s-cr", buildMixedBillingSiteInfo({ billingModel: "per_shift", monthlyFee: null }, true, [card({})], AUG1, AUG31)],
      ["s-ifc", buildMixedBillingSiteInfo({ billingModel: "monthly_fixed", monthlyFee: 35000 }, true, [], AUG1, AUG31)],
    ]),
  };
  it("控制室日薪崗冇 client snapshot → client_unpriced；IFC D 冇 client snapshot → 唔報", () => {
    const summary = computeUnpricedSummary([rec("s-cr", "st-n", null), rec("s-ifc", "st-d", null)], lookups, { month: AUG1 });
    expect(summary.clientCount).toBe(1);
    expect(summary.groups.map((g) => [g.site_name, g.category])).toEqual([["控制室", "client_unpriced"]]);
  });
});
