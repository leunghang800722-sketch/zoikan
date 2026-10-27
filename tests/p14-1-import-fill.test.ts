// P14.1：Maxwell 導入補欄（nameEn／staffNoMw）——只補空、永不覆蓋、永不改 monthlySalary；
// 正式站 staffNoMw 全空嘅情況（靠中文名配對）；撞號只警告。合成資料（測試甲乙、MG9xxx）。
import { fakeTel } from "./helpers/fake-tel";
import { describe, it, expect, beforeEach } from "vitest";
import ExcelJS from "exceljs";
import { prisma, clearAll } from "./lib/db";
import { importMaxwellContracts } from "@/lib/longterm-payroll/import-service";

type R = { staffNo: string; nameEn?: string; name: string; basic: number; commencement: string };
async function wb(rows: R[]) {
  const w = new ExcelJS.Workbook();
  const ws = w.addWorksheet("在職名單");
  ws.getCell(2, 3).value = "Staff No.";
  rows.forEach((r, i) => {
    const row = 3 + i;
    ws.getCell(row, 3).value = r.staffNo;
    if (r.nameEn) ws.getCell(row, 4).value = r.nameEn;
    ws.getCell(row, 5).value = r.name;
    ws.getCell(row, 18).value = new Date(r.commencement);
    ws.getCell(row, 23).value = r.basic;
  });
  w.addWorksheet("離職名單");
  return Buffer.from(await w.xlsx.writeBuffer());
}

describe("P14.1 Maxwell 導入補欄", () => {
  let actor: string;
  beforeEach(async () => {
    await clearAll();
    const role = await prisma.role.findFirstOrThrow({ where: { name: "老闆" } });
    actor = (await prisma.user.create({ data: { name: "測試老闆", tel: fakeTel(), passwordHash: "x", roleId: role.id, createdBy: "test" } })).id;
  });

  it("staffNoMw 全空 → 靠中文名配對，補 nameEn＋MG 工號（經 guard_staff_numbers 並同步 staffNoMw）；monthlySalary 不變", async () => {
    const g = await prisma.guard.create({ data: { nameZh: "測試甲", employmentType: "longterm_autopay", monthlySalary: 12345, createdBy: "test" } });
    const s = await importMaxwellContracts(await wb([{ staffNo: "MG9201", nameEn: "Test Alpha", name: "測試甲", basic: 15500, commencement: "2024-03-01" }]), actor, null);
    expect(s.matchedByName).toBe(1);
    expect(s.filled_name_en).toBe(1);
    expect(s.filled_staff_no_mw).toBe(1);
    const u = await prisma.guard.findUniqueOrThrow({ where: { id: g.id } });
    expect(u.nameEn).toBe("Test Alpha");
    expect(u.staffNoMw).toBe("MG9201");
    expect(Number(u.monthlySalary)).toBe(12345);
    const nums = await prisma.guardStaffNumber.findMany({ where: { guardId: g.id } });
    expect(nums).toHaveLength(1);
    expect(nums[0]).toMatchObject({ scheme: "MG", number: "MG9201", status: "current", source: "import:maxwell" });
    // 第二次：改為靠工號配對，唔再補
    const s2 = await importMaxwellContracts(await wb([{ staffNo: "MG9201", nameEn: "Test Alpha", name: "測試甲", basic: 15500, commencement: "2024-03-01" }]), actor, null);
    expect(s2.matchedByStaffNo).toBe(1);
    expect(s2.filled_name_en).toBe(0);
    expect(s2.filled_staff_no_mw).toBe(0);
  });

  it("永不覆蓋非空 nameEn／staffNoMw", async () => {
    const g = await prisma.guard.create({ data: { nameZh: "測試乙", nameEn: "Keep Name", staffNoMw: "MG9300", employmentType: "longterm_autopay", createdBy: "test" } });
    const s = await importMaxwellContracts(await wb([{ staffNo: "MG9300", nameEn: "Other Name", name: "測試乙", basic: 15500, commencement: "2024-03-01" }]), actor, null);
    expect(s.filled_name_en).toBe(0);
    expect(s.filled_staff_no_mw).toBe(0);
    const u = await prisma.guard.findUniqueOrThrow({ where: { id: g.id } });
    expect(u.nameEn).toBe("Keep Name");
    expect(u.staffNoMw).toBe("MG9300");
  });

  it("工號已掛喺另一人 → 只警告，唔補、其餘照導入", async () => {
    const other = await prisma.guard.create({ data: { nameZh: "測試丙", employmentType: "longterm_autopay", createdBy: "test" } });
    await prisma.guardStaffNumber.create({ data: { guardId: other.id, scheme: "MG", number: "MG9400", status: "current", source: "manual" } });
    const g = await prisma.guard.create({ data: { nameZh: "測試丁", employmentType: "longterm_autopay", createdBy: "test" } });
    const s = await importMaxwellContracts(await wb([{ staffNo: "MG9400", nameEn: "Test Delta", name: "測試丁", basic: 15500, commencement: "2024-03-01" }]), actor, null);
    expect(s.filled_staff_no_mw).toBe(0);
    expect(s.filled_name_en).toBe(1);
    expect(s.warnings.some((w) => w.includes("MG9400"))).toBe(true);
    expect(s.contractsCreated).toBe(1);
    expect((await prisma.guard.findUniqueOrThrow({ where: { id: g.id } })).staffNoMw).toBeNull();
  });

  it("中文名重複／配唔到 → 唔建新 guard，列入 unmatched", async () => {
    await prisma.guard.create({ data: { nameZh: "測試戊", employmentType: "longterm_autopay", createdBy: "test" } });
    await prisma.guard.create({ data: { nameZh: "測試戊", employmentType: "longterm_autopay", createdBy: "test" } });
    const before = await prisma.guard.count();
    const s = await importMaxwellContracts(await wb([{ staffNo: "MG9500", name: "測試戊", basic: 15500, commencement: "2024-03-01" }, { staffNo: "MG9501", name: "測試己", basic: 15500, commencement: "2024-03-01" }]), actor, null);
    expect(s.unmatched).toHaveLength(2);
    expect(await prisma.guard.count()).toBe(before);
  });
});
