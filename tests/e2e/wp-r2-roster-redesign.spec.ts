// WP-R2 更表編輯器重新設計（Claude Design 1a「帳冊」，README §04/§23）
// Playwright e2e——覆蓋 R1/R2 之前冇測試過嘅新視覺互動：桌面雞頭統計卡
// 撳＝篩選、手機撳格彈底部更別鍵盤、今日／週末日期欄樣式。
//
// 舊有行為（打字／拖選／複製上月／儲存／匯出／鎖定只讀／雞頭篩選 URL）
// 已經喺 wp3.spec.ts／mobile.spec.ts 覆蓋，呢度唔重複斷言。PDPO：唔寫死
// 真名，用 DB 查出嚟嘅 id／代號比對。
import { test, expect, type Page } from "@playwright/test";
import { loginAs } from "./helpers";
import { prisma, findSiteIdByName } from "./db-helpers";

const SCREENSHOT_DIR =
  "/private/tmp/claude-501/-Users-macbookpro-zoi-kan/41316f0d-3a34-4ae3-a8de-d2fb6db0b018/scratchpad/r2";

test.describe.configure({ mode: "serial" });

// wp3.spec.ts (a) 都會用「複製上月」幫 2026-08 填第一次資料，但兩個
// spec 檔案跑嘅次序由 Playwright 自己決定（唔一定跟 CLI 參數次序），加
// 上 dev DB 喺呢部機係跨 worktree 共用（另一個 worktree／重新 seed 隨時
// 會令 2026-08 打回未排更嘅空表）——呢個 helper 令本檔測試唔靠嗰邊個
// test 執行次序，自己出現空表就先撳「複製上月」（2026-08 嘅上一個月一
// 定係 2026-07，seed 固定有資料）先繼續斷言。
async function ensureRosterHasRows(page: Page): Promise<void> {
  const hasRow = await page
    .getByTestId("roster-row")
    .first()
    .isVisible({ timeout: 3_000 })
    .catch(() => false);
  if (hasRow) return;
  await page.getByRole("button", { name: /複製上月/ }).click();
  await expect(page.getByTestId("roster-row").first()).toBeVisible({ timeout: 20_000 });
}

test("(a) 桌面：雞頭統計卡撳＝篩選（行數減少 + URL 帶 broker=），再撳同一張卡＝取消篩選", async ({ page }) => {
  const siteId = await findSiteIdByName("啟航1331");
  await loginAs(page, "主管");
  await page.goto(`/roster/${siteId}/2026-08`);
  await page.waitForSelector('button:has-text("複製上月")', { timeout: 20_000 }); // 編輯器載入完成（同 wp3.spec.ts (a) 一致嘅等法）
  await ensureRosterHasRows(page);

  const cards = page.getByTestId("broker-stats-row");
  await expect(cards.first()).toBeVisible({ timeout: 20_000 });
  expect(await cards.count()).toBeGreaterThanOrEqual(2);

  const initialRows = await page.getByTestId("roster-row").count();
  const code = await cards.first().getAttribute("data-broker-code");
  expect(code).toBeTruthy();

  await cards.first().click();
  await expect.poll(() => new URL(page.url()).searchParams.get("broker")).toBe(code);
  await expect.poll(() => page.getByTestId("roster-row").count()).toBeLessThan(initialRows);
  await expect(page.getByTestId("roster-selected-broker-total")).toBeVisible();

  // README「撳卡＝篩選該雞頭（再撳取消）」——同一張卡再撳一次要取消篩選。
  await cards.first().click();
  await expect.poll(() => new URL(page.url()).searchParams.get("broker")).toBeNull();
  await expect.poll(() => page.getByTestId("roster-row").count()).toBe(initialRows);

  await page.screenshot({ path: `${SCREENSHOT_DIR}/desktop-roster-full.png`, fullPage: true });
});

test("(b) 桌面：今日／週末日期欄樣式（data-today/data-weekend）", async ({ page }) => {
  const siteId = await findSiteIdByName("啟航1331");
  await loginAs(page, "主管");
  // 2026-09 係伺服器「今日」所在月份（2026-09-14）——就算呢個盤呢個月
  // 未有更表記錄，日期表頭都照樣會 render（唔靠 shift_records 資料）。
  await page.goto(`/roster/${siteId}/2026-09`);
  await expect(page.getByTestId("roster-day-header-14")).toBeVisible({ timeout: 20_000 });

  const todayHeader = page.getByTestId("roster-day-header-14");
  await expect(todayHeader).toHaveAttribute("data-today", "true");

  // 搵返 2026-09 入面第一個週末（六／日）同第一個非週末嘅日數，逐個同
  // JS Date 對返嘅 UTC weekday 計算一致（唔靠寫死實際日曆）。
  let weekendDay = -1;
  let weekdayDay = -1;
  const daysInSep = new Date(Date.UTC(2026, 9, 0)).getUTCDate();
  for (let d = 1; d <= daysInSep; d++) {
    const wd = new Date(Date.UTC(2026, 8, d)).getUTCDay();
    const isWeekend = wd === 0 || wd === 6;
    if (isWeekend && weekendDay === -1) weekendDay = d;
    if (!isWeekend && weekdayDay === -1) weekdayDay = d;
    if (weekendDay !== -1 && weekdayDay !== -1) break;
  }
  expect(weekendDay).toBeGreaterThan(0);
  expect(weekdayDay).toBeGreaterThan(0);

  await expect(page.getByTestId(`roster-day-header-${weekendDay}`)).toHaveAttribute("data-weekend", "true");
  await expect(page.getByTestId(`roster-day-header-${weekdayDay}`)).not.toHaveAttribute("data-weekend", "true");
});

test.describe("手機（375×812）", () => {
  test.use({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });

  test("(c) 撳格彈底部更別鍵盤，撳鍵寫入該格（用未鎖定嘅 2026-08）", async ({ page }) => {
    const siteId = await findSiteIdByName("啟航1331");
    await loginAs(page, "老闆");
    await page.goto(`/roster/${siteId}/2026-08`);
    // 手機頁首冇「複製上月」掣（README §23 冇呢個 action）——依賴呢個
    // describe block 之前嘅 (a) 已經幫 2026-08 確保有資料（`test.describe.
    // configure({ mode: "serial" })` 令成個檔案由上到下順序跑）。
    await expect(page.getByTestId("roster-row").first()).toBeVisible({ timeout: 20_000 });

    await expect(page.getByTestId("roster-mobile-keypad")).toHaveCount(0);

    const cell = page.getByTestId("roster-cell-0-5");
    await cell.click();

    const keypad = page.getByTestId("roster-mobile-keypad");
    await expect(keypad).toBeVisible({ timeout: 10_000 });
    await expect(keypad.getByText(/揀更別/)).toBeVisible();

    await page.screenshot({ path: `${SCREENSHOT_DIR}/mobile-roster-keypad.png` });

    await keypad.getByRole("button", { name: "AL", exact: true }).click();

    await expect(keypad).toHaveCount(0);
    await expect(cell).toHaveText("AL", { timeout: 10_000 });

    // 清除：撳返個格 → 鍵盤再彈 → 撳「清除」→ 格變返空。
    await cell.click();
    await expect(keypad).toBeVisible({ timeout: 10_000 });
    await keypad.getByRole("button", { name: "清除", exact: true }).click();
    await expect(keypad).toHaveCount(0);
    await expect(cell).toHaveText("", { timeout: 10_000 });
  });

  test("(d) 鎖定月份撳格唔彈鍵盤", async ({ page }) => {
    const siteId = await findSiteIdByName("啟航1331");
    await loginAs(page, "老闆");
    // 2026-07 已鎖定（wp3.spec.ts (d) 匯出斷言用嘅同一個盤/月）。
    await page.goto(`/roster/${siteId}/2026-07`);
    await expect(page.getByTestId("roster-row").first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/已鎖定/).first()).toBeVisible();

    await page.getByTestId("roster-cell-0-5").click({ force: true });
    await expect(page.getByTestId("roster-mobile-keypad")).toHaveCount(0);
  });
});

test.afterAll(async () => {
  await prisma.$disconnect();
});
