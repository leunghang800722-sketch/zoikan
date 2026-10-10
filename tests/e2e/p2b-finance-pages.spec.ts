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

test("(a2) Opus 驗收 M1：雞頭A 更表索引冇「欠」字 pill（shortfall 結構性唔傳俾雞頭）", async ({ page }) => {
  await loginAs(page, "雞頭A");
  await page.goto("/roster");
  await page.locator('input[type="month"]').fill("2026-07");
  const rows = page.getByTestId("roster-overview-row");
  await expect(rows.first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/欠 \d+ 更/)).toHaveCount(0);
});

test("(a3) Opus 驗收 M3：老闆 2026-07 更表索引最多 8 項（預設 limit）", async ({ page }) => {
  await loginAs(page, "老闆");
  const res = await page.request.get("/api/roster/overview?month=2026-07");
  expect(res.ok()).toBe(true);
  const body = await res.json();
  expect(body.sites.length).toBeLessThanOrEqual(8);

  await page.goto("/roster");
  await page.locator('input[type="month"]').fill("2026-07");
  const rows = page.getByTestId("roster-overview-row");
  await expect(rows.first()).toBeVisible({ timeout: 20_000 });
  expect(await rows.count()).toBeLessThanOrEqual(8);
  await expect(page.getByText("全部盤用左邊選單開")).toBeVisible();
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

test("(b2) Opus 驗收 M4：本月應收表行數 < 記錄數（group 咗），foot 更數同 stat 卡一致", async ({ page }) => {
  await loginAs(page, "老闆");
  await page.goto("/my-receivable");
  await page.locator('input[type="month"]').fill("2026-07");
  await expect.poll(() => new URL(page.url()).searchParams.get("broker"), { timeout: 20_000 }).not.toBeNull();

  const broker = new URL(page.url()).searchParams.get("broker")!;
  const res = await page.request.get(`/api/reports/my-receivable?month=2026-07&broker=${broker}`);
  expect(res.ok()).toBe(true);
  const body = await res.json();
  expect(body.grouped_days.length).toBeLessThan(body.days.length);

  const rows = page.getByTestId("my-receivable-row");
  await expect(rows.first()).toBeVisible({ timeout: 20_000 });
  expect(await rows.count()).toBe(body.grouped_days.length);

  const footShiftsText = await page.locator("tfoot tr td").nth(1).innerText();
  expect(Number(footShiftsText.replace(/,/g, ""))).toBe(body.total_shifts);
  // stat 卡「本月更數」用返同一個數（P2BStatCard 大數）。
  await expect(page.getByText(String(body.total_shifts)).first()).toBeVisible();
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
  // P3-3.8：用 ?month= 直接開 7 月（月份選擇器讀網址），唔再 fill 之後賭資料載入先後（其他月有行但冇紅底時會 race）。
  // 月份選擇器 mount 先由網址還原月份，所以會先打一次預設月份、再打 2026-07——等 7 月嗰條 response 先斷言。
  const julyLoaded = page.waitForResponse((r) => r.url().includes("/api/reports/gross-margin") && r.url().includes("month=2026-07"));
  await page.goto("/reports/gross-margin?month=2026-07");
  await julyLoaded;
  await expect(page.locator('input[type="month"]')).toHaveValue("2026-07");

  await expect(page.getByText("全公司毛利率", { exact: true })).toBeVisible({ timeout: 20_000 });
  // 應修③（Opus 驗收）：stat label 改咗做「低於 N% 嘅盤」／「額外盤（未
  // 收入基準）」（README §12 字面），唔再係「低於門檻嘅盤」／「額外盤」。
  await expect(page.getByText(/^低於 \d+% 嘅盤$/)).toBeVisible();
  await expect(page.getByText("額外盤（未收入基準）", { exact: true })).toBeVisible();

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

test("(d2) Opus 驗收應修③：毛利即時表由低到高排（第一行毛利率 ≤ 第二行）", async ({ page }) => {
  await loginAs(page, "老闆");
  await page.goto("/reports/gross-margin");
  await page.locator('input[type="month"]').fill("2026-07");

  const rows = page.getByTestId("gross-margin-row");
  await expect(rows.first()).toBeVisible({ timeout: 20_000 });
  const count = await rows.count();
  expect(count).toBeGreaterThan(1);

  function parsePct(text: string): number | null {
    const t = text.trim();
    if (t === "—" || t === "") return null;
    return Number(t.replace("%", ""));
  }
  const firstPct = parsePct(await rows.nth(0).locator("td").nth(5).innerText());
  const secondPct = parsePct(await rows.nth(1).locator("td").nth(5).innerText());
  if (firstPct !== null && secondPct !== null) {
    expect(firstPct).toBeLessThanOrEqual(secondPct);
  } else {
    // null 排最尾——第一行係 null 就代表全部行都冇毛利率（極端情況），
    // 唔應該發生喺第一/二行都有資料嘅正常月份，呢度留返訊息方便debug。
    expect(firstPct === null && secondPct === null).toBe(true);
  }
});

test("(e) 月結工作台：2026-07 已有 month_closes 行——入頁自動 Generate，唔使自己撳掣，亦唔改任何鎖定狀態", async ({ page }) => {
  await loginAs(page, "老闆");
  await page.goto("/reports/monthly-close");
  await page.locator('input[type="month"]').fill("2026-07");

  await expect(page.getByRole("heading", { name: "月結總表" })).toBeVisible();
  await expect(page.getByRole("button", { name: /生成月結/ })).toBeVisible();
  await expect(page.getByTestId("report-tabs")).toBeVisible();
  await page.getByTestId("more-menu").click();
  await expect(page.locator('a:has-text("匯出 Excel")')).toBeVisible();
  await page.keyboard.press("Escape");
  // A1（Opus 整合驗收）：2026-07 已經有 month_closes 行（鎖定咗）——入頁
  // 應該自動行一次 Generate，直接見到規則卡／總表／狀態卡，唔使自己
  // 撳「Generate」（呢個 test 全程冇撳過任何掣，`generate()` 淨係 no-op
  // upsert，唔會觸發 lock/unlock）。
  await expect(page.getByTestId("recon-rules-title")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("heading", { name: "逐盤月結" })).toBeVisible();
  await expect(page.getByText("2026-07 狀態")).toBeVisible();
  await expect(page.getByText("已鎖定", { exact: true })).toBeVisible();

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({ path: `${SCREENSHOT_DIR}/13-monthly-close-1440.png`, fullPage: true });
});

test("(e2) Opus 整合驗收 A1：冇 month_closes 行嘅月份——空狀態＋「Generate」掣，唔自動建行", async ({ page }) => {
  await loginAs(page, "老闆");
  await page.goto("/reports/monthly-close");
  await page.locator('input[type="month"]').fill("2026-12");

  await expect(page.getByText("2026-12 未有月結記錄")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("button", { name: "Generate", exact: true })).toBeVisible();

  const res = await page.request.get("/api/month-closes?month=2026-12");
  expect(res.ok()).toBe(true);
  const body = await res.json();
  expect(body.rows.length).toBe(0);
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
