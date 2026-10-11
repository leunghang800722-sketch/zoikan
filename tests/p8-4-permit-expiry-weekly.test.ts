// P8.4：證件到期週報——計數（牌照現算／平安卡／QAS）、已過期仍排更、inactive 唔計、dedupe 每週一條、無 PII。
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { computePermitExpiryCounts, runPermitExpiryWeekly, permitExpiryWeeklyJob } from "@/lib/jobs/permit-expiry-weekly";
import { assertNoPii } from "@/lib/notify/create";
import { nextRun } from "@/lib/scheduler/cron";

const MON = new Date("2026-10-12T01:00:00Z"); // 星期一 09:00 HKT
const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const plus = (days: number) => new Date(d("2026-10-12").getTime() + days * 86400000);

describe("P8.4 permit_expiry_weekly", () => {
  let fx: Wp2Fixture;
  let n = 0;
  async function guard(data: Record<string, unknown>) {
    n++;
    return prisma.guard.create({ data: { nameZh: `測試證件${n}`, staffNo: `U9${String(8000 + n)}`, employmentType: "cash_casual", createdBy: "test", ...data } as never });
  }
  async function shift(guardId: string, day: string, status: "confirmed" | "cancelled" = "confirmed") {
    await prisma.shiftRecord.create({ data: { workDate: d(day), siteId: fx.site.id, shiftTypeId: fx.shiftType.id, guardId, recordType: "shift", status, createdBy: "test" } });
  }
  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    n = 0;
    await prisma.guard.deleteMany({ where: { staffNo: { startsWith: "U98" } } });
  });

  async function seedCases() {
    await guard({ siaPermitAExpiry: plus(10) }); // 牌照 30 日內
    await guard({ siaPermitAExpiry: plus(31) }); // 牌照 31 日 → 唔計
    await guard({ safetyCardExpiry: plus(30) }); // 平安卡剛好 30 日 → 計
    const g4 = await guard({ safetyCardExpiry: plus(-5) });
    await shift(g4.id, "2026-10-20"); // 本月仍排更 → 計
    await guard({ safetyCardExpiry: plus(-5) }); // 過期冇排更 → 唔計
    const g6 = await guard({ qasExpiryDate: plus(-1) });
    await shift(g6.id, "2026-11-03"); // 下月排更 → 計
    const g7 = await guard({ qasExpiryDate: plus(-1) });
    await shift(g7.id, "2026-12-03"); // 下下月 → 唔計
    const g8 = await guard({ siaPermitAExpiry: plus(5), status: "inactive" }); // inactive → 唔計
    void g8;
    // 乙類牌照但滿 70 歲 → 衍生值 null → 唔計
    await guard({ siaPermitBExpiry: plus(3), dateOfBirth: d("1950-01-01") });
    const g10 = await guard({ safetyCardExpiry: plus(-2) });
    await shift(g10.id, "2026-10-21", "cancelled"); // 只有取消更 → 唔計
  }

  it("計數：30 日內到期同已過期仍排更", async () => {
    await seedCases();
    expect(await computePermitExpiryCounts(MON)).toEqual({
      licence: { expiring: 1, expired_scheduled: 0 },
      safety_card: { expiring: 1, expired_scheduled: 1 },
      qas: { expiring: 0, expired_scheduled: 1 },
    });
  });

  it("通知：主管＋老闆、body 只有數字、連結 /guards?expiring=30；同週 dedupe、下週再出", async () => {
    await seedCases();
    const r = await runPermitExpiryWeekly(MON);
    expect(r.summary).toMatchObject({ notified: true, week: "2026-10-12" });
    const ns = await prisma.appNotification.findMany({ where: { kind: "permit_expiry_weekly" } });
    expect(ns).toHaveLength(1);
    expect(ns[0]!.title).toBe("證件到期週報");
    expect(ns[0]!.body).toBe("牌照 30 日內到期 1 人、已過期仍排更 0 人；平安卡 30 日內到期 1 人、已過期仍排更 1 人；QAS 30 日內到期 0 人、已過期仍排更 1 人。");
    expect(ns[0]!.href).toBe("/guards?expiring=30");
    expect(ns[0]!.audience).toEqual(["主管", "老闆"]);
    expect(() => assertNoPii(ns[0]!.title, ns[0]!.body)).not.toThrow();
    // 同一週再跑（例如手動 run-now）：唔重複
    await runPermitExpiryWeekly(new Date(MON.getTime() + 3600_000));
    expect(await prisma.appNotification.count({ where: { kind: "permit_expiry_weekly" } })).toBe(1);
    // 下一個星期一：再出一條
    await runPermitExpiryWeekly(new Date(MON.getTime() + 7 * 86400000));
    expect(await prisma.appNotification.count({ where: { kind: "permit_expiry_weekly" } })).toBe(2);
  });

  it("全部 0 → 唔通知（skipped）", async () => {
    await guard({ siaPermitAExpiry: plus(200) });
    const r = await runPermitExpiryWeekly(MON);
    expect(r.status).toBe("skipped");
    expect(await prisma.appNotification.count({ where: { kind: "permit_expiry_weekly" } })).toBe(0);
  });

  it("預設排程＝逢星期一 09:00 HKT", () => {
    expect(permitExpiryWeeklyJob.defaultSchedule).toBe("0 9 * * 1");
    expect(nextRun(permitExpiryWeeklyJob.defaultSchedule, new Date("2026-10-12T01:00:01Z"))!.toISOString()).toBe("2026-10-19T01:00:00.000Z");
  });
});
