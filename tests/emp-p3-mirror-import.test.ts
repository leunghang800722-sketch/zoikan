// EMP-P3 第 2／3 部分：人卡鏡像 syncLegacyGuardEmploymentColumns（三條規則）＋ Maxwell 導入開 MG 卡（兩情況＋離職名單）＋ 長工 gate 延伸到 staffHire.MG*。
import { describe, it, expect, beforeEach } from "vitest";
import ExcelJS from "exceljs";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { POST as cardCreate } from "@/app/api/guards/[id]/staff-numbers/route";
import { PATCH as cardPatch } from "@/app/api/guards/[id]/staff-numbers/[numberId]/route";
import { syncLegacyGuardEmploymentColumns } from "@/lib/guards/staff-numbers";
import { importMaxwellContracts } from "@/lib/longterm-payroll/import-service";
import { heldAll, isLongtermStaffHireKey } from "@/lib/guards/import/ext";

const D = (s: string) => new Date(`${s}T00:00:00.000Z`);
const dayOf = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
const sync = (guardId: string) => prisma.$transaction((tx) => syncLegacyGuardEmploymentColumns(tx, guardId));

describe("EMP-P3 鏡像 syncLegacyGuardEmploymentColumns", () => {
  let fx: Wp2Fixture;
  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    await prisma.staffScheme.upsert({ where: { code: "MG" }, update: { isLongterm: true }, create: { code: "MG", labelZh: "MG", isLongterm: true, isFrontline: false, sort: 3 } });
  });
  const mk = (over: Record<string, unknown>) => prisma.guardStaffNumber.create({ data: { guardId: fx.guardA.id, scheme: "MG", number: `MG9${Math.floor(1000 + Math.random() * 8999)}`, status: "current", ...over } as never });

  it("(1) hire_date＝長工體系卡最早 valid_from（冇卡有 valid_from 就保留原值）", async () => {
    await prisma.guard.update({ where: { id: fx.guardA.id }, data: { hireDate: D("2019-05-05") } });
    await mk({ status: "former" });
    expect((await sync(fx.guardA.id)).changed).toBe(false); // 卡冇任何日期：完全唔郁
    await mk({ status: "former", validFrom: D("2021-03-03"), validTo: D("2022-02-02"), endReason: "resigned" });
    await mk({ validFrom: D("2020-01-01") });
    expect((await sync(fx.guardA.id)).changed).toBe(true);
    expect(dayOf((await prisma.guard.findUniqueOrThrow({ where: { id: fx.guardA.id } })).hireDate)).toBe("2020-01-01");
  });

  it("(2) leave_date：長工體系卡全部 former → 最遲 valid_to；有任何 current → null；全部 former 但冇 valid_to → 保留原值", async () => {
    await prisma.guard.update({ where: { id: fx.guardA.id }, data: { leaveDate: D("2020-12-31") } });
    const a = await mk({ status: "former", validFrom: D("2020-01-01"), validTo: D("2021-06-30"), endReason: "resigned" });
    await sync(fx.guardA.id);
    expect(dayOf((await prisma.guard.findUniqueOrThrow({ where: { id: fx.guardA.id } })).leaveDate)).toBe("2021-06-30");
    const b = await mk({ validFrom: D("2022-01-01") }); // 再入職：current
    await sync(fx.guardA.id);
    expect((await prisma.guard.findUniqueOrThrow({ where: { id: fx.guardA.id } })).leaveDate).toBeNull();
    await prisma.guardStaffNumber.update({ where: { id: b.id }, data: { status: "former", validTo: D("2023-03-03"), endReason: "resigned" } });
    await sync(fx.guardA.id);
    expect(dayOf((await prisma.guard.findUniqueOrThrow({ where: { id: fx.guardA.id } })).leaveDate)).toBe("2023-03-03");
    void a;
    // 全部 former 但冇 valid_to（舊資料）→ 保留
    await clearAll();
    fx = await seedWp2Fixture();
    await prisma.guard.update({ where: { id: fx.guardA.id }, data: { leaveDate: D("2020-12-31") } });
    await mk({ status: "former", validFrom: D("2020-01-01"), validTo: null, endReason: "cancelled" });
    await sync(fx.guardA.id);
    expect(dayOf((await prisma.guard.findUniqueOrThrow({ where: { id: fx.guardA.id } })).leaveDate)).toBe("2020-12-31");
  });

  it("(3) employment_type 唔郁；只有散工卡（U）完全唔鏡像；結果有變先寫 audit，冇變唔寫", async () => {
    await prisma.guard.update({ where: { id: fx.guardA.id }, data: { employmentType: "cash_casual" } });
    await prisma.guardStaffNumber.create({ data: { guardId: fx.guardA.id, scheme: "U", number: "U99701", status: "current", validFrom: D("2018-01-01") } });
    expect((await sync(fx.guardA.id)).changed).toBe(false); // 無長工體系卡
    await mk({ validFrom: D("2020-01-01") });
    const auditBefore = await prisma.auditLog.count({ where: { tableName: "guards", rowId: fx.guardA.id } });
    expect((await sync(fx.guardA.id)).changed).toBe(true);
    expect(await prisma.auditLog.count({ where: { tableName: "guards", rowId: fx.guardA.id } })).toBe(auditBefore + 1);
    expect((await sync(fx.guardA.id)).changed).toBe(false); // 再 sync：冇變 → 冇新 audit
    expect(await prisma.auditLog.count({ where: { tableName: "guards", rowId: fx.guardA.id } })).toBe(auditBefore + 1);
    expect((await prisma.guard.findUniqueOrThrow({ where: { id: fx.guardA.id } })).employmentType).toBe("cash_casual");
  });

  it("工號卡寫入路徑（POST／PATCH）自動鏡像", async () => {
    const cookie = await sessionCookieForUser(fx.userIds["老闆"]);
    const url = `http://test.local/api/guards/${fx.guardB.id}/staff-numbers`;
    const post = (body: unknown) => cardCreate(new Request(url, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) }), { params: Promise.resolve({ id: fx.guardB.id }) });
    const res = await post({ scheme: "MG", number: "MG99801", valid_from: "2025-05-05" });
    const card = (await res.json()) as { id: string };
    expect(dayOf((await prisma.guard.findUniqueOrThrow({ where: { id: fx.guardB.id } })).hireDate)).toBe("2025-05-05");
    const patch = await cardPatch(new Request(`${url}/${card.id}`, { method: "PATCH", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ status: "former", valid_to: "2026-02-02", end_reason: "resigned" }) }), { params: Promise.resolve({ id: fx.guardB.id, numberId: card.id }) });
    expect(patch.status).toBe(200);
    expect(dayOf((await prisma.guard.findUniqueOrThrow({ where: { id: fx.guardB.id } })).leaveDate)).toBe("2026-02-02");
  });
});

type R = { staffNo: string; name: string; basic: number; commencement: string; lastDay?: string };
async function wb(active: R[], left: R[] = []) {
  const w = new ExcelJS.Workbook();
  const put = (ws: ExcelJS.Worksheet, rows: R[], withLast: boolean) => {
    ws.getCell(2, 3).value = "Staff No.";
    if (withLast) ws.getCell(2, 31).value = "Last Day";
    rows.forEach((r, i) => {
      const row = 3 + i;
      ws.getCell(row, 3).value = r.staffNo;
      ws.getCell(row, 5).value = r.name;
      ws.getCell(row, 18).value = new Date(r.commencement);
      ws.getCell(row, 23).value = r.basic;
      if (withLast && r.lastDay) ws.getCell(row, 31).value = new Date(r.lastDay);
    });
  };
  put(w.addWorksheet("在職名單"), active, false);
  put(w.addWorksheet("離職名單"), left, true);
  return Buffer.from(await w.xlsx.writeBuffer());
}

describe("EMP-P3 Maxwell 導入開 MG 卡", () => {
  let actor: string;
  beforeEach(async () => {
    await clearAll();
    const role = await prisma.role.findFirstOrThrow({ where: { name: "老闆" } });
    actor = (await prisma.user.create({ data: { name: "測試老闆", tel: `9${Math.floor(1000000 + Math.random() * 8999999)}`, passwordHash: "x", roleId: role.id, createdBy: "test" } })).id;
    await prisma.staffScheme.upsert({ where: { code: "MG" }, update: { isLongterm: true }, create: { code: "MG", labelZh: "MG", isLongterm: true, isFrontline: false, sort: 3 } });
  });

  it("情況 1：有長工 line 而冇 MG 卡 → 開 MG 卡（import:maxwell、valid_from＝導入入職日）；人卡 hire_date 由鏡像決定", async () => {
    const g = await prisma.guard.create({ data: { nameZh: "測試甲", employmentType: "longterm_autopay", createdBy: "t" } });
    const s = await importMaxwellContracts(await wb([{ staffNo: "MG9401", name: "測試甲", basic: 15500, commencement: "2024-03-01" }]), actor, null);
    expect(s.filled_staff_no_mw).toBe(1);
    const card = await prisma.guardStaffNumber.findFirstOrThrow({ where: { guardId: g.id } });
    expect(card).toMatchObject({ scheme: "MG", number: "MG9401", status: "current", source: "import:maxwell" });
    expect(dayOf(card.validFrom)).toBe("2024-03-01");
    expect(dayOf((await prisma.guard.findUniqueOrThrow({ where: { id: g.id } })).hireDate)).toBe("2024-03-01");
  });

  it("情況 2：舊 MG 卡已 resigned，導入入職日遲過 valid_to → 開新 MG 卡（新聘用段）；導入入職日唔遲過就唔開", async () => {
    const g = await prisma.guard.create({ data: { nameZh: "測試乙", employmentType: "longterm_autopay", hireDate: D("2020-01-01"), leaveDate: D("2021-12-31"), staffNoMw: "MG9500", createdBy: "t" } });
    await prisma.guardStaffNumber.create({ data: { guardId: g.id, scheme: "MG", number: "MG9500", status: "former", validFrom: D("2020-01-01"), validTo: D("2021-12-31"), endReason: "resigned" } });
    // 入職日未遲過舊卡 valid_to → 唔開
    await importMaxwellContracts(await wb([{ staffNo: "MG9501", name: "測試乙", basic: 15500, commencement: "2021-06-01" }]), actor, null);
    expect(await prisma.guardStaffNumber.count({ where: { guardId: g.id } })).toBe(1);
    // 遲過 → 開新卡，舊卡不變
    const s = await importMaxwellContracts(await wb([{ staffNo: "MG9501", name: "測試乙", basic: 15500, commencement: "2026-09-15" }]), actor, null);
    expect(s.filled_staff_no_mw).toBe(1);
    const cards = await prisma.guardStaffNumber.findMany({ where: { guardId: g.id }, orderBy: { number: "asc" } });
    expect(cards.map((c) => [c.number, c.status])).toEqual([["MG9500", "former"], ["MG9501", "current"]]);
    expect(dayOf(cards[1]!.validFrom)).toBe("2026-09-15");
    const u = await prisma.guard.findUniqueOrThrow({ where: { id: g.id } });
    expect(u.leaveDate).toBeNull(); // 鏡像：有 current 卡 → 離職日清走（再入職）
    expect(dayOf(u.hireDate)).toBe("2020-01-01"); // 最早 valid_from
  });

  it("離職名單：新卡同時結束（former／resigned／valid_to＝最後一日），人卡 leave_date 跟返名單", async () => {
    const g = await prisma.guard.create({ data: { nameZh: "測試丙", employmentType: "longterm_autopay", createdBy: "t" } });
    await importMaxwellContracts(await wb([], [{ staffNo: "MG9601", name: "測試丙", basic: 15500, commencement: "2024-01-01", lastDay: "2026-08-31" }]), actor, null);
    const card = await prisma.guardStaffNumber.findFirstOrThrow({ where: { guardId: g.id } });
    expect(card).toMatchObject({ status: "former", endReason: "resigned" });
    expect(dayOf(card.validTo)).toBe("2026-08-31");
    expect(dayOf((await prisma.guard.findUniqueOrThrow({ where: { id: g.id } })).leaveDate)).toBe("2026-08-31");
  });

  it("人卡 hireDate／leaveDate 唔再被導入直接寫：冇 MG 號可記日期時照舊補空，永不覆蓋已有值", async () => {
    const g = await prisma.guard.create({ data: { nameZh: "測試丁", employmentType: "longterm_autopay", hireDate: D("2019-09-09"), createdBy: "t" } });
    await importMaxwellContracts(await wb([{ staffNo: "", name: "測試丁", basic: 15500, commencement: "2024-03-01" }]), actor, null);
    expect(dayOf((await prisma.guard.findUniqueOrThrow({ where: { id: g.id } })).hireDate)).toBe("2019-09-09");
  });
});

describe("EMP-P3 長工入職閘延伸到 staffHire.MG*", () => {
  it("isLongtermStaffHireKey／heldAll：MG 工號入職日期納入 longtermHire；U 工號唔受影響", () => {
    expect(isLongtermStaffHireKey("staffHire.MG9001")).toBe(true);
    expect(isLongtermStaffHireKey("staffHire.U9001")).toBe(false);
    expect(isLongtermStaffHireKey("hireDate")).toBe(false);
    const gate = { scalars: true, bank: true, longtermHire: true };
    expect(heldAll(gate, "staffHire.MG9001")).toEqual(["longterm"]);
    expect(heldAll(gate, "staffHire.U9001")).toEqual([]);
    expect(heldAll({ ...gate, longtermHire: false }, "staffHire.MG9001")).toEqual([]);
  });
});
