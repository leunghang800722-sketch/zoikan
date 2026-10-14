// P18：長工糧更表來源優先次序（aggregate 只改紀錄挑選）＋「出勤修正」面板 API（attendance-issues、batch 人手紀錄、歸公司兵）。合成資料。
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { buildLongtermPayrollInputs, attendanceConflictNote } from "@/lib/longterm-payroll/aggregate";
import { pickBySourcePriority, sourceRank } from "@/lib/longterm-payroll/attendance-priority";
import { POST as batchSave } from "@/app/api/shift-records/batch/route";
import { GET as issuesGet } from "@/app/api/longterm/attendance-issues/route";

const d = (day: number) => new Date(Date.UTC(2026, 7, day));
const MONTH = new Date(Date.UTC(2026, 7, 1));

describe("P18.1 來源優先次序（純函數）", () => {
  it("rank：manual < roster_upload < master_roster < payroll_only < 其他／null", () => {
    expect([sourceRank("manual"), sourceRank("roster_upload"), sourceRank("master_roster"), sourceRank("payroll_only"), sourceRank("xyz"), sourceRank(null)]).toEqual([0, 1, 2, 3, 4, 4]);
  });
  it("三來源衝突日只留最高來源；OT 不受影響；同來源雙更全留", () => {
    const rows = [
      { workDate: d(21), recordType: "leave", leaveCode: "NL", source: "master_roster" },
      { workDate: d(21), recordType: "leave", leaveCode: "RD", source: "master_roster" },
      { workDate: d(21), recordType: "leave", leaveCode: "AL", source: "roster_upload" },
      { workDate: d(21), recordType: "ot", leaveCode: null, source: "payroll_only" },
      { workDate: d(22), recordType: "shift", leaveCode: null, source: "roster_upload" },
      { workDate: d(22), recordType: "shift", leaveCode: null, source: "roster_upload" },
      { workDate: d(23), recordType: "leave", leaveCode: "SL", source: null },
    ];
    const { picked, adoptions } = pickBySourcePriority(rows);
    expect(picked).toEqual([rows[2], rows[3], rows[4], rows[5], rows[6]]);
    expect(adoptions.get("2026-08-21")).toEqual({ adopted: "roster_upload", ignored: ["master_roster"] });
    expect(adoptions.has("2026-08-22")).toBe(false);
    const n = attendanceConflictNote(rows.slice(0, 3))!;
    expect(n).toContain("已採用：來源 roster_upload");
  });
});

describe("P18 aggregate／面板 API", () => {
  afterAll(async () => {
    await clearAll();
    await prisma.$disconnect();
  });
  let fx: Wp2Fixture;
  let owner: string;
  let guardId: string;
  let b07Id: string;
  let otherBrokerId: string;
  let stD: string;

  async function mkRec(day: number, source: string | null, rec: { recordType: "shift" | "leave"; leaveCode?: "AL" | "NL" | "RD" | "SL" | "SH"; shiftTypeId?: string; brokerId?: string | null }) {
    return prisma.shiftRecord.create({
      data: {
        workDate: d(day), siteId: fx.site.id, shiftTypeId: rec.shiftTypeId ?? fx.shiftType.id, guardId, recordType: rec.recordType, leaveCode: rec.leaveCode ?? null,
        settlementBrokerId: rec.brokerId === undefined ? b07Id : rec.brokerId, operationalBrokerId: rec.brokerId === undefined ? b07Id : rec.brokerId, source, createdBy: "test",
      },
    });
  }
  const line = async () => (await buildLongtermPayrollInputs(MONTH)).lines.find((l) => l.guardId === guardId)!;
  const batch = (body: unknown) => batchSave(new Request("http://t/api/shift-records/batch", { method: "POST", headers: { "content-type": "application/json", cookie: owner }, body: JSON.stringify(body) }));
  const issues = async () => (await issuesGet(new Request("http://t/api/longterm/attendance-issues?month=2026-08-01", { headers: { cookie: owner } }))).json();

  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    owner = await sessionCookieForUser(fx.userIds["老闆"]);
    stD = (await prisma.shiftType.create({ data: { siteId: fx.site.id, code: "D2", hours: 12, createdBy: "test" } })).id;
    const b07 = await prisma.broker.create({ data: { code: `T-B07-${Math.random().toString(36).slice(2, 6)}`, name: "測試內部長工桶", kind: "internal_longterm", settlementType: "salary", createdBy: "test" } });
    b07Id = b07.id;
    otherBrokerId = (await prisma.broker.create({ data: { code: `T-K-${Math.random().toString(36).slice(2, 6)}`, name: "測試雞頭", kind: "external", settlementType: "cash", createdBy: "test" } })).id;
    const g = await prisma.guard.create({ data: { nameZh: "測試長工-優先", employmentType: "longterm_autopay", hireDate: new Date("2020-01-01"), createdBy: "test" } });
    guardId = g.id;
    await prisma.guardLongtermContract.create({ data: { guardId, monthlySalary: 15500, effectiveFrom: new Date("2020-01-01"), effectiveTo: null, source: "manual", createdBy: fx.userIds["老闆"] } });
  });

  it("三來源衝突日只用最高來源；無衝突不變；同來源雙更照計", async () => {
    for (let day = 1; day <= 10; day++) await mkRec(day, "roster_upload", { recordType: "shift" });
    const base = await line();
    expect(base.workDays).toBe(10);
    // 7/21 風格：master_roster 有 NL＋RD，payroll_only 有 AL，roster_upload 有班（day 5）——最高來源 roster_upload＝班
    const st3 = (await prisma.shiftType.create({ data: { siteId: fx.site.id, code: "D3", hours: 12, createdBy: "test" } })).id;
    const st4 = (await prisma.shiftType.create({ data: { siteId: fx.site.id, code: "D4", hours: 12, createdBy: "test" } })).id;
    await mkRec(5, "master_roster", { recordType: "leave", leaveCode: "NL", shiftTypeId: stD });
    await mkRec(5, "master_roster", { recordType: "leave", leaveCode: "RD", shiftTypeId: st3 });
    await mkRec(5, "payroll_only", { recordType: "leave", leaveCode: "AL", shiftTypeId: st4 });
    const after = await line();
    expect(after.workDays).toBe(10);
    expect(after.nplDays).toBe(base.nplDays);
    expect(after.netBasic).toBe(base.netBasic);
    expect(after.notes.some((x) => x.includes("已採用：來源 roster_upload"))).toBe(true);
    // 同來源雙更：同日兩條 roster_upload 班（不同更別）→ 仍同一日 1 個返工日
    await mkRec(6, "roster_upload", { recordType: "shift", shiftTypeId: stD });
    expect((await line()).workDays).toBe(10);
  });

  it("人手紀錄（batch 寫 source=manual）蓋過 roster_upload：NL 日數隨之變；面板 API 列出衝突日＋影響", async () => {
    for (let day = 1; day <= 10; day++) await mkRec(day, "roster_upload", { recordType: "shift" });
    await mkRec(4, "master_roster", { recordType: "leave", leaveCode: "NL", shiftTypeId: stD });
    const before = await line();
    expect(before.nplDays ?? 0).toBe(0);
    const i1 = await issues();
    expect(i1.conflicts).toHaveLength(1);
    const c = i1.conflicts[0];
    expect(c.date).toBe("2026-08-04");
    expect(c.adopted_source).toBe("roster_upload");
    expect(c.entries.map((e: { source: string; code: string }) => `${e.source}:${e.code}`)).toEqual(["roster_upload:班", "master_roster:NL"]);
    expect(c.effect).toBe("work");
    const nl = c.options.find((o: { code: string }) => o.code === "NL");
    expect(nl).toMatchObject({ batch_code: "NL", effect: "unpaid" });
    // 採用 NL：寫到最高來源紀錄所在格
    const res = await batch({ site_id: c.target.site_id, month: "2026-08", cells: [{ guard_id: guardId, shift_type_id: c.target.shift_type_id, work_date: c.date, code: nl.batch_code }] });
    expect(res.status).toBe(200);
    const rec = await prisma.shiftRecord.findFirstOrThrow({ where: { guardId, workDate: d(4), shiftTypeId: fx.shiftType.id } });
    expect(rec).toMatchObject({ source: "manual", recordType: "leave", leaveCode: "NL" });
    expect(await prisma.shiftRecord.count({ where: { guardId, workDate: d(4), status: { not: "cancelled" } } })).toBe(2); // 唔作廢任何紀錄（最高來源嗰條就地改成人手，舊內容留喺 audit before）
    expect(await prisma.auditLog.count({ where: { tableName: "shift_records", rowId: rec.id, action: "update" } })).toBeGreaterThan(0);
    const after = await line();
    expect(after.workDays).toBe(9);
    expect(after.nplDays).toBe(1);
    expect((await issues()).conflicts).toHaveLength(0); // 人手 NL 同 master_roster NL 一致→衝突已解決
  });

  it("batch：只改結算單位唔蓋 source；新建記錄 source=manual", async () => {
    const r = await mkRec(2, "roster_upload", { recordType: "shift", brokerId: otherBrokerId });
    await batch({ site_id: fx.site.id, month: "2026-08", cells: [{ guard_id: guardId, shift_type_id: fx.shiftType.id, work_date: "2026-08-02", code: "N", settlement_broker_id: b07Id }] });
    expect((await prisma.shiftRecord.findUniqueOrThrow({ where: { id: r.id } })).source).toBe("roster_upload");
    await batch({ site_id: fx.site.id, month: "2026-08", cells: [{ guard_id: guardId, shift_type_id: fx.shiftType.id, work_date: "2026-08-03", code: "AL" }] });
    expect((await prisma.shiftRecord.findFirstOrThrow({ where: { guardId, workDate: d(3) } })).source).toBe("manual");
  });

  it("全部更歸雞頭：面板列出；歸公司兵（batch 設 B07）→ 返工日由 0 變 N；簽證形式長工唔列", async () => {
    for (let day = 1; day <= 8; day++) await mkRec(day, "roster_upload", { recordType: "shift", brokerId: otherBrokerId });
    expect((await line()).workDays).toBe(0);
    const i1 = await issues();
    expect(i1.misattributed).toHaveLength(1);
    expect(i1.misattributed[0]).toMatchObject({ guard_id: guardId, shift_days: 8 });
    expect(i1.internal_longterm_broker_id).toBe(b07Id);
    const m = i1.misattributed[0];
    const res = await batch({
      site_id: m.cells[0].site_id,
      month: "2026-08",
      cells: m.cells.map((c: { shift_type_id: string; shift_type_code: string; date: string }) => ({ guard_id: guardId, shift_type_id: c.shift_type_id, work_date: c.date, code: c.shift_type_code, settlement_broker_id: b07Id })),
    });
    expect(res.status).toBe(200);
    expect((await line()).workDays).toBe(8);
    expect((await issues()).misattributed).toHaveLength(0);
    // 簽證形式長工：歸贊助雞頭，唔列
    await prisma.shiftRecord.updateMany({ where: { guardId }, data: { settlementBrokerId: otherBrokerId } });
    await prisma.guard.update({ where: { id: guardId }, data: { visaSponsoredByBrokerId: otherBrokerId } });
    expect((await issues()).misattributed).toHaveLength(0);
  });

  it("已鎖月份：batch 寫入被擋（面板唯讀）；GET 要帶 month", async () => {
    await mkRec(2, "roster_upload", { recordType: "shift" });
    const lockedRes = await batch({ site_id: fx.site.id, month: "2026-06", cells: [{ guard_id: guardId, shift_type_id: fx.shiftType.id, work_date: "2026-06-02", code: "AL" }] });
    expect(lockedRes.status).toBe(403);
    expect((await issuesGet(new Request("http://t/api/longterm/attendance-issues", { headers: { cookie: owner } }))).status).toBe(400);
    const lockedList = await (await issuesGet(new Request("http://t/api/longterm/attendance-issues?month=2026-06-01", { headers: { cookie: owner } }))).json();
    expect(lockedList.locked).toBe(true);
  });
});
