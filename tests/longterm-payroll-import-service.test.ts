// WP-LTPAY Phase 2：`importMaxwellContracts()` DB 整合測試——合成安員
// （唔用真名/真工號/真月薪），驗證：①配對到嘅安員建新合約、補齊
// hireDate/probationMonths；②已有人手合約嘅安員跳過（唔覆蓋）；③重複
// 導入同一份名單（數值冇變）唔會重複建行；④對唔到嘅行喺 summary 列出。
import { describe, it, expect, beforeEach } from "vitest";
import ExcelJS from "exceljs";
import { prisma, clearAll } from "./lib/db";
import { importMaxwellContracts, importMaxwellContractsCsv } from "@/lib/longterm-payroll/import-service";

async function buildWorkbook(rows: Array<{ staffNo: string; name: string; basic: number; commencement: string; probation?: string; dob?: string }>) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("在職名單");
  ws.getCell(2, 3).value = "Staff No.";
  ws.getCell(2, 5).value = "Name";
  ws.getCell(2, 20).value = "Probation Period (Months)";
  rows.forEach((r, i) => {
    const row = 3 + i;
    ws.getCell(row, 3).value = r.staffNo;
    ws.getCell(row, 5).value = r.name;
    ws.getCell(row, 18).value = new Date(r.commencement);
    ws.getCell(row, 20).value = r.probation ?? "1";
    ws.getCell(row, 23).value = r.basic;
    if (r.dob) ws.getCell(row, 7).value = new Date(r.dob);
  });
  wb.addWorksheet("離職名單"); // 冚空都要有呢個分頁，唔係會 warning
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe("importMaxwellContracts", () => {
  let actorUserId: string;

  beforeEach(async () => {
    await clearAll();
    const role = await prisma.role.findFirstOrThrow({ where: { name: "老闆" } });
    const user = await prisma.user.create({ data: { name: "測試老闆", tel: `9${Math.floor(1000000 + Math.random() * 8999999)}`, passwordHash: "x", roleId: role.id, createdBy: "test" } });
    actorUserId = user.id;
  });

  it("配對到嘅安員建新合約，補齊 hireDate/probationMonths", async () => {
    const guard = await prisma.guard.create({ data: { nameZh: "測試長工甲", employmentType: "longterm_autopay", staffNoMw: "MG9101", createdBy: "test" } });
    const buf = await buildWorkbook([{ staffNo: "MG9101", name: "測試長工甲", basic: 15500, commencement: "2024-03-01", probation: "1" }]);

    const summary = await importMaxwellContracts(buf, actorUserId, null);
    expect(summary.matchedByStaffNo).toBe(1);
    expect(summary.contractsCreated).toBe(1);

    const updated = await prisma.guard.findUniqueOrThrow({ where: { id: guard.id } });
    expect(updated.hireDate?.toISOString().slice(0, 10)).toBe("2024-03-01");
    expect(updated.probationMonths).toBe(1);

    const contract = await prisma.guardLongtermContract.findFirstOrThrow({ where: { guardId: guard.id, voidedAt: null } });
    expect(Number(contract.monthlySalary)).toBe(15500);
    expect(contract.source).toBe("maxwell_import");
  });

  it("已有人手合約（source=manual）嘅安員導入時跳過，唔覆蓋", async () => {
    const guard = await prisma.guard.create({ data: { nameZh: "測試長工乙", employmentType: "longterm_autopay", staffNoMw: "MG9102", createdBy: "test" } });
    await prisma.guardLongtermContract.create({
      data: { guardId: guard.id, monthlySalary: 99999, effectiveFrom: new Date("2024-01-01"), effectiveTo: null, source: "manual", createdBy: "test" },
    });
    const buf = await buildWorkbook([{ staffNo: "MG9102", name: "測試長工乙", basic: 15500, commencement: "2024-03-01" }]);

    const summary = await importMaxwellContracts(buf, actorUserId, null);
    expect(summary.skippedManualContract.length).toBe(1);
    expect(summary.contractsCreated).toBe(0);

    const contracts = await prisma.guardLongtermContract.findMany({ where: { guardId: guard.id, voidedAt: null } });
    expect(contracts.length).toBe(1);
    expect(Number(contracts[0].monthlySalary)).toBe(99999); // 冇被覆蓋
  });

  it("重複導入同一份名單（數值冇變）唔會重複建行", async () => {
    await prisma.guard.create({ data: { nameZh: "測試長工丙", employmentType: "longterm_autopay", staffNoMw: "MG9103", createdBy: "test" } });
    const buf = await buildWorkbook([{ staffNo: "MG9103", name: "測試長工丙", basic: 16000, commencement: "2024-01-01" }]);

    const first = await importMaxwellContracts(buf, actorUserId, null);
    expect(first.contractsCreated).toBe(1);
    const second = await importMaxwellContracts(buf, actorUserId, null);
    expect(second.contractsCreated).toBe(0); // unchanged，唔重複建

    const guard = await prisma.guard.findFirstOrThrow({ where: { staffNoMw: "MG9103" } });
    const contracts = await prisma.guardLongtermContract.findMany({ where: { guardId: guard.id } });
    expect(contracts.filter((c) => !c.voidedAt).length).toBe(1);
  });

  it("月薪改咗（New Basic 未提供但 Basic 唔同）→ void 舊行、建新行", async () => {
    await prisma.guard.create({ data: { nameZh: "測試長工丁", employmentType: "longterm_autopay", staffNoMw: "MG9104", createdBy: "test" } });
    const buf1 = await buildWorkbook([{ staffNo: "MG9104", name: "測試長工丁", basic: 15000, commencement: "2024-01-01" }]);
    await importMaxwellContracts(buf1, actorUserId, null);

    const buf2 = await buildWorkbook([{ staffNo: "MG9104", name: "測試長工丁", basic: 15800, commencement: "2024-01-01" }]);
    const second = await importMaxwellContracts(buf2, actorUserId, null);
    expect(second.contractsCreated).toBe(1);
    expect(second.contractsUpdated).toBe(1);

    const guard = await prisma.guard.findFirstOrThrow({ where: { staffNoMw: "MG9104" } });
    const active = await prisma.guardLongtermContract.findMany({ where: { guardId: guard.id, voidedAt: null } });
    expect(active.length).toBe(1);
    expect(Number(active[0].monthlySalary)).toBe(15800);
    const voided = await prisma.guardLongtermContract.findMany({ where: { guardId: guard.id, voidedAt: { not: null } } });
    expect(voided.length).toBe(1);
  });

  it("對唔到嘅行喺 summary.unmatched 列出，唔會建錯人", async () => {
    const buf = await buildWorkbook([{ staffNo: "MG0000", name: "完全冇呢個人", basic: 15000, commencement: "2024-01-01" }]);
    const summary = await importMaxwellContracts(buf, actorUserId, null);
    expect(summary.unmatched.length).toBe(1);
    expect(summary.unmatched[0].staffNo).toBe("MG0000");
    expect(summary.contractsCreated).toBe(0);
  });

  it("Opus 5.5 驗收：Monthly Salary < 5,000（日薪制，同 s07 daily_rate_staff）→ payBasis=daily、dailyRate=每更價", async () => {
    await prisma.guard.create({ data: { nameZh: "測試長工日薪", employmentType: "longterm_autopay", staffNoMw: "MG9151", createdBy: "test" } });
    const buf = await buildWorkbook([{ staffNo: "MG9151", name: "測試長工日薪", basic: 600, commencement: "2024-03-01" }]);
    await importMaxwellContracts(buf, actorUserId, null);
    const c = await prisma.guardLongtermContract.findFirstOrThrow({ where: { voidedAt: null, guard: { staffNoMw: "MG9151" } } });
    expect(c.payBasis).toBe("daily");
    expect(Number(c.dailyRate)).toBe(600);
  });

  it("Opus 5.5 驗收：CSV 路徑（在職名單 CSV）同 xlsx 一樣建合約", async () => {
    await prisma.guard.create({ data: { nameZh: "測試長工CSV", employmentType: "longterm_autopay", staffNoMw: "MG9161", createdBy: "test" } });
    const cells = Array.from({ length: 30 }, () => "");
    cells[2] = "MG9161";
    cells[4] = "測試長工CSV";
    cells[17] = "1/3/2024";
    cells[19] = "1";
    cells[22] = '"$15,500"';
    const header = Array.from({ length: 30 }, (_, i) => (i === 2 ? "Staff No." : i === 4 ? "Name" : "")).join(",");
    const summary = await importMaxwellContractsCsv([{ status: "active", text: `Maxwell\r\n${header}\r\n${cells.join(",")}` }], actorUserId, null);
    expect(summary.matchedByStaffNo).toBe(1);
    expect(summary.contractsCreated).toBe(1);
    const c = await prisma.guardLongtermContract.findFirstOrThrow({ where: { voidedAt: null, guard: { staffNoMw: "MG9161" } } });
    expect(Number(c.monthlySalary)).toBe(15500);
    expect(c.effectiveFrom.toISOString().slice(0, 10)).toBe("2024-03-01");
    expect(c.payBasis).toBe("monthly");
  });
});
