// P17.4：合約 tab 編輯——清空結束日真係存 null；重疊 409 錯誤喺表單位置顯示、表單唔關。
import { test, expect } from "@playwright/test";
import { loginAs } from "./helpers";
import { prisma } from "./db-helpers";

test.describe.configure({ mode: "serial" });

const RAND = Math.random().toString(36).slice(2, 8);
const NAME_X = `測試長工-c174x-${RAND}`;
const NAME_Y = `測試長工-c174y-${RAND}`;
const ids: string[] = [];
let contractX: string;
let contractYa: string;

async function mkGuard(name: string) {
  const g = await prisma.guard.create({ data: { nameZh: name, employmentType: "longterm_autopay", hireDate: new Date("2020-01-01"), createdBy: "test-e2e" } });
  ids.push(g.id);
  return g.id;
}

test.beforeAll(async () => {
  const x = await mkGuard(NAME_X);
  contractX = (await prisma.guardLongtermContract.create({ data: { guardId: x, monthlySalary: 15000, effectiveFrom: new Date("2027-01-01"), effectiveTo: new Date("2027-12-31"), source: "manual", createdBy: "test-e2e" } })).id;
  const y = await mkGuard(NAME_Y);
  contractYa = (await prisma.guardLongtermContract.create({ data: { guardId: y, monthlySalary: 15000, effectiveFrom: new Date("2027-01-01"), effectiveTo: new Date("2027-06-30"), source: "manual", createdBy: "test-e2e" } })).id;
  await prisma.guardLongtermContract.create({ data: { guardId: y, monthlySalary: 16000, effectiveFrom: new Date("2027-07-01"), effectiveTo: null, source: "manual", createdBy: "test-e2e" } });
});

test.afterAll(async () => {
  for (const g of ids) {
    await prisma.guardLongtermContract.deleteMany({ where: { guardId: g } });
    await prisma.guard.deleteMany({ where: { id: g } });
  }
});

test("清空結束日 → API 真係存 null（編輯表單顯示原有日期，清空後儲存）", async ({ page }) => {
  await loginAs(page, "會計");
  await page.goto("/reports/longterm-payroll");
  await page.getByTestId("ltpay-tab-contracts").click();
  const row = page.locator("tr", { hasText: NAME_X });
  await row.getByRole("button", { name: "編輯" }).click();
  const to = page.getByTestId("ltpay-contract-edit-to");
  await expect(to).toHaveValue("2027-12-31");
  await to.fill("");
  const reqPromise = page.waitForRequest((r) => r.method() === "PATCH" && r.url().includes(`/api/longterm/contracts/${contractX}`));
  await page.getByTestId("ltpay-contract-edit-save").click();
  const body = (await reqPromise).postDataJSON();
  expect(body).toHaveProperty("effective_to", null);
  await expect(page.getByTestId("ltpay-contract-edit")).toHaveCount(0, { timeout: 10_000 });
  expect((await prisma.guardLongtermContract.findUniqueOrThrow({ where: { id: contractX } })).effectiveTo).toBeNull();
});

test("製造重疊 → 見到 409 錯誤（含重疊日期）、表單唔關、DB 不變", async ({ page }) => {
  await loginAs(page, "會計");
  await page.goto("/reports/longterm-payroll");
  await page.getByTestId("ltpay-tab-contracts").click();
  const row = page.locator("tr", { hasText: NAME_Y }).filter({ hasText: "2027-01-01" });
  await row.getByRole("button", { name: "編輯" }).click();
  await page.getByTestId("ltpay-contract-edit-to").fill("");
  await page.getByTestId("ltpay-contract-edit-save").click();
  const err = page.getByTestId("ltpay-contract-error");
  await expect(err).toBeVisible({ timeout: 10_000 });
  await expect(err).toContainText("2027-07-01");
  await expect(err).toContainText("先結束或作廢另一段");
  await expect(page.getByTestId("ltpay-contract-edit")).toBeVisible();
  expect((await prisma.guardLongtermContract.findUniqueOrThrow({ where: { id: contractYa } })).effectiveTo).not.toBeNull();
});
