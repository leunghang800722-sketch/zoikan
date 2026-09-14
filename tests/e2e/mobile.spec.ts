// 老闆手機版 bug（2026-09-13，手機 Chrome）Playwright e2e。
//
// 覆蓋：
//   1. `< md`（768px）左欄收埋做漢堡抽屜（`src/components/MobileNav.tsx`）。
//   2. 「在勤助手」直向 tab 一律貼實螢幕最右邊緣（`AiAssistantSidebar.tsx`
//      改用 `createPortal` 掛去 `document.body`）。
//   3. 主內容區手機用滿闊度，body 冇橫向捲動。
//
// PDPO：斷言唔寫死真名/電話，用 DB 查出嚟嘅 id 或者測試帳號角色名比對
// （同 wp3.spec.ts／ai.spec.ts 一致做法）。截圖存 scratchpad，唔入 repo。
import { test, expect } from "@playwright/test";
import { loginAs } from "./helpers";
import { findSiteIdByName, prisma } from "./db-helpers";

// 截圖只喺設咗 E2E_SHOT_DIR 先存（同 home.spec.ts 一致），唔寫死機器路徑。
const SCREENSHOT_DIR = process.env.E2E_SHOT_DIR ? `${process.env.E2E_SHOT_DIR}/mobile` : null;
const shot = async (page: import("@playwright/test").Page, name: string) => {
  if (!SCREENSHOT_DIR) return;
  await page.screenshot({ path: `${SCREENSHOT_DIR}/${name}` });
};

test.describe("手機版佈局（375×812）", () => {
  test.use({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });
  test.describe.configure({ mode: "serial" });

  test("(a) 老闆登入首頁：固定左欄唔可見、漢堡掣可見、<main> 寬度 ≥ 視窗 90%", async ({ page }) => {
    await loginAs(page, "老闆");
    await page.goto("/");

    await expect(page.locator("aside")).toBeHidden();

    const hamburger = page.getByTestId("mobile-nav-hamburger");
    await expect(hamburger).toBeVisible();

    const main = page.locator("main");
    await expect(main).toBeVisible();
    const box = await main.boundingBox();
    expect(box).toBeTruthy();
    expect(box!.width).toBeGreaterThanOrEqual(375 * 0.9);

    await shot(page, "home-drawer-closed.png");
  });

  test("(b) 撳漢堡 → 抽屜可見且含「更表」「保安員」連結，撳「更表」→ 抽屜關閉並到 /roster", async ({ page }) => {
    await loginAs(page, "老闆");
    await page.goto("/");

    await page.getByTestId("mobile-nav-hamburger").click();
    const drawer = page.getByTestId("mobile-nav-drawer");
    await expect(drawer).toBeVisible();

    await shot(page, "home-drawer-open.png");

    await expect(drawer.getByRole("link", { name: "更表" })).toBeVisible();
    await expect(drawer.getByRole("link", { name: "保安員" })).toBeVisible();

    await drawer.getByRole("link", { name: "更表" }).click();
    await page.waitForURL((u) => u.pathname === "/roster", { timeout: 15_000 });
    await expect(drawer).toBeHidden();
  });

  test("(c) 手機用右下角「助手」浮動掣（唔壓內容）；撳開 → 側欄佔滿視窗寬度；直向 tab 唔顯示", async ({ page }) => {
    await loginAs(page, "老闆");
    await page.goto("/");

    const fab = page.getByTestId("ai-assistant-fab");
    await expect(fab).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("ai-assistant-tab")).toBeHidden(); // 桌面直向 tab 手機唔出
    const box = await fab.boundingBox();
    expect(box).toBeTruthy();
    // 右下角：右邊距 8–40px、底邊距 8–60px；喺視窗下 25% 範圍內（唔會壓住中間卡片）
    expect(375 - (box!.x + box!.width)).toBeGreaterThanOrEqual(8);
    expect(375 - (box!.x + box!.width)).toBeLessThanOrEqual(40);
    expect(812 - (box!.y + box!.height)).toBeGreaterThanOrEqual(8);
    expect(812 - (box!.y + box!.height)).toBeLessThanOrEqual(60);
    expect(box!.y).toBeGreaterThan(812 * 0.75);

    await fab.click();
    const panel = page.getByTestId("ai-assistant-panel");
    await expect(panel).toBeVisible({ timeout: 20_000 });
    const panelBox = await panel.boundingBox();
    expect(panelBox).toBeTruthy();
    expect(panelBox!.width).toBeGreaterThanOrEqual(375 - 2);
    await expect(fab).toBeHidden();
  });

  test("(e) 撳當前頁連結（pathname 唔變）抽屜都要收——喺 /roster 開抽屜撳「更表」", async ({ page }) => {
    await loginAs(page, "老闆");
    await page.goto("/roster");

    await page.getByTestId("mobile-nav-hamburger").click();
    const drawer = page.getByTestId("mobile-nav-drawer");
    await expect(drawer).toBeVisible();

    // 已經喺 /roster，撳抽屜入面嘅「更表」連結 pathname 唔會變，之前
    // 淨係靠 `usePathname()` 變化嗰個 effect 關抽屜嘅寫法喺呢種情況會
    // 漏（抽屜賴喺度）——`MobileNav.tsx` 每條 `<Link>` 而家加咗顯式
    // `onClick={() => setOpen(false)}`，唔理 pathname 變唔變都會關。
    await drawer.getByRole("link", { name: "更表" }).click();
    await expect(drawer).toBeHidden();
    expect(new URL(page.url()).pathname).toBe("/roster");
  });

  test("(f) 手機闊度：更表日期欄要喺固定欄右邊見得到（唔可以被固定欄遮晒），且可以橫向捲", async ({ page }) => {
    const siteId = await findSiteIdByName("啟航1331");
    await loginAs(page, "老闆");
    await page.goto(`/roster/${siteId}/2026-07`);
    await expect(page.getByTestId("roster-row").first()).toBeVisible({ timeout: 30_000 });
    const info = await page.evaluate(() => {
      const cell = document.querySelector('[data-testid="roster-cell-0-1"]') as HTMLElement;
      const container = cell.closest("div.overflow-auto") as HTMLElement;
      const c = container.getBoundingClientRect();
      const b = cell.getBoundingClientRect();
      // 固定欄總闊（sticky 左欄）
      const stickyRight = Math.max(...[...container.querySelectorAll('tbody tr:first-child td')].filter((td) => getComputedStyle(td).position === "sticky").map((td) => td.getBoundingClientRect().right));
      return { containerRight: c.right, containerLeft: c.left, cellLeft: b.left, cellRight: b.right, stickyRight, scrollWidth: container.scrollWidth, clientWidth: container.clientWidth };
    });
    // 日期 1 格嘅左邊要喺固定欄右邊，而且整格喺容器可視範圍內
    expect(info.cellLeft).toBeGreaterThanOrEqual(info.stickyRight - 1);
    expect(info.cellRight).toBeLessThanOrEqual(info.containerRight + 1);
    // 固定欄唔可以佔多過容器 55%
    expect(info.stickyRight - info.containerLeft).toBeLessThan(info.clientWidth * 0.55);
    // 可以橫向捲（程式捲動後 scrollLeft 有變）
    const moved = await page.evaluate(() => { const d = document.querySelector('[data-testid="roster-cell-0-1"]')!.closest("div.overflow-auto") as HTMLElement; d.scrollLeft = 300; return d.scrollLeft; });
    expect(moved).toBeGreaterThan(100);
  });

  test("(d) 首頁同更表頁冇橫向捲動", async ({ page }) => {
    const siteId = await findSiteIdByName("啟航1331");

    await loginAs(page, "老闆");
    await page.goto("/");
    await expect(page.getByTestId("mobile-nav-hamburger")).toBeVisible();
    let overflow = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    expect(overflow).toBe(true);

    await page.goto(`/roster/${siteId}/2026-07`);
    await expect(page.getByTestId("roster-row").first()).toBeVisible({ timeout: 20_000 });
    await shot(page, "roster-page.png");
    overflow = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    expect(overflow).toBe(true);
  });

  // P2 整合驗收應修④：手機更表頁以前有雙層頁首——全站頂欄（`MobileNav`
  // 53px）＋更表自己嘅頁首（66px）疊埋一齊。跟原型，`< lg` 底下
  // `/roster/[site]/[month]` 呢個 route 而家完全唔 render 全站頂欄（連
  // 漢堡都冇），淨係得更表自己嗰個頁首。
  test("(g) 手機更表頁冇雙層頁首——全站頂欄漢堡唔顯示，淨係得更表自己嘅頁首", async ({ page }) => {
    const siteId = await findSiteIdByName("啟航1331");
    await loginAs(page, "老闆");

    // 對照組：更表「索引」頁（`/roster`，冇 site/month）唔受影響，全站
    // 頂欄照常顯示。
    await page.goto("/roster");
    await expect(page.getByTestId("mobile-nav-hamburger")).toBeVisible();

    await page.goto(`/roster/${siteId}/2026-07`);
    await expect(page.getByTestId("roster-row").first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("mobile-nav-hamburger")).toHaveCount(0);

    // 更表自己嘅頁首要貼實螢幕頂（y≈0），冇被一個已經冧咗嘅全站頂欄再
    // 讓落嚟。
    const header = page.getByTestId("roster-mobile-header");
    await expect(header).toBeVisible();
    const box = await header.boundingBox();
    expect(box).toBeTruthy();
    expect(box!.y).toBeLessThanOrEqual(1);

    await shot(page, "roster-page-single-header.png");
    await page.screenshot({
      path: "/private/tmp/claude-501/-Users-macbookpro-zoi-kan/41316f0d-3a34-4ae3-a8de-d2fb6db0b018/scratchpad/p1-fix/mobile-375-roster-header.png",
    });
  });
});

test.describe("桌面版回歸（1280×800）", () => {
  test.use({ viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false });

  test("左欄可見、漢堡不可見", async ({ page }) => {
    await loginAs(page, "老闆");
    await page.goto("/");

    await expect(page.locator("aside")).toBeVisible();
    await expect(page.getByTestId("mobile-nav-hamburger")).toBeHidden();
  });
});

test.afterAll(async () => {
  await prisma.$disconnect();
});
