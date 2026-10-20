// AI-PII-2（老闆 2026-10-20 定版 PII 規則）：AI 可講 姓名／工號／人卡 id／月薪／入離職日／僱傭類型／牌照到期／緊急聯絡人姓名／別名／黑名單查核日期；
// 唔可講 身份證／出生日期／住址／銀行／所有電話。假資料：測試甲乙、MG9xxxx。
import { describe, it, expect, beforeEach } from "vitest";
import ExcelJS from "exceljs";
import { clearAll, prisma } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { findKeysDeep } from "@/lib/api/serialize";
import { buildAiTools } from "@/lib/ai/tools";
import { computeFieldVisibility, scrubRowForResource, scrubUnknownShape } from "@/lib/ai/field-scrub";
import { AI_GUARD_BLOCKED_FIELDS } from "@/lib/ai/guard-blocked-fields";
import type { AuthedSession } from "@/lib/rbac/requirePermission";
import type { RoleName } from "@/lib/rbac/matrix";
import { POST as cardCreate } from "@/app/api/guards/[id]/staff-numbers/route";
import { PATCH as cardPatch } from "@/app/api/guards/[id]/staff-numbers/[numberId]/route";
import { importMaxwellContracts } from "@/lib/longterm-payroll/import-service";
import { GUARD_PII_FIELDS } from "@/lib/api/field-groups";
import { flipLeftGuards } from "@/lib/guards/flip-left";
import { runNightlyMonthHealth } from "@/lib/jobs/nightly-month-health";

const D = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));
const BLOCKED: string[] = [...AI_GUARD_BLOCKED_FIELDS];

async function sessionFor(fx: Wp2Fixture, role: RoleName): Promise<AuthedSession> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: fx.userIds[role] }, include: { role: true } });
  return { userId: user.id, tel: user.tel, name: user.name, roleId: user.roleId, roleName: user.role.name, baseRole: user.role.baseRole as RoleName, brokerId: user.brokerId, guardId: user.guardId, payoutApprovalLimit: user.payoutApprovalLimit ? user.payoutApprovalLimit.toString() : null, tokenVersion: user.tokenVersion, loggedInAt: new Date().toISOString() };
}
async function toolRun(fx: Wp2Fixture, role: RoleName, name: string, args: unknown): Promise<Record<string, unknown>> {
  const session = await sessionFor(fx, role);
  const tools = buildAiTools({ session, fieldVisibility: await computeFieldVisibility(session) });
  const tool = tools.find((t) => (t as { name?: string }).name === name)!;
  return JSON.parse(await (tool as { run: (a: unknown) => Promise<string> }).run(args));
}

describe("AI-PII-2", () => {
  let fx: Wp2Fixture;
  let cookie: string;
  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    cookie = await sessionCookieForUser(fx.userIds["老闆"]);
    await prisma.staffScheme.upsert({ where: { code: "MG" }, update: { isLongterm: true }, create: { code: "MG", labelZh: "MG", isLongterm: true, isFrontline: false, sort: 3 } });
  });
  const post = (g: string, body: unknown) => cardCreate(new Request(`http://test.local/api/guards/${g}/staff-numbers`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) }), { params: Promise.resolve({ id: g }) });
  const patch = (g: string, id: string, body: unknown) => cardPatch(new Request(`http://test.local/api/guards/${g}/staff-numbers/${id}`, { method: "PATCH", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) }), { params: Promise.resolve({ id: g, numberId: id }) });
  const mkGuard = (over: Record<string, unknown> = {}) =>
    prisma.guard.create({
      data: {
        nameZh: "測試甲", employmentType: "longterm_autopay", monthlySalary: 15500, hireDate: D(2024, 1, 1),
        hkid: "A1234563", tel: "61234567", address: "測試地址99號", dateOfBirth: D(1990, 1, 1), emergencyContactName: "測試乙", emergencyContactTel: "69998888",
        bankName: "測試銀行", bankAccountNo: "999-888777-001", bankPayeeName: "TEST PAYEE", bankCode: "004", blacklistCheckResult: "clear", blacklistCheckDate: D(2026, 5, 5),
        nameAliases: ["阿甲"], siaPermitExpiry: D(2027, 1, 1), createdBy: "t", ...over,
      },
    });

  it("sql_select：引用 ai.guards 被鎖欄（hkid／bank／tel…）或 SELECT * → 拒絕；規則內欄位（入離職日、緊急聯絡人姓名、別名、黑名單查核日期）照查得到", async () => {
    await mkGuard({ leaveDate: D(2026, 9, 1) });
    for (const q of ["SELECT hkid FROM ai.guards", "SELECT bank_account_no FROM ai.guards", "SELECT g.tel FROM ai.guards g", "SELECT * FROM ai.guards", "SELECT to_jsonb(g) FROM ai.guards g", "SELECT emergency_contact_tel FROM ai.guards"]) {
      const r = await toolRun(fx, "老闆", "sql_select", { query: q });
      expect(r.error, q).toBe("permission_denied");
      expect(r.rows, q).toBeUndefined();
    }
    const ok = await toolRun(fx, "老闆", "sql_select", { query: "SELECT name_zh, monthly_salary, hire_date, leave_date, emergency_contact_name, name_aliases, blacklist_check_date, sia_permit_expiry FROM ai.guards WHERE name_zh = '測試甲'" });
    expect(ok.error).toBeUndefined();
    const row = (ok.rows as Array<Record<string, unknown>>)[0]!;
    expect(row.name_zh).toBe("測試甲");
    expect(row.leave_date).toBe("2026-09-01"); // DATE 回字串，唔受時區影響
    expect(row.emergency_contact_name).toBe("測試乙");
    expect(row.name_aliases).toEqual(["阿甲"]);
  });

  it("guard_lookup：回入離職日、工號卡、長工合約段；任何深度零 hkid／出生日期／住址／銀行／電話；真係有權（老闆）都唔回", async () => {
    const g = await mkGuard({ leaveDate: D(2026, 9, 30) });
    await prisma.guardStaffNumber.create({ data: { guardId: g.id, scheme: "MG", number: "MG99931", status: "former", validFrom: D(2024, 1, 1), validTo: D(2026, 9, 30), endReason: "resigned" } });
    await prisma.guardLongtermContract.create({ data: { guardId: g.id, monthlySalary: 15500, effectiveFrom: D(2024, 1, 1), annualLeaveDays: 7, source: "manual", createdBy: fx.userIds["老闆"] } });
    const r = await toolRun(fx, "老闆", "guard_lookup", { query: "MG99931" }); // 用工號卡號碼都搵到
    const guards = r.guards as Array<Record<string, unknown>>;
    expect(guards).toHaveLength(1);
    const x = guards[0]!;
    expect(x).toMatchObject({ id: g.id, name_zh: "測試甲", employment_type: "longterm_autopay" });
    expect(x.hire_date).toBe("2024-01-01");
    expect(x.leave_date).toBe("2026-09-30");
    expect(x.emergency_contact_name).toBe("測試乙");
    expect(x.staff_number_cards).toEqual([expect.objectContaining({ scheme: "MG", number: "MG99931", status: "former", end_reason: "resigned" })]);
    expect((x.longterm_contracts as unknown[]).length).toBe(1);
    expect(findKeysDeep(r, BLOCKED)).toEqual([]);
    const txt = JSON.stringify(r);
    for (const v of ["A1234563", "61234567", "69998888", "999-888777-001", "測試地址99號"]) expect(txt).not.toContain(v);
    // 冇「長工糧:view」嘅主管：照有工號卡，但冇長工合約段
    const sup = await toolRun(fx, "主管", "guard_lookup", { query: "測試甲" });
    const sx = (sup.guards as Array<Record<string, unknown>>)[0]!;
    expect((sx.staff_number_cards as unknown[]).length).toBe(1);
    expect(sx.longterm_contracts).toEqual([]);
    expect(findKeysDeep(sup, BLOCKED)).toEqual([]);
  });

  it("longterm_leavers：9 月離職名單（人卡離職日）＋長工糧離職結算行（年假補償）；冇長工糧權限唔回糧行；零 PII", async () => {
    const g = await mkGuard({ leaveDate: D(2026, 9, 15) });
    await mkGuard({ nameZh: "測試丙", leaveDate: D(2026, 10, 2), hkid: null, tel: null });
    await prisma.guardStaffNumber.create({ data: { guardId: g.id, scheme: "MG", number: "MG99932", status: "former", validFrom: D(2024, 1, 1), validTo: D(2026, 9, 15), endReason: "resigned" } });
    const run = await prisma.longtermPayrollRun.create({ data: { month: D(2026, 9, 1), status: "computed", createdBy: fx.userIds["老闆"] } });
    await prisma.longtermPayrollLine.create({ data: { runId: run.id, guardId: g.id, contractSnapshot: [], daysInMonth: 30, workDays: 15, netBasic: 7750, alPayment: 1200.5, gross: 8950.5, autopay: 8950.5, alDailyRateBasis: "avg_wage" } });
    const r = await toolRun(fx, "老闆", "longterm_leavers", { month: "2026-09" });
    const left = (r.left_in_month as { guards: Array<Record<string, unknown>>; count: number });
    expect(left.count).toBe(1);
    expect(left.guards[0]).toMatchObject({ guard_id: g.id, name_zh: "測試甲" });
    expect(String(left.guards[0]!.staff_number_cards)).toContain("MG99932");
    const pl = r.payroll_leavers as Array<Record<string, unknown>>;
    expect(pl).toHaveLength(1);
    expect(Number(pl[0]!.al_payment)).toBe(1200.5);
    expect(findKeysDeep(r, BLOCKED)).toEqual([]);
    // 10 月：只見測試丙，冇糧行
    const oct = await toolRun(fx, "老闆", "longterm_leavers", { month: "2026-10" });
    expect((oct.left_in_month as { guards: Array<{ name_zh: string }> }).guards.map((x) => x.name_zh)).toEqual(["測試丙"]);
    expect(oct.payroll_leavers).toEqual([]);
    // 主管冇「長工糧:view」→ 糧行唔回
    const sup = await toolRun(fx, "主管", "longterm_leavers", { month: "2026-09" });
    expect(sup.payroll_leavers).toBeNull();
    expect(sup.payroll_leavers_note).toBeTruthy();
    expect((sup.left_in_month as { count: number }).count).toBe(1);
  });

  it("field-scrub：AI 專用遮罩清單永遠剝（唔受權限）；緊急聯絡人姓名／別名／黑名單查核日期仍跟「保安員個人資料:view」；GUARD_PII_FIELDS 人類 RBAC 清單不變", () => {
    const vis = { clientRateVisible: true, settlementVisible: true, guardPiiVisible: true, guardBankVisible: true };
    const row = { id: "x", name_zh: "測試甲", hire_date: "2024-01-01", hkid: "A1", date_of_birth: "d", address: "a", tel: "6", emergency_contact_tel: "6", bank_name: "b", bank_account_no: "1", bank_payee_name: "p", bank_code: "004", blacklist_check_result: "ok", emergency_contact_name: "測試乙", name_aliases: ["x"], blacklist_check_date: "2026-01-01" };
    const full = scrubRowForResource(row, "guards", vis);
    expect(Object.keys(full).sort()).toEqual(["blacklist_check_date", "emergency_contact_name", "hire_date", "id", "name_aliases", "name_zh"]);
    const noPii = scrubRowForResource(row, "guards", { ...vis, guardPiiVisible: false });
    expect(Object.keys(noPii).sort()).toEqual(["hire_date", "id", "name_zh"]);
    expect(Object.keys(scrubUnknownShape(row, vis)).filter((k) => BLOCKED.includes(k))).toEqual([]);
    expect(Object.keys(scrubUnknownShape(row, { ...vis, guardPiiVisible: false })).filter((k) => ["emergency_contact_name", "name_aliases", "blacklist_check_date"].includes(k))).toEqual([]);
    expect([...GUARD_PII_FIELDS.guards]).toEqual(["hkid", "date_of_birth", "address", "emergency_contact_name", "emergency_contact_tel", "blacklist_check_result", "blacklist_check_date", "name_aliases"]);
  });

  it("AI-PII-2.1 M2：冇「保安員個人資料:view」嘅角色（主管）經 guard_lookup／sql_select 睇唔到緊急聯絡人姓名／別名／黑名單查核日期，亦唔可用別名搵人；老闆睇到", async () => {
    await mkGuard();
    const boss = await toolRun(fx, "老闆", "guard_lookup", { query: "阿甲" });
    const bx = (boss.guards as Array<Record<string, unknown>>)[0]!;
    expect(bx.emergency_contact_name).toBe("測試乙");
    expect(bx.name_aliases).toEqual(["阿甲"]);
    expect(bx.blacklist_check_date).toBe("2026-05-05");
    const sup = await toolRun(fx, "主管", "guard_lookup", { query: "阿甲" });
    expect(sup.count).toBe(0); // 唔可用別名搵人
    const sup2 = await toolRun(fx, "主管", "guard_lookup", { query: "測試甲" });
    const sx = (sup2.guards as Array<Record<string, unknown>>)[0]!;
    for (const k of ["emergency_contact_name", "name_aliases", "blacklist_check_date"]) expect(Object.keys(sx), k).not.toContain(k);
    expect(sx.hire_date).toBe("2024-01-01"); // 入職日等照常
    const q = await toolRun(fx, "主管", "sql_select", { query: "SELECT name_zh, emergency_contact_name FROM ai.guards" });
    expect(q.error).toBe("permission_denied");
    const q2 = await toolRun(fx, "主管", "sql_select", { query: "SELECT name_zh, hire_date FROM ai.guards" });
    expect(q2.error).toBeUndefined();
    const q3 = await toolRun(fx, "老闆", "sql_select", { query: "SELECT name_zh, emergency_contact_name FROM ai.guards WHERE name_zh = '測試甲'" });
    expect(q3.error).toBeUndefined();
  });

  it("AI-PII-2.1 S2：guard_lookup 長工合約月薪／日薪疊返「出街價」遮罩（冇權就剝）", async () => {
    const g = await mkGuard();
    await prisma.guardLongtermContract.create({ data: { guardId: g.id, monthlySalary: 15500, effectiveFrom: D(2024, 1, 1), annualLeaveDays: 7, source: "manual", createdBy: fx.userIds["老闆"] } });
    const boss = await toolRun(fx, "老闆", "guard_lookup", { query: "測試甲" });
    const bc = ((boss.guards as Array<{ longterm_contracts: Array<Record<string, unknown>> }>)[0]!).longterm_contracts[0]!;
    expect(Number(bc.monthly_salary)).toBe(15500);
    // 老闆有長工糧 view；用 visibility override 模擬冇出街價 view
    const session = await sessionFor(fx, "老闆");
    const vis = { ...(await computeFieldVisibility(session)), settlementVisible: false };
    const tool = buildAiTools({ session, fieldVisibility: vis }).find((t) => (t as { name?: string }).name === "guard_lookup")!;
    const r = JSON.parse(await (tool as { run: (a: unknown) => Promise<string> }).run({ query: "測試甲" })) as { guards: Array<{ longterm_contracts: Array<Record<string, unknown>>; monthly_salary?: unknown }> };
    const c = r.guards[0]!.longterm_contracts[0]!;
    expect(c.monthly_salary).toBeUndefined();
    expect(c.daily_rate).toBeUndefined();
    expect(c.effective_from).toBeTruthy();
    expect(r.guards[0]!.monthly_salary).toBeUndefined(); // 同 guards.monthly_salary 一致
  });

  it("AI-PII-2.1 M1：離職日（卡 valid_to）係未來 → 仍 active；排程 flipLeftGuards 到期先轉 inactive 並寫 audit；仲有 current 卡嘅唔轉；nightly job summary 帶 flip_left_guards", async () => {
    const g = await mkGuard();
    const a = (await (await post(g.id, { scheme: "MG", number: "MG99961", valid_from: "2024-01-01" })).json()) as { id: string };
    const r = await patch(g.id, a.id, { status: "former", valid_to: "2099-12-31", end_reason: "resigned" }); // 未來離職
    expect(r.status).toBe(200);
    const mid = await prisma.guard.findUniqueOrThrow({ where: { id: g.id } });
    expect([mid.status, mid.leaveDate?.toISOString().slice(0, 10)]).toEqual(["active", "2099-12-31"]);
    expect(((await r.json()) as { employment_warnings?: string[] }).employment_warnings?.some((w) => w.startsWith("status_inactive_mirrored"))).toBeFalsy();
    // 另一個仲有 current 卡嘅（離職日已過但卡 current）→ 唔轉
    const g2 = await mkGuard({ nameZh: "測試丙", leaveDate: D(2026, 1, 1), hkid: null, tel: null });
    await prisma.guardStaffNumber.create({ data: { guardId: g2.id, scheme: "MG", number: "MG99962", status: "current", validFrom: D(2024, 1, 1) } });
    expect((await flipLeftGuards(new Date())).flipped).toBe(0); // 今日：未到期
    const night = await runNightlyMonthHealth(new Date());
    expect((night.summary as { flip_left_guards: number }).flip_left_guards).toBe(0);
    // 到期之後
    expect((await flipLeftGuards(new Date("2100-01-01T04:00:00Z"), "nightly_month_health")).flipped).toBe(1);
    expect((await prisma.guard.findUniqueOrThrow({ where: { id: g.id } })).status).toBe("left");
    expect((await prisma.guard.findUniqueOrThrow({ where: { id: g2.id } })).status).toBe("active");
    const audit = await prisma.auditLog.findFirst({ where: { tableName: "guards", rowId: g.id, action: "update" }, orderBy: { createdAt: "desc" } });
    expect(audit!.after).toMatchObject({ status: "left", auto_source: "flip_left_guards", by_job: "nightly_month_health" });
    expect((await flipLeftGuards(new Date("2100-01-01T04:00:00Z"))).flipped).toBe(0); // 冪等
  });

  it("人卡狀態鏡像：全部工號卡 former 而離職日有值 → guards.status inactive（audit＋hint）；仲有 current 卡唔郁；之後開新 current 卡唔會自動轉返在職", async () => {
    const g = await mkGuard();
    const a = (await (await post(g.id, { scheme: "MG", number: "MG99941", valid_from: "2024-01-01" })).json()) as { id: string };
    const u = (await (await post(g.id, { scheme: "U", number: "U99941", valid_from: "2024-01-01" })).json()) as { id: string };
    // 結束 MG 卡但 U 卡仲 current → 唔郁
    expect((await patch(g.id, a.id, { status: "former", valid_to: "2026-09-30", end_reason: "resigned" })).status).toBe(200);
    expect((await prisma.guard.findUniqueOrThrow({ where: { id: g.id } })).status).toBe("active");
    // U 卡都結束 → 全部 former＋離職日（由 MG 卡 valid_to 鏡像）→ inactive
    const r = await patch(g.id, u.id, { status: "former", valid_to: "2026-09-30", end_reason: "resigned" });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { employment_warnings?: string[] };
    expect(body.employment_warnings?.some((w) => w.startsWith("status_inactive_mirrored"))).toBe(true);
    const after = await prisma.guard.findUniqueOrThrow({ where: { id: g.id } });
    expect([after.status, after.leaveDate?.toISOString().slice(0, 10)]).toEqual(["left", "2026-09-30"]);
    const audit = await prisma.auditLog.findFirst({ where: { tableName: "guards", rowId: g.id, action: "update" }, orderBy: { createdAt: "desc" } });
    expect((audit!.after as { status?: string; auto_source?: string }).status).toBe("left");
    expect((audit!.after as { auto_source?: string }).auto_source).toBe("staff_number_mirror");
    // 再入職開新 current 卡：唔自動轉返在職（單向）
    await post(g.id, { scheme: "MG", number: "MG99942", valid_from: "2026-11-01" });
    expect((await prisma.guard.findUniqueOrThrow({ where: { id: g.id } })).status).toBe("left");
  });

  it("Maxwell 導入直接補人卡欄位（nameEn／入職日）留 audit（auto_source=maxwell_import）", async () => {
    const g = await mkGuard({ nameEn: null, hireDate: null, staffNoMw: "MG99951" });
    const w = new ExcelJS.Workbook();
    const act = w.addWorksheet("在職名單");
    act.getCell(2, 3).value = "Staff No.";
    act.getCell(3, 3).value = "MG99951";
    act.getCell(3, 4).value = "TEST ALPHA";
    act.getCell(3, 5).value = "測試甲";
    act.getCell(3, 18).value = new Date("2026-08-03");
    act.getCell(3, 23).value = 15500;
    w.addWorksheet("離職名單").getCell(2, 3).value = "Staff No.";
    const s = await importMaxwellContracts(Buffer.from(await w.xlsx.writeBuffer()), fx.userIds["老闆"], null);
    expect(s.guardFieldsFilled).toBeGreaterThan(0);
    expect((await prisma.guard.findUniqueOrThrow({ where: { id: g.id } })).nameEn).toBe("TEST ALPHA");
    const audits = await prisma.auditLog.findMany({ where: { tableName: "guards", rowId: g.id, action: "update" } });
    expect(audits.some((a) => (a.after as { auto_source?: string } | null)?.auto_source === "maxwell_import")).toBe(true);
  });
});
