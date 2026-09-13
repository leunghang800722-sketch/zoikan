// P1-WP4：雞頭費拆分（老闆 2026-09-13 批准，見
// scripts/seed/lib/broker-fee-split.ts 頂註解）嘅單元測試。淨係測純函數
// `applyBrokerFeeSplit()`，唔碰 DB——用 fixture 造一個有規則嘅 broker
// （兩張「合計卡」：一張啟航1331、一張其他盤）＋幾條 shift_records 快照，
// 斷言 60／50 兩級費率、payout 不變、長工卡唔動、冇規則嘅 broker 唔動。
import { describe, it, expect } from "vitest";
import { applyBrokerFeeSplit, type BrokerFeeRules } from "../scripts/seed/lib/broker-fee-split";

const RULES: BrokerFeeRules = {
  B01: { default: 50, bySite: { 啟航1331: 60 } },
};

describe("applyBrokerFeeSplit（雞頭費拆分純函數）", () => {
  it("啟航1331 嘅合計卡：$60/更雞頭費，工資 = payout − 60", () => {
    const result = applyBrokerFeeSplit(RULES, {
      brokerCsvId: "B01",
      brokerKind: "broker",
      siteCanonicalName: "啟航1331",
      guardWage: 750,
      brokerFee: 0,
    });
    expect(result).toEqual({ guardWage: 690, brokerFee: 60, split: true });
    // payout（guardWage+brokerFee）保持不變
    expect(result.guardWage! + result.brokerFee!).toBe(750);
  });

  it("其他盤嘅合計卡：跌返用 default $50/更雞頭費", () => {
    const result = applyBrokerFeeSplit(RULES, {
      brokerCsvId: "B01",
      brokerKind: "broker",
      siteCanonicalName: "數碼港 CP5 IC",
      guardWage: 650,
      brokerFee: 0,
    });
    expect(result).toEqual({ guardWage: 600, brokerFee: 50, split: true });
    expect(result.guardWage! + result.brokerFee!).toBe(650);
  });

  it("brokerFee 係 null（未拆過）都算合計卡，一樣拆", () => {
    const result = applyBrokerFeeSplit(RULES, {
      brokerCsvId: "B01",
      brokerKind: "broker",
      siteCanonicalName: null, // 冇 site 資料，跌返 default
      guardWage: 800,
      brokerFee: null,
    });
    expect(result).toEqual({ guardWage: 750, brokerFee: 50, split: true });
  });

  it("已經拆開咗嘅卡（broker_fee 已經有正數）唔再拆一次——idempotent", () => {
    const result = applyBrokerFeeSplit(RULES, {
      brokerCsvId: "B01",
      brokerKind: "broker",
      siteCanonicalName: "啟航1331",
      guardWage: 690,
      brokerFee: 60,
    });
    expect(result).toEqual({ guardWage: 690, brokerFee: 60, split: false });
  });

  it("長工／公司兵卡（kind≠broker）唔拆，就算個 broker_csv_id 有規則都唔理", () => {
    const result = applyBrokerFeeSplit(RULES, {
      brokerCsvId: "B01",
      brokerKind: "internal_longterm",
      siteCanonicalName: "啟航1331",
      guardWage: 690,
      brokerFee: null,
    });
    expect(result).toEqual({ guardWage: 690, brokerFee: null, split: false });
  });

  it("只收介紹費嘅卡（guard_wage null）唔拆", () => {
    const result = applyBrokerFeeSplit(RULES, {
      brokerCsvId: "B01",
      brokerKind: "broker",
      siteCanonicalName: "啟航1331",
      guardWage: null,
      brokerFee: null,
    });
    expect(result).toEqual({ guardWage: null, brokerFee: null, split: false });
  });

  it("冇規則嘅 broker（例如 B02=W）唔動，就算張卡睇落好似合計卡", () => {
    const result = applyBrokerFeeSplit(RULES, {
      brokerCsvId: "B02",
      brokerKind: "broker",
      siteCanonicalName: "啟航1331",
      guardWage: 750,
      brokerFee: 0,
    });
    expect(result).toEqual({ guardWage: 750, brokerFee: 0, split: false });
  });

  it("brokerCsvId 係 null（例如 external／冇對應 broker）唔動", () => {
    const result = applyBrokerFeeSplit(RULES, {
      brokerCsvId: null,
      brokerKind: null,
      siteCanonicalName: "啟航1331",
      guardWage: 750,
      brokerFee: null,
    });
    expect(result).toEqual({ guardWage: 750, brokerFee: null, split: false });
  });
});
