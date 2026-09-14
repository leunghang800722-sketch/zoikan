// P2-B：財務報表＋更表索引＋本月應收 重新實作版面——Playwright e2e。
// 用現有 2026-07 seed 真數據（見 tests/e2e/db-helpers.ts），唔寫死真名，
// 用 DB 查出嚟嘅代號／id 比對（PDPO）。
//
// 覆蓋（P2-版面重設計計劃.md P2-B 驗收要求）：
//  - 更表索引「最近開過」有項目＋撳去更表；
//  - 老闆 ?broker= 預覽本月應收有 3 stat；
//  - 毛利即時表 3 stat＋紅底行；
//  - 月結工作台 2026-07 頁面結構（唔撳 Generate，唔留低任何鎖定狀態改動）；
//  - 糧明細 foot；
//  - 手機 375 零橫向捲。
//
// 截圖（1440／375）存喺 scratchpad/p2b（唔入 git）。
import { test, expect } from "@playwright/test";
import { loginAs } from "./helpers";

const SCREENSHOT_DIR = "/private/tmp/claude-501/-Users-macbookpro-zoi-kan/41316f0d-3a34-4ae3-a8de-d2fb6db0b018/scratchpad/p2b";

test.describe.configure({ mode: "serial" });

test("(a) 更表索引：「最近開過」有項目，撳一項去更表", async ({ page }) => {
  await loginAs(page, "老闆");
  await page.goto("/roster");
  await page.locator('input[type="month"]').fill("2026-07");

  const rows = page.getByTestId("roster-overview-row");
  await expect(rows.first()).toBeVisible({ timeout: 20_000 });
  expect(await rows.count()).toBeGreaterThan(0);

  const firstHref = await rows.first().getAttribute("href");
  expect(firstHref).toMatch(/^\/roster\/[^/]+\/2026-07$/);

  await rows.first().click();
  await page.waitForURL(/\/roster\/[^/]+\/2026-07$/, { timeout: 15_000 });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/roster");
  await page.locator('input[type="month"]').fill("2026-07");
  await expect(page.getByTestId("roster-overview-row").first()).toBeVisible({ timeout: 20_000 });
  await page.screenshot({ path: `${SCREENSHOT_DIR}/03-roster-index-1440.png`, fullPage: true });
});

test("(b) 老闆帶 ?broker= 預覽本月應收：見到 3 張 stat 卡＋提示橫幅", async ({ page }) => {
  await loginAs(page, "老闆");
  await page.goto("/my-receivable");
  await page.locator('input[type="month"]').fill("2026-07");

  // 未帶 ?broker= 入嚟嘅老闆——client 自己揀第一個雞頭並寫入 URL（見
  // MyReceivableClient.tsx），等落面斷言唔使自己查 DB 攞代號。
  await expect.poll(() => new URL(page.url()).searchParams.get("broker"), { timeout: 20_000 }).not.toBeNull();

  await expect(page.getByText(/呢頁淨係俾雞頭角色用/)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("本月更數", { exact: true })).toBeVisible();
  await expect(page.getByText("合計（出街價）", { exact: true })).toBeVisible();
  await expect(page.getByText("待審批", { exact: true })).toBeVisible();
  await expect(page.getByTestId("my-receivable-broker-select")).toBeVisible();

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({ path: `${SCREENSHOT_DIR}/11-my-receivable-1440.png`, fullPage: true });
});

test("(c) 雞頭A：本月應收冇預覽橫幅，直接見自己（呢頁本身行為冇改）", async ({ page }) => {
  await loginAs(page, "雞頭A");
  await page.goto("/my-receivable");
  await page.locator('input[type="month"]').fill("2026-07");
  await expect(page.getByText(/呢頁淨係俾雞頭角色用/)).toHaveCount(0);
  await expect(page.getByText("本月更數", { exact: true })).toBeVisible({ timeout: 20_000 });
});

test("(d) 毛利即時表：3 張 stat 卡＋至少一行紅底（低於門檻）", async ({ page }) => {
  await loginAs(page, "老闆");
  await page.goto("/reports/gross-margin");
  await page.locator('input[type="month"]').fill("2026-07");

  await expect(page.getByText("全公司毛利率", { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("低於門檻嘅盤", { exact: true })).toBeVisible();
  await expect(page.getByText("額外盤", { exact: true })).toBeVisible();

  const rows = page.getByTestId("gross-margin-row");
  await expect(rows.first()).toBeVisible({ timeout: 20_000 });
  const hasRedRow = await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll('[data-testid="gross-margin-row"]'));
    return els.some((el) => getComputedStyle(el).backgroundColor === "rgb(254, 242, 242)");
  });
  expect(hasRedRow).toBe(true);

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({ path: `${SCREENSHOT_DIR}/12-gross-margin-1440.png`, fullPage: true });
});

test("(e) 月結工作台：2026-07 頁面結構（唔撳 Generate，唔改任何鎖定狀態）", async ({ page }) => {
  await loginAs(page, "老闆");
  await page.goto("/reports/monthly-close");
  await page.locator('input[type="month"]').fill("2026-07");

  await expect(page.getByRole("heading", { name: "月結工作台" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Generate/ })).toBeVisible();
  await expect(page.locator('a:has-text("匯出 Excel")')).toBeVisible();
  // 未撳 Generate 之前應該淨係見到提示文字，冇任何 lock/unlock 動作發生。
  await expect(page.getByText("撳「重新 Generate」開始。")).toBeVisible();

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({ path: `${SCREENSHOT_DIR}/13-monthly-close-1440.png`, fullPage: true });
});

test("(f) 糧明細：foot 合計可見", async ({ page }) => {
  await loginAs(page, "老闆");
  await page.goto("/reports/payroll");
  await page.locator('input[type="month"]').fill("2026-07");

  await expect(page.getByText("Total")).toBeVisible({ timeout: 20_000 });
  const footRow = page.locator("tfoot tr");
  await expect(footRow).toBeVisible();

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({ path: `${SCREENSHOT_DIR}/14-payroll-1440.png`, fullPage: true });
});

test("(g) 手機 375：五個 P2-B 頁面零橫向捲，附截圖", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await loginAs(page, "老闆");

  const pages: Array<{ path: string; shot: string }> = [
    { path: "/roster", shot: "03-roster-index-375.png" },
    { path: "/reports/gross-margin", shot: "12-gross-margin-375.png" },
    { path: "/reports/monthly-close", shot: "13-monthly-close-375.png" },
    { path: "/reports/payroll", shot: "14-payroll-375.png" },
  ];

  for (const p of pages) {
    await page.goto(p.path);
    const monthInput = page.locator('input[type="month"]');
    if (await monthInput.count()) await monthInput.first().fill("2026-07");
    await page.waitForTimeout(800); // 等 fetch 完成先量度闊度
    const noOverflow = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
    expect(noOverflow, `${p.path} 手機 375 唔應該有橫向捲`).toBe(true);
    await page.screenshot({ path: `${SCREENSHOT_DIR}/${p.shot}`, fullPage: true });
  }

  // 本月應收——雞頭A 身份量度（避免老闆預覽狀態下 broker select 影響闊度）。
  await loginAs(page, "雞頭A");
  await page.goto("/my-receivable");
  await page.locator('input[type="month"]').fill("2026-07");
  await page.waitForTimeout(800);
  const noOverflowReceivable = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  expect(noOverflowReceivable, "/my-receivable 手機 375 唔應該有橫向捲").toBe(true);
  await page.screenshot({ path: `${SCREENSHOT_DIR}/11-my-receivable-375.png`, fullPage: true });
});
