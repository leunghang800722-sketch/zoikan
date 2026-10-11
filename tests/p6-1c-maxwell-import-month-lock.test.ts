// P6.1c（H3）：Maxwell 導入作廢舊合約／新建合約前要過範圍鎖月檢查；
// 作廢舊合約要寫 audit（action=void）。
import { describe, it, expect, beforeEach } from "vitest";
import ExcelJS from "exceljs";
import { prisma, clearAll } from "./lib/db";
import { importMaxwellContracts } from "@/lib/longterm-payroll/import-service";

async function buildWorkbook(rows: Array<{ staffNo: string; name: string; basic: number; commencement: string }>) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("在職名單");
  ws.getCell(2, 3).value = "Staff No.";
  ws.getCell(2, 5).value = "Name";
  rows.forEach((r, i) => {
    const row = 3 + i;
    ws.getCell(row, 3).value = r.staffNo;
    ws.getCell(row, 5).value = r.name;
    ws.getCell(row, 18).value = new Date(r.commencement);
    ws.getCell(row, 20).value = "1";
    ws.getCell(row, 23).value = r.basic;
  });
  wb.addWorksheet("離職名單");
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe("P6.1c：Maxwell 導入鎖月", () => {
  let actorUserId: string;
  const JUN = new Date(Date.UTC(2026, 5, 1));

  beforeEach(async () => {
    await clearAll();
    const role = await prisma.role.findFirstOrThrow({ where: { name: "老闆" } });
    const user = await prisma.user.create({ data: { name: "測試老闆", tel: `9${Math.floor(1000000 + Math.random() * 8999999)}`, passwordHash: "x", roleId: role.id, createdBy: "test" } });
    actorUserId = user.id;
    await prisma.monthClose.create({ data: { month: JUN, lockedAt: new Date(), lockedBy: actorUserId, createdBy: "test" } });
  });

  async function seedAutoContract(staffNoMw: string, name: string, from: string, salary: number) {
    const guard = await prisma.guard.create({ data: { nameZh: name, employmentType: "longterm_autopay", staffNoMw, createdBy: "test" } });
    const c = await prisma.guardLongtermContract.create({
      data: { guardId: guard.id, monthlySalary: salary, effectiveFrom: new Date(from), effectiveTo: null, source: "maxwell_import", createdBy: "test" },
    });
    return { guard, c };
  }

  it("生效區間蓋過已鎖月（2026-06）：薪酬有變 → 403 month_locked，舊合約冇 void、冇新合約", async () => {
    const { guard, c } = await seedAutoContract("MG9201", "測試長工甲", "2024-01-01", 15000);
    const buf = await buildWorkbook([{ staffNo: "MG9201", name: "測試長工甲", basic: 16000, commencement: "2024-01-01" }]);
    const deniedBefore = await prisma.auditLog.count({ where: { tableName: "guard_longterm_contracts", action: "permission_denied" } });
    await expect(importMaxwellContracts(buf, actorUserId, null)).rejects.toMatchObject({ code: "month_locked" });
    const all = await prisma.guardLongtermContract.findMany({ where: { guardId: guard.id } });
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe(c.id);
    expect(all[0].voidedAt).toBeNull();
    expect(Number(all[0].monthlySalary)).toBe(15000);
    expect(await prisma.auditLog.count({ where: { tableName: "guard_longterm_contracts", action: "permission_denied" } })).toBe(deniedBefore + 1);
  });

  it("薪酬冇變（unchanged）→ 唔會觸發鎖月檢查，照舊成功（零改動）", async () => {
    await seedAutoContract("MG9202", "測試長工乙", "2024-01-01", 15000);
    const buf = await buildWorkbook([{ staffNo: "MG9202", name: "測試長工乙", basic: 15000, commencement: "2024-01-01" }]);
    const s = await importMaxwellContracts(buf, actorUserId, null);
    expect(s.contractsCreated).toBe(0);
  });

  it("生效區間喺已鎖月之後（2026-07 起）→ 作廢舊合約＋新建成功，並寫 void audit", async () => {
    const { guard, c } = await seedAutoContract("MG9203", "測試長工丙", "2026-07-01", 15000);
    const buf = await buildWorkbook([{ staffNo: "MG9203", name: "測試長工丙", basic: 17000, commencement: "2026-07-01" }]);
    const s = await importMaxwellContracts(buf, actorUserId, "1.2.3.4");
    expect(s.contractsCreated).toBe(1);
    const old = await prisma.guardLongtermContract.findUniqueOrThrow({ where: { id: c.id } });
    expect(old.voidedAt).not.toBeNull();
    expect(await prisma.guardLongtermContract.count({ where: { guardId: guard.id, voidedAt: null } })).toBe(1);
    const audit = await prisma.auditLog.findFirst({ where: { tableName: "guard_longterm_contracts", rowId: c.id, action: "void" } });
    expect(audit).not.toBeNull();
    expect(audit!.actorUserId).toBe(actorUserId);
  });
});
