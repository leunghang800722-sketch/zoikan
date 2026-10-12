// P16a：Maxwell「法定假期」欄映射（含「即時」→ immediate；空白／其他 → after_3_months）、
// 重導入更新既有 maxwell_import 合約非薪酬欄（audit＋contracts_fields_updated；manual 唔掂）、
// 7 月有 SH 且入職未滿 3 個月 → import→aggregate 扣 NPSH。合成資料。
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import ExcelJS from "exceljs";
import { prisma, clearAll } from "./lib/db";
import { importMaxwellContracts, mapStatutoryHolidayPaidFrom } from "@/lib/longterm-payroll/import-service";
import { buildLongtermPayrollInputs } from "@/lib/longterm-payroll/aggregate";

type R = { staffNo: string; name: string; basic: number; commencement: string; sh?: string };
async function wb(rows: R[]) {
  const w = new ExcelJS.Workbook();
  const ws = w.addWorksheet("在職名單");
  ws.getCell(2, 3).value = "Staff No.";
  rows.forEach((r, i) => {
    const row = 3 + i;
    ws.getCell(row, 3).value = r.staffNo;
    ws.getCell(row, 5).value = r.name;
    ws.getCell(row, 18).value = new Date(r.commencement);
    ws.getCell(row, 23).value = r.basic;
    if (r.sh !== undefined) ws.getCell(row, 28).value = r.sh;
  });
  w.addWorksheet("離職名單");
  return Buffer.from(await w.xlsx.writeBuffer());
}

describe("mapStatutoryHolidayPaidFrom", () => {
  it("即時 → immediate；空白／其他 → after_3_months", () => {
    expect(mapStatutoryHolidayPaidFrom("即時享有薪SH")).toBe("immediate");
    expect(mapStatutoryHolidayPaidFrom("Immediate")).toBe("immediate");
    expect(mapStatutoryHolidayPaidFrom(null)).toBe("after_3_months");
    expect(mapStatutoryHolidayPaidFrom("")).toBe("after_3_months");
    expect(mapStatutoryHolidayPaidFrom("滿3個月")).toBe("after_3_months");
  });
});

describe("P16a Maxwell 導入：法定假期有薪起點", () => {
  let actor: string;
  beforeEach(async () => {
    await clearAll();
    const role = await prisma.role.findFirstOrThrow({ where: { name: "老闆" } });
    actor = (await prisma.user.create({ data: { name: "測試老闆", tel: `9${Math.floor(1000000 + Math.random() * 8999999)}`, passwordHash: "x", roleId: role.id, createdBy: "test" } })).id;
  });
  afterAll(async () => {
    await clearAll();
    await prisma.$disconnect();
  });

  it("新導入：空白 → after_3_months；「即時享有薪SH」→ immediate", async () => {
    await prisma.guard.create({ data: { nameZh: "測試空白", employmentType: "longterm_autopay", staffNoMw: "MG9601", createdBy: "test" } });
    await prisma.guard.create({ data: { nameZh: "測試即時", employmentType: "longterm_autopay", staffNoMw: "MG9602", createdBy: "test" } });
    await importMaxwellContracts(await wb([
      { staffNo: "MG9601", name: "測試空白", basic: 15500, commencement: "2026-05-01" },
      { staffNo: "MG9602", name: "測試即時", basic: 15500, commencement: "2026-05-01", sh: "即時享有薪SH" },
    ]), actor, null);
    const a = await prisma.guardLongtermContract.findFirstOrThrow({ where: { guard: { nameZh: "測試空白" } } });
    const b = await prisma.guardLongtermContract.findFirstOrThrow({ where: { guard: { nameZh: "測試即時" } } });
    expect(a.statutoryHolidayPaidFrom).toBe("after_3_months");
    expect(b.statutoryHolidayPaidFrom).toBe("immediate");
  });

  it("重導入：更新既有 maxwell_import 合約（寫 audit、summary 計數）；manual 合約唔掂；再跑冪等", async () => {
    const g = await prisma.guard.create({ data: { nameZh: "測試舊約", employmentType: "longterm_autopay", staffNoMw: "MG9611", createdBy: "test" } });
    const old = await prisma.guardLongtermContract.create({
      data: { guardId: g.id, monthlySalary: 15500, effectiveFrom: new Date("2026-05-01"), effectiveTo: null, statutoryHolidayPaidFrom: "immediate", annualLeaveDays: 7, source: "maxwell_import", createdBy: actor },
    });
    const gm = await prisma.guard.create({ data: { nameZh: "測試人手約", employmentType: "longterm_autopay", staffNoMw: "MG9612", createdBy: "test" } });
    const man = await prisma.guardLongtermContract.create({
      data: { guardId: gm.id, monthlySalary: 15500, effectiveFrom: new Date("2026-05-01"), effectiveTo: null, statutoryHolidayPaidFrom: "immediate", annualLeaveDays: 7, source: "manual", createdBy: actor },
    });
    const file = await wb([
      { staffNo: "MG9611", name: "測試舊約", basic: 15500, commencement: "2026-05-01" },
      { staffNo: "MG9612", name: "測試人手約", basic: 15500, commencement: "2026-05-01" },
    ]);
    const s = await importMaxwellContracts(file, actor, null);
    expect(s.contracts_fields_updated).toBe(1);
    expect(s.contractsCreated).toBe(0);
    const after = await prisma.guardLongtermContract.findUniqueOrThrow({ where: { id: old.id } });
    expect(after.statutoryHolidayPaidFrom).toBe("after_3_months");
    expect(after.voidedAt).toBeNull();
    expect((await prisma.guardLongtermContract.findUniqueOrThrow({ where: { id: man.id } })).statutoryHolidayPaidFrom).toBe("immediate");
    expect(await prisma.auditLog.count({ where: { tableName: "guard_longterm_contracts", rowId: old.id, action: "update" } })).toBe(1);
    const s2 = await importMaxwellContracts(file, actor, null);
    expect(s2.contracts_fields_updated).toBe(0);
  });

  it("import→aggregate：7 月 1 日 SH，入職未滿 3 個月（空白）→ 扣 NPSH；「即時」→ 唔扣", async () => {
    await prisma.guard.create({ data: { nameZh: "測試未滿三月", employmentType: "longterm_autopay", staffNoMw: "MG9621", createdBy: "test" } });
    await prisma.guard.create({ data: { nameZh: "測試即時有薪", employmentType: "longterm_autopay", staffNoMw: "MG9622", createdBy: "test" } });
    await importMaxwellContracts(await wb([
      { staffNo: "MG9621", name: "測試未滿三月", basic: 15500, commencement: "2026-05-01" },
      { staffNo: "MG9622", name: "測試即時有薪", basic: 15500, commencement: "2026-05-01", sh: "即時享有薪SH" },
    ]), actor, null);
    const site = await prisma.site.create({ data: { canonicalName: `測試盤-${Math.random().toString(36).slice(2, 8)}`, clientName: "測試客戶", billingModel: "per_shift", createdBy: "test" } });
    const st = await prisma.shiftType.create({ data: { siteId: site.id, code: "N", hours: 12, createdBy: "test" } });
    for (const gd of await prisma.guard.findMany({ where: { staffNoMw: { in: ["MG9621", "MG9622"] } } })) {
      await prisma.shiftRecord.create({ data: { workDate: new Date(Date.UTC(2026, 6, 1)), siteId: site.id, shiftTypeId: st.id, guardId: gd.id, recordType: "leave", leaveCode: "SH", createdBy: "test" } });
    }
    const r = await buildLongtermPayrollInputs(new Date(Date.UTC(2026, 6, 1)));
    const byName = async (n: string) => {
      const gd = await prisma.guard.findFirstOrThrow({ where: { nameZh: n } });
      return r.lines.find((l) => l.guardId === gd.id)!;
    };
    expect((await byName("測試未滿三月")).npsh).toBeLessThan(0);
    expect((await byName("測試即時有薪")).npsh).toBe(0);
  });
});
