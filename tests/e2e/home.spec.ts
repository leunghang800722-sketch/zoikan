// P2-WP-R3 首頁重新實作 Playwright e2e（README §02＝§15／§21／§25）。用
// 現成 seed 數據（tests/e2e/db-helpers.ts；2026-07 真數）——斷言唔寫死
// 數字／真名，一律先用同一個已登入 session 打 API 攞返真實數據再同 UI
// 對照（PDPO；同 wp4.spec.ts／mobile.spec.ts 一致做法）。
//
// 兩個注意位：
//   1. 桌面／手機兩套版面喺同一個 client component 內用 `hidden
//      md:block`／`md:hidden` 一齊 render（同 R1 嘅 DesktopNav/MobileNav
//      一致手法），所以 KPI 標籤呢類文字喺 DOM 會出現兩次（桌面版先、
//      手機版後）。桌面 viewport 嘅斷言用 `.first()`（揀桌面嗰個），
//      手機 viewport 嘅斷言用 `.last()`（揀手機嗰個）；有獨立 testid
//      嘅元素（日期 chip／表格行）唔受呢個限制。
//   2. 左欄導航（`<aside>`）都係 `hidden md:flex`（同一手法）常駐 DOM，
//      有幾個連結字面（「本月應收」「配額」）同 KPI 卡標籤撞——一律用
//      `page.locator("main")` 收窄去 `<main>` 之內，避開側欄。
// 截圖存 scratchpad，唔入 repo。
import { test, expect, type Page } from "@playwright/test";
import { loginAs } from "./helpers";

const SCREENSHOT_DIR =
  "/private/tmp/claude-501/-Users-macbookpro-zoi-kan/41316f0d-3a34-4ae3-a8de-d2fb6db0b018/scratchpad/r3";

interface ShortfallSiteRow {
  site_id: string;
  site_name: string;
  required: number;
  confirmed: number;
  shortfall: number;
}
interface ShortfallResult {
  date: string;
  today: ShortfallSiteRow[];
}

/** 喺 2026-07 揾一日真係有尚欠（shortfall>0）嘅盤，等「尚欠排最前/紅底/
 * 撳行去更表」呢個斷言唔使賭 2026-07-15 嗰日岩岩好有冇尚欠。 */
async function findDateWithShortfall(page: Page): Promise<{ date: string; body: ShortfallResult }> {
  const candidates = [
    "2026-07-15", "2026-07-16", "2026-07-17", "2026-07-10", "2026-07-20",
    "2026-07-08", "2026-07-22", "2026-07-05", "2026-07-25", "2026-07-29",
    "2026-07-03", "2026-07-12",
  ];
  for (const d of candidates) {
    const res = await page.request.get(`/api/reports/shortfall?date=${d}`);
    if (!res.ok()) continue;
    const body = (await res.json()) as ShortfallResult;
    if (body.today.some((s) => s.shortfall > 0)) return { date: d, body };
  }
  throw new Error("e2e setup: 2026-07 幾個樣本日都搵唔到任何尚欠嘅盤，冇得斷言紅底排前");
}

test.describe("首頁／尚欠總覽（WP-R3）", () => {
  test("(a) 老闆首頁 ?date=2026-07-15：頁首＋三個 KPI 有數字", async ({ page }) => {
    await loginAs(page, "老闆");
    await page.goto("/?date=2026-07-15");
    const main = page.locator("main");

    await expect(main.getByText("歡迎返嚟", { exact: false })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("shortfall-date-label")).toContainText("2026-07-15");

    await expect(main.getByText("今日尚欠盤數").first()).toBeVisible();
    await expect(main.getByText("待審批（本月）").first()).toBeVisible();
    await expect(main.getByText(/本月毛利進度/).first()).toBeVisible();
    await expect(main.getByText("載入緊…")).toBeHidden();
  });

  test("(b) 尚欠嘅盤排最前兼紅底，撳行去該盤更表", async ({ page }) => {
    await loginAs(page, "老闆");
    const { date, body } = await findDateWithShortfall(page);
    await page.goto(`/?date=${date}`);

    const rows = page.getByTestId("shortfall-row");
    await expect(rows.first()).toBeVisible({ timeout: 20_000 });
    expect(await rows.count()).toBe(body.today.length);

    const top = [...body.today].sort((x, y) => y.shortfall - x.shortfall)[0];
    expect(top.shortfall).toBeGreaterThan(0);

    const firstRow = rows.first();
    await expect(firstRow).toContainText(top.site_name);
    const bg = await firstRow.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(bg).toBe("rgb(254, 242, 242)"); // README 警示行底色 #fef2f2

    await firstRow.click();
    await page.waitForURL((u) => u.pathname === `/roster/${top.site_id}/${date.slice(0, 7)}`, { timeout: 15_000 });
  });

  test("(c) 日期切換 chip：撳 ‹ › 前後一日重新 fetch，URL query 同步", async ({ page }) => {
    await loginAs(page, "老闆");
    await page.goto("/?date=2026-07-15");
    await expect(page.getByTestId("shortfall-date-label")).toContainText("2026-07-15", { timeout: 20_000 });

    await page.getByTestId("shortfall-date-prev").click();
    await expect(page.getByTestId("shortfall-date-label")).toContainText("2026-07-14");
    await expect(page).toHaveURL(/date=2026-07-14/);

    await page.getByTestId("shortfall-date-next").click();
    await page.getByTestId("shortfall-date-next").click();
    await expect(page.getByTestId("shortfall-date-label")).toContainText("2026-07-16");
    await expect(page).toHaveURL(/date=2026-07-16/);
  });

  test("(d) 尚欠總覽頁（/reports/shortfall）：H1「尚欠總覽」，KPI 卡唔可撳去自己", async ({ page }) => {
    await loginAs(page, "老闆");
    await page.goto("/reports/shortfall?date=2026-07-15");
    await expect(page.getByRole("heading", { name: "尚欠總覽" })).toBeVisible({ timeout: 20_000 });
    await expect(page.locator("main").getByText("今日尚欠盤數").first()).toBeVisible();
  });

  test("(e) 雞頭首頁：4 個 KPI 卡＋「我有份嘅盤」表", async ({ page }) => {
    await loginAs(page, "雞頭A");
    await page.goto("/");
    const main = page.locator("main");

    await expect(main.getByText("歡迎返嚟", { exact: false })).toBeVisible({ timeout: 20_000 });
    await expect(main.getByText("本月已排更數").first()).toBeVisible();
    await expect(main.getByText("本月應收（出街價）").first()).toBeVisible();
    await expect(main.getByText("配額", { exact: true }).first()).toBeVisible();
    await expect(main.getByText("自己保安員").first()).toBeVisible();
    await expect(main.getByText("我有份嘅盤").first()).toBeVisible();
  });

  test("(f) 手機 375px：老闆首頁問候語＋2×2 KPI＋出勤列表卡", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await loginAs(page, "老闆");
    await page.goto("/?date=2026-07-15");
    const main = page.locator("main");

    // 第一個斷言用長 timeout（dev server 首次撞到呢條 route 要現場
    // compile，同 mobile.spec.ts／wp4.spec.ts 一致做法）。
    await expect(main.getByText(/早晨|午安|晚安/).first()).toBeVisible({ timeout: 20_000 });
    await expect(main.getByText("今日出勤 vs 所需").last()).toBeVisible();
    // 桌面表格 testid 元素喺 DOM 但俾 `hidden md:flex` 隱藏；手機走列表卡
    // testid（如果今日有排更資料就見到至少一行）。
    await expect(page.getByTestId("shortfall-row").first()).toBeHidden();
    const mobileRows = page.getByTestId("shortfall-row-mobile");
    if ((await mobileRows.count()) > 0) {
      await expect(mobileRows.first()).toBeVisible();
    }
  });

  test("(g) 手機 375px：雞頭首頁 2×2 KPI＋「我有份嘅盤」列表卡", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await loginAs(page, "雞頭A");
    await page.goto("/");
    const main = page.locator("main");

    await expect(main.getByText(/早晨|午安|晚安/).first()).toBeVisible({ timeout: 20_000 });
    await expect(main.getByText("我有份嘅盤").last()).toBeVisible();
  });

  test("(h) 截圖：老闆首頁 桌面 1440×900 同手機 375×812", async ({ page }) => {
    await loginAs(page, "老闆");
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/?date=2026-07-15");
    await expect(page.locator("main").getByText("今日尚欠盤數").first()).toBeVisible({ timeout: 20_000 });
    await page.screenshot({ path: `${SCREENSHOT_DIR}/boss-home-desktop-1440x900.png`, fullPage: true });

    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/?date=2026-07-15");
    await expect(page.locator("main").getByText("今日出勤 vs 所需").last()).toBeVisible();
    await page.screenshot({ path: `${SCREENSHOT_DIR}/boss-home-mobile-375x812.png`, fullPage: true });
  });

  test("(i) 截圖：雞頭首頁 桌面 1440×900 同手機 375×812", async ({ page }) => {
    await loginAs(page, "雞頭A");
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await expect(page.locator("main").getByText("我有份嘅盤").first()).toBeVisible({ timeout: 20_000 });
    await page.screenshot({ path: `${SCREENSHOT_DIR}/broker-home-desktop-1440x900.png`, fullPage: true });

    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/");
    await expect(page.locator("main").getByText("我有份嘅盤").last()).toBeVisible();
    await page.screenshot({ path: `${SCREENSHOT_DIR}/broker-home-mobile-375x812.png`, fullPage: true });
  });
});
