// EMP-P3 第 2／3 部分：人卡鏡像 syncLegacyGuardEmploymentColumns（三條規則）＋ Maxwell 導入開 MG 卡（兩情況＋離職名單）＋ 長工 gate 延伸到 staffHire.MG*。
import { describe, it, expect, beforeEach } from "vitest";
import ExcelJS from "exceljs";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { POST as cardCreate } from "@/app/api/guards/[id]/staff-numbers/route";
import { PATCH as cardPatch } from "@/app/api/guards/[id]/staff-numbers/[numberId]/route";
import { PATCH as guardPatch } from "@/app/api/guards/[id]/route";
import { importMaxwellContracts } from "@/lib/longterm-payroll/import-service";
import { heldAll, isLongtermStaffHireKey } from "@/lib/guards/import/ext";

const D = (s: string) => new Date(`${s}T00:00:00.000Z`);
const dayOf = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

describe("EMP-P3 鏡像（經真實寫入路徑 POST／PATCH／換號）", () => {
  let fx: Wp2Fixture;
  let cookie: string;
  const url = (g: string) => `http://test.local/api/guards/${g}/staff-numbers`;
  const post = (g: string, body: unknown) => cardCreate(new Request(url(g), { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) }), { params: Promise.resolve({ id: g }) });
  const patch = (g: string, id: string, body: unknown) => cardPatch(new Request(`${url(g)}/${id}`, { method: "PATCH", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) }), { params: Promise.resolve({ id: g, numberId: id }) });
  const gOf = (id: string) => prisma.guard.findUniqueOrThrow({ where: { id } });
  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    cookie = await sessionCookieForUser(fx.userIds["老闆"]);
    await prisma.staffScheme.upsert({ where: { code: "MG" }, update: { isLongterm: true }, create: { code: "MG", labelZh: "MG", isLongterm: true, isFrontline: false, sort: 3 } });
  });

  it("T1 hire_date 只由鏈頭 valid_from 決定：開新鏈鏈頭有日期 → 寫入；冇日期卡完全唔郁；散工 U 卡唔鏡像", async () => {
    const g = fx.guardA.id;
    await prisma.guard.update({ where: { id: g }, data: { hireDate: D("2019-05-05"), employmentType: "cash_casual" } });
    await post(g, { scheme: "U", number: "U99701", valid_from: "2018-01-01" }); // 散工卡：唔鏡像
    expect(dayOf((await gOf(g)).hireDate)).toBe("2019-05-05");
    await post(g, { scheme: "MG", number: "MG99702" }); // 無日期：唔郁
    expect(dayOf((await gOf(g)).hireDate)).toBe("2019-05-05");
    const first = (await (await post(g, { scheme: "MG", number: "MG99703", status: "former", valid_from: "2021-03-03", valid_to: "2022-02-02", end_reason: "resigned" })).json()) as { id: string };
    void first; // 仍然有一條無日期鏈頭（MG99702）→ ambiguous → 唔郁
    expect(dayOf((await gOf(g)).hireDate)).toBe("2019-05-05");
    expect((await gOf(g)).employmentType).toBe("cash_casual");
  });

  it("T2 換號新卡（有 predecessor）永遠唔參與入職日：舊卡冇日期＋換號新卡有 valid_from → hire_date 不變", async () => {
    const g = fx.guardB.id;
    await prisma.guard.update({ where: { id: g }, data: { hireDate: D("2025-03-03") } });
    await prisma.guardStaffNumber.create({ data: { guardId: g, scheme: "MG", number: "MG99711", status: "current" } }); // 生產常見：只抄咗號碼冇日期
    const res = await post(g, { scheme: "MG", number: "MG99712", valid_from: "2026-10-15", replaces_current: true });
    expect(res.status).toBe(201);
    expect(dayOf((await gOf(g)).hireDate)).toBe("2025-03-03");
    const nc = await prisma.guardStaffNumber.findUniqueOrThrow({ where: { number: "MG99712" } });
    expect(nc.predecessorId).not.toBeNull();
  });

  it("T3 鏈頭有日期 → 取鏈頭；換號後鏈頭日期仍然係入職日（換號新卡日期唔改寫）", async () => {
    const g = fx.guardB.id;
    const first = (await (await post(g, { scheme: "MG", number: "MG99721", valid_from: "2020-01-01" })).json()) as { id: string };
    void first;
    expect(dayOf((await gOf(g)).hireDate)).toBe("2020-01-01");
    await post(g, { scheme: "MG", number: "MG99722", valid_from: "2026-10-15", replaces_current: true });
    expect(dayOf((await gOf(g)).hireDate)).toBe("2020-01-01");
  });

  it("T4 leave_date 全部 former → 最遲 valid_to；再入職開新卡（current，valid_from 遲過舊離職日）→ 清走舊段殘留；結束新卡 → 新離職日", async () => {
    const g = fx.guardA.id;
    const a = (await (await post(g, { scheme: "MG", number: "MG99731", valid_from: "2020-01-01" })).json()) as { id: string };
    const ended = await patch(g, a.id, { status: "former", valid_to: "2021-06-30", end_reason: "resigned" });
    expect(ended.status).toBe(200);
    expect(dayOf((await gOf(g)).leaveDate)).toBe("2021-06-30");
    const b = await post(g, { scheme: "MG", number: "MG99732", valid_from: "2022-01-01" });
    expect(b.status).toBe(201);
    expect((await gOf(g)).leaveDate).toBeNull();
    const bj = (await b.json()) as { id: string; employment_warnings?: string[] };
    expect(bj.employment_warnings?.[0]).toContain("stale_leave_date_cleared");
    const audit = await prisma.auditLog.findFirst({ where: { tableName: "guards", rowId: g, action: "update" }, orderBy: { createdAt: "desc" } });
    expect(audit!.actorUserId).toBe(fx.userIds["老闆"]); // S3：鏡像 audit 帶觸發者
    await patch(g, bj.id, { status: "former", valid_to: "2023-03-03", end_reason: "resigned" });
    expect(dayOf((await gOf(g)).leaveDate)).toBe("2023-03-03");
  });

  it("M4a 人卡 leave_date 遲過現行 MG 卡 valid_from（真係離職）→ 之後任何工號卡寫入都唔清走，並出提示「請用結束卡流程」", async () => {
    const g = fx.guardB.id;
    await post(g, { scheme: "MG", number: "MG99741", valid_from: "2020-01-01" });
    await prisma.guard.update({ where: { id: g }, data: { leaveDate: D("2026-12-31") } }); // 老闆喺人卡表格填咗離職日
    const r = await post(g, { scheme: "U", number: "U99742" }); // 之後任何工號卡寫入（例如加 U 卡）
    expect(r.status).toBe(201);
    expect(dayOf((await gOf(g)).leaveDate)).toBe("2026-12-31");
    expect(((await r.json()) as { employment_warnings?: string[] }).employment_warnings?.[0]).toContain("leave_date_vs_current_card");
  });

  it("M4b 人卡 PATCH 改 hire_date／leave_date：有帶日期嘅 current MG 卡 → 409 use_staff_number_card；值冇變、冇 MG 卡、卡冇日期 → 照舊接受", async () => {
    const g = fx.guardB.id;
    const patchGuard = (id: string, body: unknown) => guardPatch(new Request(`http://test.local/api/guards/${id}`, { method: "PATCH", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) }), { params: Promise.resolve({ id }) });
    expect((await patchGuard(g, { leave_date: "2026-12-31" })).status).toBe(200); // 冇 MG 卡
    await prisma.guardStaffNumber.create({ data: { guardId: g, scheme: "MG", number: "MG99751", status: "current" } });
    expect((await patchGuard(g, { hire_date: "2024-04-04" })).status).toBe(200); // 卡冇日期
    await prisma.guardStaffNumber.updateMany({ where: { guardId: g }, data: { validFrom: D("2020-01-01") } });
    const blocked = await patchGuard(g, { leave_date: "2027-01-01" });
    expect(blocked.status).toBe(409);
    expect(((await blocked.json()) as { error: string }).error).toBe("use_staff_number_card");
    expect((await patchGuard(g, { hire_date: "2024-04-04", leave_date: "2026-12-31" })).status).toBe(200); // 值冇變（成個 form 一齊送）
    expect(dayOf((await gOf(g)).leaveDate)).toBe("2026-12-31");
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
