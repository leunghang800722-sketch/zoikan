// P3-2.5：shift-records/batch 批量化——結果／audit 內容同逐格寫法一致；查詢數唔隨格數增長；
// payload 重複格行返舊路徑；quota 警示 groupBy 同逐個 count 一致。
import { fakeTel } from "./helpers/fake-tel";
import { describe, it, expect, beforeEach, vi } from "vitest";

const queries = await vi.hoisted(async () => {
  const { PrismaClient } = await import("@prisma/client");
  const list: string[] = [];
  const client = new PrismaClient({ log: [{ emit: "event", level: "query" }] });
  (client as unknown as { $on: (e: string, cb: (q: { query: string }) => void) => void }).$on("query", (q) => list.push(q.query));
  (globalThis as unknown as { prisma: unknown }).prisma = client;
  return list;
});
import { clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { prisma } from "@/lib/db";
import { writeAudit, writeAuditMany, orderedAuditIds } from "@/lib/audit";
import { POST as batchSave } from "@/app/api/shift-records/batch/route";
import { createSettlementBrokerFallbackResolver, resolveSettlementBrokerFallback } from "@/lib/pricing/settlement-broker-fallback";

const post = (cookie: string, body: unknown) =>
  batchSave(new Request("http://test.local/api/shift-records/batch", { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) }));
const iso = (d: Date) => d.toISOString().slice(0, 10);

describe("P3-2.5 shift-records/batch 批量寫入", () => {
  let fx: Wp2Fixture;
  let cookie: string;
  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    cookie = await sessionCookieForUser(fx.userIds["老闆"]);
  });

  it("結果、DB 狀態、audit before/after 同「逐條 writeAudit」一致", async () => {
    const cells = [
      { guard_id: fx.guardA.id, shift_type_id: fx.shiftType.id, work_date: "2026-08-01", code: "N" }, // 既有→update
      { guard_id: fx.guardB.id, shift_type_id: fx.shiftType.id, work_date: "2026-08-01", code: null }, // 既有→清格
      { guard_id: fx.guardA.id, shift_type_id: fx.shiftType.id, work_date: "2026-08-02", code: "N" }, // create
      { guard_id: fx.guardB.id, shift_type_id: fx.shiftType.id, work_date: "2026-08-02", code: "AL" }, // create (leave)
      { guard_id: fx.guardA.id, shift_type_id: fx.shiftType.id, work_date: "2026-08-03", code: null }, // noop
    ];
    const beforeA = await prisma.shiftRecord.findUniqueOrThrow({ where: { id: fx.shiftRecordA.id } });
    const beforeB = await prisma.shiftRecord.findUniqueOrThrow({ where: { id: fx.shiftRecordB.id } });
        const auditBefore = await prisma.auditLog.count({ where: { tableName: "shift_records" } });
    const res = await post(cookie, { site_id: fx.site.id, month: "2026-08", cells });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results.map((r: { action: string }) => r.action)).toEqual(["updated", "cleared", "created", "created"]);

    const afterA = await prisma.shiftRecord.findUniqueOrThrow({ where: { id: fx.shiftRecordA.id } });
    const afterB = await prisma.shiftRecord.findUniqueOrThrow({ where: { id: fx.shiftRecordB.id } });
    expect(afterB.status).toBe("cancelled");
    expect(afterA.updatedAt.getTime()).toBeGreaterThan(beforeA.updatedAt.getTime());
    expect(afterB.updatedAt.getTime()).toBeGreaterThan(beforeB.updatedAt.getTime());
    const createdIds = body.results.filter((r: { action: string }) => r.action === "created").map((r: { id: string }) => r.id);
    const created = await prisma.shiftRecord.findMany({ where: { id: { in: createdIds } } });
    expect(created).toHaveLength(2);
    expect(created.find((c) => c.guardId === fx.guardB.id)!.recordType).toBe("leave");

    const audits = await prisma.auditLog.findMany({ where: { tableName: "shift_records" }, orderBy: { createdAt: "asc" } });
    const mine = audits.slice(auditBefore);
    expect(mine).toHaveLength(4);
    // 期望值：用同一個 writeAudit 逐條寫「參考列」（rowId 加前綴），再比 before／after JSON
    const refs: Array<{ rowId: string; action: "update" | "void" | "create"; before?: unknown; after: unknown }> = [
      { rowId: fx.shiftRecordA.id, action: "update", before: beforeA, after: afterA },
      { rowId: fx.shiftRecordB.id, action: "void", before: beforeB, after: { ...afterB, void_reason: "batch:clear_cell" } },
      ...createdIds.map((id: string) => ({ rowId: id, action: "create" as const, after: created.find((c) => c.id === id)! })),
    ];
    for (const r of refs) await writeAudit({ actorUserId: fx.userIds["老闆"], tableName: "shift_records", rowId: `ref:${r.rowId}`, action: r.action, before: r.before, after: r.after, ip: null });
    const refRows = await prisma.auditLog.findMany({ where: { tableName: "shift_records", rowId: { startsWith: "ref:" } } });
    for (const r of refs) {
      const got = mine.find((a) => a.rowId === r.rowId)!;
      const ref = refRows.find((a) => a.rowId === `ref:${r.rowId}`)!;
      expect(got.action).toBe(ref.action);
      expect(got.before).toEqual(ref.before);
      expect(got.after).toEqual(ref.after);
      expect(got.actorUserId).toBe(fx.userIds["老闆"]);
    }
    // 同一批共用同一個 created_at（唔偽造未來時間）
    expect(new Set(mine.map((a) => a.createdAt.getTime())).size).toBe(1);
    expect(Math.abs(mine[0]!.createdAt.getTime() - Date.now())).toBeLessThan(60_000);
    expect(mine.map((a) => a.rowId).sort()).toEqual([fx.shiftRecordA.id, fx.shiftRecordB.id, ...createdIds].sort());
  });

  it("查詢數唔隨格數／保安員數增長（20 人×2 日 vs 200 人×2 日，差 ≤ 6 條）", async () => {
    const guards = await Promise.all(
      Array.from({ length: 200 }, (_, i) => prisma.guard.create({ data: { nameZh: `G${i}`, tel: `6000${String(i).padStart(4, "0")}`, createdBy: "t", employmentType: "cash_casual", defaultBrokerId: fx.brokerA.id } })),
    );
    const mk = (days: number[], gs: typeof guards) =>
      gs.flatMap((g) => days.map((d) => ({ guard_id: g.id, shift_type_id: fx.shiftType.id, work_date: `2026-08-${String(d).padStart(2, "0")}`, code: "N" })));
    const run = async (cells: ReturnType<typeof mk>) => {
      const before = queries.length;
      const res = await post(cookie, { site_id: fx.site.id, month: "2026-08", cells });
      expect(res.status).toBe(200);
      return queries.length - before;
    };
    const small = await run(mk([10, 11], guards.slice(0, 20))); // 40 格、20 個 guard
    const big = await run(mk([12, 13], guards)); // 400 格、200 個 guard
    expect(big - small).toBeLessThanOrEqual(6);
    expect(big).toBeLessThan(60);
  });

  it("payload 有重複格 → 舊逐格路徑，行為不變（既有格兩次 update 都成功）", async () => {
    const cell = { guard_id: fx.guardA.id, shift_type_id: fx.shiftType.id, work_date: "2026-08-01", code: "N" };
    const res = await post(cookie, { site_id: fx.site.id, month: "2026-08", cells: [cell, cell] });
    expect(res.status).toBe(200);
    expect((await res.json()).results.map((r: { action: string }) => r.action)).toEqual(["updated", "updated"]);
    const dupNew = { guard_id: fx.guardA.id, shift_type_id: fx.shiftType.id, work_date: "2026-08-20", code: "N" };
    expect((await post(cookie, { site_id: fx.site.id, month: "2026-08", cells: [dupNew, dupNew] })).status).toBe(409);
    expect(await prisma.shiftRecord.count({ where: { workDate: new Date(Date.UTC(2026, 7, 20)) } })).toBe(0); // 成批 rollback
  });

  it("quota 警示（groupBy）同逐個 count 一致", async () => {
    await prisma.quota.create({ data: { siteId: fx.site.id, shiftTypeId: fx.shiftType.id, brokerId: fx.brokerA.id, month: new Date(Date.UTC(2026, 7, 1)), targetShifts: 1, createdBy: "t" } });
    const res = await post(cookie, {
      site_id: fx.site.id,
      month: "2026-08",
      cells: [{ guard_id: fx.guardA.id, shift_type_id: fx.shiftType.id, work_date: "2026-08-05", code: "N", settlement_broker_id: fx.brokerA.id }],
    });
    const warnings: string[] = (await res.json()).warnings;
    const actual = await prisma.shiftRecord.count({
      where: { siteId: fx.site.id, shiftTypeId: fx.shiftType.id, settlementBrokerId: fx.brokerA.id, recordType: "shift", status: { not: "cancelled" }, workDate: { gte: new Date(Date.UTC(2026, 7, 1)), lte: new Date(Date.UTC(2026, 7, 31)) } },
    });
    expect(actual).toBeGreaterThan(1);
    expect(warnings.some((w) => w.includes(`已排 ${actual} / 配額 1`))).toBe(true);
    void iso;
  });

  it("settlement broker fallback：prefetch（DISTINCT ON）同逐個 resolve 逐級一致", async () => {
    const mkGuard = (name: string, extra: Record<string, unknown> = {}) =>
      prisma.guard.create({ data: { nameZh: name, tel: fakeTel(), createdBy: "t", employmentType: "cash_casual", ...extra } as never });
    const ltBroker = await prisma.broker.create({ data: { code: "LTX", name: "LT", kind: "internal_longterm", isInternal: true, settlementType: "autopay", createdBy: "t" } as never });
    const otherSite = await prisma.site.create({ data: { canonicalName: "另一個盤", clientName: "x", billingModel: "per_shift", createdBy: "t" } });
    const otherSt = await prisma.shiftType.create({ data: { siteId: otherSite.id, code: "N", createdBy: "t" } });
    const gSame = await mkGuard("同盤有記錄");
    const gOther = await mkGuard("只他盤有記錄");
    const gDefault = await mkGuard("只有預設雞頭", { defaultBrokerId: fx.brokerB.id });
    const gLongterm = await mkGuard("長工無預設", { employmentType: "longterm_autopay" });
    const gNone = await mkGuard("乜都冇");
    const rec = (guardId: string, siteId: string, shiftTypeId: string, day: number, brokerId: string | null, status: "confirmed" | "cancelled" = "confirmed") =>
      prisma.shiftRecord.create({ data: { workDate: new Date(Date.UTC(2026, 7, day)), siteId, shiftTypeId, guardId, settlementBrokerId: brokerId, operationalBrokerId: brokerId, recordType: "shift", status, createdBy: "t" } });
    await rec(gSame.id, fx.site.id, fx.shiftType.id, 3, fx.brokerB.id);
    await rec(gSame.id, fx.site.id, fx.shiftType.id, 9, fx.brokerA.id); // 較新
    await rec(gSame.id, fx.site.id, fx.shiftType.id, 20, fx.brokerB.id, "cancelled"); // 作廢，唔計
    await rec(gSame.id, otherSite.id, otherSt.id, 25, fx.brokerB.id); // 他盤更新，但同盤優先
    await rec(gOther.id, otherSite.id, otherSt.id, 5, fx.brokerB.id);
    const all = [gSame, gOther, gDefault, gLongterm, gNone];
    const inputs = all.map((g) => ({ guardId: g.id, siteId: fx.site.id, employmentType: g.employmentType, defaultBrokerId: g.defaultBrokerId }));
    const single = await Promise.all(inputs.map((i) => resolveSettlementBrokerFallback(i)));
    const resolver = createSettlementBrokerFallbackResolver(prisma);
    await resolver.prefetch(inputs);
    const before = queries.length;
    const batched = await Promise.all(inputs.map((i) => resolver(i)));
    expect(queries.length - before).toBe(0); // prefetch 後唔再查
    expect(batched).toEqual(single);
    expect(single).toEqual([fx.brokerA.id, fx.brokerB.id, fx.brokerB.id, ltBroker.id, null]);
  });
});

describe("P3-5.5 writeAuditMany 同批次序", () => {
  beforeEach(async () => {
    await clearAll();
  });

  it("orderedAuditIds：升序、唯一、合法 uuid 形狀", () => {
    const ids = orderedAuditIds(300);
    expect(new Set(ids).size).toBe(300);
    expect([...ids].sort()).toEqual(ids);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(orderedAuditIds(2)[0]).not.toBe(orderedAuditIds(2)[0]); // 跨批唔撞
  });

  it("同批 createMany：audit-log 排序（createdAt desc, id asc）＝插入次序", async () => {
    const fx = await seedWp2Fixture();
    const inputs = Array.from({ length: 40 }, (_, i) => ({
      actorUserId: fx.userIds["老闆"],
      tableName: "shift_records",
      rowId: `p35-ordered-${String(i).padStart(2, "0")}`,
      action: "create" as const,
      after: { n: i },
    }));
    await writeAuditMany(inputs);
    const rows = await prisma.auditLog.findMany({ where: { tableName: "shift_records", rowId: { startsWith: "p35-ordered-" } }, orderBy: [{ createdAt: "desc" }, { id: "asc" }] });
    expect(rows.map((r) => r.rowId)).toEqual(inputs.map((x) => x.rowId));
    expect(new Set(rows.map((r) => r.createdAt.getTime())).size).toBe(1); // 同批同一個 createdAt
  });
});
