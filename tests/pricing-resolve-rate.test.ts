// WP-PRICE：計价 resolver 單元測試——淨係測純函數
// `resolveShiftPricingFromCards()`／`isUnpricedShift()`（唔碰 DB，用自建
// fixture 卡），涵蓋優先次序、日期邊界、拆分／合計口徑、external／
// longterm／leave／ot、冇卡。
import { describe, it, expect } from "vitest";
import { resolveShiftPricingFromCards, isUnpricedShift, isClientUnpricedShift, type RateCardLite, type ResolveShiftPricingInput } from "@/lib/pricing/resolve-rate";

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
    // M1：預設 per_shift（逐更卡）——需要測試 monthly_fixed/admin_fee/
    // special 嘅盤級/更別級「總額」卡唔可以誤畀逐更 resolver 揀中，逐個
    // overrides 指定 billingModel。
    billingModel: "per_shift",
    effectiveFrom: new Date(Date.UTC(2026, 6, 1)),
    effectiveTo: null,
    ...overrides,
  };
}

function baseInput(overrides: Partial<ResolveShiftPricingInput> = {}): ResolveShiftPricingInput {
  return {
    siteId: "site-1",
    shiftTypeId: SITE_SHIFT_TYPE,
    shiftTypeCode: "N",
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

  it("只有 guard_wage（broker_fee／payout_rate 皆 null）→ guardWage=guard_wage、brokerFee=null（gate:pricing 對 7 月數據驗證：呢種情況 broker_fee_snapshot 一律係 null，唔係 0——同下面「只有 payout_rate」嗰種 0 唔可以混為一談）", () => {
    const cards: RateCardLite[] = [card({ id: "c1", clientRate: 800, guardWage: 700 })];
    const result = resolveShiftPricingFromCards(cards, baseInput());
    expect(result.guardWage).toBe(700);
    expect(result.brokerFee).toBeNull();
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
  it("external（brokerKind=external）：收客价／出街价都 null，unpriced=false，reason=external（gate:pricing 對 7 月 286 條 external 記錄驗證：client_rate_snapshot 100% null，公司唔開單俾客戶自己嘅人）", () => {
    const cards: RateCardLite[] = [card({ id: "c1", clientRate: 800, guardWage: 700, brokerFee: 50 })];
    const result = resolveShiftPricingFromCards(cards, baseInput({ brokerKind: "external", isExternal: true }));
    expect(result.clientRate).toBeNull();
    expect(result.guardWage).toBeNull();
    expect(result.brokerFee).toBeNull();
    expect(result.unpriced).toBe(false);
    expect(result.reason).toBe("external");
  });

  it("is_external=true 就算 brokerKind 唔係 external 都當 external 處理（收客价都 null）", () => {
    const cards: RateCardLite[] = [card({ id: "c1", clientRate: 800, guardWage: 700, brokerFee: 50 })];
    const result = resolveShiftPricingFromCards(cards, baseInput({ brokerKind: "broker", isExternal: true }));
    expect(result.clientRate).toBeNull();
    expect(result.guardWage).toBeNull();
    expect(result.reason).toBe("external");
  });

  it("internal_longterm、冇任何出街价卡：收客价照計，出街价 null（月薪 autopay），unpriced=false，reason=longterm", () => {
    const cards: RateCardLite[] = [card({ id: "c1", clientRate: 800 })];
    const result = resolveShiftPricingFromCards(cards, baseInput({ brokerKind: "internal_longterm" }));
    expect(result.clientRate).toBe(800);
    expect(result.guardWage).toBeNull();
    expect(result.brokerFee).toBeNull();
    expect(result.unpriced).toBe(false);
    expect(result.reason).toBe("longterm");
  });

  it("internal_longterm、雞頭有純介紹費卡（gate:pricing 對 7 月數據驗證）：長工月薪 autopay 唔經卡出糧（wage 保持 null），但雞頭轉介費（broker_fee）照計，unpriced=false", () => {
    const cards: RateCardLite[] = [card({ id: "client-card", clientRate: 800 }), card({ id: "referral-fee-card", brokerId: BROKER_K, brokerFee: 30 })];
    const result = resolveShiftPricingFromCards(cards, baseInput({ brokerKind: "internal_longterm" }));
    expect(result.clientRate).toBe(800);
    expect(result.guardWage).toBeNull();
    expect(result.brokerFee).toBe(30);
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

describe("resolveShiftPricingFromCards：M1 billing_model 過濾（月費／admin_fee／special 卡唔可以做逐更 snapshot）", () => {
  it("更別級 special 卡（例：Event Guard $11,700）唔可以當逐更收客价——冇 per_shift 卡就 unpriced", () => {
    const cards: RateCardLite[] = [
      card({ id: "event-guard-special", shiftTypeId: SITE_SHIFT_TYPE, clientRate: 11700, billingModel: "special" }),
    ];
    const result = resolveShiftPricingFromCards(cards, baseInput());
    expect(result.clientRate).toBeNull();
    expect(result.source.clientCardId).toBeUndefined();
  });

  it("site 級 monthly_fixed/admin_fee flat 卡（三個 FK 皆空）唔可以當逐更收客价", () => {
    const cards: RateCardLite[] = [
      card({ id: "monthly-flat", clientRate: 19804, billingModel: "monthly_fixed" }),
      card({ id: "admin-flat", clientRate: 25200, billingModel: "admin_fee" }),
    ];
    const result = resolveShiftPricingFromCards(cards, baseInput());
    expect(result.clientRate).toBeNull();
  });

  it("有 per_shift 卡就照常揀（月費卡唔影響 per_shift 卡照選）", () => {
    const cards: RateCardLite[] = [
      card({ id: "monthly-flat", clientRate: 19804, billingModel: "monthly_fixed" }),
      card({ id: "normal", clientRate: 500, guardWage: 300, brokerFee: 20, billingModel: "per_shift" }),
    ];
    const result = resolveShiftPricingFromCards(cards, baseInput());
    expect(result.clientRate).toBe(500);
    expect(result.source.clientCardId).toBe("normal");
  });

  it("billing_model 未填（null，向下相容）當 per_shift 睇待", () => {
    const cards: RateCardLite[] = [card({ id: "legacy", clientRate: 500, guardWage: 300, brokerFee: 20, billingModel: null })];
    const result = resolveShiftPricingFromCards(cards, baseInput());
    expect(result.clientRate).toBe(500);
  });
});

describe("resolveShiftPricingFromCards：收客价 broker-agnostic fallback（gate:pricing 對 7 月數據驗證）", () => {
  it("冇夾到結算雞頭嘅收客价卡——擴大搜尋，唔理張卡掛咗邊個雞頭（例：啟航1331 D 更收客价卡掛咗喺 K 雞頭，但 B07 長工做呢個更別都係收返同一個價）", () => {
    const cards: RateCardLite[] = [
      card({ id: "K-card", shiftTypeId: SITE_SHIFT_TYPE, brokerId: "broker-K-other", clientRate: 1200, guardWage: 820, brokerFee: 60 }),
    ];
    const result = resolveShiftPricingFromCards(cards, baseInput({ settlementBrokerId: "broker-B07", brokerKind: "internal_longterm" }));
    expect(result.clientRate).toBe(1200); // 收客价：擴大搜尋揾到
    expect(result.guardWage).toBeNull(); // 出街价：longterm 本身唔计
  });

  it("夾到結算雞頭嘅卡就優先用（唔使擴大搜尋）", () => {
    const cards: RateCardLite[] = [
      card({ id: "K-card", shiftTypeId: SITE_SHIFT_TYPE, brokerId: BROKER_K, clientRate: 1200 }),
      card({ id: "generic-card", shiftTypeId: SITE_SHIFT_TYPE, clientRate: 999 }),
    ];
    const result = resolveShiftPricingFromCards(cards, baseInput());
    expect(result.clientRate).toBe(1200);
    expect(result.source.clientCardId).toBe("K-card");
  });
});

describe("resolveShiftPricingFromCards：code=PR（糧明細生成 reconciliation placeholder）唔可以夾泛用卡（gate:pricing 對 7 月數據驗證）", () => {
  it("shiftTypeCode='PR'：guard/broker 专属但 shift_type_id=null 嘅泛用卡唔會夾中——unpriced", () => {
    const cards: RateCardLite[] = [
      card({ id: "guard-flat", guardId: GUARD_A, clientRate: 800, guardWage: 700, brokerFee: 50 }), // shiftTypeId: null（泛用）
    ];
    const result = resolveShiftPricingFromCards(cards, baseInput({ shiftTypeCode: "PR" }));
    expect(result.clientRate).toBeNull();
    expect(result.guardWage).toBeNull();
    expect(result.unpriced).toBe(true);
  });

  it("shiftTypeCode='PR'：有張卡直接掛咗呢個 shift_type_id 就照樣夾中（唔係完全唔用卡，淨係唔可以用泛用卡）", () => {
    const cards: RateCardLite[] = [
      card({ id: "guard-flat", guardId: GUARD_A, clientRate: 800, guardWage: 700, brokerFee: 50 }), // 泛用，唔應該中
      card({ id: "exact-pr", shiftTypeId: SITE_SHIFT_TYPE, clientRate: 900, guardWage: 800, brokerFee: 60 }),
    ];
    const result = resolveShiftPricingFromCards(cards, baseInput({ shiftTypeCode: "PR" }));
    expect(result.clientRate).toBe(900);
    expect(result.source.clientCardId).toBe("exact-pr");
  });

  it("普通 shiftTypeCode（非 PR）：泛用卡照舊夾中（冇改壞正常情況）", () => {
    const cards: RateCardLite[] = [card({ id: "guard-flat", guardId: GUARD_A, clientRate: 800, guardWage: 700, brokerFee: 50 })];
    const result = resolveShiftPricingFromCards(cards, baseInput({ shiftTypeCode: "N" }));
    expect(result.clientRate).toBe(800);
  });
});

describe("resolveShiftPricingFromCards：S2 出街价取值規則", () => {
  it("guard_wage 有值、broker_fee null（就算 payout_rate 有值）→ fee=null（gate:pricing 推翻咗『payout_rate−guard_wage』反推：guard 专属卡好多時 payout_rate 純粹等於 guard_wage，冇拆開嘅歷史遺留，逐差得出 0 同 7 月實際 broker_fee_snapshot=null 唔一致）", () => {
    const cards: RateCardLite[] = [card({ id: "c1", clientRate: 800, guardWage: 690, payoutRate: 750 })];
    const result = resolveShiftPricingFromCards(cards, baseInput());
    expect(result.guardWage).toBe(690);
    expect(result.brokerFee).toBeNull();
  });

  it("純介紹費卡（guard_wage null、broker_fee 有值）→ wage=null、fee=broker_fee（唔當工資）", () => {
    const cards: RateCardLite[] = [card({ id: "c1", clientRate: 800, brokerFee: 45 })];
    const result = resolveShiftPricingFromCards(cards, baseInput());
    expect(result.guardWage).toBeNull();
    expect(result.brokerFee).toBe(45);
    expect(result.unpriced).toBe(false);
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

  it("S3：wage=0 且 fee=null → true（未定价，唔止兩者皆 null 先算）", () => {
    expect(isUnpricedShift({ recordType: "shift", status: "confirmed", guardWageSnapshot: 0, brokerFeeSnapshot: null }, "broker")).toBe(true);
  });

  it("S3：wage=0 但 fee 有值 → false（純介紹費卡嘅正常狀態）", () => {
    expect(isUnpricedShift({ recordType: "shift", status: "confirmed", guardWageSnapshot: 0, brokerFeeSnapshot: 45 }, "broker")).toBe(false);
  });
});

describe("isClientUnpricedShift（S3：收客价未定，淨係逐更盤先算）", () => {
  it("per_shift 盤，client_rate_snapshot null → true", () => {
    expect(isClientUnpricedShift({ recordType: "shift", status: "confirmed", clientRateSnapshot: null }, "per_shift")).toBe(true);
  });

  it("per_shift 盤，client_rate_snapshot 有值 → false", () => {
    expect(isClientUnpricedShift({ recordType: "shift", status: "confirmed", clientRateSnapshot: 500 }, "per_shift")).toBe(false);
  });

  it("非逐更盤（monthly_fixed/admin_fee/special），client_rate_snapshot null 屬正常 → false", () => {
    expect(isClientUnpricedShift({ recordType: "shift", status: "confirmed", clientRateSnapshot: null }, "monthly_fixed")).toBe(false);
    expect(isClientUnpricedShift({ recordType: "shift", status: "confirmed", clientRateSnapshot: null }, "admin_fee")).toBe(false);
    expect(isClientUnpricedShift({ recordType: "shift", status: "confirmed", clientRateSnapshot: null }, "special")).toBe(false);
  });

  it("cancelled／leave/ot → false", () => {
    expect(isClientUnpricedShift({ recordType: "shift", status: "cancelled", clientRateSnapshot: null }, "per_shift")).toBe(false);
    expect(isClientUnpricedShift({ recordType: "leave", status: "confirmed", clientRateSnapshot: null }, "per_shift")).toBe(false);
  });
});
