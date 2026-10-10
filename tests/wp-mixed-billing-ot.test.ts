// WP-MIXED-BILLING（老闆 2026-09-24 答：OT 冇統一公式，個個盤個個人都
// 唔同，系統唔准自動套公式計 OT 價）：
//   1. `computeUnpricedSummary()` 新增 `ot_unpriced` 分類——純函數測試。
//   2. `gross-margin.ts` 嘅「parent 更 snapshot ÷ hours × ot_hours」公式
//      fallback 對 2026-08 起嘅月份停用（7 月照舊，gate 用緊）——integration
//      test（真 DB）。
// WP-BOSS5 §25.1（老闆 2026-09-28 決定 1）：OT 卡＝每小時價——多加一個
// 端到端 describe（見文件尾），一條「多過 1 個鐘 OT 有卡」記錄由
// resolveShiftPricing() 寫入 snapshot（同真實 caller 一致，唔係人手砌
// 已經乘好嘅數字），再驗毛利表（gross-margin.ts）同糧單（payroll.ts）
// 兩個報表口徑一致（同一個 snapshot，直接加總，冇邊個再自己乘一次）。
import { describe, it, expect, beforeAll } from "vitest";
import { clearAll, prisma } from "./lib/db";
import { computeUnpricedSummary, type UnpricedLookups, type UnpricedRecordLike } from "@/lib/pricing/unpriced";
import { buildGrossMargin } from "@/lib/reports/gross-margin";
import { buildPayrollTotals } from "@/lib/reports/payroll";
import { resolveShiftPricing } from "@/lib/pricing/resolve-rate";

function baseLookups(overrides: Partial<UnpricedLookups> = {}): UnpricedLookups {
  return {
    brokerKindById: new Map(),
    brokerCodeById: new Map(),
    siteNameById: new Map([["site-1", "測試盤"]]),
    siteBillingModelById: new Map([["site-1", "per_shift"]]),
    shiftTypeCodeById: new Map([["ot-shift-type", "1Hr OT"]]),
    shiftTypeBillingGroupById: new Map([["ot-shift-type", "per_shift"]]),
    siteGuardsPaidByClientById: new Map(),
    ...overrides,
  };
}

function otRecord(overrides: Partial<UnpricedRecordLike> = {}): UnpricedRecordLike {
  return {
    siteId: "site-1",
    shiftTypeId: "ot-shift-type",
    settlementBrokerId: "broker-Y",
    status: "confirmed",
    recordType: "ot",
    guardWageSnapshot: null,
    brokerFeeSnapshot: null,
    clientRateSnapshot: null,
    isExternal: false,
    ...overrides,
  };
}

describe("computeUnpricedSummary：ot_unpriced 分類（純函數）", () => {
  it("OT 記錄完全冇 client/guard/fee snapshot → ot_unpriced", () => {
    const result = computeUnpricedSummary([otRecord()], baseLookups());
    expect(result.otUnpricedCount).toBe(1);
    expect(result.count).toBe(1);
    expect(result.groups.some((g) => g.category === "ot_unpriced")).toBe(true);
    // OT 記錄唔會行 payout_unpriced/client_unpriced 嗰套（嗰套係為 shift 設計）
    expect(result.payoutCount).toBe(0);
    expect(result.clientCount).toBe(0);
  });

  it("OT 記錄有 client_rate_snapshot（OT 更種卡起咗）→ 唔算未定價", () => {
    const result = computeUnpricedSummary([otRecord({ clientRateSnapshot: 84.85, guardWageSnapshot: 73, brokerFeeSnapshot: 0 })], baseLookups());
    expect(result.otUnpricedCount).toBe(0);
    expect(result.count).toBe(0);
  });

  it("OT 記錄 cancelled → 唔算", () => {
    const result = computeUnpricedSummary([otRecord({ status: "cancelled" })], baseLookups());
    expect(result.otUnpricedCount).toBe(0);
  });

  it("guardsPaidByClient 嘅盤——OT 記錄唔算未定價（LINK 呢類盤唔逐更計）", () => {
    const result = computeUnpricedSummary([otRecord()], baseLookups({ siteGuardsPaidByClientById: new Map([["site-1", true]]) }));
    expect(result.otUnpricedCount).toBe(0);
  });

  it("冇傳 recordType（向下相容舊 call site）：當 shift 處理，唔行 ot_unpriced 分支", () => {
    const record: UnpricedRecordLike = { siteId: "site-1", shiftTypeId: "ot-shift-type", settlementBrokerId: "broker-Y", status: "confirmed", guardWageSnapshot: null, brokerFeeSnapshot: null, clientRateSnapshot: null, isExternal: false };
    const result = computeUnpricedSummary([record], baseLookups());
    expect(result.otUnpricedCount).toBe(0);
    // 冇 recordType 當 shift，會行 payout_unpriced/client_unpriced 判斷（呢度 wage=null&&fee=null → payout_unpriced）
    expect(result.payoutCount).toBe(1);
  });
});

describe("gross-margin.ts：OT 公式 fallback 只對 2026-08 之前嘅月份生效", () => {
  let siteId: string;
  let normalShiftTypeId: string;
  let otShiftTypeId: string;
  let guardId: string;
  let brokerId: string;

  beforeAll(async () => {
    await clearAll();
    const site = await prisma.site.create({
      data: { canonicalName: "測試盤-OT公式停用", clientName: "測試客戶", billingModel: "per_shift", inScope: true, status: "active", createdBy: "test" },
    });
    siteId = site.id;
    const normalShiftType = await prisma.shiftType.create({
      data: { siteId, code: "C", billingGroup: "per_shift", hours: 8, startTime: new Date("1970-01-01T22:00:00Z"), endTime: new Date("1970-01-02T06:00:00Z"), createdBy: "test" },
    });
    normalShiftTypeId = normalShiftType.id;
    const otShiftType = await prisma.shiftType.create({
      data: { siteId, code: "OT1", billingGroup: "per_shift", hours: 1, startTime: new Date("1970-01-01T06:00:00Z"), endTime: new Date("1970-01-01T07:00:00Z"), createdBy: "test" },
    });
    otShiftTypeId = otShiftType.id;
    const guard = await prisma.guard.create({ data: { nameZh: "測試-OT保安員", employmentType: "cash_casual", createdBy: "test" } });
    guardId = guard.id;
    const broker = await prisma.broker.create({ data: { code: "TESTY", name: "測試雞頭", kind: "broker", settlementType: "cash", createdBy: "test" } });
    brokerId = broker.id;
  });

  it("7 月：冇 OT 更種自己嘅 snapshot、有 parent 更 → 照用「parent snapshot÷hours×ot_hours」公式（唔准變）", async () => {
    const parent = await prisma.shiftRecord.create({
      data: {
        siteId, shiftTypeId: normalShiftTypeId, guardId, settlementBrokerId: brokerId, workDate: new Date(Date.UTC(2026, 6, 10)),
        recordType: "shift", status: "confirmed", clientRateSnapshot: 800, guardWageSnapshot: 700, brokerFeeSnapshot: 0, createdBy: "test",
      },
    });
    await prisma.shiftRecord.create({
      data: {
        siteId, shiftTypeId: otShiftTypeId, guardId, settlementBrokerId: brokerId, workDate: new Date(Date.UTC(2026, 6, 10)),
        recordType: "ot", status: "confirmed", otHours: 1, parentShiftId: parent.id,
        clientRateSnapshot: null, guardWageSnapshot: null, brokerFeeSnapshot: null, createdBy: "test",
      },
    });
    const result = await buildGrossMargin(new Date(Date.UTC(2026, 6, 1)));
    const siteRow = result.sites.find((s) => s.siteId === siteId);
    expect(siteRow).toBeDefined();
    const otRow = siteRow!.shiftTypes.find((t) => t.code === "OT1");
    expect(otRow).toBeDefined();
    // 800/8 = 100 per hour × 1 hour = 100
    expect(otRow!.revenue).toBe(100);
    expect(otRow!.cost).toBe(87.5); // 700/8 = 87.5
    expect(otRow!.note).toBeNull(); // 有解到，唔係 unresolved
  });

  it("8 月：同一個 site，冇 OT 更種自己嘅 snapshot——唔再用 parent 公式，直接列未定價（unresolved）", async () => {
    const parent = await prisma.shiftRecord.create({
      data: {
        siteId, shiftTypeId: normalShiftTypeId, guardId, settlementBrokerId: brokerId, workDate: new Date(Date.UTC(2026, 7, 10)),
        recordType: "shift", status: "confirmed", clientRateSnapshot: 800, guardWageSnapshot: 700, brokerFeeSnapshot: 0, createdBy: "test",
      },
    });
    await prisma.shiftRecord.create({
      data: {
        siteId, shiftTypeId: otShiftTypeId, guardId, settlementBrokerId: brokerId, workDate: new Date(Date.UTC(2026, 7, 10)),
        recordType: "ot", status: "confirmed", otHours: 1, parentShiftId: parent.id,
        clientRateSnapshot: null, guardWageSnapshot: null, brokerFeeSnapshot: null, createdBy: "test",
      },
    });
    const result = await buildGrossMargin(new Date(Date.UTC(2026, 7, 1)));
    const siteRow = result.sites.find((s) => s.siteId === siteId);
    expect(siteRow).toBeDefined();
    const otRow = siteRow!.shiftTypes.find((t) => t.code === "OT1");
    expect(otRow).toBeDefined();
    expect(otRow!.revenue).toBe(0); // 冇套公式，唔會計到 100
    expect(otRow!.cost).toBe(0);
    expect(otRow!.note).toContain("搵唔到時薪來源，未計價");
  });

  it("8 月：OT 記錄自己有 client/guard snapshot（OT 更種卡起咗）——直接用 snapshot 做金額，唔再乘 ot_hours（WP-BOSS5 §25.1：resolver 寫入嗰刻已經乘咗，snapshot＝該條記錄金額）", async () => {
    await prisma.shiftRecord.create({
      data: {
        siteId, shiftTypeId: otShiftTypeId, guardId, settlementBrokerId: brokerId, workDate: new Date(Date.UTC(2026, 7, 20)),
        recordType: "ot", status: "confirmed", otHours: 2,
        // WP-BOSS5 §25.1：呢個 snapshot 代表「呢條記錄嘅金額」（即卡嘅
        // 每小時價 84.85／73 × otHours=2，由 resolver 喺寫入嗰刻計好—
        // —169.7／146），唔係「每粒鐘」價，gross-margin.ts 唔會再乘一次。
        clientRateSnapshot: 169.7, guardWageSnapshot: 146, brokerFeeSnapshot: 0, createdBy: "test",
      },
    });
    const result = await buildGrossMargin(new Date(Date.UTC(2026, 7, 1)));
    const siteRow = result.sites.find((s) => s.siteId === siteId);
    const otRow = siteRow!.shiftTypes.find((t) => t.code === "OT1");
    expect(otRow).toBeDefined();
    // 呢個 test 同上面「8 月冇 snapshot」共用同一個 site/shiftType bucket，
    // revenue/cost 係加埋嘅（上面嗰條 record 貢獻 0），淨係呢條新 record
    // 貢獻 169.7／146（snapshot 直接加總，唔再乘 otHours）。
    expect(otRow!.revenue).toBe(169.7);
    expect(otRow!.cost).toBe(146);
  });
});

describe("WP-BOSS5 §25.1 端到端：多過 1 個鐘 OT 有卡——毛利表同糧單口徑一致", () => {
  it("resolveShiftPricing() 寫入嘅 snapshot（卡 84.85/73 每小時價 × otHours=2.5）——gross-margin 同 payroll 兩個報表都直接加總，數值一致", async () => {
    await clearAll();
    const site = await prisma.site.create({
      data: { canonicalName: "測試盤-OT端到端", clientName: "測試客戶", billingModel: "per_shift", inScope: true, status: "active", createdBy: "test" },
    });
    const otShiftType = await prisma.shiftType.create({
      data: { siteId: site.id, code: "OT1", billingGroup: "per_shift", hours: 1, startTime: new Date("1970-01-01T06:00:00Z"), endTime: new Date("1970-01-01T07:00:00Z"), createdBy: "test" },
    });
    const guard = await prisma.guard.create({ data: { nameZh: "測試-OT端到端保安員", employmentType: "cash_casual", createdBy: "test" } });
    const broker = await prisma.broker.create({ data: { code: "TESTOTE2E", name: "測試雞頭", kind: "broker", settlementType: "cash", createdBy: "test" } });
    // OT 更種卡：每小時價 client=84.85／guard=73（同 HKU座頭 1Hr OT 一致嘅
    // 數量級），呢條記錄做咗 2.5 個鐘 OT。
    await prisma.rateCard.create({ data: { siteId: site.id, shiftTypeId: otShiftType.id, clientRate: 84.85, guardWage: 73, effectiveFrom: new Date(Date.UTC(2026, 7, 1)), createdBy: "test" } });

    const workDate = new Date(Date.UTC(2026, 7, 20));
    const otHours = 2.5;
    // 同真實 caller（reconcile-apply.ts／shift-records route）一致：由
    // resolver 計 snapshot，唔係測試自己砌乘好嘅數字。
    const pricing = await resolveShiftPricing({
      siteId: site.id,
      shiftTypeId: otShiftType.id,
      shiftTypeCode: otShiftType.code,
      shiftTypeBillingGroup: otShiftType.billingGroup,
      settlementBrokerId: broker.id,
      brokerKind: "broker",
      guardId: guard.id,
      workDate,
      isExternal: false,
      recordType: "ot",
      otHours,
    });
    expect(pricing.clientRate).toBe(212.13); // 84.85*2.5 round2
    expect(pricing.guardWage).toBe(182.5);

    await prisma.shiftRecord.create({
      data: {
        siteId: site.id, shiftTypeId: otShiftType.id, guardId: guard.id, settlementBrokerId: broker.id, operationalBrokerId: broker.id,
        workDate, recordType: "ot", status: "confirmed", otHours,
        clientRateSnapshot: pricing.clientRate, guardWageSnapshot: pricing.guardWage, brokerFeeSnapshot: pricing.brokerFee,
        createdBy: "test",
      },
    });

    const month = new Date(Date.UTC(2026, 7, 1));
    const [grossMargin, payrollTotals] = await Promise.all([buildGrossMargin(month), buildPayrollTotals(month)]);
    const siteRow = grossMargin.sites.find((s) => s.siteId === site.id);
    const otRow = siteRow!.shiftTypes.find((t) => t.code === "OT1");
    expect(otRow).toBeDefined();
    // 毛利表：cost＝guardWageSnapshot 直接加總（呢個 broker 冇 broker_fee）。
    expect(otRow!.cost).toBe(182.5);

    const brokerRow = payrollTotals.find((b) => b.brokerId === broker.id);
    expect(brokerRow).toBeDefined();
    // 糧單：wage 一樣直接加總 guardWageSnapshot（payroll.ts 一直嘅口徑）。
    expect(brokerRow!.wage).toBe(182.5);
    // 兩個報表對住同一條記錄嘅 OT 成本，數值完全一致——冇邊個自己再乘
    // 一次 otHours、亦冇邊個漏乘。
    expect(otRow!.cost).toBe(brokerRow!.wage);
  });
});
