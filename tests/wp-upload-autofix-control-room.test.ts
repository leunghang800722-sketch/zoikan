// Opus 5.5 驗收（WP-UPLOAD-AUTOFIX 個案 2）：控制室型「月費盤＋逐更日薪崗
// ＋月薪崗 guard 級 $0 卡」端到端——真係經 `POST /api/shift-records/reprice`
// 寫 snapshot（唔係人手填），再對四個報表：
//   - resolver：guard 級 client 0 卡贏 site 級 840 卡（8/1、8/15、8/31）；
//   - 月結／毛利：收入 22,000＋22×840＝40,480，成本 47×800＝37,600；
//   - 糧單（buildPayrollTotals）：結算單位 47 更 wage 37,600；
//   - 雞頭應收（buildMyReceivable）：37,600，DTO 冇 client 欄；
//   - 未定价：月薪崗嗰位 client_rate_snapshot=0 唔算「收客价未定」。
// 全部合成資料（測試名／測試號碼），冇真名真號。
import { describe, it, expect, beforeAll } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { POST as reprice } from "@/app/api/shift-records/reprice/route";
import { fetchEffectiveRateCards, resolveShiftPricingFromCards, isClientUnpricedShift } from "@/lib/pricing/resolve-rate";
import { buildMonthlyClose } from "@/lib/reports/monthly-close";
import { buildGrossMargin } from "@/lib/reports/gross-margin";
import { buildPayrollTotals } from "@/lib/reports/payroll";
import { buildMyReceivable } from "@/lib/reports/my-receivable";
import { loadMixedBillingInfo } from "@/lib/reports/mixed-billing";
import { includedInSiteFlatFee } from "@/lib/pricing/unpriced";

const AUG = new Date(Date.UTC(2026, 7, 1));
const AUG_END = new Date(Date.UTC(2026, 7, 31));
const aug = (d: number) => new Date(Date.UTC(2026, 7, d));

describe("WP-UPLOAD-AUTOFIX 個案 2（Opus 5.5 驗收）：控制室 guard 級 $0 卡端到端", () => {
  let fx: Wp2Fixture;
  let siteId: string;
  let nTypeId: string;
  let monthlyGuardId: string;
  let dayGuardId: string;
  let brokerId: string;

  beforeAll(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    brokerId = fx.brokerInternal.id;
    const site = await prisma.site.create({
      data: { canonicalName: "測試控制室AUTOFIX", clientName: "測試客戶", billingModel: "per_shift", inScope: true, status: "active", createdBy: "test" },
    });
    siteId = site.id;
    const nType = await prisma.shiftType.create({
      data: { siteId, code: "N", billingGroup: "per_shift", startTime: new Date("1970-01-01T19:30:00Z"), endTime: new Date("1970-01-01T07:30:00Z"), hours: 12, createdBy: "test" },
    });
    nTypeId = nType.id;
    const monthlyGuard = await prisma.guard.create({ data: { nameZh: "測試月薪崗", employmentType: "cash_casual", defaultBrokerId: brokerId, createdBy: "test" } });
    const dayGuard = await prisma.guard.create({ data: { nameZh: "測試日薪崗", employmentType: "cash_casual", defaultBrokerId: brokerId, createdBy: "test" } });
    monthlyGuardId = monthlyGuard.id;
    dayGuardId = dayGuard.id;

    // 同 build-aug-plan.ts 控制室段起嘅三張 8 月卡一樣結構。
    await prisma.rateCard.create({ data: { siteId, billingModel: "monthly_fixed", clientRate: 22000, effectiveFrom: AUG, createdBy: "test" } });
    await prisma.rateCard.create({
      data: { siteId, shiftTypeId: nTypeId, brokerId, billingModel: "per_shift", clientRate: 840, guardWage: 800, brokerFee: 0, effectiveFrom: AUG, createdBy: "test" },
    });
    await prisma.rateCard.create({
      data: { siteId, shiftTypeId: nTypeId, brokerId, guardId: monthlyGuardId, billingModel: "per_shift", clientRate: 0, guardWage: 800, brokerFee: 0, effectiveFrom: AUG, createdBy: "test" },
    });

    // 上載後嘅樣：全部格都係 per_shift「N」（Wilson Control 檔分唔到崗位），snapshot 未計。
    const rows = [
      ...Array.from({ length: 25 }, (_, i) => ({ guardId: monthlyGuardId, d: i + 1 })),
      ...Array.from({ length: 22 }, (_, i) => ({ guardId: dayGuardId, d: i + 1 })),
    ];
    for (const r of rows) {
      await prisma.shiftRecord.create({
        data: { siteId, shiftTypeId: nTypeId, guardId: r.guardId, settlementBrokerId: brokerId, workDate: aug(r.d), recordType: "shift", status: "confirmed", createdBy: "test" },
      });
    }
    const cookie = await sessionCookieForUser(fx.userIds["老闆"]);
    const res = await reprice(
      new Request("http://test.local/api/shift-records/reprice", {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ month: "2026-08", site_id: siteId, dry_run: false }),
      }),
    );
    expect(res.status).toBe(200);
  });

  it("resolver：8/1、8/15、8/31 月薪崗嗰位 client=0（guard 級卡），日薪崗 840", async () => {
    const cards = await fetchEffectiveRateCards(siteId, AUG, AUG_END);
    const broker = await prisma.broker.findUniqueOrThrow({ where: { id: brokerId } });
    for (const d of [1, 15, 31]) {
      const base = { siteId, shiftTypeId: nTypeId, shiftTypeCode: "N", shiftTypeBillingGroup: "per_shift", settlementBrokerId: brokerId, brokerKind: broker.kind, workDate: aug(d), isExternal: false, recordType: "shift" } as const;
      const m = resolveShiftPricingFromCards(cards, { ...base, guardId: monthlyGuardId });
      const x = resolveShiftPricingFromCards(cards, { ...base, guardId: dayGuardId });
      expect(m.clientRate).toBe(0);
      expect(m.guardWage).toBe(800);
      expect(m.brokerFee).toBe(0);
      expect(x.clientRate).toBe(840);
      expect(x.guardWage).toBe(800);
    }
  });

  it("reprice 寫入 snapshot：月薪崗 25 更 client 0／wage 800；日薪崗 22 更 client 840", async () => {
    const m = await prisma.shiftRecord.findMany({ where: { siteId, guardId: monthlyGuardId } });
    const x = await prisma.shiftRecord.findMany({ where: { siteId, guardId: dayGuardId } });
    expect(m).toHaveLength(25);
    expect(m.every((r) => Number(r.clientRateSnapshot) === 0 && r.clientRateSnapshot !== null && Number(r.guardWageSnapshot) === 800)).toBe(true);
    expect(x.every((r) => Number(r.clientRateSnapshot) === 840 && Number(r.guardWageSnapshot) === 800)).toBe(true);
  });

  it("月結／毛利：收入 40,480，成本 37,600", async () => {
    const { mainRows } = await buildMonthlyClose(AUG);
    const row = mainRows.find((r) => r.siteId === siteId)!;
    expect(row.revenue).toBe(40480);
    const gm = await buildGrossMargin(AUG);
    const g = gm.sites.find((s) => s.siteId === siteId)!;
    expect(g.revenue).toBe(40480);
    expect(g.cost).toBe(37600);
  });

  it("糧單＋雞頭應收：47 更、37,600；雞頭 DTO 冇 client 欄", async () => {
    const payroll = await buildPayrollTotals(AUG);
    const p = payroll.find((r) => r.brokerId === brokerId)!;
    expect(p.shifts).toBe(47);
    expect(p.wage).toBe(37600);
    const recv = await buildMyReceivable(brokerId, AUG);
    expect(recv.total).toBe(37600);
    expect(recv.totalShifts).toBe(47);
    expect(JSON.stringify(recv).toLowerCase()).not.toContain("client");
  });

  it("未定价：月薪崗 client_rate_snapshot=0 唔算「收客价未定」", async () => {
    const info = (await loadMixedBillingInfo([siteId], AUG, AUG_END)).get(siteId);
    const r = await prisma.shiftRecord.findFirstOrThrow({ where: { siteId, guardId: monthlyGuardId } });
    expect(isClientUnpricedShift(r, "per_shift", { month: AUG, includedInSiteFlatFee: includedInSiteFlatFee(info, nTypeId) })).toBe(false);
  });
});
