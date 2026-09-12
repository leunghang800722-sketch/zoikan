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

const SCREENSHOT_DIR =
  "/private/tmp/claude-501/-Users-macbookpro-zoi-kan/41316f0d-3a34-4ae3-a8de-d2fb6db0b018/scratchpad/mobile";

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

    await page.screenshot({ path: `${SCREENSHOT_DIR}/home-drawer-closed.png` });
  });

  test("(b) 撳漢堡 → 抽屜可見且含「更表」「保安員」連結，撳「更表」→ 抽屜關閉並到 /roster", async ({ page }) => {
    await loginAs(page, "老闆");
    await page.goto("/");

    await page.getByTestId("mobile-nav-hamburger").click();
    const drawer = page.getByTestId("mobile-nav-drawer");
    await expect(drawer).toBeVisible();

    await page.screenshot({ path: `${SCREENSHOT_DIR}/home-drawer-open.png` });

    await expect(drawer.getByRole("link", { name: "更表" })).toBeVisible();
    await expect(drawer.getByRole("link", { name: "保安員" })).toBeVisible();

    await drawer.getByRole("link", { name: "更表" }).click();
    await page.waitForURL((u) => u.pathname === "/roster", { timeout: 15_000 });
    await expect(drawer).toBeHidden();
  });

  test("(c) 「在勤助手」tab 貼實螢幕最右邊緣；撳開 → 側欄佔滿視窗寬度", async ({ page }) => {
    await loginAs(page, "老闆");
    await page.goto("/");

    const tab = page.getByTestId("ai-assistant-tab");
    await expect(tab).toBeVisible({ timeout: 20_000 });
    const tabBox = await tab.boundingBox();
    expect(tabBox).toBeTruthy();
    expect(Math.abs(tabBox!.x + tabBox!.width - 375)).toBeLessThanOrEqual(2);

    await tab.click();
    const panel = page.getByTestId("ai-assistant-panel");
    await expect(panel).toBeVisible({ timeout: 20_000 });
    const panelBox = await panel.boundingBox();
    expect(panelBox).toBeTruthy();
    expect(panelBox!.width).toBeGreaterThanOrEqual(375 - 2);
    // 側欄開晒全螢幕嗰陣 tab 應該隱藏（`AiAssistantSidebar.tsx` `!open` 先
    // render tab）。
    await expect(tab).toBeHidden();
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
    await page.screenshot({ path: `${SCREENSHOT_DIR}/roster-page.png` });
    overflow = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    expect(overflow).toBe(true);
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
