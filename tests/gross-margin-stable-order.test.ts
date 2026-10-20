// AI-PII-2.3 S1：毛利即時表 sites[].shiftTypes 排序只用穩定業務欄（code→label→otHours→kind→revenue→cost→shifts），唔用 UUID。
// 兩個更別 code／label 都相同（只差開始時間），次序由更數決定；多次建立（uuid 次序不同）結果次序一致。
import { describe, it, expect, beforeEach } from "vitest";
import { clearAll, prisma } from "./lib/db";
import { seedWp2Fixture, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { buildGrossMargin } from "@/lib/reports/gross-margin";

const AUG = new Date(Date.UTC(2026, 7, 1));

describe("gross-margin shiftTypes 穩定次序", () => {
  let fx: Wp2Fixture;
  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
  });
  it("同 code／label 嘅更別：次序跟更數（穩定欄），同 uuid 次序無關", async () => {
    for (let round = 0; round < 3; round++) {
      const site = await prisma.site.create({ data: { canonicalName: `測試排序盤${round}`, clientName: "測試客", billingModel: "per_shift", createdBy: "t" } });
      const mkType = (start: string) => prisma.shiftType.create({ data: { siteId: site.id, code: "D", label: "測試日更", startTime: new Date(`1970-01-01T${start}:00Z`), endTime: new Date("1970-01-01T19:00:00Z"), hours: 12, createdBy: "t" } });
      // 每輪倒轉建立次序（uuid 次序亦會變）
      const order = round % 2 === 0 ? ["07:00", "08:00"] : ["08:00", "07:00"];
      const types: Record<string, { id: string }> = {};
      for (const o of order) types[o] = await mkType(o);
      const guard = await prisma.guard.create({ data: { nameZh: `測試更別${round}`, employmentType: "cash_casual", createdBy: "t" } });
      const mkShift = (stId: string, day: number) =>
        prisma.shiftRecord.create({ data: { workDate: new Date(Date.UTC(2026, 7, day)), siteId: site.id, shiftTypeId: stId, guardId: guard.id, settlementBrokerId: fx.brokerA.id, recordType: "shift", clientRateSnapshot: 300, guardWageSnapshot: 200, brokerFeeSnapshot: 20, createdBy: "t" } });
      for (const d of [1, 2, 3]) await mkShift(types["07:00"]!.id, d); // 07:00 型 3 更
      await mkShift(types["08:00"]!.id, 4); // 08:00 型 1 更
      const gm = await buildGrossMargin(AUG);
      const row = gm.sites.find((s) => s.siteId === site.id)!;
      const ds = row.shiftTypes.filter((t) => t.code === "D");
      expect(ds.map((t) => t.shifts)).toEqual([1, 3]); // revenue 小者（更數少）排前，每輪一致
    }
  });
});
