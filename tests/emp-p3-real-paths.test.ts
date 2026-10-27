// EMP-P3.1：長工糧 10 月數字經「真實寫入路徑」驗證（POST／PATCH／換號／Maxwell 導入），唔直接 prisma 建卡繞過鏡像。
// 例外：「生產現狀」（舊 MG 卡只抄咗號碼冇日期、人卡舊日期）用 prisma 直接起——因為嗰啲資料本來就係鏡像上線前寫入嘅。
import { fakeTel } from "./helpers/fake-tel";
import { describe, it, expect, beforeEach } from "vitest";
import ExcelJS from "exceljs";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { POST as cardCreate } from "@/app/api/guards/[id]/staff-numbers/route";
import { PATCH as cardPatch } from "@/app/api/guards/[id]/staff-numbers/[numberId]/route";
import { buildLongtermPayrollInputs } from "@/lib/longterm-payroll/aggregate";
import { importMaxwellContracts } from "@/lib/longterm-payroll/import-service";

const D = (m: number, d: number, y = 2026) => new Date(Date.UTC(y, m - 1, d));
const OCT = D(10, 1);
const dayOf = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

describe("EMP-P3.1 真實路徑（10 月長工糧）", () => {
  let fx: Wp2Fixture;
  let cookie: string;
  let site: { id: string };
  let st: { id: string };
  let b07: { id: string };
  const url = (g: string) => `http://test.local/api/guards/${g}/staff-numbers`;
  const post = (g: string, body: unknown) => cardCreate(new Request(url(g), { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) }), { params: Promise.resolve({ id: g }) });
  const patch = (g: string, id: string, body: unknown) => cardPatch(new Request(`${url(g)}/${id}`, { method: "PATCH", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) }), { params: Promise.resolve({ id: g, numberId: id }) });

  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    cookie = await sessionCookieForUser(fx.userIds["老闆"]);
    await prisma.staffScheme.upsert({ where: { code: "MG" }, update: { isLongterm: true }, create: { code: "MG", labelZh: "MG", isLongterm: true, isFrontline: false, sort: 3 } });
    site = await prisma.site.create({ data: { canonicalName: `測試P31盤-${Math.random().toString(36).slice(2, 7)}`, clientName: "測試客", billingModel: "per_shift", createdBy: "t" } });
    st = await prisma.shiftType.create({ data: { siteId: site.id, code: "N", hours: 12, createdBy: "t" } });
    b07 = await prisma.broker.create({ data: { code: `T-B07-${Math.random().toString(36).slice(2, 6)}`, name: "測試內部長工桶", kind: "internal_longterm", settlementType: "salary", createdBy: "t" } });
  });
  const guard = (name: string, hire: Date | null, leave: Date | null = null) => prisma.guard.create({ data: { nameZh: name, employmentType: "longterm_autopay", hireDate: hire, leaveDate: leave, createdBy: "t" } });
  const contract = (guardId: string, from: Date, to: Date | null = null) => prisma.guardLongtermContract.create({ data: { guardId, monthlySalary: 15500, effectiveFrom: from, effectiveTo: to, annualLeaveDays: 7, source: "manual", createdBy: fx.userIds["老闆"] } });
  const shifts = async (guardId: string, month: number, from: number, to: number) => {
    for (let d = from; d <= to; d++) await prisma.shiftRecord.create({ data: { workDate: D(month, d), siteId: site.id, shiftTypeId: st.id, guardId, settlementBrokerId: b07.id, operationalBrokerId: b07.id, recordType: "shift", createdBy: "t" } });
  };
  const lineOf = async (guardId: string, month = OCT) => {
    const r = await buildLongtermPayrollInputs(month);
    return { line: r.lines.find((l) => l.guardId === guardId), warnings: r.warnings };
  };

  it("M1 換號：舊 MG 卡冇日期＋人卡 hire_date 2024-02-01；replaces_current 新卡 valid_from=10/15 → 人卡 hire_date 不變、10 月 netBasic／slAccrued 不變、零警告", async () => {
    const g = await guard("測試甲", D(2, 1, 2024));
    await contract(g.id, D(2, 1, 2024));
    await prisma.guardStaffNumber.create({ data: { guardId: g.id, scheme: "MG", number: "MG99811", status: "current" } }); // 生產現狀：只有號碼
    await shifts(g.id, 10, 1, 31);
    const before = await lineOf(g.id);
    expect(before.line!.netBasic).toBe(15500);
    const res = await post(g.id, { scheme: "MG", number: "MG99812", valid_from: "2026-10-15", replaces_current: true });
    expect(res.status).toBe(201);
    expect(dayOf((await prisma.guard.findUniqueOrThrow({ where: { id: g.id } })).hireDate)).toBe("2024-02-01");
    const after = await lineOf(g.id);
    expect(after.line!.netBasic).toBe(15500);
    expect(after.line!.leaveBalanceWriteback.slAccruedAtMonthEnd).toBe(before.line!.leaveBalanceWriteback.slAccruedAtMonthEnd);
    expect(after.warnings.filter((w) => w.includes(g.id))).toEqual([]);
  });

  it("M2 再入職（真實流程）：結束舊卡 → 開新 MG 卡；鏡像清走舊 leave_date 之後 10 月仍然判到再入職——出糧、workDays 正確、病假年假以 0 開局、warning rehire_detected(chain)", async () => {
    const g = await guard("測試再入職", D(1, 1, 2020));
    await contract(g.id, D(1, 1, 2020), D(3, 31));
    await contract(g.id, D(9, 15));
    const a = (await (await post(g.id, { scheme: "MG", number: "MG99821", valid_from: "2020-01-01" })).json()) as { id: string };
    expect((await patch(g.id, a.id, { status: "former", valid_to: "2026-03-31", end_reason: "resigned" })).status).toBe(200);
    expect(dayOf((await prisma.guard.findUniqueOrThrow({ where: { id: g.id } })).leaveDate)).toBe("2026-03-31");
    await prisma.guardLeaveBalance.create({ data: { guardId: g.id, year: 2026, slAccrued: 10, slTaken: 4, alTaken: 3, asOfMonth: D(3, 1), alTakenOpening: 3, slTakenOpening: 4 } });
    const b = await post(g.id, { scheme: "MG", number: "MG99822", valid_from: "2026-09-15" });
    expect(b.status).toBe(201);
    expect((await prisma.guard.findUniqueOrThrow({ where: { id: g.id } })).leaveDate).toBeNull(); // 鏡像已清走（以前令再入職判斷失效）
    await shifts(g.id, 10, 1, 20);
    const { line, warnings } = await lineOf(g.id);
    expect(line).toBeDefined();
    expect(line!.workDays).toBe(20);
    expect(line!.leaveBalanceWriteback).toMatchObject({ slOpeningUsed: 0, alOpeningUsed: 0 });
    expect(line!.notes.some((n) => n.includes("再入職新聘用段"))).toBe(true);
    expect(warnings.some((w) => w.includes("[rehire_detected]") && w.includes(g.id) && w.includes("更早一段聘用已 resigned"))).toBe(true);
  });

  it("S1 同月兩段聘用：舊段 10/10 結束、新段 10/20 起 → 專用警告 two_segments_in_month；S2 選中鏈起點遲過月尾 → segment_starts_after_month", async () => {
    const g = await guard("測試同月兩段", D(1, 1, 2020));
    await contract(g.id, D(1, 1, 2020), D(10, 10));
    await contract(g.id, D(10, 20));
    const a = (await (await post(g.id, { scheme: "MG", number: "MG99831", valid_from: "2020-01-01" })).json()) as { id: string };
    await patch(g.id, a.id, { status: "former", valid_to: "2026-10-10", end_reason: "resigned" });
    await post(g.id, { scheme: "MG", number: "MG99832", valid_from: "2026-10-20" });
    await shifts(g.id, 10, 20, 31);
    const { line, warnings } = await lineOf(g.id);
    expect(line).toBeDefined();
    expect(warnings.some((w) => w.includes("[two_segments_in_month]") && w.includes(g.id))).toBe(true);
    // S2
    const g2 = await guard("測試遲起點", D(1, 1, 2020));
    await contract(g2.id, D(1, 1, 2020));
    await post(g2.id, { scheme: "MG", number: "MG99833", valid_from: "2026-11-05" });
    const r2 = await lineOf(g2.id);
    expect(r2.warnings.some((w) => w.includes("[segment_starts_after_month]") && w.includes(g2.id))).toBe(true);
  });
});

type R = { staffNo: string; name: string; basic: number; commencement: string; lastDay?: string };
async function wb(left: R[]) {
  const w = new ExcelJS.Workbook();
  const act = w.addWorksheet("在職名單");
  act.getCell(2, 3).value = "Staff No.";
  const ws = w.addWorksheet("離職名單");
  ws.getCell(2, 3).value = "Staff No.";
  ws.getCell(2, 31).value = "Last Day";
  left.forEach((r, i) => {
    const row = 3 + i;
    ws.getCell(row, 3).value = r.staffNo;
    ws.getCell(row, 5).value = r.name;
    ws.getCell(row, 18).value = new Date(r.commencement);
    ws.getCell(row, 23).value = r.basic;
    if (r.lastDay) ws.getCell(row, 31).value = new Date(r.lastDay);
  });
  return Buffer.from(await w.xlsx.writeBuffer());
}

describe("EMP-P3.1 M3 Maxwell 離職名單 vs 再入職者", () => {
  it("離職名單嘅最後一日（上一段 3/31）早過現行聘用段起點／卡 valid_from → 唔結束張 MG 卡、加 leaver_date_before_segment 警告；10 月照出糧", async () => {
    await clearAll();
    const role = await prisma.role.findFirstOrThrow({ where: { name: "老闆" } });
    const actor = (await prisma.user.create({ data: { name: "測試老闆", tel: fakeTel(), passwordHash: "x", roleId: role.id, createdBy: "t" } })).id;
    await prisma.staffScheme.upsert({ where: { code: "MG" }, update: { isLongterm: true }, create: { code: "MG", labelZh: "MG", isLongterm: true, isFrontline: false, sort: 3 } });
    const site = await prisma.site.create({ data: { canonicalName: `測試P31M3-${Math.random().toString(36).slice(2, 7)}`, clientName: "測試客", billingModel: "per_shift", createdBy: "t" } });
    const st = await prisma.shiftType.create({ data: { siteId: site.id, code: "N", hours: 12, createdBy: "t" } });
    const b07 = await prisma.broker.create({ data: { code: `T-B07-${Math.random().toString(36).slice(2, 6)}`, name: "測試內部長工桶", kind: "internal_longterm", settlementType: "salary", createdBy: "t" } });
    // 再入職者：人卡 hire 2020、第二段合約 9/15 起；MG 卡（生產現狀）冇日期
    const g = await prisma.guard.create({ data: { nameZh: "測試再入職丙", employmentType: "longterm_autopay", hireDate: D(1, 1, 2020), createdBy: "t" } });
    await prisma.guardLongtermContract.create({ data: { guardId: g.id, monthlySalary: 15500, effectiveFrom: D(9, 15), effectiveTo: null, annualLeaveDays: 7, source: "manual", createdBy: actor } });
    await prisma.guardStaffNumber.create({ data: { guardId: g.id, scheme: "MG", number: "MG99841", status: "current", validFrom: D(9, 15) } });
    const s = await importMaxwellContracts(await wb([{ staffNo: "MG99841", name: "測試再入職丙", basic: 15500, commencement: "2020-01-01", lastDay: "2026-03-31" }]), actor, null);
    const card = await prisma.guardStaffNumber.findUniqueOrThrow({ where: { number: "MG99841" } });
    expect(card.status).toBe("current"); // 冇被舊段最後一日結束
    expect(card.validTo).toBeNull();
    expect(s.warnings.some((w) => w.includes("[leaver_date_before_segment]") && w.includes(g.id) && w.includes("2026-03-31"))).toBe(true);
    expect((await prisma.guard.findUniqueOrThrow({ where: { id: g.id } })).leaveDate).toBeNull();
    // Opus 個案：MG 卡冇日期（生產現狀）——靠「現行合約鏈起點」(9/15) 判斷舊段最後一日 3/31 屬上一段
    const g2 = await prisma.guard.create({ data: { nameZh: "測試再入職丁", employmentType: "longterm_autopay", hireDate: D(1, 1, 2020), createdBy: "t" } });
    await prisma.guardLongtermContract.create({ data: { guardId: g2.id, monthlySalary: 15500, effectiveFrom: D(9, 15), effectiveTo: null, annualLeaveDays: 7, source: "manual", createdBy: actor } });
    await prisma.guardStaffNumber.create({ data: { guardId: g2.id, scheme: "MG", number: "MG99842", status: "current" } });
    const s2 = await importMaxwellContracts(await wb([{ staffNo: "MG99842", name: "測試再入職丁", basic: 15500, commencement: "2026-09-15", lastDay: "2026-03-31" }]), actor, null);
    const card2 = await prisma.guardStaffNumber.findUniqueOrThrow({ where: { number: "MG99842" } });
    expect([card2.status, card2.validTo]).toEqual(["current", null]);
    expect(s2.warnings.some((w) => w.includes("[leaver_date_before_segment]") && w.includes(g2.id))).toBe(true);
    expect((await prisma.guard.findUniqueOrThrow({ where: { id: g2.id } })).leaveDate).toBeNull(); // 唔補空舊段最後一日
    // 對照：正常離職者（最後一日遲過所有參考日期）照舊結束張卡
    const g3 = await prisma.guard.create({ data: { nameZh: "測試離職戊", employmentType: "longterm_autopay", hireDate: D(1, 1, 2024), createdBy: "t" } });
    await prisma.guardStaffNumber.create({ data: { guardId: g3.id, scheme: "MG", number: "MG99843", status: "current", validFrom: D(1, 1, 2024) } });
    await importMaxwellContracts(await wb([{ staffNo: "MG99843", name: "測試離職戊", basic: 15500, commencement: "2024-01-01", lastDay: "2026-08-31" }]), actor, null);
    const card3 = await prisma.guardStaffNumber.findUniqueOrThrow({ where: { number: "MG99843" } });
    expect([card3.status, card3.endReason, dayOf(card3.validTo)]).toEqual(["former", "resigned", "2026-08-31"]);
    for (let d = 1; d <= 10; d++) await prisma.shiftRecord.create({ data: { workDate: D(10, d), siteId: site.id, shiftTypeId: st.id, guardId: g.id, settlementBrokerId: b07.id, operationalBrokerId: b07.id, recordType: "shift", createdBy: "t" } });
    const r = await buildLongtermPayrollInputs(OCT);
    expect(r.lines.find((l) => l.guardId === g.id)).toBeDefined(); // 10 月冇整行跳過
  });
});

describe("EMP-P3.2 M1' 離職名單：導入入職日同卡／人卡／合約鏈日期有差都要結束卡", () => {
  const setup = async () => {
    await clearAll();
    const role = await prisma.role.findFirstOrThrow({ where: { name: "老闆" } });
    const actor = (await prisma.user.create({ data: { name: "測試老闆", tel: fakeTel(), passwordHash: "x", roleId: role.id, createdBy: "t" } })).id;
    await prisma.staffScheme.upsert({ where: { code: "MG" }, update: { isLongterm: true }, create: { code: "MG", labelZh: "MG", isLongterm: true, isFrontline: false, sort: 3 } });
    const site = await prisma.site.create({ data: { canonicalName: `測試P32-${Math.random().toString(36).slice(2, 7)}`, clientName: "測試客", billingModel: "per_shift", createdBy: "t" } });
    const st = await prisma.shiftType.create({ data: { siteId: site.id, code: "N", hours: 12, createdBy: "t" } });
    const b07 = await prisma.broker.create({ data: { code: `T-B07-${Math.random().toString(36).slice(2, 6)}`, name: "測試內部長工桶", kind: "internal_longterm", settlementType: "salary", createdBy: "t" } });
    const work = async (guardId: string, from: number, to: number) => {
      for (let d = from; d <= to; d++) await prisma.shiftRecord.create({ data: { workDate: D(10, d), siteId: site.id, shiftTypeId: st.id, guardId, settlementBrokerId: b07.id, operationalBrokerId: b07.id, recordType: "shift", createdBy: "t" } });
    };
    return { actor, work };
  };
  it("情境 A：人卡 hire 2019-05-03、Maxwell 入職 2019-05-01（差 2 日），最後一日 2026-10-15 → 卡結束、leave 補上、10 月 isLeaver=true", async () => {
    const { actor, work } = await setup();
    const g = await prisma.guard.create({ data: { nameZh: "測試離職己", employmentType: "longterm_autopay", hireDate: D(5, 3, 2019), createdBy: "t" } });
    await prisma.guardLongtermContract.create({ data: { guardId: g.id, monthlySalary: 15500, effectiveFrom: D(5, 3, 2019), effectiveTo: null, annualLeaveDays: 7, source: "manual", createdBy: actor } });
    await prisma.guardStaffNumber.create({ data: { guardId: g.id, scheme: "MG", number: "MG99851", status: "current", validFrom: D(5, 3, 2019) } });
    const s = await importMaxwellContracts(await wb([{ staffNo: "MG99851", name: "測試離職己", basic: 15500, commencement: "2019-05-01", lastDay: "2026-10-15" }]), actor, null);
    const card = await prisma.guardStaffNumber.findUniqueOrThrow({ where: { number: "MG99851" } });
    expect([card.status, card.endReason, dayOf(card.validTo)]).toEqual(["former", "resigned", "2026-10-15"]);
    expect(dayOf((await prisma.guard.findUniqueOrThrow({ where: { id: g.id } })).leaveDate)).toBe("2026-10-15");
    expect(s.warnings.some((w) => w.includes("[leaver_date_before_segment]") && w.includes(g.id))).toBe(false);
    expect(s.warnings.some((w) => w.includes("[import_hire_date_differs]") && w.includes(g.id))).toBe(true); // 只係提示
    await work(g.id, 1, 15);
    const line = (await buildLongtermPayrollInputs(OCT)).lines.find((l) => l.guardId === g.id);
    expect(line?.isLeaver).toBe(true);
  });
  it("情境 B：合約續約隔 3 日令鏈起點 2025-01-04 遲過入職 2019-05-01，最後一日 2026-10-15 → 卡結束、leave 補上、isLeaver=true", async () => {
    const { actor, work } = await setup();
    const g = await prisma.guard.create({ data: { nameZh: "測試離職庚", employmentType: "longterm_autopay", hireDate: D(5, 1, 2019), createdBy: "t" } });
    await prisma.guardLongtermContract.create({ data: { guardId: g.id, monthlySalary: 15000, effectiveFrom: D(5, 1, 2019), effectiveTo: D(12, 31, 2024), annualLeaveDays: 7, source: "manual", createdBy: actor } });
    await prisma.guardLongtermContract.create({ data: { guardId: g.id, monthlySalary: 15500, effectiveFrom: D(1, 4, 2025), effectiveTo: null, annualLeaveDays: 7, source: "manual", createdBy: actor } });
    await prisma.guardStaffNumber.create({ data: { guardId: g.id, scheme: "MG", number: "MG99852", status: "current" } }); // 生產現狀：冇日期
    const s = await importMaxwellContracts(await wb([{ staffNo: "MG99852", name: "測試離職庚", basic: 15500, commencement: "2019-05-01", lastDay: "2026-10-15" }]), actor, null);
    const card = await prisma.guardStaffNumber.findUniqueOrThrow({ where: { number: "MG99852" } });
    expect([card.status, card.endReason, dayOf(card.validTo)]).toEqual(["former", "resigned", "2026-10-15"]);
    expect(dayOf((await prisma.guard.findUniqueOrThrow({ where: { id: g.id } })).leaveDate)).toBe("2026-10-15");
    expect(s.warnings.some((w) => w.includes("[leaver_date_before_segment]") && w.includes(g.id))).toBe(false);
    await work(g.id, 1, 15);
    const line = (await buildLongtermPayrollInputs(OCT)).lines.find((l) => l.guardId === g.id);
    expect(line?.isLeaver).toBe(true);
  });
});
