// P15：長工糧頁——「作廢本月計算」掣流程、平均工資批量導入面板。合成資料，afterAll 清走。
import { test, expect } from "@playwright/test";
import { loginAs } from "./helpers";
import { prisma } from "./db-helpers";

test.describe.configure({ mode: "serial" });

const DEC = new Date(Date.UTC(2026, 11, 1)); // 2026-12（未鎖，避開其他 spec 用嘅月份）
const RAND = Math.random().toString(36).slice(2, 8).toUpperCase();
let gid: string;
let gid2: string;
let runId: string;

test.beforeAll(async () => {
  const g = await prisma.guard.create({ data: { nameZh: `測試p15甲${RAND}`, nameEn: `P15 Test A ${RAND}`, staffNoMw: `MG97${RAND.slice(0, 3)}`, employmentType: "longterm_autopay", hireDate: new Date("2020-01-01"), createdBy: "test-e2e" } });
  gid = g.id;
  const g2 = await prisma.guard.create({ data: { nameZh: `測試p15乙${RAND}`, nameEn: `P15 Test B ${RAND}`, staffNoMw: `MG96${RAND.slice(0, 3)}`, employmentType: "longterm_autopay", hireDate: new Date("2020-01-01"), createdBy: "test-e2e" } });
  gid2 = g2.id;
  const run = await prisma.longtermPayrollRun.create({ data: { month: DEC, status: "computed", createdBy: "test-e2e", totalsJson: { guardCount: 1, grossTotal: 100, autopayTotal: 95, mpfEeTotal: 5, mpfErTotal: 5 } } });
  runId = run.id;
  await prisma.longtermPayrollLine.create({ data: { runId, guardId: gid, contractSnapshot: [], daysInMonth: 31, workDays: 26, netBasic: 100, gross: 100, autopay: 95, notesJson: [] } });
});

test.afterAll(async () => {
  await prisma.longtermPayrollRun.deleteMany({ where: { month: DEC } });
  await prisma.guardAvgWage.deleteMany({ where: { guardId: { in: [gid, gid2] } } });
  await prisma.guardLeaveBalanceHistory.deleteMany({ where: { guardId: { in: [gid, gid2] } } });
  await prisma.guardLongtermContract.deleteMany({ where: { guardId: { in: [gid, gid2] } } });
  await prisma.guard.deleteMany({ where: { id: { in: [gid, gid2] } } });
});

test("作廢本月計算：填原因 → 確認 → run 變 void、頁面重載", async ({ page }) => {
  await loginAs(page, "老闆");
  await page.goto("/reports/longterm-payroll");
  await page.locator('input[type="month"]').fill("2026-12");
  const sec = page.getByTestId("ltpay-void-section");
  await expect(sec).toBeVisible({ timeout: 15_000 });
  await sec.getByRole("button", { name: /作廢本月計算/ }).click();
  const confirm = sec.getByRole("button", { name: "確認作廢" });
  await expect(confirm).toBeDisabled(); // 冇原因唔可以確認
  await sec.getByPlaceholder("填原因先可以確認").fill("e2e 倒序重算");
  await confirm.click();
  await expect.poll(() => prisma.longtermPayrollRun.count({ where: { id: runId, status: "void" } }), { timeout: 15_000 }).toBe(1);
  await expect(page.getByTestId("ltpay-void-section")).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByText("已作廢 2026-12 長工糧計算")).toBeVisible();
});

test("平均工資批量導入：上載 CSV → 預覽（工號、唔顯示姓名）→ 確認寫入 → 重傳全部無變化", async ({ page }) => {
  await loginAs(page, "會計");
  await page.goto("/reports/longterm-payroll");
  await page.locator('input[type="month"]').fill("2026-12");
  await page.getByTestId("ltpay-tab-avg").click();
  const g = await prisma.guard.findUniqueOrThrow({ where: { id: gid } });
  const csv = `staff_no_mw,name_en,avg_daily_wage,note\n${g.staffNoMw},,612.5,e2e\n,P15 Test B ${RAND},700,\nMG9999ZZ,,500,\n`;
  await page.getByTestId("ltpay-avgbulk-file").setInputFiles({ name: "avg.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
  const prev = page.getByTestId("ltpay-avgbulk-preview");
  await expect(prev).toContainText("共 3 行，配到 2 行", { timeout: 15_000 });
  await expect(prev).toContainText("預計新增 2");
  await expect(prev).toContainText("MG9999ZZ");
  await expect(prev).not.toContainText("測試p15");
  await page.getByTestId("ltpay-avgbulk-confirm").click();
  await expect.poll(() => prisma.guardAvgWage.count({ where: { guardId: { in: [gid, gid2] }, month: DEC, source: { startsWith: "人手批量導入" } } }), { timeout: 15_000 }).toBe(2);
  await page.getByTestId("ltpay-avgbulk-file").setInputFiles({ name: "avg.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
  await expect(page.getByTestId("ltpay-avgbulk-preview")).toContainText("無變化 2", { timeout: 15_000 });
  await expect(page.getByTestId("ltpay-avgbulk-confirm")).toBeDisabled();
});
