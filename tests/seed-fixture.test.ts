import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { seedFakeFixture } from "./fixtures/fake-data";

beforeEach(async () => {
  await clearAll();
});

afterAll(async () => {
  await clearAll();
  await prisma.$disconnect();
});

describe("假數據 fixture 種入", () => {
  it("種入後逐表行數啱", async () => {
    await seedFakeFixture();
    await expect(prisma.broker.count()).resolves.toBe(2);
    await expect(prisma.site.count()).resolves.toBe(2);
    await expect(prisma.shiftType.count()).resolves.toBe(1);
    await expect(prisma.guard.count()).resolves.toBe(2);
    await expect(prisma.shiftRecord.count()).resolves.toBe(2);
  });

  it("硬性規則4：長工掛雞頭桶嘅更——settlement_broker_id同operational_broker_id都係雞頭，employment_type=longterm_autopay", async () => {
    const { longtermGuard, brokerInternal } = await seedFakeFixture();
    const rec = await prisma.shiftRecord.findFirstOrThrow({ where: { guardId: longtermGuard.id } });
    expect(rec.settlementBrokerId).toBe(brokerInternal.id);
    expect(rec.operationalBrokerId).toBe(brokerInternal.id);
    expect(rec.settlementBrokerId).toBe(rec.operationalBrokerId);

    const guard = await prisma.guard.findUniqueOrThrow({ where: { id: longtermGuard.id } });
    expect(guard.employmentType).toBe("longterm_autopay");
    expect(guard.monthlySalary?.toString()).toBe("18000");

    // 毛利表如實計兩份成本：呢條更本身有 guard_wage/broker_fee snapshot
    // （雞頭現金），guard 仲有獨立嘅 monthly_salary（autopay 月薪）——
    // 兩個數值源頭喺 schema 層面完全獨立存在，報表可以照計「雙重支付」
    expect(Number(rec.guardWageSnapshot)).toBeGreaterThan(0);
    expect(Number(guard.monthlySalary)).toBeGreaterThan(0);
  });
});
