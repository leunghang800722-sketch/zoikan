// G2：單條新建重用已取消行（雞頭／內部兩分支）；G4：batch audit 同 shift 同一個 transaction。
import { describe, it, expect, beforeEach } from "vitest";
import { clearAll, prisma } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { POST as createShift } from "@/app/api/shift-records/route";
import { POST as batchSave } from "@/app/api/shift-records/batch/route";

const post = (url: string, cookie: string, body: unknown) =>
  new Request(url, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) });

describe("G2 單條新建重用 cancelled 行", () => {
  let fx: Wp2Fixture;
  let owner: string;
  let broker: string;
  const url = "http://test.local/api/shift-records";
  const body = (guardId: string) => ({ work_date: "2026-08-01", site_id: fx.site.id, shift_type_id: fx.shiftType.id, guard_id: guardId, record_type: "shift" });
  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    owner = await sessionCookieForUser(fx.userIds["老闆"]);
    broker = await sessionCookieForUser(fx.userIds["雞頭"]);
    await prisma.broker.update({ where: { id: fx.brokerA.id }, data: { requiresApproval: true } });
  });

  for (const branch of ["內部", "雞頭"] as const) {
    const cookie = () => (branch === "內部" ? owner : broker);
    // 雞頭只可以開自己 guardA；內部都用 guardA／shiftRecordA
    it(`${branch}：冇行 → 新建 201（無 reused）`, async () => {
      await prisma.shiftRecord.delete({ where: { id: fx.shiftRecordA.id } });
      const res = await createShift(post(url, cookie(), body(fx.guardA.id)));
      expect(res.status).toBe(201);
      const j = await res.json();
      expect(j.reused).toBeUndefined();
      const a = await prisma.auditLog.findMany({ where: { tableName: "shift_records", rowId: j.id } });
      expect(a.map((x) => x.action)).toEqual(["create"]);
    });

    it(`${branch}：cancelled → 重用 201＋reused，id 保留，audit update before/after`, async () => {
      await prisma.shiftRecord.update({ where: { id: fx.shiftRecordA.id }, data: { status: "cancelled", otHours: 2, billed: true } });
      const before = await prisma.shiftRecord.findUniqueOrThrow({ where: { id: fx.shiftRecordA.id } });
      const res = await createShift(post(url, cookie(), body(fx.guardA.id)));
      expect(res.status).toBe(201);
      const j = await res.json();
      expect(j.reused).toBe(true);
      expect(j.id).toBe(fx.shiftRecordA.id);
      const row = await prisma.shiftRecord.findUniqueOrThrow({ where: { id: fx.shiftRecordA.id } });
      expect(row.status).not.toBe("cancelled");
      expect(row.otHours).toBeNull();
      expect(row.billed).toBe(false);
      // provenance 係 SQL NULL（唔係 JSON null）
      const pv = await prisma.$queryRaw<{ isnull: boolean }[]>`SELECT (provenance IS NULL) AS isnull FROM shift_records WHERE id = ${fx.shiftRecordA.id}`;
      expect(pv[0]!.isnull).toBe(true);
      if (branch === "雞頭") expect(row.status).toBe("pending_approval");
      expect(row.createdBy).toBe(before.createdBy);
      expect(row.createdAt.getTime()).toBe(before.createdAt.getTime());
      expect(await prisma.shiftRecord.count({ where: { guardId: fx.guardA.id, workDate: before.workDate, shiftTypeId: fx.shiftType.id } })).toBe(1);
      const audits = await prisma.auditLog.findMany({ where: { tableName: "shift_records", rowId: fx.shiftRecordA.id } });
      expect(audits).toHaveLength(1);
      expect(audits[0]!.action).toBe("update");
      expect((audits[0]!.before as { status?: string }).status).toBe("cancelled");
      expect((audits[0]!.after as { status?: string; reused_cancelled?: boolean }).reused_cancelled).toBe(true);
      expect((audits[0]!.after as { status?: string }).status).toBe(row.status);
    });

    it(`${branch}：重用行舊 snapshot 等於新自動價 → 仍然寫 journal 行`, async () => {
      const run = await prisma.monthCloseRun.create({ data: { month: new Date(Date.UTC(2026, 7, 1)), startedById: fx.userIds["老闆"] } });
      await prisma.rateCard.updateMany({ where: { id: { in: [fx.rateCardBrokerA.id, fx.rateCardGeneric.id] } }, data: { source: `auto:one-click:${run.id}` } });
      // 舊行 snapshot 設成同新自動價一樣（brokerA 卡：client 888／wage 650／fee 60）
      await prisma.shiftRecord.update({ where: { id: fx.shiftRecordA.id }, data: { status: "cancelled", clientRateSnapshot: 888, guardWageSnapshot: 650, brokerFeeSnapshot: 60 } });
      const res = await createShift(post(url, cookie(), body(fx.guardA.id)));
      expect(res.status).toBe(201);
      expect((await res.json()).reused).toBe(true);
      expect(await prisma.monthCloseAutoChange.count({ where: { runId: run.id, kind: "price_snapshots" } })).toBeGreaterThan(0);
    });

    it(`${branch}：非 cancelled → 409，唔改行、唔寫 audit`, async () => {
      const b = await prisma.shiftRecord.findUniqueOrThrow({ where: { id: fx.shiftRecordA.id } });
      const res = await createShift(post(url, cookie(), body(fx.guardA.id)));
      expect(res.status).toBe(409);
      const a = await prisma.shiftRecord.findUniqueOrThrow({ where: { id: fx.shiftRecordA.id } });
      expect(a.updatedAt.getTime()).toBe(b.updatedAt.getTime());
      expect(await prisma.auditLog.count({ where: { tableName: "shift_records", rowId: fx.shiftRecordA.id } })).toBe(0);
    });

    it(`${branch}：鎖月擋住重用，行保持 cancelled`, async () => {
      const locked = await prisma.shiftRecord.create({
        data: { workDate: new Date(Date.UTC(2026, 5, 10)), siteId: fx.site.id, shiftTypeId: fx.shiftType.id, guardId: fx.guardA.id, status: "cancelled", createdBy: "test" },
      });
      const res = await createShift(post(url, cookie(), { ...body(fx.guardA.id), work_date: "2026-06-10" }));
      expect(res.status).toBe(403);
      expect((await prisma.shiftRecord.findUniqueOrThrow({ where: { id: locked.id } })).status).toBe("cancelled");
    });
  }
});

describe("G4 batch audit 同 tx", () => {
  let fx: Wp2Fixture;
  let owner: string;
  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    owner = await sessionCookieForUser(fx.userIds["老闆"]);
  });
  const batch = (cells: unknown[]) => batchSave(post("http://test.local/api/shift-records/batch", owner, { site_id: fx.site.id, month: "2026-08", cells }));

  it("成功：audit 行數＝寫入格數", async () => {
    const before = await prisma.auditLog.count({ where: { tableName: "shift_records" } });
    const res = await batch([
      { guard_id: fx.guardA.id, shift_type_id: fx.shiftType.id, work_date: "2026-08-02", code: "N" },
      { guard_id: fx.guardA.id, shift_type_id: fx.shiftType.id, work_date: "2026-08-03", code: "N" },
    ]);
    expect(res.status).toBe(200);
    expect(await prisma.auditLog.count({ where: { tableName: "shift_records" } })).toBe(before + 2);
  });

  it("tx 中途失敗：shift 同 audit 都 0 行（audit 唔孤兒）", async () => {
    const { writeAuditMany } = await import("@/lib/audit");
    void writeAuditMany;
    // 令 audit createMany 失敗（id 撞：預先塞一行同 id 唔可能預測）→ 改用 mock：令 auditLog.createMany throw
    const orig = prisma.auditLog.createMany;
    // 只攔 tx 內 createMany：tx client 係 extension 之 proxy，唯一可靠方法係令 DB 拒絕——用 trigger
    await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION g4_fail() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'g4 forced failure'; END; $$ LANGUAGE plpgsql`);
    await prisma.$executeRawUnsafe(`CREATE TRIGGER g4_fail_trg BEFORE INSERT ON audit_log FOR EACH ROW WHEN (NEW.table_name = 'shift_records') EXECUTE FUNCTION g4_fail()`);
    try {
      const auditBefore = await prisma.auditLog.count({ where: { tableName: "shift_records", action: "create" } });
      const sr = await prisma.shiftRecord.count({ where: { workDate: { gte: new Date("2026-08-02"), lte: new Date("2026-08-10") } } });
      const res = await batch([
        { guard_id: fx.guardA.id, shift_type_id: fx.shiftType.id, work_date: "2026-08-04", code: "N" },
        { guard_id: fx.guardB.id, shift_type_id: fx.shiftType.id, work_date: "2026-08-04", code: "N" },
      ]);
      expect(res.status).toBeGreaterThanOrEqual(500);
      expect(await prisma.shiftRecord.count({ where: { workDate: { gte: new Date("2026-08-02"), lte: new Date("2026-08-10") } } })).toBe(sr);
      expect(await prisma.auditLog.count({ where: { tableName: "shift_records", action: "create" } })).toBe(auditBefore);
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS g4_fail_trg ON audit_log`);
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS g4_fail()`);
      void orig;
    }
  });

  it("鎖月：batch 被擋，shift／audit 都冇寫入", async () => {
    const before = await prisma.auditLog.count({ where: { tableName: "shift_records", action: "create" } });
    const res = await batchSave(post("http://test.local/api/shift-records/batch", owner, { site_id: fx.site.id, month: "2026-06", cells: [{ guard_id: fx.guardA.id, shift_type_id: fx.shiftType.id, work_date: "2026-06-02", code: "N" }] }));
    expect(res.status).toBe(403);
    expect(await prisma.shiftRecord.count({ where: { workDate: new Date("2026-06-02") } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { tableName: "shift_records", action: "create" } })).toBe(before);
  });
});
