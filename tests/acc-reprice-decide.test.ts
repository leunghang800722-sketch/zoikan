// 驗收修正（2026-09-26）：`src/lib/pricing/reprice.ts` `decideReprice()`
// 單元測試——純函數（同 pricing-resolve-rate.test.ts 一致手法，自建
// fixture 卡）。兩個模式：`full`（更表頁「重新計价」，覆蓋已有值）／
// `fill_and_fix_b07`（`runReconcileAllForMonth()` 開頭自動 reprice，
// 保守：淨係補 null，B07 例外）。
import { describe, it, expect } from "vitest";
import { decideReprice, type RepriceRecordInput, type RepriceLookups } from "@/lib/pricing/reprice";
import type { RateCardLite } from "@/lib/pricing/resolve-rate";

const SITE = "site-1";
const SHIFT_TYPE = "st-D";
const BROKER_NORMAL = "broker-normal";
const BROKER_B07 = "broker-b07";
const GUARD = "guard-1";

function card(overrides: Partial<RateCardLite>): RateCardLite {
  return {
    id: overrides.id ?? "card-default",
    shiftTypeId: null,
    brokerId: null,
    guardId: null,
    clientRate: null,
    guardWage: null,
    brokerFee: null,
    payoutRate: null,
    billingModel: "per_shift",
    effectiveFrom: new Date(Date.UTC(2026, 6, 1)),
    effectiveTo: null,
    source: null,
    ...overrides,
  };
}

function record(overrides: Partial<RepriceRecordInput> = {}): RepriceRecordInput {
  return {
    id: "rec-1",
    siteId: SITE,
    shiftTypeId: SHIFT_TYPE,
    guardId: GUARD,
    settlementBrokerId: BROKER_NORMAL,
    workDate: new Date(Date.UTC(2026, 7, 15)), // 2026-08-15
    isExternal: false,
    clientRateSnapshot: null,
    guardWageSnapshot: null,
    brokerFeeSnapshot: null,
    ...overrides,
  };
}

function lookups(overrides: Partial<RepriceLookups> = {}): RepriceLookups {
  return {
    brokerKindById: new Map([
      [BROKER_NORMAL, "broker"],
      [BROKER_B07, "internal_longterm"],
    ]),
    shiftTypeCodeById: new Map([[SHIFT_TYPE, "D"]]),
    shiftTypeBillingGroupById: new Map([[SHIFT_TYPE, "per_shift"]]),
    siteGuardsPaidByClientById: new Map([[SITE, false]]),
    ...overrides,
  };
}

describe("decideReprice() mode:full（更表頁「重新計价」，同 route.ts 原有行為一致）", () => {
  it("搵到卡就覆蓋——包括覆蓋緊已有值", () => {
    const cards = [card({ id: "c1", shiftTypeId: SHIFT_TYPE, clientRate: 999 })];
    const rec = record({ clientRateSnapshot: 500 });
    const d = decideReprice(rec, lookups(), cards, "full");
    expect(d.after.clientRate).toBe(999);
    expect(d.changed).toBe(true);
    expect(d.keptUnresolved).toBe(false);
  });

  it("搵唔到卡——保留原值，keptUnresolved=true", () => {
    const rec = record({ clientRateSnapshot: 500 });
    const d = decideReprice(rec, lookups(), [], "full");
    expect(d.after.clientRate).toBe(500);
    expect(d.changed).toBe(false);
    expect(d.keptUnresolved).toBe(true);
  });

  it("internal_longterm（B07）：wage/fee 永遠唔郁（neverRepriceWage）", () => {
    const cards = [card({ id: "c1", shiftTypeId: SHIFT_TYPE, brokerId: BROKER_B07, guardWage: 999, brokerFee: 999 })];
    const rec = record({ settlementBrokerId: BROKER_B07, guardWageSnapshot: 86607, brokerFeeSnapshot: 30 });
    const d = decideReprice(rec, lookups(), cards, "full");
    expect(d.after.guardWage).toBe(86607); // 保留原值，唔覆蓋
    expect(d.after.brokerFee).toBe(30);
  });

  it("驗收修正：fill_and_fix_b07 對 8 月前（7 月）記錄一律唔郁——null 收客價有卡都唔補、B07 舊 wage 都唔清", () => {
    const july = new Date(Date.UTC(2026, 6, 31));
    const cards = [card({ id: "c1", shiftTypeId: SHIFT_TYPE, clientRate: 100, guardWage: 90, brokerFee: 10 })];
    const d1 = decideReprice(record({ workDate: july }), lookups(), cards, "fill_and_fix_b07");
    expect(d1.after).toEqual(d1.before);
    expect(d1.changed).toBe(false);
    const d2 = decideReprice(record({ workDate: july, settlementBrokerId: BROKER_B07, guardWageSnapshot: 90, brokerFeeSnapshot: 10 }), lookups(), cards, "fill_and_fix_b07");
    expect(d2.after).toEqual(d2.before);
    expect(d2.changed).toBe(false);
    // 人手 full 模式唔受呢條影響
    const d3 = decideReprice(record({ workDate: july }), lookups(), cards, "full");
    expect(d3.after.clientRate).toBe(100);
  });

  it("guardsPaidByClient 嘅盤（LINK）完全唔掂", () => {
    const cards = [card({ id: "c1", shiftTypeId: SHIFT_TYPE, clientRate: 999, guardWage: 999, brokerFee: 999 })];
    const rec = record({ clientRateSnapshot: 500, guardWageSnapshot: 300, brokerFeeSnapshot: 10 });
    const d = decideReprice(rec, lookups({ siteGuardsPaidByClientById: new Map([[SITE, true]]) }), cards, "full");
    expect(d.after).toEqual(d.before);
    expect(d.changed).toBe(false);
  });
});

describe("decideReprice() mode:fill_and_fix_b07（reconcile-all 自動、保守）", () => {
  it("普通雞頭：clientRate 已有值——唔覆蓋（就算搵到唔同嘅卡）", () => {
    const cards = [card({ id: "c1", shiftTypeId: SHIFT_TYPE, clientRate: 999 })];
    const rec = record({ clientRateSnapshot: 500 });
    const d = decideReprice(rec, lookups(), cards, "fill_and_fix_b07");
    expect(d.after.clientRate).toBe(500);
    expect(d.changed).toBe(false);
  });

  it("普通雞頭：clientRate 係 null——補（搵到卡先補，搵唔到就繼續 null）", () => {
    const cards = [card({ id: "c1", shiftTypeId: SHIFT_TYPE, clientRate: 935.48 })];
    const rec = record({ clientRateSnapshot: null });
    const d = decideReprice(rec, lookups(), cards, "fill_and_fix_b07");
    expect(d.after.clientRate).toBe(935.48);
    expect(d.changed).toBe(true);
  });

  it("普通雞頭：guardWage/brokerFee 已有值——唔覆蓋", () => {
    const cards = [card({ id: "c1", shiftTypeId: SHIFT_TYPE, guardWage: 999, brokerFee: 99 })];
    const rec = record({ guardWageSnapshot: 600, brokerFeeSnapshot: 30 });
    const d = decideReprice(rec, lookups(), cards, "fill_and_fix_b07");
    expect(d.after.guardWage).toBe(600);
    expect(d.after.brokerFee).toBe(30);
    expect(d.changed).toBe(false);
  });

  it("B07（internal_longterm），8 月：guardWage 永遠 null——就算舊值非 null 都覆蓋（「B07 舊價」修正）", () => {
    const rec = record({ settlementBrokerId: BROKER_B07, guardWageSnapshot: 86607, brokerFeeSnapshot: 7240, workDate: new Date(Date.UTC(2026, 7, 15)) });
    const d = decideReprice(rec, lookups(), [], "fill_and_fix_b07");
    expect(d.after.guardWage).toBeNull();
    expect(d.after.brokerFee).toBeNull(); // 8 月起一律 null（referralAutoMonth）
    expect(d.changed).toBe(true);
  });

  it("B07，7 月（referralAutoMonth 之前）：fee 已有值——唔強制覆蓋，淨係補 null（同 7 月 gate 一致）", () => {
    const rec = record({ settlementBrokerId: BROKER_B07, guardWageSnapshot: null, brokerFeeSnapshot: 50, workDate: new Date(Date.UTC(2026, 6, 15)) }); // 2026-07-15
    const d = decideReprice(rec, lookups(), [], "fill_and_fix_b07");
    expect(d.after.guardWage).toBeNull(); // wage 任何月都 null（本身已經係 null，no-op）
    expect(d.after.brokerFee).toBe(50); // 7 月已有值保留，唔強制覆蓋
    expect(d.changed).toBe(false);
  });

  it("驗收修正：fill_and_fix_b07 對 8 月前（7 月）記錄一律唔郁——null 收客價有卡都唔補、B07 舊 wage 都唔清", () => {
    const july = new Date(Date.UTC(2026, 6, 31));
    const cards = [card({ id: "c1", shiftTypeId: SHIFT_TYPE, clientRate: 100, guardWage: 90, brokerFee: 10 })];
    const d1 = decideReprice(record({ workDate: july }), lookups(), cards, "fill_and_fix_b07");
    expect(d1.after).toEqual(d1.before);
    expect(d1.changed).toBe(false);
    const d2 = decideReprice(record({ workDate: july, settlementBrokerId: BROKER_B07, guardWageSnapshot: 90, brokerFeeSnapshot: 10 }), lookups(), cards, "fill_and_fix_b07");
    expect(d2.after).toEqual(d2.before);
    expect(d2.changed).toBe(false);
    // 人手 full 模式唔受呢條影響
    const d3 = decideReprice(record({ workDate: july }), lookups(), cards, "full");
    expect(d3.after.clientRate).toBe(100);
  });

  it("guardsPaidByClient 嘅盤（LINK）完全唔掂", () => {
    const rec = record({ clientRateSnapshot: null, guardWageSnapshot: null, brokerFeeSnapshot: null });
    const d = decideReprice(rec, lookups({ siteGuardsPaidByClientById: new Map([[SITE, true]]) }), [card({ id: "c1", shiftTypeId: SHIFT_TYPE, clientRate: 100, guardWage: 100, brokerFee: 10 })], "fill_and_fix_b07");
    expect(d.after).toEqual(d.before);
    expect(d.changed).toBe(false);
  });
});
