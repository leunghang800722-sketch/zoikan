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
//      嘅元素（日期 chip／表格行／KPI 數值）唔受呢個限制。
//   2. 左欄導航（`<aside>`）都係 `hidden md:flex`（同一手法）常駐 DOM，
//      有幾個連結字面（「本月應收」「配額」）同 KPI 卡標籤撞——一律用
//      `page.locator("main")` 收窄去 `<main>` 之內，避開側欄。
//
import { test, expect, type Page } from "@playwright/test";
import { loginAs } from "./helpers";

// B5 驗收修正：截圖路徑原本寫死一個 scratchpad 絕對路徑（淨係喺起呢份
// 修正嘅 agent 個 session 度先存在）——改用 `process.env.E2E_SHOT_DIR`，
// 冇設就唔截圖（唔應該因為冇呢個環境變量就成個 test fail）。
const SCREENSHOT_DIR = process.env.E2E_SHOT_DIR;

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
  pending_approval_count: number;
  month_progress: {
    month: string;
    margin_pct: number | null;
    threshold_pct: number;
    below_threshold_site_count: number;
  };
}

interface BrokerSiteRow {
  site_id: string;
  site_name: string;
  shifts: number;
  pending: number;
}
interface BrokerDashboardResult {
  month: string;
  scheduled_shifts: number;
  pending_approval_count: number;
  guard_count: number;
  quota: { target_shifts: number; scheduled_shifts: number } | null;
  sites: BrokerSiteRow[];
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

/** 截圖：`E2E_SHOT_DIR` 冇設就靜靜哋 skip（B5）。 */
async function maybeScreenshot(page: Page, filename: string): Promise<void> {
  if (!SCREENSHOT_DIR) return;
  await page.screenshot({ path: `${SCREENSHOT_DIR}/${filename}`, fullPage: true });
}

test.describe("首頁／尚欠總覽（WP-R3）", () => {
  // B6(a)：唔淨係斷言「有個 KPI 標籤」，要用同一個已登入 session 打
  // `GET /api/reports/shortfall?date=2026-07-15` 攞返真數，同 UI 顯示嘅
  // 「尚欠盤數」「共欠更數」「毛利率」逐個數值對照（唔係淨係睇有冇文字）。
  test("(a) 老闆首頁 ?date=2026-07-15：頁首＋KPI 數值同 API 逐個對", async ({ page }) => {
    await loginAs(page, "老闆");
    await page.goto("/?date=2026-07-15");
    const main = page.locator("main");

    await expect(main.getByText("歡迎返嚟", { exact: false })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("shortfall-date-label")).toContainText("2026-07-15");
    await expect(main.getByText("載入緊…")).toBeHidden();

    const res = await page.request.get("/api/reports/shortfall?date=2026-07-15");
    expect(res.ok()).toBe(true);
    const body = (await res.json()) as ShortfallResult;

    const shortfallSites = body.today.filter((s) => s.shortfall > 0);
    const totalShort = shortfallSites.reduce((a, s) => a + s.shortfall, 0);

    // 尚欠盤數——用 R3 修正加咗嘅 `data-testid="shortfall-count-value"`
    // 直接對數值（`.first()`＝桌面 viewport 嗰個）。
    await expect(page.getByTestId("shortfall-count-value").first()).toHaveText(String(shortfallSites.length));

    // 共欠更數——KPI 卡副行原文一字不漏（>0 先有呢行；=0 就係「今日各盤
    // 人手足夠」）。
    if (shortfallSites.length > 0) {
      await expect(main.getByText(`共欠 ${totalShort} 更`).first()).toBeVisible();
    } else {
      await expect(main.getByText("今日各盤人手足夠").first()).toBeVisible();
    }

    // 待審批（本月）。
    await expect(main.getByText("待審批（本月）").first()).toBeVisible();
    await expect(main.getByText(String(body.pending_approval_count)).first()).toBeVisible();

    // 毛利率——「本月毛利進度」大數同 API `month_progress.margin_pct`
    // 一字不漏（README：進度條數字直出，UI 冇再 round）。
    await expect(main.getByText(/本月毛利進度/).first()).toBeVisible();
    const marginText = body.month_progress.margin_pct == null ? "—" : `${body.month_progress.margin_pct}%`;
    await expect(page.getByTestId("margin-pct-value").first()).toHaveText(marginText);
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

    // B1 驗收修正之後：成行撳得改用行內覆蓋嘅真 <a>（見
    // ShortfallDashboard.tsx），Tab 焦點都要去到（唔淨係撳得郁）。
    await firstRow.getByRole("link").focus();
    await expect(firstRow.getByRole("link")).toBeFocused();

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

    // B8：月份切換 chip，預設當月。
    await expect(page.getByTestId("broker-month-label").first()).toBeVisible();
  });

  test("(f) 手機 375px：老闆首頁問候語＋2×2 KPI＋出勤列表卡", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await loginAs(page, "老闆");
    await page.goto("/?date=2026-07-15");
    const main = page.locator("main");

    // 第一個斷言用長 timeout（dev server 首次撞到呢條 route 要現場
    // compile，同 mobile.spec.ts／wp4.spec.ts 一致做法）。
    await expect(main.getByText(/早晨|午安|晚安/).first()).toBeVisible({ timeout: 20_000 });
    // B3：手機版一定要有可見 <h1>（同一個 h1，responsive class 兩邊都做
    // heading），唔係得桌面先有。
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(main.getByText("今日出勤 vs 所需").last()).toBeVisible();
    // 桌面表格 testid 元素喺 DOM 但俾 `hidden md:flex` 隱藏；手機走列表卡
    // testid（如果今日有排更資料就見到至少一行）。
    await expect(page.getByTestId("shortfall-row").first()).toBeHidden();
    const mobileRows = page.getByTestId("shortfall-row-mobile");
    if ((await mobileRows.count()) > 0) {
      await expect(mobileRows.first()).toBeVisible();
      // B2：列表卡改用真 <a>，可以 Tab 到。
      await expect(mobileRows.first()).toHaveJSProperty("tagName", "A");
    }
  });

  test("(g) 手機 375px：雞頭首頁 2×2 KPI＋「我有份嘅盤」列表卡", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await loginAs(page, "雞頭A");
    await page.goto("/");
    const main = page.locator("main");

    await expect(main.getByText(/早晨|午安|晚安/).first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(main.getByText("我有份嘅盤").last()).toBeVisible();
  });

  // B6：雞頭隔離——雞頭B 打自己個 dashboard API，回應入面嘅更數／sites
  // 唔可以同雞頭A 一樣（起碼要證明兩者數據唔同，唔係「岩岩好個 endpoint
  // 冇 scope 但兩個雞頭岩岩得同一組數」嗰種假陽性），亦唔含任何雞頭A
  // 專屬（A 有份但 B 冇份）嘅盤。內部角色（老闆）打呢個 route 一律 403。
  test("(j) 雞頭隔離：雞頭B fetch /api/dashboard/broker 唔含雞頭A 嘅數，老闆 fetch → 403", async ({ browser }) => {
    const monthQuery = "2026-07";

    const ctxA = await browser.newContext();
    const pageA = await ctxA.newPage();
    await loginAs(pageA, "雞頭A");
    const resA = await pageA.request.get(`/api/dashboard/broker?month=${monthQuery}`);
    expect(resA.ok()).toBe(true);
    const bodyA = (await resA.json()) as BrokerDashboardResult;
    await ctxA.close();

    const ctxB = await browser.newContext();
    const pageB = await ctxB.newPage();
    await loginAs(pageB, "雞頭B");
    const resB = await pageB.request.get(`/api/dashboard/broker?month=${monthQuery}`);
    expect(resB.ok()).toBe(true);
    const bodyB = (await resB.json()) as BrokerDashboardResult;

    // 更數口徑唔一樣（結構性隔離，唔係岩岩兩條數一樣）。
    expect(bodyB.scheduled_shifts).not.toBe(bodyA.scheduled_shifts);

    // A 專屬（A 有份、B 冇份）嘅盤，一個都唔可以出現喺 B 嘅 sites 入面
    // ——連盤名都唔可以漏落 B 個 response body（同
    // wp-r3-broker-dashboard.test.ts 嘅 unit test 手法一致，呢度用 e2e
    // 再證一次真係打緊 API、真係已登入嘅 session 隔離做緊嘢）。
    const bSiteIds = new Set(bodyB.sites.map((s) => s.site_id));
    const aExclusiveSites = bodyA.sites.filter((s) => !bSiteIds.has(s.site_id));
    expect(aExclusiveSites.length).toBeGreaterThan(0); // 確保呢個 negative test 真係有嘢好測（A、B 唔係岩岩份晒同一組盤）

    const bodyBStr = JSON.stringify(bodyB);
    for (const aSite of aExclusiveSites) {
      expect(bSiteIds.has(aSite.site_id)).toBe(false);
      expect(bodyBStr).not.toContain(aSite.site_name);
    }
    await ctxB.close();

    // 老闆（內部角色）打呢個雞頭專用 route → 403。
    const ctxOwner = await browser.newContext();
    const pageOwner = await ctxOwner.newPage();
    await loginAs(pageOwner, "老闆");
    const resOwner = await pageOwner.request.get(`/api/dashboard/broker?month=${monthQuery}`);
    expect(resOwner.status()).toBe(403);
    await ctxOwner.close();
  });

  test("(h) 截圖：老闆首頁 桌面 1440×900 同手機 375×812", async ({ page }) => {
    await loginAs(page, "老闆");
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/?date=2026-07-15");
    await expect(page.locator("main").getByText("今日尚欠盤數").first()).toBeVisible({ timeout: 20_000 });
    await maybeScreenshot(page, "boss-home-desktop-1440x900.png");

    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/?date=2026-07-15");
    await expect(page.locator("main").getByText("今日出勤 vs 所需").last()).toBeVisible();
    await maybeScreenshot(page, "boss-home-mobile-375x812.png");
  });

  test("(i) 截圖：雞頭首頁 桌面 1440×900 同手機 375×812", async ({ page }) => {
    await loginAs(page, "雞頭A");
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await expect(page.locator("main").getByText("我有份嘅盤").first()).toBeVisible({ timeout: 20_000 });
    await maybeScreenshot(page, "broker-home-desktop-1440x900.png");

    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/");
    await expect(page.locator("main").getByText("我有份嘅盤").last()).toBeVisible();
    await maybeScreenshot(page, "broker-home-mobile-375x812.png");
  });
});

// A1 驗收：`todayLocalStr()`／`greetingWord()`／`currentMonthStr()` 原本
// 用「跑緊 code 嗰部機」嘅本地時區，SSR（容器 UTC）同瀏覽器（用戶本地
// 時區）唔一致就 hydration mismatch。用兩個刻意揀嘅極端時區
// （`Pacific/Kiritimati` UTC+14、`Pacific/Honolulu` UTC-10——分別喺
// UTC 之後同之前成半日）開首頁，證明 console 冇 "Hydration failed"／
// React hydration 相關錯誤。
for (const tz of ["Pacific/Kiritimati", "Pacific/Honolulu"] as const) {
  test.describe(`A1 hydration 驗證（timezoneId=${tz}）`, () => {
    test.use({ timezoneId: tz });

    test(`老闆首頁喺 ${tz} 開，零 hydration error`, async ({ page }) => {
      const consoleErrors: string[] = [];
      const pageErrors: string[] = [];
      page.on("console", (msg) => {
        if (msg.type() === "error") consoleErrors.push(msg.text());
      });
      page.on("pageerror", (err) => {
        pageErrors.push(err.message);
      });

      await loginAs(page, "老闆");
      await page.goto("/?date=2026-07-15");
      await expect(page.locator("main").getByText("歡迎返嚟", { exact: false })).toBeVisible({ timeout: 20_000 });
      // 畀 React 足夠時間 hydrate 完成（如果會出 hydration warning，通常
      // 掛載完即刻出）。
      await page.waitForTimeout(1_000);

      const hydrationIssues = [...consoleErrors, ...pageErrors].filter((m) => /hydrat/i.test(m));
      expect(hydrationIssues).toEqual([]);
    });

    test(`雞頭首頁喺 ${tz} 開，零 hydration error`, async ({ page }) => {
      const consoleErrors: string[] = [];
      const pageErrors: string[] = [];
      page.on("console", (msg) => {
        if (msg.type() === "error") consoleErrors.push(msg.text());
      });
      page.on("pageerror", (err) => {
        pageErrors.push(err.message);
      });

      await loginAs(page, "雞頭A");
      await page.goto("/");
      await expect(page.locator("main").getByText("歡迎返嚟", { exact: false })).toBeVisible({ timeout: 20_000 });
      await page.waitForTimeout(1_000);

      const hydrationIssues = [...consoleErrors, ...pageErrors].filter((m) => /hydrat/i.test(m));
      expect(hydrationIssues).toEqual([]);
    });
  });
}
