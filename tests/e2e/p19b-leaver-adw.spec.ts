// P19b：長工糧頁「離職者平均工資待確認」導航卡——出現、輸入平均日薪、儲存後轉「已輸入待重算」、手機 375px 唔橫向捲動。合成資料（假名「測試」、假月薪），afterAll 清走。
import { test, expect } from "@playwright/test";
import { loginAs } from "./helpers";
import { prisma } from "./db-helpers";

test.describe.configure({ mode: "serial" });

const MONTH = new Date(Date.UTC(2027, 2, 1)); // 2027-03（未鎖，避開其他 spec）
const RAND = Math.random().toString(36).slice(2, 8).toUpperCase();
let gid: string;
let runId: string;

test.beforeAll(async () => {
  const g = await prisma.guard.create({ data: { nameZh: `測試p19b甲${RAND}`, nameEn: `P19b Test A ${RAND}`, staffNoMw: `MG95${RAND.slice(0, 3)}`, employmentType: "longterm_autopay", hireDate: new Date("2026-05-01"), leaveDate: new Date("2027-03-31"), createdBy: "test-e2e" } });
  gid = g.id;
  const run = await prisma.longtermPayrollRun.create({ data: { month: MONTH, status: "computed", createdBy: "test-e2e", totalsJson: { guardCount: 1, grossTotal: 100, autopayTotal: 95, mpfEeTotal: 5, mpfErTotal: 5 } } });
  runId = run.id;
  const line = await prisma.longtermPayrollLine.create({ data: { runId, guardId: gid, contractSnapshot: [], daysInMonth: 31, workDays: 26, netBasic: 20000, gross: 20000, autopay: 19000, notesJson: [] } });
  const info = JSON.stringify({ basis: "fallback_monthly", rateUsed: 645.16, monthlyFallback: 645.16, eo: { adw: 650.1, basis: "fallback_monthly", periodFrom: "2026-05-01", periodTo: "2027-03-31", daysCounted: 335, disregardedDays: 0, wages: 217783.5, historyIncomplete: true, monthsMissing: ["2026-06"] }, needsConfirm: true, leaveDate: "2027-03-31", balanceDays: 2.5 });
  await prisma.$executeRaw`UPDATE longterm_payroll_lines SET al_daily_rate_basis = 'fallback_monthly', al_adw_json = ${info}::jsonb WHERE id = ${line.id}`;
});

test.afterAll(async () => {
  await prisma.longtermPayrollRun.deleteMany({ where: { month: MONTH } });
  await prisma.guardAvgWage.deleteMany({ where: { guardId: gid } });
  await prisma.guard.deleteMany({ where: { id: gid } });
});

test("導航卡出現 → 輸入平均日薪 → 儲存（source 預填）→ 轉已輸入待重算", async ({ page }) => {
  await loginAs(page, "會計");
  await page.goto("/reports/longterm-payroll");
  await page.locator('input[type="month"]').fill("2027-03");
  const card = page.getByTestId("leaver-adw-card");
  await expect(card).toBeVisible({ timeout: 15_000 });
  await expect(card).toContainText("離職者平均工資待確認");
  await expect(card).toContainText("終止僱傭合約薪酬計算表");
  await expect(card).toContainText("645.16");
  await expect(card).toContainText("2026-06");
  const item = card.locator('[data-testid^="leaver-adw-item-"]').first();
  await item.getByTestId("leaver-adw-input").fill("655.5");
  await item.getByTestId("leaver-adw-save").click();
  await expect(item.getByTestId("leaver-adw-saved")).toContainText("已儲存平均日薪", { timeout: 15_000 });
  const rec = await prisma.guardAvgWage.findFirstOrThrow({ where: { guardId: gid, month: MONTH } });
  expect(Number(rec.avgDailyWage)).toBe(655.5);
  expect(rec.source).toBe("終止僱傭合約薪酬計算表");
});

test("手機 375px：卡喺視窗內、冇橫向捲動", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await loginAs(page, "會計");
  await page.goto("/reports/longterm-payroll");
  await page.locator('input[type="month"]').fill("2027-03");
  const card = page.getByTestId("leaver-adw-card");
  await expect(card).toBeVisible({ timeout: 15_000 });
  const box = await card.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(375);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  expect(overflow).toBe(false);
});

test("已有 avg wage 記錄＋重算套用後（basis=imported）卡消失", async ({ page }) => {
  await prisma.$executeRaw`UPDATE longterm_payroll_lines SET al_daily_rate_basis = 'imported', al_adw_json = jsonb_set(al_adw_json, '{needsConfirm}', 'false') WHERE run_id = ${runId}`;
  await loginAs(page, "會計");
  await page.goto("/reports/longterm-payroll");
  await page.locator('input[type="month"]').fill("2027-03");
  await expect(page.getByText("逐人結算")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("leaver-adw-card")).toHaveCount(0);
});
