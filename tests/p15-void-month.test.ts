// P15：作廢長工糧某月計算（倒序重算，假期結餘回滾）＋平均工資批量導入。合成資料。
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { recomputeLongtermPayroll } from "@/lib/longterm-payroll/aggregate";
import { POST as voidRoute, GET as voidGetRoute } from "@/app/api/longterm/payroll/[month]/void/route";
import { POST as avgBulk } from "@/app/api/longterm/avg-wages/bulk/route";

const M = (mo: number) => new Date(Date.UTC(2026, mo - 1, 1));
const D = (mo: number, d: number) => new Date(Date.UTC(2026, mo - 1, d));
function req(url: string, cookie: string, body?: unknown) {
  return new Request(url, { method: "POST", headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
}
const voidGet = (month: string, cookie: string) =>
  voidGetRoute(new Request(`http://t/api/longterm/payroll/${month}/void`, { headers: { cookie } }), { params: Promise.resolve({ month }) });
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
    // 唯讀前置檢查：之前月份已計、冇快照 → 近似重建，要額外確認
    const pv = await (await voidGet("2026-08", owner)).json();
    expect(pv).toMatchObject({ has_run: true, earlier_valid_runs: ["2026-07"], later_blockers: [], rollback_method: "approx_rebuild", needs_confirm_approx: true, affected_guards: 2 });
    const refused = await voidCall("2026-08", owner);
    expect(refused.status).toBe(409);
    expect((await refused.json()).error).toBe("approx_rollback_requires_confirm");
    expect((await prisma.longtermPayrollRun.count({ where: { month: M(8), status: { not: "void" } } }))).toBe(1); // 未確認 → 冇作廢
    const j = await (await voidCall("2026-08", owner, { reason: "測試倒序重算", confirm_approx: true })).json();
    expect(j).toMatchObject({ legacy_rebuilt: 2, rollback_method: "approx_rebuild" });
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

  it("平均工資：只清 computed／auto:／自動計: 前綴；note 含「自動計」嘅人手行保留", async () => {
    await recomputeLongtermPayroll(M(8), actor);
    await prisma.guardAvgWage.create({ data: { guardId: g1, month: M(8), avgDailyWage: 600, source: "auto:12個月平均", createdBy: actor } });
    await prisma.guardAvgWage.create({ data: { guardId: g2, month: M(8), avgDailyWage: 610, source: "manual:批量導入：由自動計表複製", createdBy: actor } });
    const j = await (await voidCall("2026-08", owner)).json();
    expect(j.avg_wages_cleared).toBe(1);
    const left = await prisma.guardAvgWage.findMany();
    expect(left).toHaveLength(1);
    expect(left[0]!.source).toContain("自動計");
  });

  it("唯讀前置檢查＋can_void＋audit before/after 欄位", async () => {
    await recomputeLongtermPayroll(M(7), actor);
    await recomputeLongtermPayroll(M(8), actor);
    const p7 = await (await voidGet("2026-07", owner)).json();
    expect(p7.later_blockers).toEqual(["2026-08"]);
    const p8 = await (await voidGet("2026-08", accountant)).json(); // 會計都可以睇前置檢查
    expect(p8).toMatchObject({ earlier_valid_runs: ["2026-07"], rollback_method: "snapshot", needs_confirm_approx: false });
    const { GET: payrollGet } = await import("@/app/api/longterm/payroll/[month]/route");
    const getAs = async (c: string) => (await (await payrollGet(new Request("http://t/api/longterm/payroll/2026-08", { headers: { cookie: c } }), { params: Promise.resolve({ month: "2026-08" }) })).json()).can_void;
    expect(await getAs(owner)).toBe(true);
    expect(await getAs(accountant)).toBe(false);
    const runIds = (await prisma.longtermPayrollRun.findMany({ where: { month: M(8), status: { not: "void" } } })).map((r) => r.id);
    await voidCall("2026-08", owner);
    const au = await prisma.auditLog.findFirstOrThrow({ where: { action: "void_longterm_payroll_month", rowId: runIds[0] } });
    expect(au.before).toMatchObject({ month: "2026-08", run_ids: runIds, guards_affected: 2 });
    expect(au.after).toMatchObject({ rollback_method: "snapshot", balances_restored: 2, balances_deleted: 0, kept_manual_rows: 0, avg_wages_cleared: 0 });
  });

  it("existed=false 快照：行而家有人手 al_entitled／carry → 唔刪行，taken 回 0，kept_manual_rows 計數", async () => {
    await recomputeLongtermPayroll(M(8), actor); // 之前冇任何結餘行 → 兩個 existed=false 快照
    await prisma.guardLeaveBalance.update({ where: { guardId_year: { guardId: g1, year: 2026 } }, data: { alEntitled: 7, alCarry: 2 } });
    const j = await (await voidCall("2026-08", owner)).json();
    expect(j).toMatchObject({ kept_manual_rows: 1, balances_deleted: 1 });
    const rows = await prisma.guardLeaveBalance.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ guardId: g1, asOfMonth: null });
    expect(Number(rows[0]!.alTaken)).toBe(0);
    expect(Number(rows[0]!.alEntitled)).toBe(7);
    expect(Number(rows[0]!.alCarry)).toBe(2);
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
    expect(w.source).toBe("manual:批量導入");
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

describe("P15.3 新增合約／揀保安員", () => {
  it("guard-search 只回 id／姓名／工號；月薪制＋日薪制合約可建；鎖月 403；主管 403", async () => {
    await clearAll();
    const fx = await seedWp2Fixture();
    const owner = await sessionCookieForUser(fx.userIds["老闆"]);
    const accountant = await sessionCookieForUser(fx.userIds["會計"]);
    const supervisor = await sessionCookieForUser(fx.userIds["主管"]);
    const g = await prisma.guard.create({ data: { nameZh: "測試P15搜", nameEn: "P15 Searchable", staffNoMw: "MG9801", tel: "91234567", employmentType: "longterm_autopay", createdBy: "test" } });
    const { GET: search } = await import("@/app/api/longterm/guard-search/route");
    const { POST: createContract } = await import("@/app/api/longterm/contracts/route");
    const sr = await search(new Request("http://t/api/longterm/guard-search?q=mg98", { headers: { cookie: accountant } }));
    expect(sr.status).toBe(200);
    const sj = await sr.json();
    expect(sj.rows).toEqual([{ guard_id: g.id, name: "測試P15搜", staff_no: "MG9801" }]);
    expect(JSON.stringify(sj)).not.toMatch(/91234567/);
    expect((await search(new Request("http://t/api/longterm/guard-search?q=mg98", { headers: { cookie: supervisor } }))).status).toBe(403);

    const mk = (cookie: string, extra: Record<string, unknown>) =>
      createContract(req("http://t/api/longterm/contracts", cookie, { guard_id: g.id, effective_from: "2026-12-01", effective_to: null, shift_hours: 12, annual_leave_days: 7, statutory_holiday_paid_from: "immediate", rest_day_paid: true, mpf_exempt_reason: "auto", ...extra }));
    expect((await mk(accountant, { pay_basis: "monthly", monthly_salary: 15500 })).status).toBe(201);
    expect((await mk(owner, { pay_basis: "daily", monthly_salary: 650, daily_rate: 650, effective_from: "2027-01-01", close_previous: true })).status).toBe(201);
    const rows = await prisma.guardLongtermContract.findMany({ where: { guardId: g.id }, orderBy: { effectiveFrom: "asc" } });
    expect(rows.map((r) => r.payBasis)).toEqual(["monthly", "daily"]);
    expect(Number(rows[1]!.dailyRate)).toBe(650);
    expect((await mk(accountant, { pay_basis: "monthly", monthly_salary: 1, effective_from: fx.lockedMonth.toISOString().slice(0, 10) })).status).toBe(403);
  });
});

describe("P15.1 legacy：系統首次計算（冇快照）作廢後同從未計過一模一樣", () => {
  it("只計 8 月（冇快照）→ 作廢 → 結餘表同未計過一樣（空）；有 opening 嘅預存結餘 → taken 回到 opening；重算 8 月結果同首次一致", async () => {
    await clearAll();
    const fx = await seedWp2Fixture();
    const owner = await sessionCookieForUser(fx.userIds["老闆"]);
    const actor = fx.userIds["老闆"];
    const site = await prisma.site.create({ data: { canonicalName: `P15L-${Math.random().toString(36).slice(2, 7)}`, clientName: "測試客戶", billingModel: "per_shift", createdBy: "test" } });
    const st = await prisma.shiftType.create({ data: { siteId: site.id, code: "N", hours: 12, createdBy: "test" } });
    const mk = async (name: string) => {
      const g = await prisma.guard.create({ data: { nameZh: name, employmentType: "longterm_autopay", hireDate: new Date("2024-01-01"), createdBy: "test" } });
      await prisma.guardLongtermContract.create({ data: { guardId: g.id, monthlySalary: 15500, effectiveFrom: new Date("2024-01-01"), effectiveTo: null, source: "manual", createdBy: actor } });
      return g.id;
    };
    const a = await mk("測試L甲");
    const b = await mk("測試L乙");
    for (const d of [10, 11]) await prisma.shiftRecord.create({ data: { workDate: D(8, d), siteId: site.id, shiftTypeId: st.id, guardId: a, recordType: "leave", leaveCode: "AL", createdBy: "test" } });
    // 乙有預存結餘（先前人手／匯入，asOfMonth=null）
    await prisma.guardLeaveBalance.create({ data: { guardId: b, year: 2026, alTaken: 3, slTaken: 2, alEntitled: 7, alCarry: 1 } });
    const snap = async () => (await prisma.guardLeaveBalance.findMany({ orderBy: { guardId: "asc" } })).map((r) => ({ g: r.guardId, al: Number(r.alTaken), sl: Number(r.slTaken), ent: Number(r.alEntitled), carry: Number(r.alCarry), as: r.asOfMonth?.toISOString() ?? null, alo: Number(r.alTakenOpening), slo: Number(r.slTakenOpening) }));
    const before = await snap();
    await recomputeLongtermPayroll(M(8), actor);
    const first = await snap();
    await prisma.guardLeaveBalanceHistory.deleteMany({}); // 模擬 P15 前
    const j = await (await voidCall("2026-08", owner)).json();
    expect(j).toMatchObject({ voided_runs: 1, balances_deleted: 1, balances_restored: 1, restored_as_of_month: null });
    const after = await snap();
    // 甲（計糧先生成）→ 行消失；乙 → taken 回到 opening（3／2），entitled／carry 不變
    expect(after.map((r) => r.g)).toEqual([b]);
    expect(after[0]).toMatchObject({ al: 3, sl: 2, ent: 7, carry: 1, as: null, alo: 3, slo: 2 });
    expect(before.find((r) => r.g === b)).toMatchObject({ al: 3, sl: 2, ent: 7, carry: 1 });
    await recomputeLongtermPayroll(M(8), actor);
    expect(await snap()).toEqual(first);
  });
});
