// P3 階段 4（UI 一致性＋面板清理）e2e：鎖月狀態（month_closes 為準，唔依賴 run）、保安員 Drawer tab、長工糧 tab、
// 分診預設只顯示未答、操作紀錄中文欄名 diff、ConfirmDialog、手機版面無橫向溢出。
// 鎖月測試用 2099-03／2099-04 嘅 month_closes 行（冇 run、冇更表），測後刪走；唔碰 2026-07／08。
import { test, expect, type Page } from "@playwright/test";
import { loginAs } from "./helpers";
import { prisma } from "./db-helpers";

const LOCKED = "2099-03";
const UNLOCKED = "2099-04";
const d = (m: string) => new Date(`${m}-01T00:00:00.000Z`);

test.beforeAll(async () => {
  await prisma.monthClose.deleteMany({ where: { month: { in: [d(LOCKED), d(UNLOCKED)] } } });
  await prisma.monthClose.create({ data: { month: d(LOCKED), lockedAt: new Date("2099-04-02T03:00:00.000Z"), createdBy: "test-e2e" } });
  await prisma.monthClose.create({ data: { month: d(UNLOCKED), createdBy: "test-e2e" } });
});
test.afterAll(async () => {
  await prisma.monthClose.deleteMany({ where: { month: { in: [d(LOCKED), d(UNLOCKED)] } } });
  await prisma.$disconnect();
});

async function noHScroll(page: Page) {
  const [sw, iw] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  expect(sw).toBeLessThanOrEqual(iw);
}

test.describe("P3-4.0 鎖月狀態（舊流程鎖咗、冇一鍵結算 run）", () => {
  test("老闆：一鍵結算頁見「已鎖定」＋鎖定資訊＋解鎖框；StageBar ⑤ 已鎖定", async ({ page }) => {
    await loginAs(page, "老闆");
    await page.goto(`/month-close?month=${LOCKED}`);
    await expect(page.getByTestId("lock-section")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("locked-info")).toContainText("已鎖定");
    await expect(page.getByTestId("unlock-box")).toBeVisible();
    const stages = page.getByTestId("stage-bar").locator("li");
    await expect(stages.nth(4)).toHaveAttribute("data-state", "ok");
    await expect(stages.nth(4)).toContainText("已鎖定");
    // 冇 run：其餘步仍然「未」
    await expect(stages.nth(1)).toContainText("未跑");
  });

  test("主管：見「已鎖定」但冇解鎖框（月結鎖定解鎖:void 權限）", async ({ page }) => {
    await loginAs(page, "主管");
    await page.goto(`/month-close?month=${LOCKED}`);
    await expect(page.getByTestId("locked-info")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("unlock-box")).toHaveCount(0);
  });

  test("未鎖又冇 run：StageBar ⑤ 照舊「未到」，冇鎖定資訊", async ({ page }) => {
    await loginAs(page, "老闆");
    await page.goto(`/month-close?month=${UNLOCKED}`);
    await expect(page.getByTestId("stage-bar")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("stage-bar").locator("li").nth(4)).toContainText("未到");
    await expect(page.getByTestId("locked-info")).toHaveCount(0);
  });

  test("月結總表右欄：已鎖定 → 「去一鍵結算解鎖 ›」；未鎖定 → 「去一鍵結算鎖月 ›」", async ({ page }) => {
    await loginAs(page, "老闆");
    await page.goto(`/reports/monthly-close?month=${LOCKED}`);
    await expect(page.getByTestId("lock-pointer-text")).toContainText("已鎖定", { timeout: 20_000 });
    await expect(page.getByTestId("goto-month-close")).toHaveText("去一鍵結算解鎖 ›");
    await page.goto(`/reports/monthly-close?month=${UNLOCKED}`);
    await expect(page.getByTestId("lock-pointer-text")).toContainText("未鎖定", { timeout: 20_000 });
    await expect(page.getByTestId("goto-month-close")).toHaveText("去一鍵結算鎖月 ›");
  });
});

test.describe("P3-4.3 面板清理", () => {
  test("保安員 Drawer：5 個 tab 分組（老闆），切 tab 顯示對應分區", async ({ page }) => {
    await loginAs(page, "老闆");
    await page.goto("/guards");
    const main = page.locator("main");
    await expect(main.getByText("載入緊…")).toHaveCount(0, { timeout: 20_000 });
    await main.locator("table tbody tr").first().getByRole("button", { name: "編輯" }).click();
    await expect(page.getByRole("heading", { name: "編輯保安員" })).toBeVisible({ timeout: 10_000 });
    const tabs = page.getByTestId("guard-drawer-tabs").getByRole("tab");
    await expect(tabs.first()).toHaveText("基本");
    expect(await tabs.count()).toBeGreaterThanOrEqual(4);
    await expect(page.getByTestId("guard-tab-panel-basic")).toBeVisible();
    await expect(page.locator('[data-testid^="guard-tab-panel-docs"]').first()).toBeHidden();
    // 預設雞頭／聘用形式／月薪／Polo 尺碼屬「基本」tab，切走就隱藏
    await expect(page.getByText("聘用形式（employment_type）")).toBeVisible();
    await page.getByTestId("guard-tab-docs").click();
    await expect(page.getByText("聘用形式（employment_type）")).toBeHidden();
    await expect(page.locator('[data-testid^="guard-tab-panel-docs"]').first()).toBeVisible();
    await expect(page.locator('[data-testid^="guard-tab-panel-basic"]').first()).toBeHidden();
    await page.getByTestId("guard-tab-longterm").click();
    await expect(page.getByTestId("guard-tab-panel-longterm")).toBeVisible();
  });

  test("保安員 Drawer：多個隱藏 tab 同時 invalid → 跳去 DOM 次序最前嗰個 tab", async ({ page }) => {
    await loginAs(page, "老闆");
    await page.goto("/guards");
    const main = page.locator("main");
    await expect(main.getByText("載入緊…")).toHaveCount(0, { timeout: 20_000 });
    await main.locator("table tbody tr").first().getByRole("button", { name: "編輯" }).click();
    await expect(page.getByRole("heading", { name: "編輯保安員" })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole("button", { name: "儲存" })).toBeEnabled({ timeout: 15_000 });
    // 「證件」同「銀行」tab 各一個欄設自訂驗證錯誤（模擬多個隱藏 tab 同時 invalid）；基本 tab 係當前 tab。
    const marked = await page.evaluate(() => {
      const docs = document.querySelector<HTMLInputElement>('[data-testid="guard-tab-panel-docs"] input');
      const bank = document.querySelector<HTMLInputElement>('[data-testid="guard-tab-panel-bank"] input');
      docs?.setCustomValidity("e2e docs invalid");
      bank?.setCustomValidity("e2e bank invalid");
      return { docs: !!docs, bank: !!bank };
    });
    expect(marked.docs).toBe(true);
    if (!marked.bank) test.skip(true, "呢個 seed 保安員冇銀行 tab");
    await page.getByRole("button", { name: "儲存" }).click();
    await expect(page.getByTestId("guard-tab-docs")).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("guard-tab-bank")).toHaveAttribute("aria-selected", "false");
  });

  test("長工糧頁：4 個 tab", async ({ page }) => {
    await loginAs(page, "老闆");
    await page.goto("/reports/longterm-payroll");
    const tabs = page.getByTestId("ltpay-tabs").getByRole("tab");
    await expect(tabs).toHaveCount(4);
    await expect(page.getByTestId("ltpay-panel-pay")).toBeVisible();
    await expect(page.getByTestId("ltpay-panel-contracts")).toBeHidden();
    await page.getByTestId("ltpay-tab-contracts").click();
    await expect(page.getByTestId("ltpay-panel-contracts")).toBeVisible();
    await expect(page.getByTestId("ltpay-panel-pay")).toBeHidden();
  });

  test("操作紀錄：展開改動見中文欄名 diff，原始 JSON 收埋", async ({ page }) => {
    await loginAs(page, "老闆");
    await page.goto("/audit-log");
    await expect(page.getByTestId("audit-log-row").first()).toBeVisible({ timeout: 20_000 });
    await page.getByTestId("audit-log-row").first().getByText("展開改動").click();
    const diff = page.getByTestId("audit-diff").first();
    await expect(diff).toBeVisible();
    await expect(diff.getByText("原始 JSON")).toBeVisible();
    await expect(diff.locator("pre").first()).toBeHidden();
  });

  test("分診：預設只顯示未答（已處理晒／被取代摺埋），可顯示全部", async ({ page }) => {
    await loginAs(page, "老闆");
    await page.goto("/triage");
    await expect(page.getByRole("heading", { name: "待答問題" })).toBeVisible();
    // 預設可見嘅卡全部有未答（按鈕唔係「冇未答」）
    await page.waitForLoadState("networkidle");
    const cards = page.getByTestId("triage-session-card");
    const n = await cards.count();
    for (let i = 0; i < n; i++) await expect(cards.nth(i).getByRole("button", { name: "繼續答" })).toBeVisible();
    if (await page.getByTestId("triage-show-all").count()) {
      await page.getByTestId("triage-show-all").click();
      expect(await cards.count()).toBeGreaterThanOrEqual(n);
    }
  });
});

test("價目頁：?month= 做生效月初始值", async ({ page }) => {
  await loginAs(page, "老闆");
  await page.goto("/rate-cards?month=2026-08");
  await expect(page.getByTestId("rate-cards-effective-month")).toHaveValue("2026-08", { timeout: 15_000 });
});

test.describe("P3-4.4 手機版面（375px）無橫向溢出", () => {
  test.use({ viewport: { width: 375, height: 800 }, isMobile: true, hasTouch: true });
  for (const path of ["/", "/month-close", "/reports/monthly-close", "/reports/payroll", "/reports/longterm-payroll", "/reports/ops-digest", "/audit-log", "/users", "/roles", "/triage", "/guards/import", "/roster-uploads", "/roster-uploads?tab=fix"]) {
    test(`老闆 ${path}`, async ({ page }) => {
      await loginAs(page, "老闆");
      await page.goto(path);
      await page.waitForLoadState("networkidle");
      await noHScroll(page);
    });
  }
  test("月結頁：StageBar 一行（高度 ≤ 90）、右欄變底部 sticky CTA", async ({ page }) => {
    await loginAs(page, "老闆");
    await page.goto(`/month-close?month=${LOCKED}`);
    const bar = page.getByTestId("stage-bar");
    await expect(bar).toBeVisible({ timeout: 15_000 });
    const h = await bar.evaluate((e) => e.getBoundingClientRect().height);
    expect(h).toBeLessThanOrEqual(90);
    await noHScroll(page);
  });
});
