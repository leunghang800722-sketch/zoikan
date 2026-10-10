// WP-PRICE：計價 resolver 單元測試——淨係測純函數
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
    source: null,
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

describe("resolveShiftPricingFromCards：出街價拆分／合計口徑", () => {
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

  it("收客價卡同出街價卡可以係唔同嘅兩張（各自揀最具體嗰張）", () => {
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
  it("external（brokerKind=external）：收客價／出街價都 null，unpriced=false，reason=external（gate:pricing 對 7 月 286 條 external 記錄驗證：client_rate_snapshot 100% null，公司唔開單俾客戶自己嘅人）", () => {
    const cards: RateCardLite[] = [card({ id: "c1", clientRate: 800, guardWage: 700, brokerFee: 50 })];
    const result = resolveShiftPricingFromCards(cards, baseInput({ brokerKind: "external", isExternal: true }));
    expect(result.clientRate).toBeNull();
    expect(result.guardWage).toBeNull();
    expect(result.brokerFee).toBeNull();
    expect(result.unpriced).toBe(false);
    expect(result.reason).toBe("external");
  });

  it("is_external=true 就算 brokerKind 唔係 external 都當 external 處理（收客價都 null）", () => {
    const cards: RateCardLite[] = [card({ id: "c1", clientRate: 800, guardWage: 700, brokerFee: 50 })];
    const result = resolveShiftPricingFromCards(cards, baseInput({ brokerKind: "broker", isExternal: true }));
    expect(result.clientRate).toBeNull();
    expect(result.guardWage).toBeNull();
    expect(result.reason).toBe("external");
  });

  it("internal_longterm、冇任何出街價卡：收客價照計，出街價 null（月薪 autopay），unpriced=false，reason=longterm", () => {
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
    // 驗收（Opus 5.5）：用 7 月日子——8 月起 B07 broker_fee 唔寫（見下一條）。
    const result = resolveShiftPricingFromCards(cards, baseInput({ brokerKind: "internal_longterm", workDate: new Date("2026-07-15T00:00:00.000Z") }));
    expect(result.clientRate).toBe(800);
    expect(result.guardWage).toBeNull();
    expect(result.brokerFee).toBe(30);
    expect(result.unpriced).toBe(false);
    expect(result.reason).toBe("longterm");
  });

  it("驗收（Opus 5.5）：internal_longterm 8 月起——guard_wage 一律 null（就算揀中張卡有外判價），broker_fee 都唔寫（介紹費改由 recomputeReferralFees 計，避免重複）", () => {
    const cards: RateCardLite[] = [card({ id: "client-card", clientRate: 800 }), card({ id: "payout-card", brokerId: BROKER_K, guardWage: 850, brokerFee: 30 })];
    const aug = resolveShiftPricingFromCards(cards, baseInput({ brokerKind: "internal_longterm", workDate: new Date("2026-08-10T00:00:00.000Z") }));
    expect(aug.clientRate).toBe(800);
    expect(aug.guardWage).toBeNull();
    expect(aug.brokerFee).toBeNull();
    expect(aug.reason).toBe("longterm");
    const jul = resolveShiftPricingFromCards(cards, baseInput({ brokerKind: "internal_longterm", workDate: new Date("2026-07-10T00:00:00.000Z") }));
    expect(jul.guardWage).toBeNull();
    expect(jul.brokerFee).toBe(30);
  });

  it("冇结算雞頭（settlementBrokerId=null）：只計收客價，出街 unpriced=true，reason=no_broker", () => {
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
    expect(result).toEqual({ clientRate: null, guardWage: null, brokerFee: null, source: {}, unpriced: false, clientCardFound: false, payoutCardFound: false });
  });

  it("ot：冇卡就全 null（WP-MIXED-BILLING 之前嘅口徑，冇卡冇 snapshot＝未定價 OT，見 unpriced.ts）", () => {
    const result = resolveShiftPricingFromCards([], baseInput({ recordType: "ot" }));
    expect(result).toEqual({ clientRate: null, guardWage: null, brokerFee: null, source: {}, unpriced: true, clientCardFound: false, payoutCardFound: false });
  });

  it("Opus 5.5 驗收：OT 記錄唔准配 shift_type=null 嘅盤級／雞頭級正更卡（例：HKU座頭 OT1＋W 雞頭 7 月正更卡 700／620）", () => {
    const cards: RateCardLite[] = [
      card({ id: "site-generic", clientRate: 700, guardWage: 620 }),
      card({ id: "broker-generic", brokerId: BROKER_K, clientRate: 700, guardWage: 620 }),
      card({ id: "guard-generic", guardId: GUARD_A, guardWage: 650 }),
    ];
    const result = resolveShiftPricingFromCards(cards, baseInput({ recordType: "ot" }));
    expect(result.clientRate).toBeNull();
    expect(result.guardWage).toBeNull();
    expect(result.brokerFee).toBeNull();
  });

  it("WP-MIXED-BILLING（老闆 2026-09-24 答：OT 冇統一公式，OT 记录行同 shift 一樣嘅卡揀邏輯）：OT 更種有卡就照用，1 個鐘嘅 OT 同「每條記錄」睇落一樣（WP-BOSS5 §25.1：卡金額每小時價 × otHours=1）", () => {
    const cards: RateCardLite[] = [card({ id: "c1", shiftTypeId: SITE_SHIFT_TYPE, clientRate: 800, guardWage: 700, brokerFee: 50 })];
    const result = resolveShiftPricingFromCards(cards, baseInput({ recordType: "ot", otHours: 1 }));
    expect(result).toEqual({
      clientRate: 800,
      guardWage: 700,
      brokerFee: 50,
      source: { clientCardId: "c1", payoutCardId: "c1" },
      unpriced: false,
      clientCardFound: true,
      payoutCardFound: true,
    });
  });

  describe("WP-BOSS5 §25.1（老闆 2026-09-28 決定 1）：OT 卡金額＝每小時價，揀到卡之後乘 otHours——淨係 workDate>=2026-08-01 生效", () => {
    it("2.5 個鐘 OT：client／guardWage／brokerFee 各乘 2.5（round2）", () => {
      const cards: RateCardLite[] = [card({ id: "c1", shiftTypeId: SITE_SHIFT_TYPE, clientRate: 84.85, guardWage: 73, brokerFee: 10.33 })];
      const result = resolveShiftPricingFromCards(cards, baseInput({ recordType: "ot", otHours: 2.5 }));
      expect(result.clientRate).toBe(212.13); // 84.85*2.5=212.125 → round2 212.13
      expect(result.guardWage).toBe(182.5);
      expect(result.brokerFee).toBe(25.83); // 10.33*2.5=25.825 → round2 25.83
      expect(result.unpriced).toBe(false);
    });

    it("otHours 冇傳（undefined）：揾到卡都當未定價 OT，三欄 null，unpriced=true", () => {
      const cards: RateCardLite[] = [card({ id: "c1", shiftTypeId: SITE_SHIFT_TYPE, clientRate: 800, guardWage: 700, brokerFee: 50 })];
      const result = resolveShiftPricingFromCards(cards, baseInput({ recordType: "ot" }));
      expect(result.clientRate).toBeNull();
      expect(result.guardWage).toBeNull();
      expect(result.brokerFee).toBeNull();
      expect(result.unpriced).toBe(true);
      expect(result.reason).toBe("ot_hours_missing");
    });

    it("otHours=0：一樣當未定價 OT，唔可以當「0 個鐘＝0 蚊」", () => {
      const cards: RateCardLite[] = [card({ id: "c1", shiftTypeId: SITE_SHIFT_TYPE, clientRate: 800, guardWage: 700, brokerFee: 50 })];
      const result = resolveShiftPricingFromCards(cards, baseInput({ recordType: "ot", otHours: 0 }));
      expect(result.clientRate).toBeNull();
      expect(result.unpriced).toBe(true);
    });

    it("7 月（workDate < 2026-08-01）：唔乘，OT 卡金額原樣寫入 snapshot（7 月口徑不變，gate:pricing 對住）", () => {
      const cards: RateCardLite[] = [card({ id: "c1", shiftTypeId: SITE_SHIFT_TYPE, clientRate: 84.85, guardWage: 73, brokerFee: 10 })];
      const result = resolveShiftPricingFromCards(cards, baseInput({ recordType: "ot", otHours: 3.5, workDate: new Date("2026-07-15T00:00:00.000Z") }));
      expect(result.clientRate).toBe(84.85);
      expect(result.guardWage).toBe(73);
      expect(result.brokerFee).toBe(10);
      expect(result.unpriced).toBe(false);
    });

    it("揾唔到卡（本身已經全 null）：otHours 冇傳都維持原狀，唔會將 reason 蓋做 ot_hours_missing", () => {
      const result = resolveShiftPricingFromCards([], baseInput({ recordType: "ot" }));
      expect(result.clientRate).toBeNull();
      expect(result.unpriced).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    it("external OT：維持 external 口徑（全 null，reason=external），唔會俾 otHours 邏輯覆蓋", () => {
      const cards: RateCardLite[] = [card({ id: "c1", shiftTypeId: SITE_SHIFT_TYPE, clientRate: 800, guardWage: 700, brokerFee: 50 })];
      const result = resolveShiftPricingFromCards(cards, baseInput({ recordType: "ot", brokerKind: "external", isExternal: true, otHours: 2 }));
      expect(result.clientRate).toBeNull();
      expect(result.reason).toBe("external");
    });
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
  it("更別級 special 卡（例：Event Guard $11,700）唔可以當逐更收客價——冇 per_shift 卡就 unpriced", () => {
    const cards: RateCardLite[] = [
      card({ id: "event-guard-special", shiftTypeId: SITE_SHIFT_TYPE, clientRate: 11700, billingModel: "special" }),
    ];
    const result = resolveShiftPricingFromCards(cards, baseInput());
    expect(result.clientRate).toBeNull();
    expect(result.source.clientCardId).toBeUndefined();
  });

  it("site 級 monthly_fixed/admin_fee flat 卡（三個 FK 皆空）唔可以當逐更收客價", () => {
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

  it("WP-MIXED-BILLING（控制室例子）：monthly_fixed 盤嘅 per_shift 更種（日薪崗）照樣配到逐更收客卡 840，唔畀 site flat 卡（22000）蓋過", () => {
    const cards: RateCardLite[] = [
      card({ id: "flat-22000", clientRate: 22000, billingModel: "monthly_fixed" }), // 盤級 flat 卡（月薪崗，唔理呢個 shift_type）
      card({ id: "per-shift-840", shiftTypeId: SITE_SHIFT_TYPE, brokerId: BROKER_K, clientRate: 840, guardWage: 800, brokerFee: 0 }), // 日薪崗更種嘅逐更卡
    ];
    const result = resolveShiftPricingFromCards(cards, baseInput({ shiftTypeBillingGroup: "per_shift" }));
    expect(result.clientRate).toBe(840);
    expect(result.source.clientCardId).toBe("per-shift-840");
  });

  it("WP-MIXED-BILLING（控制室例子）：同一個盤嘅 monthly_ic 更種（月薪崗）一律唔配逐更收客卡（就算有夾得中嘅卡都唔用）——收入淨係嚟自 flat 卡", () => {
    const cards: RateCardLite[] = [
      card({ id: "flat-22000", clientRate: 22000, billingModel: "monthly_fixed" }),
      card({ id: "per-shift-840", shiftTypeId: SITE_SHIFT_TYPE, brokerId: BROKER_K, clientRate: 840, guardWage: 800, brokerFee: 0 }),
    ];
    const result = resolveShiftPricingFromCards(cards, baseInput({ shiftTypeBillingGroup: "monthly_ic" }));
    expect(result.clientRate).toBeNull();
  });
});

describe("resolveShiftPricingFromCards：收客價 broker-agnostic fallback（gate:pricing 對 7 月數據驗證）", () => {
  it("冇夾到結算雞頭嘅收客價卡——擴大搜尋，唔理張卡掛咗邊個雞頭（例：啟航1331 D 更收客價卡掛咗喺 K 雞頭，但 B07 長工做呢個更別都係收返同一個價）", () => {
    const cards: RateCardLite[] = [
      card({ id: "K-card", shiftTypeId: SITE_SHIFT_TYPE, brokerId: "broker-K-other", clientRate: 1200, guardWage: 820, brokerFee: 60 }),
    ];
    const result = resolveShiftPricingFromCards(cards, baseInput({ settlementBrokerId: "broker-B07", brokerKind: "internal_longterm" }));
    expect(result.clientRate).toBe(1200); // 收客價：擴大搜尋揾到
    expect(result.guardWage).toBeNull(); // 出街價：longterm 本身唔计
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

describe("resolveShiftPricingFromCards：S2 出街價取值規則", () => {
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

  it("cancelled → false（作廢咗唔算未定價）", () => {
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

  it("internal_cash／null broker kind，wage/fee 皆 null → true（真係缺價）", () => {
    expect(isUnpricedShift({ recordType: "shift", status: "confirmed", guardWageSnapshot: null, brokerFeeSnapshot: null }, "internal_cash")).toBe(true);
    expect(isUnpricedShift({ recordType: "shift", status: "confirmed", guardWageSnapshot: null, brokerFeeSnapshot: null }, null)).toBe(true);
  });

  it("S3：wage=0 且 fee=null → true（未定價，唔止兩者皆 null 先算）", () => {
    expect(isUnpricedShift({ recordType: "shift", status: "confirmed", guardWageSnapshot: 0, brokerFeeSnapshot: null }, "broker")).toBe(true);
  });

  it("S3：wage=0 但 fee 有值 → false（純介紹費卡嘅正常狀態）", () => {
    expect(isUnpricedShift({ recordType: "shift", status: "confirmed", guardWageSnapshot: 0, brokerFeeSnapshot: 45 }, "broker")).toBe(false);
  });
});

describe("isClientUnpricedShift（S3：收客價未定，淨係逐更盤先算；應修：改用 shift_type.billing_group）", () => {
  it("per_shift 更別，client_rate_snapshot null → true", () => {
    expect(isClientUnpricedShift({ recordType: "shift", status: "confirmed", clientRateSnapshot: null }, "per_shift")).toBe(true);
  });

  it("per_shift 更別，client_rate_snapshot 有值 → false", () => {
    expect(isClientUnpricedShift({ recordType: "shift", status: "confirmed", clientRateSnapshot: 500 }, "per_shift")).toBe(false);
  });

  it("非逐更更別（monthly_ic，例：數碼港 CP5「D」更），client_rate_snapshot null 屬正常 → false", () => {
    // Opus 第三輪 M1：盤層面唔逐更開單（月費／admin_fee／special）→ 唔算收客未定
    for (const bm of ["monthly_fixed", "admin_fee", "special"]) {
      expect(isClientUnpricedShift({ recordType: "shift", status: "confirmed", clientRateSnapshot: null }, "per_shift", { siteBillingModel: bm })).toBe(false);
    }
    expect(isClientUnpricedShift({ recordType: "shift", status: "confirmed", clientRateSnapshot: null }, "per_shift", { siteBillingModel: "per_shift" })).toBe(true);
    expect(isClientUnpricedShift({ recordType: "shift", status: "confirmed", clientRateSnapshot: null }, "per_shift", { brokerKind: "external" })).toBe(false);
    expect(isClientUnpricedShift({ recordType: "shift", status: "confirmed", clientRateSnapshot: null }, "monthly_ic")).toBe(false);
  });

  describe("WP-MIXED-BILLING（老闆 2026-09-24）：月費盤層面豁免只對 2026-08 之前嘅月份生效", () => {
    const JULY = new Date(Date.UTC(2026, 6, 15));
    const AUG = new Date(Date.UTC(2026, 7, 15));

    it("7 月（或冇傳 month，向下相容）：monthly_fixed 盤嘅 per_shift 更種 client_rate null 照舊豁免 → false", () => {
      expect(isClientUnpricedShift({ recordType: "shift", status: "confirmed", clientRateSnapshot: null }, "per_shift", { siteBillingModel: "monthly_fixed" })).toBe(false);
      expect(
        isClientUnpricedShift({ recordType: "shift", status: "confirmed", clientRateSnapshot: null }, "per_shift", { siteBillingModel: "monthly_fixed", month: JULY }),
      ).toBe(false);
    });

    it("8 月起：月費盤「逐更另收」per_shift 更種（例：控制室日薪崗，includedInSiteFlatFee=false）client_rate null → true", () => {
      expect(
        isClientUnpricedShift({ recordType: "shift", status: "confirmed", clientRateSnapshot: null }, "per_shift", { siteBillingModel: "monthly_fixed", month: AUG, includedInSiteFlatFee: false }),
      ).toBe(true);
      // 控制室 site.billing_model 其實係 per_shift（有 flat 卡）——一樣要報
      expect(
        isClientUnpricedShift({ recordType: "shift", status: "confirmed", clientRateSnapshot: null }, "per_shift", { siteBillingModel: "per_shift", month: AUG, includedInSiteFlatFee: false }),
      ).toBe(true);
    });

    it("Opus 5.5 驗收：8 月起，月費盤上「已包喺月費」嘅 per_shift 更種（例：IFC D/N，includedInSiteFlatFee=true）client_rate null → false（唔標收客價未定）", () => {
      expect(
        isClientUnpricedShift({ recordType: "shift", status: "confirmed", clientRateSnapshot: null }, "per_shift", { siteBillingModel: "monthly_fixed", month: AUG, includedInSiteFlatFee: true }),
      ).toBe(false);
      // site.billing_model=per_shift 但有 flat 卡（蔚峰園／屯門小欖／都會大學夜巡邏）同樣豁免
      expect(
        isClientUnpricedShift({ recordType: "shift", status: "confirmed", clientRateSnapshot: null }, "per_shift", { siteBillingModel: "per_shift", month: AUG, includedInSiteFlatFee: true }),
      ).toBe(false);
    });

    it("8 月起但 call site 冇提供 includedInSiteFlatFee：保守沿用舊盤層面豁免（唔多報）", () => {
      expect(
        isClientUnpricedShift({ recordType: "shift", status: "confirmed", clientRateSnapshot: null }, "per_shift", { siteBillingModel: "monthly_fixed", month: AUG }),
      ).toBe(false);
    });

    it("8 月起：「逐更另收」per_shift 更種有 client_rate → false（有卡就唔算未定價）", () => {
      expect(
        isClientUnpricedShift({ recordType: "shift", status: "confirmed", clientRateSnapshot: 840 }, "per_shift", { siteBillingModel: "monthly_fixed", month: AUG, includedInSiteFlatFee: false }),
      ).toBe(false);
    });

    it("8 月起：monthly_ic 更種（例：控制室月薪崗）本身層面已經豁免，唔理盤層面 → false", () => {
      expect(
        isClientUnpricedShift({ recordType: "shift", status: "confirmed", clientRateSnapshot: null }, "monthly_ic", { siteBillingModel: "monthly_fixed", month: AUG }),
      ).toBe(false);
    });
  });

  it("cancelled／leave/ot → false", () => {
    expect(isClientUnpricedShift({ recordType: "shift", status: "cancelled", clientRateSnapshot: null }, "per_shift")).toBe(false);
    expect(isClientUnpricedShift({ recordType: "leave", status: "confirmed", clientRateSnapshot: null }, "per_shift")).toBe(false);
  });

  it("應修：B10（external）——就算係 per_shift 更別，is_external=true 都唔算收客價未定 → false", () => {
    expect(isClientUnpricedShift({ recordType: "shift", status: "confirmed", clientRateSnapshot: null, isExternal: true }, "per_shift")).toBe(false);
  });
});

describe("應修（Opus 第二輪驗收）：ResolvedShiftPricing.clientCardFound／payoutCardFound", () => {
  it("正常路徑揾到收客價卡＋出街價卡：兩個 flag 皆 true", () => {
    const cards: RateCardLite[] = [card({ id: "c1", clientRate: 800, guardWage: 700, brokerFee: 50 })];
    const result = resolveShiftPricingFromCards(cards, baseInput());
    expect(result.clientCardFound).toBe(true);
    expect(result.payoutCardFound).toBe(true);
  });

  it("完全冇卡：兩個 flag 皆 false", () => {
    const result = resolveShiftPricingFromCards([], baseInput());
    expect(result.clientCardFound).toBe(false);
    expect(result.payoutCardFound).toBe(false);
  });

  it("external：兩個 flag 皆 false（根本冇計，唔係「揾到但係 null」）", () => {
    const cards: RateCardLite[] = [card({ id: "c1", clientRate: 800, guardWage: 700, brokerFee: 50 })];
    const result = resolveShiftPricingFromCards(cards, baseInput({ brokerKind: "external", isExternal: true }));
    expect(result.clientCardFound).toBe(false);
    expect(result.payoutCardFound).toBe(false);
  });

  it("數碼港 CP5「D」更（billing_group=monthly_ic）：就算有一張形狀啱嘅 site flat 卡，clientCardFound 都係 false、clientRate 必須 null（例：CP5 8 月更表）", () => {
    const cards: RateCardLite[] = [
      // site 級通用 flat 卡（冇 shift_type/broker/guard），形狀好似 CP5 現實嗰張 $930 卡。
      card({ id: "cp5-flat", clientRate: 930 }),
    ];
    const result = resolveShiftPricingFromCards(cards, baseInput({ shiftTypeBillingGroup: "monthly_ic" }));
    expect(result.clientRate).toBeNull();
    expect(result.clientCardFound).toBe(false);
  });

  it("monthly_ic 更別就算有張直接掛咗呢個 shift_type_id 嘅卡，一樣唔會計收客價（billing_group 淨係更別層面，同 shift_type_id 夾唔夾係兩回事）", () => {
    const cards: RateCardLite[] = [card({ id: "exact", shiftTypeId: SITE_SHIFT_TYPE, clientRate: 930 })];
    const result = resolveShiftPricingFromCards(cards, baseInput({ shiftTypeBillingGroup: "monthly_ic" }));
    expect(result.clientRate).toBeNull();
  });

  it("冇填 shiftTypeBillingGroup（向下相容）當 per_shift 睇待，唔影響現有行為", () => {
    const cards: RateCardLite[] = [card({ id: "c1", clientRate: 500 })];
    const result = resolveShiftPricingFromCards(cards, baseInput({ shiftTypeBillingGroup: undefined }));
    expect(result.clientRate).toBe(500);
  });
});

// WP-UPLOAD-AUTOFIX 個案 2（P2-版面重設計計劃.md §17.11）：控制室月薪崗
// 保安員專屬卡——client_rate=0、guard_wage=800，冧 guard 专属+同 shift_type
// 一定贏 site 级 840 卡；client_rate=0 唔准被 isClientUnpricedShift() 誤標
// 「未定價」（0 係有效值，唔係 null）。
describe("resolveShiftPricingFromCards：WP-UPLOAD-AUTOFIX 個案 2（月薪崗保安員 client_rate=0 專屬卡）", () => {
  it("guard 专属＋client_rate=0 卡贏 site 级 840 卡——呢位保安員嘅更 client=0（已包喺月費）、guard_wage=800", () => {
    const cards: RateCardLite[] = [
      card({ id: "site-840", clientRate: 840, guardWage: 800 }), // rank 4：site 级，通用
      card({ id: "guard-0", guardId: GUARD_A, clientRate: 0, guardWage: 800, brokerFee: null }), // rank 0：guard 专属+同 shift_type
    ];
    const result = resolveShiftPricingFromCards(cards, baseInput());
    expect(result.clientRate).toBe(0);
    expect(result.guardWage).toBe(800);
  });

  it("另一位保安員（唔係呢張 guard 专属卡嘅 guardId）照舊行 site 级 840 卡，唔受影響", () => {
    const cards: RateCardLite[] = [
      card({ id: "site-840", clientRate: 840, guardWage: 800 }),
      card({ id: "guard-0", guardId: GUARD_A, clientRate: 0, guardWage: 800, brokerFee: null }),
    ];
    const result = resolveShiftPricingFromCards(cards, baseInput({ guardId: "guard-B-日薪崗" }));
    expect(result.clientRate).toBe(840);
    expect(result.guardWage).toBe(800);
  });

  it("isClientUnpricedShift()：clientRateSnapshot=0 唔算未定價（0 係有效值，唔係 null）", () => {
    const unpriced = isClientUnpricedShift({ recordType: "shift", status: "confirmed", clientRateSnapshot: 0 }, "per_shift");
    expect(unpriced).toBe(false);
  });

  it("對比：clientRateSnapshot=null 先算未定價", () => {
    const unpriced = isClientUnpricedShift({ recordType: "shift", status: "confirmed", clientRateSnapshot: null }, "per_shift");
    expect(unpriced).toBe(true);
  });
});
