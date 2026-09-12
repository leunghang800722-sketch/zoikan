// 假數據 fixture——淨係用嚟測試 schema/report 邏輯，冇任何真名/工號/電話。
import { prisma } from "../lib/db";

export async function seedFakeFixture() {
  const brokerA = await prisma.broker.create({
    data: { code: "TEST-A", name: "測試雞頭A", kind: "broker", settlementType: "cash", createdBy: "test-fixture" },
  });
  const brokerInternal = await prisma.broker.create({
    data: { code: "TEST-Y", name: "測試公司兵", kind: "internal_cash", settlementType: "cash", isInternal: true, createdBy: "test-fixture" },
  });

  const site = await prisma.site.create({
    data: {
      canonicalName: "測試盤一號",
      clientName: "測試客戶",
      billingModel: "per_shift",
      createdBy: "test-fixture",
    },
  });
  const siteMonthly = await prisma.site.create({
    data: {
      canonicalName: "測試月費盤",
      clientName: "測試客戶B",
      billingModel: "monthly_fixed",
      monthlyFee: 10000,
      createdBy: "test-fixture",
    },
  });

  const shiftTypeN = await prisma.shiftType.create({
    data: { siteId: site.id, code: "N", label: "測試夜更", hours: 12, createdBy: "test-fixture" },
  });

  const casualGuard = await prisma.guard.create({
    data: { staffNo: "T00001", nameZh: "測試安員甲", employmentType: "cash_casual", createdBy: "test-fixture" },
  });
  const longtermGuard = await prisma.guard.create({
    data: {
      staffNo: "T00002",
      nameZh: "測試安員乙",
      employmentType: "longterm_autopay",
      monthlySalary: 18000,
      createdBy: "test-fixture",
    },
  });

  // 普通現金安員一個更：settlement=operational=brokerA
  await prisma.shiftRecord.create({
    data: {
      workDate: new Date(Date.UTC(2026, 6, 1)),
      siteId: site.id,
      shiftTypeId: shiftTypeN.id,
      guardId: casualGuard.id,
      settlementBrokerId: brokerA.id,
      operationalBrokerId: brokerA.id,
      recordType: "shift",
      clientRateSnapshot: 900,
      guardWageSnapshot: 700,
      brokerFeeSnapshot: 50,
      createdBy: "test-fixture",
    },
  });

  // 硬性規則4：長工掛雞頭桶嘅更——settlement_broker_id＝operational_broker_id＝
  // 雞頭（照收現金），employment_type＝longterm_autopay，毛利表要如實計兩份成本
  // （雞頭現金 + 月薪分攤）
  await prisma.shiftRecord.create({
    data: {
      workDate: new Date(Date.UTC(2026, 6, 2)),
      siteId: site.id,
      shiftTypeId: shiftTypeN.id,
      guardId: longtermGuard.id,
      settlementBrokerId: brokerInternal.id,
      operationalBrokerId: brokerInternal.id,
      recordType: "shift",
      clientRateSnapshot: 900,
      guardWageSnapshot: 800,
      brokerFeeSnapshot: 0,
      createdBy: "test-fixture",
    },
  });

  return { brokerA, brokerInternal, site, siteMonthly, shiftTypeN, casualGuard, longtermGuard };
}
