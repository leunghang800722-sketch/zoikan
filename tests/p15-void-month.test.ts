// P15：作廢長工糧某月計算（倒序重算，假期結餘回滾）＋平均工資批量導入。合成資料。
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { recomputeLongtermPayroll } from "@/lib/longterm-payroll/aggregate";
import { POST as voidRoute } from "@/app/api/longterm/payroll/[month]/void/route";
import { POST as avgBulk } from "@/app/api/longterm/avg-wages/bulk/route";

const M = (mo: number) => new Date(Date.UTC(2026, mo - 1, 1));
const D = (mo: number, d: number) => new Date(Date.UTC(2026, mo - 1, d));
function req(url: string, cookie: string, body?: unknown) {
  return new Request(url, { method: "POST", headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
}
const voidCall = (month: string, cookie: string, body: unknown = { reason: "測試倒序重算" }) =>
  voidRoute(req(`http://t/api/longterm/payroll/${month}/void`, cookie, body), { params: Promise.resolve({ month }) });

describe("P15.1 作廢本月計算", () => {
  let fx: Wp2Fixture;
  let owner: string;
  let accountant: string;
  let actor: string;
  let g1: string;
  let g2: string;

  async function leave(guardId: string, siteId: string, stId: string, date: Date, code: "AL" | "SL") {
    await prisma.shiftRecord.create({ data: { workDate: date, siteId, shiftTypeId: stId, guardId, recordType: "leave", leaveCode: code, createdBy: "test" } });
  }

  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    owner = await sessionCookieForUser(fx.userIds["老闆"]);
    accountant = await sessionCookieForUser(fx.userIds["會計"]);
    actor = fx.userIds["老闆"];
    const site = await prisma.site.create({ data: { canonicalName: `P15盤-${Math.random().toString(36).slice(2, 7)}`, clientName: "測試客戶", billingModel: "per_shift", createdBy: "test" } });
    const st = await prisma.shiftType.create({ data: { siteId: site.id, code: "N", hours: 12, createdBy: "test" } });
    const mk = async (name: string) => {
      const g = await prisma.guard.create({ data: { nameZh: name, employmentType: "longterm_autopay", hireDate: new Date("2024-01-01"), createdBy: "test" } });
      await prisma.guardLongtermContract.create({ data: { guardId: g.id, monthlySalary: 15500, effectiveFrom: new Date("2024-01-01"), effectiveTo: null, source: "manual", createdBy: actor } });
      return g.id;
    };
    g1 = await mk("測試P15甲");
    g2 = await mk("測試P15乙");
    // 7 月：甲 AL 2 日；8 月：甲 AL 1 日＋SL 4 日（有紙）；乙 AL 3 日（8 月）
    for (const d of [3, 4]) await leave(g1, site.id, st.id, D(7, d), "AL");
    await leave(g1, site.id, st.id, D(8, 10), "AL");
    for (const d of [5, 6, 7, 8]) await leave(g1, site.id, st.id, D(8, d), "SL");
    await prisma.longtermPayrollInput.create({ data: { month: M(8), guardId: g1, kind: "leave", dateFrom: "2026-08-05", dateTo: "2026-08-08", doctorNoteVerified: true, status: "confirmed", createdBy: actor } });
    for (const d of [11, 12, 13]) await leave(g2, site.id, st.id, D(8, d), "AL");
  });

  async function state(month: number) {
    const bal = await prisma.guardLeaveBalance.findMany({ orderBy: { guardId: "asc" } });
    const run = await prisma.longtermPayrollRun.findFirst({ where: { month: M(month), voidedAt: null, status: { not: "void" } }, include: { lines: { orderBy: { guardId: "asc" } } } });
    return {
      bal: bal.map((b) => ({ g: b.guardId, al: Number(b.alTaken), sl: Number(b.slTaken), acc: Number(b.slAccrued), as: b.asOfMonth?.toISOString() ?? null, alo: Number(b.alTakenOpening), slo: Number(b.slTakenOpening) })),
      lines: (run?.lines ?? []).map((l) => ({ g: l.guardId, gross: Number(l.gross), sl45: Number(l.sl45Amount), al: Number(l.alPayment), ded: Number(l.deduction), auto: Number(l.autopay) })),
    };
  }

  it("計 7→8→作廢 8→重算 8：結餘同 lines 同第一次完全一樣", async () => {
    await recomputeLongtermPayroll(M(7), actor);
    const s7 = await state(7);
    await recomputeLongtermPayroll(M(8), actor);
    const s8 = await state(8);
    expect(s8.bal.find((b) => b.g === g1)!.al).toBe(3);
    const res = await voidCall("2026-08", owner);
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j).toMatchObject({ voided_runs: 1, legacy_rebuilt: 0, restored_as_of_month: "2026-07" });
    expect(JSON.stringify(j)).not.toMatch(/測試/);
    expect((await state(7)).bal).toEqual(s7.bal); // 結餘回到 7 月尾
    await recomputeLongtermPayroll(M(8), actor);
    expect(await state(8)).toEqual(s8);
    const au = await prisma.auditLog.findFirst({ where: { action: "void_longterm_payroll_month" } });
    expect(au).not.toBeNull();
  });

  it("計 8→作廢 8→計 7→計 8：等於順序 7→8", async () => {
    await recomputeLongtermPayroll(M(7), actor);
    await recomputeLongtermPayroll(M(8), actor);
    const seq = await state(8);
    await clearBalancesAndRuns();
    await recomputeLongtermPayroll(M(8), actor);
    expect((await prisma.guardLeaveBalance.count())).toBe(2);
    expect((await voidCall("2026-08", owner)).status).toBe(200);
    expect(await prisma.guardLeaveBalance.count()).toBe(0); // 8 月前冇記錄 → 刪除
    await recomputeLongtermPayroll(M(7), actor);
    await recomputeLongtermPayroll(M(8), actor);
    expect(await state(8)).toEqual(seq);
  });

  async function clearBalancesAndRuns() {
    await prisma.guardLeaveBalanceHistory.deleteMany({});
    await prisma.guardLeaveBalance.deleteMany({});
    await prisma.longtermPayrollLine.deleteMany({});
    await prisma.longtermPayrollRun.deleteMany({});
  }

  it("legacy（P15 前計過、冇快照）：作廢 8 後重算 7→8 同順序結果一樣", async () => {
    await recomputeLongtermPayroll(M(7), actor);
    const s7 = await state(7);
    await recomputeLongtermPayroll(M(8), actor);
    const s8 = await state(8);
    await prisma.guardLeaveBalanceHistory.deleteMany({}); // 模擬 P15 前
    const j = await (await voidCall("2026-08", owner)).json();
    expect(j.legacy_rebuilt).toBe(2);
    const after = await state(7);
    expect(after.bal).toEqual(s7.bal);
    await recomputeLongtermPayroll(M(7), actor);
    expect((await state(7)).bal).toEqual(s7.bal);
    await recomputeLongtermPayroll(M(8), actor);
    expect(await state(8)).toEqual(s8);
  });

  it("只准作廢最近一個已計月份（後月有效 → 409）；先作廢後月再作廢前月 OK", async () => {
    await recomputeLongtermPayroll(M(7), actor);
    await recomputeLongtermPayroll(M(8), actor);
    const r = await voidCall("2026-07", owner);
    expect(r.status).toBe(409);
    expect((await voidCall("2026-08", owner)).status).toBe(200);
    expect((await voidCall("2026-07", owner)).status).toBe(200);
    expect(await prisma.guardLeaveBalance.count()).toBe(0);
  });

  it("權限／驗證：會計 403、冇原因 400、冇可作廢 404、鎖月 403、再作廢一次 404", async () => {
    await recomputeLongtermPayroll(M(8), actor);
    expect((await voidCall("2026-08", accountant)).status).toBe(403);
    expect((await voidCall("2026-08", owner, {})).status).toBe(400);
    expect((await voidCall("2026-08", owner, { reason: "  " })).status).toBe(400);
    expect((await voidCall("2026-09", owner)).status).toBe(404);
    const june = await prisma.longtermPayrollRun.create({ data: { month: fx.lockedMonth, status: "computed", createdBy: actor } });
    expect((await voidCall("2026-06", owner)).status).toBe(403);
    expect((await prisma.longtermPayrollRun.findUniqueOrThrow({ where: { id: june.id } })).status).toBe("computed");
    expect((await voidCall("2026-08", owner)).status).toBe(200);
    expect((await voidCall("2026-08", owner)).status).toBe(404);
  });

  it("平均工資：source=computed 清走，manual 保留", async () => {
    await recomputeLongtermPayroll(M(8), actor);
    await prisma.guardAvgWage.create({ data: { guardId: g1, month: M(8), avgDailyWage: 600, source: "computed", createdBy: actor } });
    await prisma.guardAvgWage.create({ data: { guardId: g2, month: M(8), avgDailyWage: 610, source: "人手批量導入", createdBy: actor } });
    const j = await (await voidCall("2026-08", owner)).json();
    expect(j.avg_wages_cleared).toBe(1);
    expect(await prisma.guardAvgWage.count()).toBe(1);
  });
});

describe("P15.2 平均工資批量導入", () => {
  let fx: Wp2Fixture;
  let owner: string;
  let accountant: string;
  let supervisor: string;
  let a: string;
  let month: string;

  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    owner = await sessionCookieForUser(fx.userIds["老闆"]);
    accountant = await sessionCookieForUser(fx.userIds["會計"]);
    supervisor = await sessionCookieForUser(fx.userIds["主管"]);
    month = fx.unlockedMonth.toISOString().slice(0, 10);
    a = (await prisma.guard.create({ data: { nameZh: "測試甲", nameEn: "Test Alpha", staffNoMw: "MG9701", employmentType: "longterm_autopay", createdBy: "test" } })).id;
    await prisma.guard.create({ data: { nameZh: "測試乙", nameEn: "Test Bravo", staffNo: "U9702", employmentType: "longterm_autopay", createdBy: "test" } });
  });
  const rows = () => [
    { staff_no_mw: "mg9701", avg_daily_wage: 612.5 },
    { name_en: "TEST-BRAVO", avg_daily_wage: "700", note: "銀行" },
    { name_en: "NOBODY", avg_daily_wage: 500 },
    { staff_no: "U9702", avg_daily_wage: -1 },
  ];
  const call = (cookie: string, body: unknown, q = "") => avgBulk(req(`http://t/api/longterm/avg-wages/bulk${q}`, cookie, body));

  it("配對、寫 manual、冪等、dry_run 唔寫、回應無姓名", async () => {
    const dry = await call(accountant, { month, rows: rows() }, "?dry_run=1");
    expect(dry.status).toBe(200);
    expect(await prisma.guardAvgWage.count()).toBe(0);
    const res = await call(accountant, { month, rows: rows() });
    expect(res.status).toBe(201);
    const j = await res.json();
    expect(j).toMatchObject({ created: 2, updated: 0, matched: 3, total: 4 });
    expect(j.unmatched).toEqual([{ row: 3, reason: "no_match" }]);
    expect(j.invalid).toHaveLength(1);
    expect(JSON.stringify(j)).not.toMatch(/測試|Alpha|Bravo|NOBODY/);
    const w = await prisma.guardAvgWage.findFirstOrThrow({ where: { guardId: a } });
    expect(Number(w.avgDailyWage)).toBe(612.5);
    expect(w.source).toBe("人手批量導入");
    const again = await (await call(owner, { month, rows: rows() })).json();
    expect(again).toMatchObject({ created: 0, updated: 0, skipped_unchanged: 2 });
    const changed = await (await call(owner, { month, rows: [{ staff_no_mw: "MG9701", avg_daily_wage: 650 }] })).json();
    expect(changed.updated).toBe(1);
    expect(await prisma.guardAvgWage.count()).toBe(2);
  });

  it("權限／鎖月／上限", async () => {
    expect((await call(supervisor, { month, rows: rows() })).status).toBe(403);
    expect((await call(owner, { month: fx.lockedMonth.toISOString().slice(0, 10), rows: rows() })).status).toBe(403);
    expect((await call(owner, { month, rows: [] })).status).toBe(400);
    const many = Array.from({ length: 501 }, () => ({ staff_no: "U9702", avg_daily_wage: 1 }));
    expect((await call(owner, { month, rows: many })).status).toBe(400);
  });
});
