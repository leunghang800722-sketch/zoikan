// P11.1：Maxwell 導入 contract_start_mode（original／first_unlocked）。合成 fixture，唔用真人資料。
import { fakeTel } from "./helpers/fake-tel";
import { describe, it, expect, beforeEach } from "vitest";
import ExcelJS from "exceljs";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser } from "./fixtures/wp2-fixture";
import { importMaxwellContracts, importMaxwellContractsCsv, clipSegmentsFrom } from "@/lib/longterm-payroll/import-service";
import { recomputeLongtermPayroll } from "@/lib/longterm-payroll/aggregate";
import { POST as importContracts } from "@/app/api/longterm/contracts/import/route";

type R = { staffNo: string; name: string; basic: number; commencement: string; newBasic?: number; newBasicEff?: string };
async function buildWorkbook(rows: R[]) {
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
    if (r.newBasic != null) ws.getCell(row, 24).value = r.newBasic;
    if (r.newBasicEff) ws.getCell(row, 25).value = new Date(r.newBasicEff);
  });
  wb.addWorksheet("離職名單");
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe("P11.1：Maxwell 導入合約起始模式", () => {
  let actorUserId: string;
  const d = (s: string) => new Date(s + "T00:00:00.000Z");

  beforeEach(async () => {
    await clearAll();
    const role = await prisma.role.findFirstOrThrow({ where: { name: "老闆" } });
    const user = await prisma.user.create({ data: { name: "測試老闆", tel: fakeTel(), passwordHash: "x", roleId: role.id, createdBy: "test" } });
    actorUserId = user.id;
    await prisma.monthClose.create({ data: { month: d("2026-07-01"), lockedAt: new Date(), lockedBy: actorUserId, createdBy: "test" } });
    await prisma.monthClose.create({ data: { month: d("2026-08-01"), lockedAt: new Date(), lockedBy: actorUserId, createdBy: "test" } });
    await prisma.monthClose.create({ data: { month: d("2026-09-01"), createdBy: "test" } }); // 未鎖
  });

  async function mkGuard(staffNoMw: string, name: string, monthlySalary?: number) {
    return prisma.guard.create({ data: { nameZh: name, employmentType: "longterm_autopay", staffNoMw, monthlySalary, createdBy: "test" } });
  }
  const rows: R[] = [
    { staffNo: "MG9301", name: "測試甲", basic: 15000, commencement: "2024-03-01" },
    { staffNo: "MG9302", name: "測試乙", basic: 16000, commencement: "2025-06-15" },
    { staffNo: "MG9303", name: "測試丙", basic: 15000, commencement: "2023-01-01", newBasic: 17000, newBasicEff: "2026-05-01" },
    { staffNo: "MG9304", name: "測試丁", basic: 18000, commencement: "2026-10-01" }, // 入職晚過第一個未鎖月
  ];

  it("original（預設）：覆蓋鎖月嘅行全部跳過，行為同階段 9 一樣", async () => {
    for (const r of rows) await mkGuard(r.staffNo, r.name);
    const s = await importMaxwellContracts(await buildWorkbook(rows), actorUserId, null);
    expect(s.startMode).toBe("original");
    expect(s.contractStartFrom).toBeNull();
    expect(s.skippedLockedRows).toBe(s.skippedLocked);
    expect(s.skippedLockedRows).toBe(3);
    expect(s.contractsCreated).toBe(1); // 只得入職 2026-10 嗰個
    expect(s.created).toBe(1);
    expect(s.warnings.some((w) => w.includes("名單月薪同系統現值"))).toBe(false);
  });

  it("first_unlocked：全部建合約、effective_from＝第一個未鎖月 1 號，原入職日喺 note，monthlySalary 零改動，鎖月零改動", async () => {
    const g1 = await mkGuard("MG9301", "測試甲", 15000);
    await mkGuard("MG9302", "測試乙", 15500); // 同名單 16000 唔同
    await mkGuard("MG9303", "測試丙");
    await mkGuard("MG9304", "測試丁");
    const auditBefore = await prisma.auditLog.count({ where: { action: "permission_denied" } });
    const s = await importMaxwellContracts(await buildWorkbook(rows), actorUserId, null, { contractStartMode: "first_unlocked" });
    expect(s.startMode).toBe("first_unlocked");
    expect(s.contractStartFrom).toBe("2026-09-01");
    expect(s.skippedLockedRows).toBe(0);
    expect(s.contractsCreated).toBe(4);
    expect(s.salaryMismatch).toBe(1);
    expect(s.warnings.some((w) => w.includes("1 人名單月薪同系統現值"))).toBe(true);

    const all = await prisma.guardLongtermContract.findMany({ where: { voidedAt: null }, include: { guard: true }, orderBy: { guard: { staffNoMw: "asc" } } });
    expect(all).toHaveLength(4);
    const byNo = Object.fromEntries(all.map((c) => [c.guard.staffNoMw!, c]));
    expect(byNo.MG9301.effectiveFrom.toISOString().slice(0, 10)).toBe("2026-09-01");
    expect(byNo.MG9301.note).toContain("原入職日 2024-03-01");
    expect(byNo.MG9303.effectiveFrom.toISOString().slice(0, 10)).toBe("2026-09-01"); // 舊薪段喺 start 前（丟棄），只留新薪段
    expect(Number(byNo.MG9303.monthlySalary)).toBe(17000);
    expect(byNo.MG9304.effectiveFrom.toISOString().slice(0, 10)).toBe("2026-10-01"); // 入職遲過 start → 保留
    // monthlySalary 零改動
    expect(Number((await prisma.guard.findUniqueOrThrow({ where: { id: g1.id } })).monthlySalary)).toBe(15000);
    expect(Number((await prisma.guard.findFirstOrThrow({ where: { staffNoMw: "MG9302" } })).monthlySalary)).toBe(15500);
    expect((await prisma.guard.findFirstOrThrow({ where: { staffNoMw: "MG9303" } })).monthlySalary).toBeNull();
    // 鎖月零改動：冇任何合約蓋住 7、8 月；無 permission_denied；month_closes 鎖狀態不變
    for (const c of all) expect(c.effectiveFrom.getTime()).toBeGreaterThanOrEqual(d("2026-09-01").getTime());
    expect(await prisma.auditLog.count({ where: { action: "permission_denied" } })).toBe(auditBefore);
    expect(await prisma.monthClose.count({ where: { lockedAt: { not: null } } })).toBe(2);
  });

  it("first_unlocked 重跑冪等（唔重複建）；冇鎖月 → 保持原入職日", async () => {
    for (const r of rows) await mkGuard(r.staffNo, r.name);
    const buf = await buildWorkbook(rows);
    await importMaxwellContracts(buf, actorUserId, null, { contractStartMode: "first_unlocked" });
    const again = await importMaxwellContracts(buf, actorUserId, null, { contractStartMode: "first_unlocked" });
    expect(again.contractsCreated).toBe(0);
    expect(await prisma.guardLongtermContract.count({ where: { voidedAt: null } })).toBe(4);

    await prisma.guardLongtermContract.deleteMany({});
    await prisma.monthClose.updateMany({ data: { lockedAt: null, lockedBy: null } });
    const none = await importMaxwellContracts(buf, actorUserId, null, { contractStartMode: "first_unlocked" });
    expect(none.contractStartFrom).toBeNull();
    expect(none.contractsCreated).toBe(5); // 甲乙丁各 1 + 丙兩段
    const a = await prisma.guardLongtermContract.findFirstOrThrow({ where: { guard: { staffNoMw: "MG9301" } } });
    expect(a.effectiveFrom.toISOString().slice(0, 10)).toBe("2024-03-01");
  });

  // ---- M1：離職名單 ----
  async function buildLeftWorkbook(left: Array<{ staffNo: string; name: string; lastDay: string | null }>) {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet("在職名單");
    const ws = wb.addWorksheet("離職名單");
    ws.getCell(2, 3).value = "Staff No.";
    ws.getCell(2, 5).value = "Name";
    ws.getCell(2, 30).value = "Last Day";
    left.forEach((r, i) => {
      const row = 3 + i;
      ws.getCell(row, 3).value = r.staffNo;
      ws.getCell(row, 5).value = r.name;
      ws.getCell(row, 18).value = new Date("2024-03-01");
      ws.getCell(row, 20).value = "1";
      ws.getCell(row, 23).value = 15000;
      if (r.lastDay) ws.getCell(row, 30).value = new Date(r.lastDay);
    });
    return Buffer.from(await wb.xlsx.writeBuffer());
  }
  const LEFT = [
    { staffNo: "MG9401", name: "離職甲", lastDay: "2026-08-15" }, // 早過起始日
    { staffNo: "MG9402", name: "離職乙", lastDay: null }, // 冇離職日
    { staffNo: "MG9403", name: "離職丙", lastDay: "2026-09-20" }, // 起始日之後
  ];

  it("M1 first_unlocked + xlsx 離職名單：離職日空／早過起始日 → 唔建合約；之後 → effectiveTo＝離職日；唔出糧", async () => {
    for (const l of LEFT) await mkGuard(l.staffNo, l.name);
    const s = await importMaxwellContracts(await buildLeftWorkbook(LEFT), actorUserId, null, { contractStartMode: "first_unlocked" });
    expect(s.skippedLeftBeforeStart).toBe(2);
    expect(s.contractsCreated).toBe(1);
    expect(s.warnings.filter((w) => w.includes("唔建合約"))).toHaveLength(2);
    expect(await prisma.guardLongtermContract.count({ where: { guard: { staffNoMw: { in: ["MG9401", "MG9402"] } } } })).toBe(0);
    const c = await prisma.guardLongtermContract.findFirstOrThrow({ where: { guard: { staffNoMw: "MG9403" } } });
    expect(c.effectiveFrom.toISOString().slice(0, 10)).toBe("2026-09-01");
    expect(c.effectiveTo?.toISOString().slice(0, 10)).toBe("2026-09-20");
    expect(c.note).toContain("原入職日 2024-03-01");
    const run = await recomputeLongtermPayroll(d("2026-09-01"), actorUserId, null);
    const lines = await prisma.longtermPayrollLine.findMany({ where: { runId: run.runId }, include: { guard: true } });
    expect(lines.some((l) => ["MG9401", "MG9402"].includes(l.guard.staffNoMw ?? ""))).toBe(false);
  });

  it("M1 first_unlocked + CSV（left_csv）同樣處理", async () => {
    for (const l of LEFT) await mkGuard(l.staffNo, l.name);
    const header = Array.from({ length: 30 }, (_, i) => (i === 2 ? "Staff No." : i === 4 ? "Name" : i === 29 ? "Last Day" : "")).join(",");
    const line = (l: (typeof LEFT)[number]) => {
      const cells = Array.from({ length: 30 }, () => "");
      cells[2] = l.staffNo;
      cells[4] = l.name;
      cells[17] = "2024-03-01";
      cells[19] = "1";
      cells[22] = "15000";
      cells[29] = l.lastDay ?? "";
      return cells.join(",");
    };
    const text = `Maxwell\r\n${header}\r\n${LEFT.map(line).join("\r\n")}`;
    const s = await importMaxwellContractsCsv([{ status: "left", text }], actorUserId, null, { contractStartMode: "first_unlocked" });
    expect(s.skippedLeftBeforeStart).toBe(2);
    expect(s.contractsCreated).toBe(1);
    const c = await prisma.guardLongtermContract.findFirstOrThrow({ where: { guard: { staffNoMw: "MG9403" } } });
    expect(c.effectiveTo?.toISOString().slice(0, 10)).toBe("2026-09-20");
    // 入職日晚過起始日嘅 note 唔寫「原入職日」
    expect(await prisma.guardLongtermContract.count({ where: { guard: { staffNoMw: { in: ["MG9401", "MG9402"] } } } })).toBe(0);
  });

  it("clipSegmentsFrom 純函數", () => {
    const segs = [
      { monthlySalary: 1, effectiveFrom: d("2024-01-01"), effectiveTo: d("2026-04-30") },
      { monthlySalary: 2, effectiveFrom: d("2026-05-01"), effectiveTo: null },
    ];
    expect(clipSegmentsFrom(segs, d("2026-09-01"))).toEqual([{ monthlySalary: 2, effectiveFrom: d("2026-09-01"), effectiveTo: null }]);
    expect(clipSegmentsFrom(segs, d("2024-01-01"))).toEqual(segs);
  });

  it("route：contract_start_mode 非法值 400；first_unlocked 200 並回 start_mode／salary_mismatch", async () => {
    const fx = await seedWp2Fixture();
    const cookie = await sessionCookieForUser(fx.userIds["老闆"]);
    const buf = await buildWorkbook([rows[0]]);
    const mk = (mode: string) => {
      const form = new FormData();
      form.set("file", new File([new Uint8Array(buf)], "m.xlsx"));
      form.set("contract_start_mode", mode);
      return new Request("http://x/api/longterm/contracts/import", { method: "POST", headers: { cookie }, body: form });
    };
    expect((await importContracts(mk("bogus"))).status).toBe(400);
    const res = await importContracts(mk("first_unlocked"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.summary.start_mode).toBe("first_unlocked");
    expect(body.summary).toHaveProperty("salary_mismatch");
    expect(body.summary).toHaveProperty("skipped_locked");
  });
});
