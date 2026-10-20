// 長工糧逐人結算篩選 chips：全部／離職者／零返工日／有警告（含 run 層警告）；離職 badge、0 日 badge、表頭人數跟篩選。
// 用遠期月份 2027-03（未鎖，唔會撞 8 月已鎖 409），自己起 4 個合成長工；斷言只針對自己建嘅人（名稱 filter），唔寫死總人數，afterAll 清走（含假期結餘，免影響其他 spec 嘅重算保護）。
import { test, expect } from "@playwright/test";
import { loginAs } from "./helpers";
import { prisma } from "./db-helpers";

test.describe.configure({ mode: "serial" });

const MONTH = new Date(Date.UTC(2027, 2, 1));
const RAND = Math.random().toString(36).slice(2, 8);
const ids: { guards: string[]; site?: string; st?: string } = { guards: [] };
const N = (k: string) => `測試${k}-ltui-${RAND}`;

test.beforeAll(async () => {
  const b07 = await prisma.broker.findFirstOrThrow({ where: { kind: "internal_longterm", status: "active" } });
  const site = await prisma.site.create({ data: { canonicalName: `測試長工盤-ltui-${RAND}`, clientName: "測試客戶-e2e", billingModel: "per_shift", createdBy: "test-e2e" } });
  const st = await prisma.shiftType.create({ data: { siteId: site.id, code: "N", label: "測試夜更", hours: 12, createdBy: "test-e2e" } });
  ids.site = site.id;
  ids.st = st.id;
  const mk = async (name: string, o: { days: number; leave?: Date; contractFrom?: Date; cardNo?: string }) => {
    const from = o.contractFrom ?? new Date("2020-01-01");
    const g = await prisma.guard.create({ data: { nameZh: name, employmentType: "longterm_autopay", hireDate: new Date("2020-01-01"), leaveDate: o.leave ?? null, createdBy: "test-e2e" } });
    ids.guards.push(g.id);
    await prisma.guardLongtermContract.create({ data: { guardId: g.id, monthlySalary: 15000, effectiveFrom: from, effectiveTo: o.leave && !o.contractFrom ? o.leave : null, annualLeaveDays: 7, source: "manual", createdBy: "test-e2e" } });
    if (o.cardNo) await prisma.guardStaffNumber.create({ data: { guardId: g.id, scheme: "MG", number: o.cardNo, status: "current", validFrom: from } });
    for (let d = 1; d <= o.days; d++) {
      await prisma.shiftRecord.create({ data: { workDate: new Date(Date.UTC(2027, 2, d)), siteId: site.id, shiftTypeId: st.id, guardId: g.id, settlementBrokerId: b07.id, operationalBrokerId: b07.id, recordType: "shift", createdBy: "test-e2e" } });
    }
  };
  await mk(N("在職"), { days: 20 });
  await mk(N("離職"), { days: 10, leave: new Date(Date.UTC(2027, 2, 10)) });
  await mk(N("零日"), { days: 0 });
  // 疑似再入職：MG 卡鏈起點 2027-02-01，人卡舊離職日 2027-01-15 早過起點 → run 層警告（rehire_detected／card_guard_date_mismatch），行仍然出糧
  await mk(N("警告"), { days: 5, leave: new Date(Date.UTC(2027, 0, 15)), contractFrom: new Date(Date.UTC(2027, 1, 1)), cardNo: `MG98${RAND.slice(0, 3).replace(/[^0-9]/g, "7")}77` });
});

test.afterAll(async () => {
  await prisma.longtermPayrollLine.deleteMany({ where: { guardId: { in: ids.guards } } });
  await prisma.longtermPayrollRun.deleteMany({ where: { month: MONTH } });
  await prisma.guardLeaveBalance.deleteMany({ where: { guardId: { in: ids.guards } } });
  await prisma.guardStaffNumber.deleteMany({ where: { guardId: { in: ids.guards } } });
  await prisma.guardLongtermContract.deleteMany({ where: { guardId: { in: ids.guards } } });
  await prisma.shiftRecord.deleteMany({ where: { guardId: { in: ids.guards } } });
  await prisma.guard.deleteMany({ where: { id: { in: ids.guards } } });
  if (ids.st) await prisma.shiftType.deleteMany({ where: { id: ids.st } });
  if (ids.site) await prisma.site.deleteMany({ where: { id: ids.site } });
});

test("老闆：逐人結算篩選 chips（離職／零日／run 層警告）、表頭人數跟篩選、badge", async ({ page }) => {
  await loginAs(page, "老闆");
  await page.goto("/reports/longterm-payroll");
  await page.locator('input[type="month"]').fill("2027-03");
  await page.getByRole("button", { name: "重算本月" }).click();
  await expect(page.getByTestId("ltpay-line-filter")).toBeVisible({ timeout: 20_000 });
  const rows = page.locator('[data-testid="ltpay-lines-title"]').locator("xpath=ancestor::section[1]").locator("tbody tr");

  // 只針對自己建嘅 4 人斷言（DB 內可能仲有其他長工，唔斷言「全部 N」／總人數）
  for (const k of ["在職", "離職", "零日", "警告"]) await expect(rows.filter({ hasText: N(k) })).toHaveCount(1);
  await expect(page.getByTestId("ltpay-lines-title")).toContainText(/逐人結算（\d+ 人）/);

  await page.getByTestId("ltpay-filter-leaver").click();
  await expect(page.getByTestId("ltpay-lines-title")).toContainText(/逐人結算（\d+ 人）/);
  await expect(rows.filter({ hasText: N("離職") })).toHaveCount(1);
  await expect(rows.filter({ hasText: N("在職") })).toHaveCount(0);
  await expect(rows.filter({ hasText: N("離職") }).getByTestId("badge-leaver")).toBeVisible();

  await page.getByTestId("ltpay-filter-zero").click();
  await expect(rows.filter({ hasText: N("零日") })).toHaveCount(1);
  await expect(rows.filter({ hasText: N("零日") }).getByTestId("badge-zero")).toBeVisible();
  await expect(rows.filter({ hasText: N("在職") })).toHaveCount(0);

  await page.getByTestId("ltpay-filter-warn").click();
  await expect(rows.filter({ hasText: N("警告") })).toHaveCount(1); // 靠 run 層 warnings_by_guard
  await expect(rows.filter({ hasText: N("在職") })).toHaveCount(0);
  await expect(page.getByTestId("ltpay-filter-warn")).toContainText(/有警告 [1-9]/);

  await page.getByTestId("ltpay-filter-all").click();
  for (const k of ["在職", "離職", "零日", "警告"]) await expect(rows.filter({ hasText: N(k) })).toHaveCount(1);
});
