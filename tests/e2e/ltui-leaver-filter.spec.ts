// 長工糧頁逐人結算篩選 chips：全部／離職者／零返工日／有警告；離職 badge、0 日 badge、表頭人數跟篩選。
// 自己起合成長工（用 test-e2e-ltui 前綴，afterAll 清走），用 2026-08（未鎖）。
import { test, expect } from "@playwright/test";
import { loginAs } from "./helpers";
import { prisma } from "./db-helpers";

test.describe.configure({ mode: "serial" });

const AUG = new Date(Date.UTC(2026, 7, 1));
const RAND = Math.random().toString(36).slice(2, 8);
const ids: { guards: string[]; site?: string; st?: string } = { guards: [] };

test.beforeAll(async () => {
  const b07 = await prisma.broker.findFirstOrThrow({ where: { kind: "internal_longterm", status: "active" } });
  const site = await prisma.site.create({ data: { canonicalName: `測試長工盤-ltui-${RAND}`, clientName: "測試客戶-e2e", billingModel: "per_shift", createdBy: "test-e2e" } });
  const st = await prisma.shiftType.create({ data: { siteId: site.id, code: "N", label: "測試夜更", hours: 12, createdBy: "test-e2e" } });
  ids.site = site.id;
  ids.st = st.id;
  const mk = async (name: string, over: { leaveDate?: Date; days: number }) => {
    const g = await prisma.guard.create({ data: { nameZh: name, employmentType: "longterm_autopay", hireDate: new Date("2020-01-01"), leaveDate: over.leaveDate ?? null, createdBy: "test-e2e" } });
    ids.guards.push(g.id);
    await prisma.guardLongtermContract.create({ data: { guardId: g.id, monthlySalary: 15000, effectiveFrom: new Date("2020-01-01"), effectiveTo: over.leaveDate ?? null, annualLeaveDays: 7, source: "manual", createdBy: "test-e2e" } });
    for (let d = 1; d <= over.days; d++) {
      await prisma.shiftRecord.create({ data: { workDate: new Date(Date.UTC(2026, 7, d)), siteId: site.id, shiftTypeId: st.id, guardId: g.id, settlementBrokerId: b07.id, operationalBrokerId: b07.id, recordType: "shift", createdBy: "test-e2e" } });
    }
  };
  await mk(`測試在職-ltui-${RAND}`, { days: 20 });
  await mk(`測試離職-ltui-${RAND}`, { days: 10, leaveDate: new Date(Date.UTC(2026, 7, 10)) });
  await mk(`測試零日-ltui-${RAND}`, { days: 0 });
});

test.afterAll(async () => {
  await prisma.longtermPayrollLine.deleteMany({ where: { guardId: { in: ids.guards } } });
  await prisma.longtermPayrollRun.deleteMany({ where: { month: AUG } });
  await prisma.guardLeaveBalance.deleteMany({ where: { guardId: { in: ids.guards } } });
  await prisma.guardLongtermContract.deleteMany({ where: { guardId: { in: ids.guards } } });
  await prisma.shiftRecord.deleteMany({ where: { guardId: { in: ids.guards } } });
  await prisma.guard.deleteMany({ where: { id: { in: ids.guards } } });
  if (ids.st) await prisma.shiftType.deleteMany({ where: { id: ids.st } });
  if (ids.site) await prisma.site.deleteMany({ where: { id: ids.site } });
});

test("老闆：逐人結算篩選 chips 顯示人數、表頭跟篩選、離職／0 日 badge", async ({ page }) => {
  await loginAs(page, "老闆");
  await page.goto("/reports/longterm-payroll");
  await page.locator('input[type="month"]').fill("2026-08");
  await page.getByRole("button", { name: "重算本月" }).click();
  await expect(page.getByTestId("ltpay-line-filter")).toBeVisible({ timeout: 20_000 });

  await expect(page.getByTestId("ltpay-filter-leaver")).toContainText("離職者 1");
  await expect(page.getByTestId("ltpay-filter-zero")).toContainText("零返工日 1");
  const allText = await page.getByTestId("ltpay-filter-all").innerText();
  const total = Number(allText.replace(/\D/g, ""));
  expect(total).toBeGreaterThanOrEqual(3);
  await expect(page.getByTestId("ltpay-lines-title")).toContainText(`逐人結算（${total} 人）`);

  await page.getByTestId("ltpay-filter-leaver").click();
  await expect(page.getByTestId("ltpay-lines-title")).toContainText("逐人結算（1 人）");
  await expect(page.locator("tr", { has: page.getByTestId("badge-leaver") })).toContainText(`測試離職-ltui-${RAND}`);
  await expect(page.getByTestId("badge-leaver")).toHaveCount(1);

  await page.getByTestId("ltpay-filter-zero").click();
  await expect(page.getByTestId("ltpay-lines-title")).toContainText("逐人結算（1 人）");
  await expect(page.locator("tr", { has: page.getByTestId("badge-zero") })).toContainText(`測試零日-ltui-${RAND}`);

  await page.getByTestId("ltpay-filter-all").click();
  await expect(page.getByTestId("ltpay-lines-title")).toContainText(`逐人結算（${total} 人）`);
});
