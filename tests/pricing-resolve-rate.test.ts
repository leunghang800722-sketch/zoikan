// WP-PRICE：計价 resolver 單元測試——淨係測純函數
// `resolveShiftPricingFromCards()`／`isUnpricedShift()`（唔碰 DB，用自建
// fixture 卡），涵蓋優先次序、日期邊界、拆分／合計口徑、external／
// longterm／leave／ot、冇卡。
import { describe, it, expect } from "vitest";
import { resolveShiftPricingFromCards, isUnpricedShift, type RateCardLite, type ResolveShiftPricingInput } from "@/lib/pricing/resolve-rate";

const SITE_SHIFT_TYPE = "shiftType-N";
const BROKER_K = "broker-K";
const GUARD_A = "guard-A";
const DAY = new Date(Date.UTC(2026, 7, 15)); // 2026-08-15

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
    effectiveFrom: new Date(Date.UTC(2026, 6, 1)),
    effectiveTo: null,
    ...overrides,
  };
}

function baseInput(overrides: Partial<ResolveShiftPricingInput> = {}): ResolveShiftPricingInput {
  return {
    siteId: "site-1",
    shiftTypeId: SITE_SHIFT_TYPE,
    settlementBrokerId: BROKER_K,
    brokerKind: "broker",
    guardId: GUARD_A,
    workDate: DAY,
    isExternal: false,
    recordType: "shift",
    ...overrides,
  };
}

describe("resolveShiftPricingFromCards：優先次序", () => {
  it("guard 专属 + 同 shift_type 卡 > 雞頭专属卡 > 通用卡", () => {
    const cards: RateCardLite[] = [
      card({ id: "generic", clientRate: 500, guardWage: 300, brokerFee: 20 }),
      card({ id: "broker", brokerId: BROKER_K, clientRate: 600, guardWage: 400, brokerFee: 30 }),
      card({ id: "guard", guardId: GUARD_A, shiftTypeId: SITE_SHIFT_TYPE, clientRate: 700, guardWage: 500, brokerFee: 40 }),
    ];
    const result = resolveShiftPricingFromCards(cards, baseInput());
    expect(result.clientRate).toBe(700);
    expect(result.guardWage).toBe(500);
    expect(result.brokerFee).toBe(40);
    expect(result.source).toEqual({ clientCardId: "guard", payoutCardId: "guard" });
    expect(result.unpriced).toBe(false);
  });

  it("雞頭专属卡 > 通用卡（冇 guard 专属卡嘅情況下）", () => {
    const cards: RateCardLite[] = [
      card({ id: "generic", clientRate: 500, guardWage: 300, brokerFee: 20 }),
      card({ id: "broker", brokerId: BROKER_K, clientRate: 600, guardWage: 400, brokerFee: 30 }),
    ];
    const result = resolveShiftPricingFromCards(cards, baseInput());
    expect(result.source.clientCardId).toBe("broker");
    expect(result.clientRate).toBe(600);
  });

  it("同一級入面，同 shift_type 对应嘅卡 > shift_type=null 嘅盘级卡", () => {
    const cards: RateCardLite[] = [
      card({ id: "flat", clientRate: 500, guardWage: 300, brokerFee: 20 }),
      card({ id: "shift-type-specific", shiftTypeId: SITE_SHIFT_TYPE, clientRate: 650, guardWage: 350, brokerFee: 25 }),
    ];
    const result = resolveShiftPricingFromCards(cards, baseInput());
    expect(result.source.clientCardId).toBe("shift-type-specific");
    expect(result.clientRate).toBe(650);
  });

  it("卡嘅 broker_id/guard_id/shift_type_id 同輸入唔夾——完全唔選（唔會夾錯人）", () => {
    const cards: RateCardLite[] = [
      card({ id: "other-broker", brokerId: "broker-other", clientRate: 999, guardWage: 999, brokerFee: 0 }),
      card({ id: "other-guard", guardId: "guard-other", clientRate: 999, guardWage: 999, brokerFee: 0 }),
      card({ id: "other-shift-type", shiftTypeId: "shiftType-other", clientRate: 999, guardWage: 999, brokerFee: 0 }),
      card({ id: "ok", clientRate: 100, guardWage: 60, brokerFee: 5 }),
    ];
    const result = resolveShiftPricingFromCards(cards, baseInput());
    expect(result.source.clientCardId).toBe("ok");
    expect(result.clientRate).toBe(100);
  });
});

describe("resolveShiftPricingFromCards：日期邊界", () => {
  it("effective_to 當日仍然生效", () => {
    const cards: RateCardLite[] = [
      card({ id: "c1", clientRate: 100, guardWage: 60, brokerFee: 5, effectiveFrom: new Date(Date.UTC(2026, 6, 1)), effectiveTo: DAY }),
    ];
    const result = resolveShiftPricingFromCards(cards, baseInput());
    expect(result.clientRate).toBe(100);
  });

  it("effective_to 翌日唔再生效（unpriced）", () => {
    const dayAfter = new Date(Date.UTC(2026, 6, 1));
    const effectiveTo = new Date(Date.UTC(2026, 7, 14)); // DAY 前一日
    const cards: RateCardLite[] = [card({ id: "c1", clientRate: 100, guardWage: 60, brokerFee: 5, effectiveFrom: dayAfter, effectiveTo })];
    const result = resolveShiftPricingFromCards(cards, baseInput());
    expect(result.clientRate).toBeNull();
    expect(result.guardWage).toBeNull();
    expect(result.unpriced).toBe(true);
  });

  it("effective_to = null 代表無限期，任何未來日子都生效", () => {
    const farFuture = new Date(Date.UTC(2030, 0, 1));
    const cards: RateCardLite[] = [card({ id: "c1", clientRate: 100, guardWage: 60, brokerFee: 5, effectiveFrom: new Date(Date.UTC(2026, 6, 1)), effectiveTo: null })];
    const result = resolveShiftPricingFromCards(cards, baseInput({ workDate: farFuture }));
    expect(result.clientRate).toBe(100);
  });

  it("effective_from 之前唔生效", () => {
    const cards: RateCardLite[] = [
      card({ id: "c1", clientRate: 100, guardWage: 60, brokerFee: 5, effectiveFrom: new Date(Date.UTC(2026, 8, 1)), effectiveTo: null }),
    ];
    const result = resolveShiftPricingFromCards(cards, baseInput());
    expect(result.clientRate).toBeNull();
    expect(result.unpriced).toBe(true);
  });
});

describe("resolveShiftPricingFromCards：出街价拆分／合計口徑", () => {
  it("guard_wage 且 broker_fee 都非 null → 照拆", () => {
    const cards: RateCardLite[] = [card({ id: "c1", clientRate: 800, guardWage: 690, brokerFee: 60 })];
    const result = resolveShiftPricingFromCards(cards, baseInput());
    expect(result.guardWage).toBe(690);
    expect(result.brokerFee).toBe(60);
  });

  it("只有 payout_rate（guard_wage/broker_fee 皆 null）→ guardWage=payout_rate、brokerFee=0", () => {
    const cards: RateCardLite[] = [card({ id: "c1", clientRate: 800, payoutRate: 750 })];
    const result = resolveShiftPricingFromCards(cards, baseInput());
    expect(result.guardWage).toBe(750);
    expect(result.brokerFee).toBe(0);
  });

  it("只有 guard_wage（broker_fee／payout_rate 皆 null）→ guardWage=guard_wage、brokerFee=0", () => {
    const cards: RateCardLite[] = [card({ id: "c1", clientRate: 800, guardWage: 700 })];
    const result = resolveShiftPricingFromCards(cards, baseInput());
    expect(result.guardWage).toBe(700);
    expect(result.brokerFee).toBe(0);
  });

  it("收客价卡同出街价卡可以係唔同嘅兩張（各自揀最具體嗰張）", () => {
    const cards: RateCardLite[] = [
      card({ id: "client-only", clientRate: 900 }),
      card({ id: "payout-only", guardWage: 700, brokerFee: 50 }),
    ];
    const result = resolveShiftPricingFromCards(cards, baseInput());
    expect(result.clientRate).toBe(900);
    expect(result.guardWage).toBe(700);
    expect(result.brokerFee).toBe(50);
    expect(result.source).toEqual({ clientCardId: "client-only", payoutCardId: "payout-only" });
  });
});

describe("resolveShiftPricingFromCards：external／longterm／leave／ot／冇卡", () => {
  it("external（brokerKind=external）：收客价照計，出街价 null，unpriced=false，reason=external", () => {
    const cards: RateCardLite[] = [card({ id: "c1", clientRate: 800, guardWage: 700, brokerFee: 50 })];
    const result = resolveShiftPricingFromCards(cards, baseInput({ brokerKind: "external", isExternal: true }));
    expect(result.clientRate).toBe(800);
    expect(result.guardWage).toBeNull();
    expect(result.brokerFee).toBeNull();
    expect(result.unpriced).toBe(false);
    expect(result.reason).toBe("external");
  });

  it("is_external=true 就算 brokerKind 唔係 external 都當 external 處理", () => {
    const cards: RateCardLite[] = [card({ id: "c1", clientRate: 800, guardWage: 700, brokerFee: 50 })];
    const result = resolveShiftPricingFromCards(cards, baseInput({ brokerKind: "broker", isExternal: true }));
    expect(result.guardWage).toBeNull();
    expect(result.reason).toBe("external");
  });

  it("internal_longterm：收客价照計，出街价 null（月薪 autopay），unpriced=false，reason=longterm", () => {
    const cards: RateCardLite[] = [card({ id: "c1", clientRate: 800, guardWage: 700, brokerFee: 50 })];
    const result = resolveShiftPricingFromCards(cards, baseInput({ brokerKind: "internal_longterm" }));
    expect(result.clientRate).toBe(800);
    expect(result.guardWage).toBeNull();
    expect(result.brokerFee).toBeNull();
    expect(result.unpriced).toBe(false);
    expect(result.reason).toBe("longterm");
  });

  it("冇结算雞頭（settlementBrokerId=null）：只計收客价，出街 unpriced=true，reason=no_broker", () => {
    const cards: RateCardLite[] = [card({ id: "c1", clientRate: 800, guardWage: 700, brokerFee: 50 })];
    const result = resolveShiftPricingFromCards(cards, baseInput({ settlementBrokerId: null, brokerKind: null }));
    expect(result.clientRate).toBe(800);
    expect(result.guardWage).toBeNull();
    expect(result.unpriced).toBe(true);
    expect(result.reason).toBe("no_broker");
  });

  it("leave：全 null，unpriced=false", () => {
    const cards: RateCardLite[] = [card({ id: "c1", clientRate: 800, guardWage: 700, brokerFee: 50 })];
    const result = resolveShiftPricingFromCards(cards, baseInput({ recordType: "leave" }));
    expect(result).toEqual({ clientRate: null, guardWage: null, brokerFee: null, source: {}, unpriced: false });
  });

  it("ot：全 null，unpriced=false（按鐘計留返報表層）", () => {
    const cards: RateCardLite[] = [card({ id: "c1", clientRate: 800, guardWage: 700, brokerFee: 50 })];
    const result = resolveShiftPricingFromCards(cards, baseInput({ recordType: "ot" }));
    expect(result).toEqual({ clientRate: null, guardWage: null, brokerFee: null, source: {}, unpriced: false });
  });

  it("完全冇卡：兩邊都 null，unpriced=true，冇 reason", () => {
    const result = resolveShiftPricingFromCards([], baseInput());
    expect(result.clientRate).toBeNull();
    expect(result.guardWage).toBeNull();
    expect(result.brokerFee).toBeNull();
    expect(result.unpriced).toBe(true);
    expect(result.reason).toBeUndefined();
  });
});

describe("isUnpricedShift", () => {
  it("shift + 非 cancelled + wage/fee 皆 null + 普通 broker → true", () => {
    expect(isUnpricedShift({ recordType: "shift", status: "confirmed", guardWageSnapshot: null, brokerFeeSnapshot: null }, "broker")).toBe(true);
  });

  it("有 wage 或 fee 任何一個有值 → false", () => {
    expect(isUnpricedShift({ recordType: "shift", status: "confirmed", guardWageSnapshot: 700, brokerFeeSnapshot: null }, "broker")).toBe(false);
    expect(isUnpricedShift({ recordType: "shift", status: "confirmed", guardWageSnapshot: null, brokerFeeSnapshot: 50 }, "broker")).toBe(false);
  });

  it("cancelled → false（作廢咗唔算未定价）", () => {
    expect(isUnpricedShift({ recordType: "shift", status: "cancelled", guardWageSnapshot: null, brokerFeeSnapshot: null }, "broker")).toBe(false);
  });

  it("leave/ot → false（唔係 shift）", () => {
    expect(isUnpricedShift({ recordType: "leave", status: "confirmed", guardWageSnapshot: null, brokerFeeSnapshot: null }, "broker")).toBe(false);
    expect(isUnpricedShift({ recordType: "ot", status: "confirmed", guardWageSnapshot: null, brokerFeeSnapshot: null }, "broker")).toBe(false);
  });

  it("internal_longterm／external → false（月薪／唔係成本，正常冇 wage/fee）", () => {
    expect(isUnpricedShift({ recordType: "shift", status: "confirmed", guardWageSnapshot: null, brokerFeeSnapshot: null }, "internal_longterm")).toBe(false);
    expect(isUnpricedShift({ recordType: "shift", status: "confirmed", guardWageSnapshot: null, brokerFeeSnapshot: null }, "external")).toBe(false);
  });

  it("internal_cash／null broker kind，wage/fee 皆 null → true（真係缺价）", () => {
    expect(isUnpricedShift({ recordType: "shift", status: "confirmed", guardWageSnapshot: null, brokerFeeSnapshot: null }, "internal_cash")).toBe(true);
    expect(isUnpricedShift({ recordType: "shift", status: "confirmed", guardWageSnapshot: null, brokerFeeSnapshot: null }, null)).toBe(true);
  });
});
