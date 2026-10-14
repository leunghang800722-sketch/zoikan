// P18.2：長工糧「出勤修正」面板 e2e（合成保安員，afterAll 清走）。
// ① 同日多來源衝突：採用代號 NL → batch 寫人手紀錄 → 重算後返工日 10→9、NPL 日數 0→1。
// ② 全部更歸雞頭嘅長工：重算後返工日 0 → 歸公司兵 → 重算後 0→8。
import { test, expect } from "@playwright/test";
import { loginAs } from "./helpers";
import { prisma } from "./db-helpers";

test.describe.configure({ mode: "serial" });

const AUG = new Date(Date.UTC(2026, 7, 1));
const RAND = Math.random().toString(36).slice(2, 8);
const NAME_A = `測試修正甲-${RAND}`;
const NAME_B = `測試修正乙-${RAND}`;
let siteId: string;
let stN: string;
let stD: string;
let guardA: string;
let guardB: string;
let extBrokerId: string;

const d = (day: number) => new Date(Date.UTC(2026, 7, day));

test.beforeAll(async () => {
  const b07 = await prisma.broker.findFirstOrThrow({ where: { kind: "internal_longterm", status: "active" } });
  extBrokerId = (await prisma.broker.create({ data: { code: `TE-${RAND}`, name: `測試雞頭-${RAND}`, kind: "external", settlementType: "cash", createdBy: "test-e2e" } })).id;
  const site = await prisma.site.create({ data: { canonicalName: `測試修正盤-e2e-${RAND}`, clientName: "測試客戶-e2e", billingModel: "per_shift", createdBy: "test-e2e" } });
  siteId = site.id;
  stN = (await prisma.shiftType.create({ data: { siteId, code: "N", label: "測試夜更", hours: 12, createdBy: "test-e2e" } })).id;
  stD = (await prisma.shiftType.create({ data: { siteId, code: "D", label: "測試日更", hours: 12, createdBy: "test-e2e" } })).id;
  for (const [name, id] of [[NAME_A, "A"], [NAME_B, "B"]] as const) {
    const g = await prisma.guard.create({ data: { nameZh: name, employmentType: "longterm_autopay", hireDate: new Date("2020-01-01"), createdBy: "test-e2e" } });
    await prisma.guardLongtermContract.create({ data: { guardId: g.id, monthlySalary: 15000, effectiveFrom: new Date("2020-01-01"), effectiveTo: null, annualLeaveDays: 7, source: "manual", createdBy: "test-e2e" } });
    if (id === "A") guardA = g.id;
    else guardB = g.id;
  }
  for (let day = 1; day <= 10; day++) {
    await prisma.shiftRecord.create({ data: { workDate: d(day), siteId, shiftTypeId: stN, guardId: guardA, settlementBrokerId: b07.id, operationalBrokerId: b07.id, recordType: "shift", source: "roster_upload", createdBy: "test-e2e" } });
  }
  await prisma.shiftRecord.create({ data: { workDate: d(4), siteId, shiftTypeId: stD, guardId: guardA, settlementBrokerId: b07.id, operationalBrokerId: b07.id, recordType: "leave", leaveCode: "NL", source: "master_roster", createdBy: "test-e2e" } });
  for (let day = 1; day <= 8; day++) {
    await prisma.shiftRecord.create({ data: { workDate: d(day), siteId, shiftTypeId: stN, guardId: guardB, settlementBrokerId: extBrokerId, operationalBrokerId: extBrokerId, recordType: "shift", source: "roster_upload", createdBy: "test-e2e" } });
  }
});

test.afterAll(async () => {
  const ids = [guardA, guardB];
  await prisma.longtermPayrollLine.deleteMany({ where: { guardId: { in: ids } } });
  await prisma.longtermPayrollRun.deleteMany({ where: { month: AUG } });
  await prisma.guardLeaveBalance.deleteMany({ where: { guardId: { in: ids } } });
  await prisma.guardLongtermContract.deleteMany({ where: { guardId: { in: ids } } });
  await prisma.shiftRecord.deleteMany({ where: { guardId: { in: ids } } });
  await prisma.guard.deleteMany({ where: { id: { in: ids } } });
  await prisma.shiftType.deleteMany({ where: { siteId } });
  await prisma.site.deleteMany({ where: { id: siteId } });
  await prisma.broker.deleteMany({ where: { id: extBrokerId } });
});

test("老闆：出勤修正面板——採用代號 NL → 重算後返工日／NPL 日數變；歸公司兵 → 返工日 0→8", async ({ page }) => {
  await loginAs(page, "老闆");
  await page.goto("/reports/longterm-payroll");
  await page.locator('input[type="month"]').fill("2026-08");
  await page.getByRole("button", { name: "重算本月" }).click();
  await expect(page.getByText("重算完成")).toBeVisible({ timeout: 20_000 });
  const rowA = page.locator("tbody tr", { hasText: NAME_A }).first();
  const rowB = page.locator("tbody tr", { hasText: NAME_B }).first();
  await expect(rowA).toContainText("10／31", { timeout: 10_000 });
  await expect(rowB).toContainText("0／31");

  await page.getByTestId("ltpay-tab-attfix").click();
  const conflict = page.locator('[data-testid="attfix-conflict-row"]', { hasText: NAME_A });
  await expect(conflict).toHaveCount(1, { timeout: 10_000 });
  await expect(conflict).toContainText("roster_upload：班");
  await expect(conflict).toContainText("master_roster：NL");
  await expect(conflict).toContainText("來源 roster_upload：班");
  await expect(conflict).toContainText("返工");
  await conflict.getByTestId("attfix-adopt-NL").click();
  await expect(page.getByTestId("attfix-recompute-hint")).toBeVisible({ timeout: 10_000 });
  // 人手紀錄已寫入（原有紀錄冇作廢）
  const manual = await prisma.shiftRecord.findFirstOrThrow({ where: { guardId: guardA, workDate: d(4), source: "manual" } });
  expect(manual.leaveCode).toBe("NL");
  expect(await prisma.shiftRecord.count({ where: { guardId: guardA, workDate: d(4), status: { not: "cancelled" } } })).toBe(2);
  expect(await prisma.auditLog.count({ where: { tableName: "shift_records", rowId: manual.id } })).toBeGreaterThan(0);
  await expect(page.locator('[data-testid="attfix-conflict-row"]', { hasText: NAME_A })).toHaveCount(0); // 衝突已解決

  // 歸公司兵
  const mis = page.locator('[data-testid="attfix-mis-row"]', { hasText: NAME_B });
  await expect(mis).toHaveCount(1);
  await mis.getByTestId("attfix-to-company").click();
  await expect(mis).toHaveCount(0, { timeout: 10_000 });

  await page.getByTestId("attfix-recompute").click();
  await page.getByTestId("ltpay-tab-pay").click();
  await expect(page.locator("tbody tr", { hasText: NAME_A }).first()).toContainText("9／31", { timeout: 20_000 });
  await expect(page.locator("tbody tr", { hasText: NAME_B }).first()).toContainText("8／31", { timeout: 20_000 });
  const line = await prisma.longtermPayrollLine.findFirstOrThrow({ where: { guardId: guardA }, orderBy: { createdAt: "desc" } });
  expect(Number(line.nplDays ?? 0)).toBe(1);
});
