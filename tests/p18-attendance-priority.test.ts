// P18：長工糧更表來源優先次序（aggregate 只改紀錄挑選）＋「出勤修正」面板 API（attendance-issues、batch 人手紀錄、歸公司兵）。合成資料。
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { buildLongtermPayrollInputs, attendanceConflictNote } from "@/lib/longterm-payroll/aggregate";
import { pickBySourcePriority, sourceRank } from "@/lib/longterm-payroll/attendance-priority";
import { POST as batchSave } from "@/app/api/shift-records/batch/route";
import { GET as issuesGet } from "@/app/api/longterm/attendance-issues/route";
import { POST as fixPost } from "@/app/api/longterm/attendance-fix/route";
import { POST as shiftPost } from "@/app/api/shift-records/route";
import { generateLongtermInputDrafts } from "@/lib/longterm-payroll/drafts";
import { listSlPending } from "@/lib/longterm-payroll/sl-confirm";
import { listAttendanceBonusEligible } from "@/lib/longterm-payroll/drafts";
import { loadCoverShifts } from "@/lib/longterm-payroll/cover-shifts";
import { ensureSystemUser } from "@/lib/system-user";

const d = (day: number) => new Date(Date.UTC(2026, 7, day));
const MONTH = new Date(Date.UTC(2026, 7, 1));

describe("P18.1 來源優先次序（純函數）", () => {
  it("rank：manual < roster_upload < master_roster < payroll_only < 其他／null", () => {
    expect([sourceRank("manual"), sourceRank("roster_upload"), sourceRank("master_roster"), sourceRank("payroll_only"), sourceRank("xyz"), sourceRank(null)]).toEqual([0, 1, 2, 3, 4, 4]);
    expect([sourceRank("master_roster_only"), sourceRank("master_roster_site"), sourceRank("payroll")]).toEqual([2, 2, 3]);
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
  const fix = (cookie: string, actions: unknown[], month = "2026-08") =>
    fixPost(new Request("http://t/api/longterm/attendance-fix", { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ month, actions }) }));
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
    expect(nl).toMatchObject({ set_code: "NL", effect: "unpaid" });
    // 採用 NL：寫到最高來源紀錄所在格（會計亦得——長工糧:update）
    const acct = await sessionCookieForUser(fx.userIds["會計"]);
    const res = await fix(acct, [{ guard_id: guardId, work_date: c.date, site_id: c.target.site_id, shift_type_id: c.target.shift_type_id, set_code: nl.set_code }]);
    expect(res.status).toBe(200);
    expect((await res.json()).noop).toBe(false);
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
    const acct = await sessionCookieForUser(fx.userIds["會計"]);
    const res = await fix(acct, m.cells.map((c: { site_id: string; date: string }) => ({ guard_id: guardId, work_date: c.date, site_id: c.site_id, settle_internal: true })));
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

  it("M1：SL 草稿跟來源優先次序——7/16 upload 班 vs master SL → aggregate 當返工、草稿唔生成、sl-pending 0；最高來源係 SL 先生成", async () => {
    const sysId = await ensureSystemUser();
    for (let day = 1; day <= 10; day++) await mkRec(day, "roster_upload", { recordType: "shift" });
    await mkRec(5, "master_roster", { recordType: "leave", leaveCode: "SL", shiftTypeId: stD });
    const gross0 = (await line()).gross;
    await generateLongtermInputDrafts(MONTH, sysId);
    expect(await prisma.longtermPayrollInput.count({ where: { guardId, kind: "leave", draftSource: "roster_leave:SL" } })).toBe(0);
    expect((await listSlPending(MONTH)).segment_count).toBe(0);
    expect((await line()).gross).toBe(gross0);
    // 反過來：最高來源係 SL（roster_upload SL vs master 班）→ 生成草稿
    await mkRec(12, "roster_upload", { recordType: "leave", leaveCode: "SL", shiftTypeId: stD });
    await mkRec(12, "master_roster", { recordType: "shift" });
    await generateLongtermInputDrafts(MONTH, sysId);
    const dr = await prisma.longtermPayrollInput.findMany({ where: { guardId, draftSource: "roster_leave:SL", voidedAt: null } });
    expect(dr).toHaveLength(1);
    expect(dr[0]!.dateFrom).toBe("2026-08-12");
  });

  it("M2：權限——會計 200；主管／雞頭 403；已鎖月 403；can_update 旗；非長工 400", async () => {
    await mkRec(4, "roster_upload", { recordType: "shift" });
    await mkRec(4, "master_roster", { recordType: "leave", leaveCode: "NL", shiftTypeId: stD });
    const act = [{ guard_id: guardId, work_date: "2026-08-04", site_id: fx.site.id, set_code: "NL" }];
    expect((await fix(await sessionCookieForUser(fx.userIds["主管"]), act)).status).toBe(403);
    expect((await fix(await sessionCookieForUser(fx.userIds["雞頭"]), act)).status).toBe(403);
    const acct = await sessionCookieForUser(fx.userIds["會計"]);
    const iss = await (await issuesGet(new Request("http://t/api/longterm/attendance-issues?month=2026-08-01", { headers: { cookie: acct } }))).json();
    expect(iss.can_update).toBe(true);
    expect((await fix(acct, [{ guard_id: fx.guardA.id, work_date: "2026-08-04", site_id: fx.site.id, set_code: "NL" }])).status).toBe(400); // 非長工
    expect((await fix(acct, act, "2026-06")).status).toBe(403); // 已鎖月
    expect((await fix(acct, act)).status).toBe(200);
  });

  it("ii.1：採用 X 而最高來源已係 X → noop:true 唔改；最高來源內有唔同代號嗰條會被揀去改", async () => {
    await mkRec(4, "roster_upload", { recordType: "shift" });
    await mkRec(4, "master_roster", { recordType: "leave", leaveCode: "NL", shiftTypeId: stD });
    const act = (code: string) => [{ guard_id: guardId, work_date: "2026-08-04", site_id: fx.site.id, set_code: code }];
    const r1 = await (await fix(owner, act("SHIFT"))).json();
    expect(r1).toMatchObject({ noop: true, updated: 0 });
    expect(await prisma.shiftRecord.count({ where: { guardId, source: "manual" } })).toBe(0);
    // 最高來源同日兩條唔同代號（班＋RD）→ 採用 RD：改去代號唔同嗰條（班）
    const st3 = (await prisma.shiftType.create({ data: { siteId: fx.site.id, code: "D3", hours: 12, createdBy: "test" } })).id;
    await mkRec(4, "roster_upload", { recordType: "leave", leaveCode: "RD", shiftTypeId: st3 });
    const r2 = await (await fix(owner, act("RD"))).json();
    expect(r2).toMatchObject({ noop: false, updated: 1 });
    expect((await prisma.shiftRecord.findFirstOrThrow({ where: { guardId, workDate: d(4), shiftTypeId: fx.shiftType.id } })).leaveCode).toBe("RD");
  });

  it("ii.3：按 (日, 盤) 分組——同日唔同盤各自揀最高來源，兩邊都保留", async () => {
    const site2 = await prisma.site.create({ data: { canonicalName: `測試盤二-${Math.random().toString(36).slice(2, 6)}`, clientName: "測試客戶", billingModel: "per_shift", createdBy: "test" } });
    const st2 = await prisma.shiftType.create({ data: { siteId: site2.id, code: "N", hours: 12, createdBy: "test" } });
    for (let day = 1; day <= 5; day++) await mkRec(day, "roster_upload", { recordType: "shift" });
    // 5 號盤二有頂位更（master_roster 班，低來源）——舊行為會被盤一 roster_upload 蓋走；新行為兩盤各自保留
    await prisma.shiftRecord.create({ data: { workDate: d(8), siteId: site2.id, shiftTypeId: st2.id, guardId, recordType: "shift", settlementBrokerId: otherBrokerId, operationalBrokerId: otherBrokerId, source: "master_roster", createdBy: "test" } });
    await mkRec(8, "roster_upload", { recordType: "shift" });
    const l = await line();
    expect(l.workDays).toBe(6); // 1-5 + 8（盤一）；盤二 8 號係頂位更唔計返工日，但冇被盤一蓋走
    const picked = pickBySourcePriority([
      { workDate: d(8), recordType: "shift", source: "roster_upload", siteId: "A" },
      { workDate: d(8), recordType: "shift", source: "master_roster", siteId: "B" },
    ]);
    expect(picked.picked).toHaveLength(2);
  });

  it("ii.4：單條 POST /api/shift-records 新建寫 source=manual；PATCH 改代號寫 manual", async () => {
    const res = await shiftPost(new Request("http://t/api/shift-records", { method: "POST", headers: { "content-type": "application/json", cookie: owner }, body: JSON.stringify({ work_date: "2026-08-09", site_id: fx.site.id, shift_type_id: fx.shiftType.id, guard_id: guardId, settlement_broker_id: b07Id, operational_broker_id: b07Id }) }));
    expect(res.status).toBe(201);
    const rec = await prisma.shiftRecord.findFirstOrThrow({ where: { guardId, workDate: d(9) } });
    expect(rec.source).toBe("manual");
    const { PATCH } = await import("@/app/api/shift-records/[id]/route");
    const other = await mkRec(11, "roster_upload", { recordType: "shift" });
    const p = await PATCH(new Request("http://t/x", { method: "PATCH", headers: { "content-type": "application/json", cookie: owner }, body: JSON.stringify({ record_type: "leave", leave_code: "AL" }) }), { params: Promise.resolve({ id: other.id }) });
    expect(p.status).toBe(200);
    expect((await prisma.shiftRecord.findUniqueOrThrow({ where: { id: other.id } })).source).toBe("manual");
  });

  it("M4：跨盤 leave 錯配——upload 班@盤A vs master SL@盤B 同日 → SL 忽略（草稿 0、npsl 0、workDays 不變）；反向（upload SL@B vs master 班@A）→ 生成草稿", async () => {
    const sysId = await ensureSystemUser();
    const site2 = await prisma.site.create({ data: { canonicalName: `測試盤二-${Math.random().toString(36).slice(2, 6)}`, clientName: "測試客戶", billingModel: "per_shift", createdBy: "test" } });
    const st2 = await prisma.shiftType.create({ data: { siteId: site2.id, code: "N", hours: 12, createdBy: "test" } });
    for (let day = 1; day <= 10; day++) await mkRec(day, "roster_upload", { recordType: "shift" });
    const base0 = await line();
    await prisma.shiftRecord.create({ data: { workDate: d(3), siteId: site2.id, shiftTypeId: st2.id, guardId, recordType: "leave", leaveCode: "SL", source: "master_roster", createdBy: "test" } });
    await prisma.shiftRecord.create({ data: { workDate: d(4), siteId: site2.id, shiftTypeId: st2.id, guardId, recordType: "leave", leaveCode: "NL", source: "master_roster", createdBy: "test" } });
    const l = await line();
    expect(l.workDays).toBe(base0.workDays);
    expect(l.nplDays).toBe(base0.nplDays);
    expect(l.gross).toBe(base0.gross);
    await generateLongtermInputDrafts(MONTH, sysId);
    expect(await prisma.longtermPayrollInput.count({ where: { guardId, draftSource: "roster_leave:SL" } })).toBe(0);
    expect((await listSlPending(MONTH)).segment_count).toBe(0);
    // 反向：最高來源（roster_upload）係盤B 嘅 SL，低來源 master 班@盤A → SL 保留
    await prisma.shiftRecord.create({ data: { workDate: d(12), siteId: site2.id, shiftTypeId: st2.id, guardId, recordType: "leave", leaveCode: "SL", source: "roster_upload", createdBy: "test" } });
    await mkRec(12, "master_roster", { recordType: "shift" });
    await generateLongtermInputDrafts(MONTH, sysId);
    expect(await prisma.longtermPayrollInput.count({ where: { guardId, draftSource: "roster_leave:SL", voidedAt: null } })).toBe(1);
    // 驗收修正 3：最高級來源當日只有 leave → 低級來源嘅 shift（任何盤）唔計——12 號 master 班@盤A 被忽略，workDays 唔計該日
    const picked = pickBySourcePriority(await prisma.shiftRecord.findMany({ where: { guardId, workDate: d(12) } }));
    expect(picked.picked.map((r) => r.recordType)).toEqual(["leave"]);
    const wd = (await line()).workDays;
    expect(wd).toBe(10); // 1–10 號 roster_upload 班；12 號 master 班唔計
  });

  it("驗收修正 3：最高級有 shift 時 shift 仍按（日, 盤）保留兩邊；頂位班被最高級 leave 蓋走唔計", async () => {
    const r = [
      { workDate: d(8), recordType: "shift", source: "roster_upload", siteId: "A" },
      { workDate: d(8), recordType: "shift", source: "master_roster", siteId: "B" },
      { workDate: d(8), recordType: "leave", source: "master_roster", siteId: "B" },
    ];
    expect(pickBySourcePriority(r).picked).toEqual([r[0], r[1]]); // 最高級有 shift@A → shift@B 按盤分組保留；低級 leave 被忽略
    const only = pickBySourcePriority([
      { workDate: d(9), recordType: "leave", source: "roster_upload", siteId: "A" },
      { workDate: d(9), recordType: "shift", source: "master_roster", siteId: "B" },
    ]);
    expect(only.picked.map((x) => x.recordType)).toEqual(["leave"]);
  });

  it("M5：勤工獎資格跟來源優先次序——被忽略嘅低來源 SL 唔取消資格；最高來源 SL 先取消", async () => {
    for (let day = 1; day <= 5; day++) await mkRec(day, "roster_upload", { recordType: "shift" });
    await mkRec(3, "master_roster", { recordType: "leave", leaveCode: "SL", shiftTypeId: stD });
    expect((await listAttendanceBonusEligible(MONTH)).eligible.some((e) => e.guard_id === guardId)).toBe(true);
    await mkRec(7, "roster_upload", { recordType: "leave", leaveCode: "SL", shiftTypeId: stD });
    expect((await listAttendanceBonusEligible(MONTH)).eligible.some((e) => e.guard_id === guardId)).toBe(false);
  });

  it("(ii)a：頂位津貼 cover-shifts 先跟優先次序——同盤兩來源都有頂位班只計 1 更；最高來源係 AL 時低來源頂位班唔計", async () => {
    await mkRec(3, "roster_upload", { recordType: "shift", brokerId: otherBrokerId });
    await mkRec(3, "master_roster", { recordType: "shift", brokerId: otherBrokerId, shiftTypeId: stD });
    await mkRec(5, "roster_upload", { recordType: "leave", leaveCode: "AL", shiftTypeId: stD });
    await mkRec(5, "master_roster", { recordType: "shift", brokerId: otherBrokerId });
    const c = await loadCoverShifts([MONTH]);
    expect(c.shifts.filter((x) => x.guardId === guardId).map((x) => x.date)).toEqual(["2026-08-03"]);
  });

  it("M6：attendance-fix 寫價 snapshot 時補 auto 價卡 journal；audit 有 via 標記", async () => {
    const run = await prisma.monthCloseRun.create({ data: { month: MONTH, status: "running", startedById: fx.userIds["老闆"], applyStartedAt: new Date() } });
    await prisma.rateCard.update({ where: { id: fx.rateCardGeneric.id }, data: { source: `auto:one-click:${run.id}` } });
    await mkRec(6, "roster_upload", { recordType: "leave", leaveCode: "NL" });
    const res = await fix(owner, [{ guard_id: guardId, work_date: "2026-08-06", site_id: fx.site.id, set_code: "SHIFT" }]);
    expect(res.status).toBe(200);
    const rec = await prisma.shiftRecord.findFirstOrThrow({ where: { guardId, workDate: d(6) } });
    expect(rec.recordType).toBe("shift");
    expect(rec.clientRateSnapshot).not.toBeNull();
    expect(await prisma.monthCloseAutoChange.count({ where: { runId: run.id, kind: "price_snapshots" } })).toBeGreaterThan(0);
    const au = await prisma.auditLog.findFirst({ where: { tableName: "shift_records", rowId: rec.id, action: "update" }, orderBy: { createdAt: "desc" } });
    expect((au!.after as { via?: string }).via).toBe("longterm_attendance_fix");
  });
});
