// HIST-2 目標 4：POST /api/leave-balances/opening-from-rosters（糧務:create）——dry-run 唔寫、apply 寫＋audit、冇 PII。
// 腳本行為不變由 tests/hist1-leave-opening.test.ts 照過。
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { POST } from "@/app/api/leave-balances/opening-from-rosters/route";

const D = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));
const post = (cookie: string, body: unknown) =>
  POST(new Request("http://x/api/leave-balances/opening-from-rosters", { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) }));

describe("HIST-2 POST /api/leave-balances/opening-from-rosters", () => {
  let fx: Wp2Fixture;
  let boss: string;
  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    boss = await sessionCookieForUser(fx.userIds["老闆"]);
    await prisma.staffScheme.upsert({ where: { code: "MG" }, update: { isLongterm: true }, create: { code: "MG", labelZh: "MG", isLongterm: true, isFrontline: false, sort: 3 } });
  });

  async function seedLongterm() {
    const g = await prisma.guard.create({ data: { nameZh: "測試長工甲", employmentType: "longterm_autopay", hireDate: D(2025, 1, 1), createdBy: "t" } });
    await prisma.guardStaffNumber.create({ data: { guardId: g.id, scheme: "MG", number: "MG99931", status: "current" } });
    for (const d of [2, 3, 4]) await prisma.shiftRecord.create({ data: { workDate: D(2026, 3, d), siteId: fx.site.id, shiftTypeId: fx.shiftType.id, guardId: g.id, recordType: "leave", leaveCode: "SL", status: "confirmed", createdBy: "t" } });
    await prisma.shiftRecord.create({ data: { workDate: D(2026, 5, 4), siteId: fx.site.id, shiftTypeId: fx.shiftType.id, guardId: g.id, recordType: "leave", leaveCode: "AL", status: "confirmed", createdBy: "t" } });
    return g;
  }

  it("RBAC：雞頭／主管 403；老闆、會計得", async () => {
    for (const role of ["雞頭", "主管"] as const) {
      expect((await post(await sessionCookieForUser(fx.userIds[role]), { as_of: "2026-06" })).status).toBe(403);
    }
    expect((await post(await sessionCookieForUser(fx.userIds["會計"]), { as_of: "2026-06" })).status).toBe(200);
    expect((await post(boss, { as_of: "2026-06" })).status).toBe(200);
  });

  it("參數檢查：as_of 格式、7 月起拒絕、布林欄", async () => {
    expect((await post(boss, {})).status).toBe(400);
    expect((await post(boss, { as_of: "2026-6" })).status).toBe(400);
    expect((await post(boss, { as_of: "2026-07" })).status).toBe(400);
    expect((await post(boss, { as_of: "2026-06", apply: "yes" })).status).toBe(400);
  });

  it("dry-run（預設）唔寫、回差異清單（guard_id＋數字，冇姓名／工號）；apply 寫行＋逐人 audit＋summary audit；再跑冪等", async () => {
    const startedAt = new Date(Date.now() - 1000);
    const g = await seedLongterm();
    const dryRes = await post(boss, { as_of: "2026-06", apply: false, merge_into_existing: true });
    expect(dryRes.status).toBe(200);
    const dry = (await dryRes.json()) as { apply: boolean; counts: Record<string, number>; rows: Array<{ guard_id: string; action: string; computed: Record<string, unknown> }> };
    expect(dry.apply).toBe(false);
    expect(dry.counts).toMatchObject({ guards: 1, create: 1 });
    expect(dry.rows[0]).toMatchObject({ guard_id: g.id, action: "create", computed: { al_taken: 1, sl_taken: 3 } });
    const text = JSON.stringify(dry);
    expect(text).not.toContain("測試長工甲");
    expect(text).not.toContain("MG99931");
    expect(await prisma.guardLeaveBalance.count()).toBe(0);

    const ap = await post(boss, { as_of: "2026-06", apply: true, merge_into_existing: true });
    expect(ap.status).toBe(200);
    const row = await prisma.guardLeaveBalance.findUniqueOrThrow({ where: { guardId_year: { guardId: g.id, year: 2026 } } });
    expect([Number(row.alTaken), Number(row.slTaken)]).toEqual([1, 3]);
    const audits = await prisma.auditLog.findMany({ where: { action: "backfill_leave_opening", createdAt: { gte: startedAt } } });
    expect(audits).toHaveLength(2); // summary＋逐人
    expect(audits.every((a) => a.actorUserId === fx.userIds["老闆"])).toBe(true);
    expect(JSON.stringify(audits.map((a) => a.after))).not.toMatch(/測試/);

    const again = (await (await post(boss, { as_of: "2026-06", apply: true, merge_into_existing: true })).json()) as { counts: Record<string, number> };
    expect(again.counts).toMatchObject({ create: 0, update: 0 });
    expect(await prisma.guardLeaveBalance.count()).toBe(1);
  });
});
