// W2：共用排更 write service（src/lib/shift-records/write.ts）——writeShiftCells／cancelShiftRecordsTx。
// batch route 嘅行為由原有 batch tests（p3-2-batch-write 等）原樣覆蓋；呢度測 WhatsApp 入口：
// pending_approval／confirmed、source／provenance、鎖月、重用已取消行、已存在 no-op、衝突、rollback、請假格、取消舊記錄。
// 全部假資料（wp2 fixture）。
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { cancelShiftRecordsTx, writeShiftCells } from "@/lib/shift-records/write";

let fx: Wp2Fixture;
const D = (iso: string) => new Date(`${iso}T00:00:00Z`);
const PROV = { message_id: "m-w2", revision: 1, intent_idx: 0, triage_question_id: "q-w2" };

function write(over: Partial<Parameters<typeof writeShiftCells>[1]> = {}, cells?: Array<{ guard_id: string; shift_type_id: string; work_date: Date; code: string | null }>) {
  return prisma.$transaction((tx) =>
    writeShiftCells(tx, {
      siteId: fx.site.id,
      month: D("2026-10-01"),
      cells: cells ?? [{ guard_id: fx.guardA.id, shift_type_id: fx.shiftType.id, work_date: D("2026-10-20"), code: "N" }],
      actor: { userId: fx.userIds["老闆"] },
      source: "whatsapp",
      provenance: PROV,
      statusPolicy: "pending_approval",
      ...over,
    }),
  );
}

beforeEach(async () => {
  await clearAll();
  fx = await seedWp2Fixture();
});

describe("W2 writeShiftCells", () => {
  it("pending_approval：source／provenance／createdBy／計價 snapshot／結算單位 fallback／audit", async () => {
    const r = await write();
    expect(r.results).toHaveLength(1);
    expect(r.results[0]).toMatchObject({ action: "created" });
    const row = await prisma.shiftRecord.findUniqueOrThrow({ where: { id: r.results[0]!.id } });
    expect(row).toMatchObject({ status: "pending_approval", source: "whatsapp", recordType: "shift", leaveCode: null, createdBy: fx.userIds["老闆"], settlementBrokerId: fx.brokerA.id });
    expect(row.provenance).toEqual(PROV);
    expect(Number(row.clientRateSnapshot)).toBe(888); // 雞頭 A 專屬卡
    expect(Number(row.guardWageSnapshot)).toBe(650);
    expect(r.pricing).toEqual({ priced: 1, unpriced: 0 });
    expect(r.noSettlementCount).toBe(0);
    const audits = await prisma.auditLog.findMany({ where: { tableName: "shift_records", rowId: row.id } });
    expect(audits.map((a) => a.action)).toEqual(["create"]);
  });

  it("statusPolicy=confirmed → confirmed", async () => {
    const r = await write({ statusPolicy: "confirmed" });
    expect((await prisma.shiftRecord.findUniqueOrThrow({ where: { id: r.results[0]!.id } })).status).toBe("confirmed");
  });

  it("鎖月：tx 內 assertMonthNotLockedTx → 拒絕、冇寫入", async () => {
    await expect(write({ month: fx.lockedMonth }, [{ guard_id: fx.guardA.id, shift_type_id: fx.shiftType.id, work_date: D("2026-06-10"), code: "N" }])).rejects.toMatchObject({ code: "month_locked" });
    expect(await prisma.shiftRecord.count({ where: { workDate: D("2026-06-10") } })).toBe(0);
  });

  it("重用已取消行：同一行 id 還原成 pending_approval，source 變 whatsapp，audit=update", async () => {
    const old = await prisma.shiftRecord.create({ data: { workDate: D("2026-10-21"), siteId: fx.site.id, shiftTypeId: fx.shiftType.id, guardId: fx.guardA.id, recordType: "shift", status: "cancelled", source: "manual", createdBy: "test:w2" } });
    const r = await write({}, [{ guard_id: fx.guardA.id, shift_type_id: fx.shiftType.id, work_date: D("2026-10-21"), code: "N" }]);
    expect(r.results[0]).toMatchObject({ id: old.id, action: "updated" });
    const row = await prisma.shiftRecord.findUniqueOrThrow({ where: { id: old.id } });
    expect(row).toMatchObject({ status: "pending_approval", source: "whatsapp" });
    expect(row.provenance).toEqual(PROV);
    expect((await prisma.auditLog.findMany({ where: { tableName: "shift_records", rowId: old.id } })).map((a) => a.action)).toEqual(["update"]);
    expect(await prisma.shiftRecord.count({ where: { guardId: fx.guardA.id, workDate: D("2026-10-21") } })).toBe(1);
  });

  it("已存在、完全相同嘅非取消記錄 → no-op（action=exists），唔改狀態／來源", async () => {
    const ex = await prisma.shiftRecord.create({ data: { workDate: D("2026-10-22"), siteId: fx.site.id, shiftTypeId: fx.shiftType.id, guardId: fx.guardA.id, recordType: "shift", status: "confirmed", source: "manual", createdBy: "test:w2" } });
    const r = await write({}, [{ guard_id: fx.guardA.id, shift_type_id: fx.shiftType.id, work_date: D("2026-10-22"), code: "N" }]);
    expect(r.results).toEqual([{ key: `${fx.guardA.id}|2026-10-22|${fx.shiftType.id}`, id: ex.id, action: "exists" }]);
    expect(await prisma.shiftRecord.findUniqueOrThrow({ where: { id: ex.id } })).toMatchObject({ status: "confirmed", source: "manual" });
    expect(await prisma.auditLog.count({ where: { tableName: "shift_records", rowId: ex.id } })).toBe(0);
  });

  it("同格已有唔同類型（請假 vs 更）：預設 409；overwriteActive=true 先覆寫", async () => {
    const ex = await prisma.shiftRecord.create({ data: { workDate: D("2026-10-23"), siteId: fx.site.id, shiftTypeId: fx.shiftType.id, guardId: fx.guardA.id, recordType: "leave", leaveCode: "AL", status: "confirmed", createdBy: "test:w2" } });
    await expect(write({}, [{ guard_id: fx.guardA.id, shift_type_id: fx.shiftType.id, work_date: D("2026-10-23"), code: "N" }])).rejects.toMatchObject({ status: 409 });
    expect(await prisma.shiftRecord.findUniqueOrThrow({ where: { id: ex.id } })).toMatchObject({ recordType: "leave", leaveCode: "AL" });
    await write({ overwriteActive: true }, [{ guard_id: fx.guardA.id, shift_type_id: fx.shiftType.id, work_date: D("2026-10-23"), code: "N" }]);
    expect(await prisma.shiftRecord.findUniqueOrThrow({ where: { id: ex.id } })).toMatchObject({ recordType: "shift", leaveCode: null, status: "pending_approval" });
  });

  it("請假格：code=SL → record_type=leave；唔計未定價", async () => {
    const r = await write({}, [{ guard_id: fx.guardA.id, shift_type_id: fx.shiftType.id, work_date: D("2026-10-24"), code: "SL" }]);
    expect(await prisma.shiftRecord.findUniqueOrThrow({ where: { id: r.results[0]!.id } })).toMatchObject({ recordType: "leave", leaveCode: "SL", status: "pending_approval", source: "whatsapp" });
    expect(r.pricing).toEqual({ priced: 0, unpriced: 0 });
  });

  it("驗證失敗（錯 code／跨月／唔存在 guard）→ 400 且整批 rollback（含 audit）", async () => {
    const before = await prisma.auditLog.count({ where: { tableName: "shift_records" } });
    const good = { guard_id: fx.guardA.id, shift_type_id: fx.shiftType.id, work_date: D("2026-10-25"), code: "N" };
    await expect(write({}, [good, { ...good, work_date: D("2026-10-26"), code: "ZZ" }])).rejects.toMatchObject({ status: 400 });
    await expect(write({}, [good, { ...good, work_date: D("2026-11-02") }])).rejects.toMatchObject({ status: 400 });
    await expect(write({}, [{ ...good, guard_id: "no-such-guard" }])).rejects.toMatchObject({ status: 400 });
    expect(await prisma.shiftRecord.count({ where: { workDate: D("2026-10-25") } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { tableName: "shift_records" } })).toBe(before);
  });

  it("PR 佔位更別唔可以新建；一批多格一條 audit createMany", async () => {
    const pr = await prisma.shiftType.create({ data: { siteId: fx.site.id, code: "PR", label: "對數佔位", hours: 0, createdBy: "test:w2" } });
    await expect(write({}, [{ guard_id: fx.guardA.id, shift_type_id: pr.id, work_date: D("2026-10-25"), code: "PR" }])).rejects.toMatchObject({ status: 400 });
    const r = await write({}, [
      { guard_id: fx.guardA.id, shift_type_id: fx.shiftType.id, work_date: D("2026-10-27"), code: "N" },
      { guard_id: fx.guardB.id, shift_type_id: fx.shiftType.id, work_date: D("2026-10-27"), code: "N" },
    ]);
    expect(r.results.map((x) => x.action)).toEqual(["created", "created"]);
    expect(await prisma.auditLog.count({ where: { tableName: "shift_records", rowId: { in: r.results.map((x) => x.id) } } })).toBe(2);
  });
});

describe("W2 cancelShiftRecordsTx", () => {
  it("作廢（冇刪除）＋audit action=void、after.void_reason；已取消嘅唔重覆", async () => {
    const a = await prisma.shiftRecord.create({ data: { workDate: D("2026-10-28"), siteId: fx.site.id, shiftTypeId: fx.shiftType.id, guardId: fx.guardA.id, recordType: "shift", status: "confirmed", createdBy: "test:w2" } });
    const n = await prisma.$transaction((tx) => cancelShiftRecordsTx(tx, { ids: [a.id], actorUserId: fx.userIds["老闆"], reason: "whatsapp:use_whatsapp" }));
    expect(n).toBe(1);
    expect((await prisma.shiftRecord.findUniqueOrThrow({ where: { id: a.id } })).status).toBe("cancelled");
    const au = await prisma.auditLog.findMany({ where: { tableName: "shift_records", rowId: a.id } });
    expect(au.map((x) => x.action)).toEqual(["void"]);
    expect(JSON.stringify(au[0]!.after)).toContain("whatsapp:use_whatsapp");
    expect(await prisma.$transaction((tx) => cancelShiftRecordsTx(tx, { ids: [a.id], actorUserId: fx.userIds["老闆"], reason: "x" }))).toBe(0);
  });
});
