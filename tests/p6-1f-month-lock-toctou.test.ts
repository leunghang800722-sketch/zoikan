// P6.1f（H6）：鎖月 TOCTOU——寫入 tx 內 FOR SHARE 查鎖月、鎖月 route FOR UPDATE＋條件式 update。
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { POST as lockMonth } from "@/app/api/month-closes/[id]/lock/route";
import { assertMonthNotLockedTx } from "@/lib/month-lock";

function lockReq(cookie: string, id: string) {
  return lockMonth(new Request(`http://test.local/api/month-closes/${id}/lock`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ force: true }) }), { params: Promise.resolve({ id }) });
}
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("P6.1f：鎖月 TOCTOU", () => {
  let fx: Wp2Fixture;
  let ownerCookie: string;
  let mcId: string;
  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    ownerCookie = await sessionCookieForUser(fx.userIds["老闆"]);
    mcId = (await prisma.monthClose.create({ data: { month: fx.unlockedMonth, createdBy: "test" } })).id;
  });
  const chk = (tx: Parameters<typeof assertMonthNotLockedTx>[0]) =>
    assertMonthNotLockedTx(tx, { workDate: fx.unlockedMonth, actorUserId: fx.userIds["老闆"], tableName: "shift_records", rowId: "t", ip: null });

  it("tx 先開、查鎖月（未鎖）→ 之後鎖月要等 tx commit 先完成；tx 內寫入照 commit", async () => {
    const checked = deferred();
    const release = deferred();
    let committed = false;
    const writer = prisma.$transaction(async (tx) => {
      await chk(tx); // 未鎖 → 通過，持有 FOR SHARE
      checked.resolve();
      await release.promise;
      await tx.rosterUpload.count();
      committed = true;
    });
    await checked.promise;
    let lockDone = false;
    const lockP = lockReq(ownerCookie, mcId).then((r) => { lockDone = true; return r; });
    await sleep(600);
    expect(lockDone).toBe(false); // 被 FOR SHARE 擋住，等緊寫入 tx
    expect(committed).toBe(false);
    release.resolve();
    await writer;
    const res = await lockP;
    expect(res.status).toBe(200);
    expect(committed).toBe(true);
    expect((await prisma.monthClose.findUniqueOrThrow({ where: { id: mcId } })).lockedAt).not.toBeNull();
  });

  it("tx 已開（未查鎖月）→ 期間月份鎖咗 → tx 內查鎖月擋住（403 month_locked）", async () => {
    const started = deferred();
    const proceed = deferred();
    const writer = prisma.$transaction(async (tx) => {
      await tx.rosterUpload.count(); // 確保 tx 真正開咗
      started.resolve();
      await proceed.promise;
      await chk(tx);
    });
    await started.promise;
    const res = await lockReq(ownerCookie, mcId);
    expect(res.status).toBe(200);
    proceed.resolve();
    await expect(writer).rejects.toMatchObject({ code: "month_locked" });
  });

  it("兩個並發鎖月請求：只有一個 200，另一個 409，唔會雙重 lock_month audit", async () => {
    const [a, b] = await Promise.all([lockReq(ownerCookie, mcId), lockReq(ownerCookie, mcId)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(await prisma.auditLog.count({ where: { tableName: "month_closes", rowId: mcId, action: "lock_month" } })).toBe(1);
  });

  it("月份未有 month_closes row → assertMonthNotLockedTx 當未鎖（不 throw）", async () => {
    await expect(
      prisma.$transaction((tx) => assertMonthNotLockedTx(tx, { workDate: new Date(Date.UTC(2030, 0, 1)), actorUserId: null, tableName: "t", rowId: "x", ip: null })),
    ).resolves.toBeUndefined();
  });
});

describe("P6.1f 驗收修正：鎖月等唔到長寫入 tx → 409 lock_busy", () => {
  it("writer 揸 FOR SHARE 超過 lock_timeout → 409 lock_busy、locked_at 仍 null；釋放後再鎖 → 200", async () => {
    await clearAll();
    const fx = await seedWp2Fixture();
    const cookie = await sessionCookieForUser(fx.userIds["老闆"]);
    const mcId = (await prisma.monthClose.create({ data: { month: fx.unlockedMonth, createdBy: "test" } })).id;
    process.env.MONTH_LOCK_TIMEOUT_MS = "1500";
    try {
      const started = deferred();
      const release = deferred();
      const writer = prisma.$transaction(async (tx) => {
        await assertMonthNotLockedTx(tx, { workDate: fx.unlockedMonth, actorUserId: null, tableName: "t", rowId: "x", ip: null });
        started.resolve();
        await release.promise;
      }, { timeout: 30_000 });
      await started.promise;
      const busy = await lockReq(cookie, mcId);
      expect(busy.status).toBe(409);
      expect((await busy.json()).error).toBe("lock_busy");
      expect((await prisma.monthClose.findUniqueOrThrow({ where: { id: mcId } })).lockedAt).toBeNull();
      release.resolve();
      await writer;
      expect((await lockReq(cookie, mcId)).status).toBe(200);
    } finally {
      delete process.env.MONTH_LOCK_TIMEOUT_MS;
    }
  });
});
