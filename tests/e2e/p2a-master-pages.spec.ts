// P2-A：主檔＋排更列表頁重新實作（README §05 配額／§06 審批隊列／§07
// 盤／§08 保安員／§09 雞頭／§10 價目）Playwright e2e。
//
// 斷言唔寫死數字／真名（PDPO）——雞頭隔離、金額遮蔽呢類斷言一律先用
// Prisma 查返實際資料再同 UI 對照（同 wp3.spec.ts／mobile.spec.ts 一致
// 做法）。截圖存 `E2E_SHOT_DIR`（冇設就跳過，同 home.spec.ts 一致）。
import { test, expect, type Page } from "@playwright/test";
import { loginAs } from "./helpers";
import { prisma } from "./db-helpers";

const SCREENSHOT_DIR = process.env.E2E_SHOT_DIR ? `${process.env.E2E_SHOT_DIR}/p2a` : null;
async function shot(page: Page, name: string) {
  if (!SCREENSHOT_DIR) return;
  await page.screenshot({ path: `${SCREENSHOT_DIR}/${name}`, fullPage: true });
}

const PAGES: { path: string; h1: string; headers: string[] }[] = [
  { path: "/quotas", h1: "配額", headers: ["月份", "盤", "更別", "雞頭", "目標更數"] },
  { path: "/approvals", h1: "審批隊列", headers: ["日期", "盤", "更別", "保安員", "類型", "雞頭"] },
  { path: "/sites", h1: "盤", headers: ["盤名", "客戶", "結算模式", "更別", "狀態"] },
  { path: "/guards", h1: "保安員", headers: ["姓名", "工號", "雞頭", "電話", "本月更數", "狀態"] },
  { path: "/brokers", h1: "雞頭", headers: ["代號", "名稱", "種類", "人數", "掛邊啲盤", "狀態"] },
  { path: "/rate-cards", h1: "價目", headers: ["盤", "更別", "雞頭", "保安員", "收客價", "出街價"] },
];

test.describe("P2-A 主檔＋排更列表頁：老闆登入", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  for (const p of PAGES) {
    test(`${p.path} 有 H1／表頭欄名／至少一行或空狀態`, async ({ page }) => {
      await loginAs(page, "老闆");
      await page.goto(p.path);

      const main = page.locator("main");
      await expect(main.getByRole("heading", { level: 1, name: p.h1 })).toBeVisible({ timeout: 20_000 });
      // 等 loading 完（載入緊… 消失）先判斷表格 vs EmptyState 邊個 render。
      await expect(main.getByText("載入緊…")).toHaveCount(0, { timeout: 20_000 });

      // 表頭欄名（桌面表格，喺 `hidden sm:block` wrap 入面）；或者表格
      // 唔存在時要見到 EmptyState（灰塊 + 標題）。
      const table = main.locator("table").first();
      const hasTable = await table.isVisible().catch(() => false);
      if (hasTable) {
        for (const h of p.headers) {
          await expect(table.locator("thead").getByText(h, { exact: true }).first()).toBeVisible();
        }
        const rowCount = await table.locator("tbody tr").count();
        expect(rowCount).toBeGreaterThan(0);
      } else {
        await expect(main.getByText(/未設任何配額|暫時冇|搵唔到符合/).first()).toBeVisible({ timeout: 20_000 });
      }

      await shot(page, `${p.path.slice(1)}-desktop-1440.png`);
    });
  }

  test("/rate-cards：主管登入見唔到收客價（field-group gate 保留，client_rate 一律「—」）", async ({ page }) => {
    await loginAs(page, "主管");
    await page.goto("/rate-cards");
    const main = page.locator("main");
    await expect(main.getByRole("heading", { level: 1, name: "價目" })).toBeVisible({ timeout: 20_000 });
    await expect(main.getByText("載入緊…")).toHaveCount(0, { timeout: 20_000 });
    const table = main.locator("table").first();
    await expect(table).toBeVisible({ timeout: 20_000 });
    const rowCount = await table.locator("tbody tr").count();
    expect(rowCount).toBeGreaterThan(0);
    // 收客價欄（第 5 欄，index 4）——現有 `hasClientRate` 邏輯保留，主管
    // 冇「收客價:view」，成欄一律「—」。
    const clientRateCells = table.locator("tbody tr td:nth-child(5)");
    const n = await clientRateCells.count();
    for (let i = 0; i < n; i++) {
      await expect(clientRateCells.nth(i)).toHaveText("—");
    }
  });

  test("/guards：雞頭A登入只見自己保安員（廣東話：唔見到第二個雞頭嘅人）", async ({ page }) => {
    const broker = await prisma.user.findFirstOrThrow({ where: { tel: "90000004" }, select: { brokerId: true } });
    const ownGuardCount = await prisma.guard.count({ where: { defaultBrokerId: broker.brokerId, status: "active" } });
    const otherGuard = await prisma.guard.findFirst({
      where: { defaultBrokerId: { not: broker.brokerId }, status: "active" },
      select: { nameZh: true },
    });
    expect(ownGuardCount).toBeGreaterThan(0);

    await loginAs(page, "雞頭A");
    await page.goto("/guards");
    const main = page.locator("main");
    await expect(main.getByRole("heading", { level: 1, name: "保安員" })).toBeVisible({ timeout: 20_000 });
    await expect(main.getByText("載入緊…")).toHaveCount(0, { timeout: 20_000 });
    const table = main.locator("table").first();
    await expect(table).toBeVisible({ timeout: 20_000 });
    const rowCount = await table.locator("tbody tr").count();
    expect(rowCount).toBe(ownGuardCount);
    if (otherGuard) {
      await expect(main.getByText(otherGuard.nameZh, { exact: true })).toHaveCount(0);
    }
  });
});

test.describe("P2-A 驗收修復（M1/M2/M3/S1）", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("M1：GET /api/guards?with_month_shifts=2026-13（月份唔存在）→ 400，唔係 500", async ({ page }) => {
    await loginAs(page, "老闆");
    const res = await page.request.get("/api/guards?with_month_shifts=2026-13");
    expect(res.status()).toBe(400);
  });

  test("M2：/rate-cards 更別欄至少一行顯示真代號（唔係全部「通用」）——揀一個有 shift_type_id 嘅盤過濾", async ({ page }) => {
    const row = await prisma.rateCard.findFirstOrThrow({ where: { shiftTypeId: { not: null } }, select: { siteId: true } });
    const site = await prisma.site.findUniqueOrThrow({ where: { id: row.siteId } });

    await loginAs(page, "老闆");
    await page.goto("/rate-cards");
    const main = page.locator("main");
    await expect(main.getByRole("heading", { level: 1, name: "價目" })).toBeVisible({ timeout: 20_000 });
    await expect(main.getByText("載入緊…")).toHaveCount(0, { timeout: 20_000 });

    await main.locator("select").first().selectOption({ label: site.canonicalName });
    await expect(main.getByText("載入緊…")).toHaveCount(0, { timeout: 20_000 });

    const table = main.locator("table").first();
    await expect(table).toBeVisible({ timeout: 20_000 });
    const shiftTypeCells = table.locator("tbody tr td:nth-child(2)");
    const n = await shiftTypeCells.count();
    let sawRealCode = false;
    for (let i = 0; i < n; i++) {
      const text = (await shiftTypeCells.nth(i).innerText()).trim();
      if (text && text !== "通用") sawRealCode = true;
    }
    expect(sawRealCode).toBe(true);
  });

  test("M3：/brokers K 雞頭「掛邊啲盤」（2026-08）≥ 10 個（用 broker_site_assignments，唔再用 referral_fee_rates 去重）", async ({ page }) => {
    const kBroker = await prisma.broker.findFirstOrThrow({ where: { code: "K" } });

    await loginAs(page, "老闆");
    await page.goto("/brokers");
    const main = page.locator("main");
    await expect(main.getByRole("heading", { level: 1, name: "雞頭" })).toBeVisible({ timeout: 20_000 });
    await expect(main.getByText("載入緊…")).toHaveCount(0, { timeout: 20_000 });

    // 今日（測試環境）當月未必有 K 嘅 broker_site_assignments 資料，
    // 撳返 2026-08 月份 chip（seed 資料確定有）。
    await main.locator('input[type="month"]').fill("2026-08");
    await page.waitForTimeout(300);

    const row = main.locator("table tbody tr", { has: page.getByText(kBroker.code, { exact: true }) }).first();
    await expect(row).toBeVisible({ timeout: 20_000 });
    const sitesCellText = (await row.locator("td").nth(4).innerText()).trim();
    expect(sitesCellText).not.toBe("—");
    const siteCount = sitesCellText.split("、").filter(Boolean).length;
    expect(siteCount).toBeGreaterThanOrEqual(10);
  });

  test("S1：/sites 更別欄冇 N+1——GET /api/shift-types 請求數 ≤ 2", async ({ page }) => {
    let shiftTypeRequests = 0;
    page.on("request", (r) => {
      if (r.url().includes("/api/shift-types")) shiftTypeRequests++;
    });

    await loginAs(page, "老闆");
    await page.goto("/sites");
    const main = page.locator("main");
    await expect(main.getByRole("heading", { level: 1, name: "盤" })).toBeVisible({ timeout: 20_000 });
    await expect(main.getByText("載入緊…")).toHaveCount(0, { timeout: 20_000 });

    expect(shiftTypeRequests).toBeLessThanOrEqual(2);
  });
});

test.describe("P2-A 主檔＋排更列表頁：手機 375px 零橫向捲", () => {
  test.use({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });

  for (const p of PAGES) {
    test(`${p.path} 手機 375px：body 冇橫向捲動`, async ({ page }) => {
      await loginAs(page, "老闆");
      await page.goto(p.path);
      const main = page.locator("main");
      await expect(main.getByRole("heading", { level: 1, name: p.h1 })).toBeVisible({ timeout: 20_000 });
      await expect(main.getByText("載入緊…")).toHaveCount(0, { timeout: 20_000 });
      const overflow = await page.evaluate(() => document.body.scrollWidth <= window.innerWidth + 1);
      expect(overflow).toBe(true);
      await shot(page, `${p.path.slice(1)}-mobile-375.png`);
    });
  }
});
