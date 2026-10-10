// P3 階段 3（導覽列＋頁面架構）e2e：NAV_SCHEMA 導覽、共用月份選擇器、報表 tab、首頁待辦收件箱、
// 舊路徑 redirect、保安員「新增 ▾」、雞頭銀行兩格、保安員角色說明頁。
// 全部用 seed 假數據；銀行值只用假值並於測試後還原（PII 規則）。截圖只喺設咗 E2E_SHOT_DIR 先存（唔入 repo）。
import { test, expect, type Page } from "@playwright/test";
import { Prisma } from "@prisma/client";
import { loginAs } from "./helpers";
import { prisma } from "./db-helpers";

const SHOT = process.env.E2E_SHOT_DIR;
async function shot(page: Page, name: string) {
  if (SHOT) await page.screenshot({ path: `${SHOT}/${name}` });
}

const navLinks = (page: Page) => page.locator('aside [data-testid^="nav-/"]');

test.describe("導覽列（桌面 1512×700）", () => {
  test.use({ viewport: { width: 1512, height: 700 } });

  test("老闆：17 條、6 組、唔使捲（nav scrollHeight ≤ clientHeight）", async ({ page }) => {
    await loginAs(page, "老闆");
    await page.goto("/");
    await expect(navLinks(page)).toHaveCount(17);
    // 組標題：排更／對數／月結／資料／設定（首頁冇標題）
    const aside = page.locator("aside");
    for (const t of ["排更", "對數", "月結", "資料", "設定"]) await expect(aside.getByText(t, { exact: true })).toBeVisible();
    const m = await page.locator("aside nav").evaluate((el) => ({ sh: el.scrollHeight, ch: el.clientHeight }));
    expect(m.sh).toBeLessThanOrEqual(m.ch);
    await shot(page, "nav-boss-1512x700.png");
    // 已移除嘅舊連結
    for (const h of ["/reports/shortfall", "/guard-fix", "/guards/import", "/reports/gross-margin", "/reports/payroll", "/reports/ops-digest", "/reports/longterm-payroll"]) {
      await expect(page.locator(`aside [data-testid="nav-${h}"]`)).toHaveCount(0);
    }
  });

  for (const [who, n] of [["主管", 11], ["會計", 11], ["雞頭A", 6]] as const) {
    test(`${who}：${n} 條`, async ({ page }) => {
      await loginAs(page, who);
      await page.goto("/");
      await expect(navLinks(page)).toHaveCount(n);
      await shot(page, `nav-${who}-1512x700.png`);
    });
  }

  test("雞頭：3 組（首頁／排更／我的），冇「雞頭」連結", async ({ page }) => {
    await loginAs(page, "雞頭A");
    await page.goto("/");
    const aside = page.locator("aside");
    await expect(aside.getByText("排更", { exact: true })).toBeVisible();
    await expect(aside.getByText("我的", { exact: true })).toBeVisible();
    await expect(aside.getByText("其他", { exact: true })).toHaveCount(0);
    await expect(page.locator('aside [data-testid="nav-/brokers"]')).toHaveCount(0);
    await expect(page.locator('aside [data-testid="nav-/guards"]')).toHaveText("我的保安員");
  });

  test("保安員：只有首頁，見說明頁（改密碼／登出）", async ({ page }) => {
    await loginAs(page, "安員");
    await page.goto("/");
    await expect(navLinks(page)).toHaveCount(1);
    const landing = page.getByTestId("guard-landing");
    await expect(landing).toContainText("系統功能稍後開放");
    await expect(landing.getByRole("link", { name: "改密碼" })).toBeVisible();
    await expect(landing.getByRole("button", { name: "登出" })).toBeVisible();
    await shot(page, "nav-guard-landing.png");
  });
});

test.describe("手機導覽（375）", () => {
  test.use({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });
  test("老闆：抽屜 17 條連結＋組標題", async ({ page }) => {
    await loginAs(page, "老闆");
    await page.goto("/");
    await page.getByTestId("mobile-nav-hamburger").click();
    const drawer = page.getByTestId("mobile-nav-drawer");
    await expect(drawer.locator('[data-testid^="mnav-/"]')).toHaveCount(17);
    await shot(page, "nav-boss-mobile-375.png");
  });
});

test.describe("共用月份選擇器＋報表 tab", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("揀 2026-07 → URL＋sessionStorage 同步；換報表 tab、換去更表上載，月份跟住", async ({ page }) => {
    await loginAs(page, "老闆");
    await page.goto("/reports/payroll");
    await expect(page.getByTestId("report-tabs")).toBeVisible();
    await page.locator('input[type="month"]').fill("2026-07");
    await expect.poll(() => page.evaluate(() => sessionStorage.getItem("zk.month"))).toBe("2026-07");
    await expect.poll(() => new URL(page.url()).searchParams.get("month")).toBe("2026-07");

    await page.getByTestId("report-tab-gross-margin").click();
    await page.waitForURL(/\/reports\/gross-margin/);
    await expect(page.locator('input[type="month"]')).toHaveValue("2026-07");
    await expect(page.getByTestId("report-tab-gross-margin")).toHaveAttribute("aria-current", "page");

    // 用導覽去另一頁（冇 ?month=），由 sessionStorage 還原
    await page.locator('aside [data-testid="nav-/roster-uploads"]').click();
    await page.waitForURL(/\/roster-uploads/);
    await expect(page.locator('input[type="month"]').first()).toHaveValue("2026-07");
    await expect.poll(() => new URL(page.url()).searchParams.get("month")).toBe("2026-07");
  });

  test("報表五個 tab 全部可去，kicker「月結 › 報表」", async ({ page }) => {
    await loginAs(page, "老闆");
    await page.goto("/reports/monthly-close");
    const tabs = page.getByTestId("report-tabs");
    await expect(tabs.getByRole("link")).toHaveCount(5);
    for (const [slug, text] of [["payroll", "糧明細"], ["longterm-payroll", "長工糧"], ["ops-digest", "修正摘要"], ["gross-margin", "毛利"], ["monthly-close", "月結總表"]] as const) {
      await tabs.getByTestId(`report-tab-${slug}`).click();
      await page.waitForURL(new RegExp(`/reports/${slug}`));
      await expect(page.getByText("月結 › 報表").first()).toBeVisible();
      await expect(tabs.getByTestId(`report-tab-${slug}`)).toHaveText(text);
    }
    await shot(page, "report-tabs.png");
  });

  test("月結總表頁：冇鎖定掣，有去一鍵結算連結；更多 ▾ 有匯出／介紹費", async ({ page }) => {
    await loginAs(page, "老闆");
    await page.goto("/reports/monthly-close?month=2026-07");
    await expect(page.getByTestId("recon-rules-title")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("button", { name: /^鎖定|^解鎖/ })).toHaveCount(0);
    await expect(page.getByTestId("goto-month-close")).toBeVisible();
    await page.getByTestId("more-menu").click();
    await expect(page.getByRole("menuitem", { name: "匯出 Excel" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "重算介紹費" })).toBeVisible();
  });
});

test.describe("首頁待辦收件箱＋舊路徑 redirect", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("老闆首頁：待辦卡齊（單位更／題／盤），待審批數同 API 一致", async ({ page }) => {
    await loginAs(page, "老闆");
    await page.goto("/");
    const inbox = page.getByTestId("home-inbox");
    await expect(inbox).toBeVisible({ timeout: 20_000 });
    for (const id of ["inbox-approvals", "inbox-triage", "inbox-unreconciled", "inbox-month-close"]) await expect(inbox.getByTestId(id)).toBeVisible();
    const res = await page.request.get("/api/reports/shortfall?date=2026-07-15&include_margin=0");
    const body = (await res.json()) as { pending_approval_total: number };
    await expect(inbox.getByTestId("inbox-approvals")).toContainText(`${body.pending_approval_total}`);
    await expect(inbox.getByTestId("inbox-approvals")).toContainText("更");
    await expect(inbox.getByTestId("inbox-triage")).toContainText("題");
    await shot(page, "home-inbox.png");
  });

  test("主管首頁：只有有權限嗰啲格（冇「要老闆決定」）", async ({ page }) => {
    await loginAs(page, "主管");
    await page.goto("/");
    const inbox = page.getByTestId("home-inbox");
    await expect(inbox).toBeVisible({ timeout: 20_000 });
    await expect(inbox.getByTestId("inbox-needs-boss")).toHaveCount(0);
  });

  test("/reports/shortfall → /；/guard-fix → /roster-uploads?tab=fix（導覽 active 跟住）", async ({ page }) => {
    await loginAs(page, "老闆");
    await page.goto("/reports/shortfall?date=2026-07-15");
    await page.waitForURL((u) => u.pathname === "/");
    expect(new URL(page.url()).searchParams.get("date")).toBe("2026-07-15");

    await page.goto("/guard-fix");
    await page.waitForURL(/\/roster-uploads\?tab=fix/);
    await expect(page.getByTestId("roster-uploads-tab-fix")).toHaveAttribute("aria-selected", "true");
    await expect(page.locator('aside [data-testid="nav-/roster-uploads?tab=fix"]')).toHaveClass(/font-semibold/);
    await expect(page.locator('aside [data-testid="nav-/roster-uploads"]')).not.toHaveClass(/font-semibold/);
    // 切返「上載與對數」tab
    await page.getByTestId("roster-uploads-tab-upload").click();
    await expect(page.getByTestId("roster-uploads-upload-tab")).toBeVisible();
  });

  test("主管 /roster-uploads：冇修復 tab", async ({ page }) => {
    await loginAs(page, "主管");
    await page.goto("/roster-uploads?tab=fix");
    await expect(page.getByTestId("roster-uploads-tabs")).toHaveCount(0);
    await expect(page.getByTestId("roster-uploads-upload-tab")).toBeVisible();
  });
});

test.describe("資料頁", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("保安員「新增 ▾」：手動新增開 Drawer；批量導入去 /guards/import，有「返回保安員」", async ({ page }) => {
    await loginAs(page, "老闆");
    await page.goto("/guards");
    await page.getByTestId("guards-add-menu").click();
    await expect(page.getByTestId("guards-add-manual")).toBeVisible();
    await page.getByTestId("guards-add-manual").click();
    await expect(page.getByRole("heading", { name: /新增保安員/ })).toBeVisible();
    await page.keyboard.press("Escape");

    await page.goto("/guards");
    await page.getByTestId("guards-add-menu").click();
    await page.getByTestId("guards-add-import").click();
    await page.waitForURL(/\/guards\/import/);
    await page.getByTestId("back-to-guards").click();
    await page.waitForURL((u) => u.pathname === "/guards");
  });

  test("雞頭 Drawer：銀行名＋戶口號碼兩格，存返 bank_info（假值，測試後還原）", async ({ page }) => {
    const broker = await prisma.broker.findFirstOrThrow({ where: { isInternal: false, status: "active" }, orderBy: { code: "asc" } });
    const original = broker.bankInfo;
    try {
      await loginAs(page, "老闆");
      await page.goto("/brokers");
      const row = page.locator("main table tbody tr", { hasText: broker.code }).first();
      await expect(row).toBeVisible({ timeout: 20_000 });
      await row.getByRole("button", { name: "編輯" }).click();
      await expect(page.getByTestId("broker-bank-name")).toBeVisible();
      await expect(page.locator("textarea")).toHaveCount(0);
      await page.getByTestId("broker-bank-name").fill("測試銀行（假）");
      await page.getByTestId("broker-bank-account").fill("000-000000-000");
      await page.getByRole("button", { name: /^儲存/ }).click();
      await expect(page.getByText(/已更新|已儲存/).first()).toBeVisible({ timeout: 15_000 });
      const after = await prisma.broker.findUniqueOrThrow({ where: { id: broker.id } });
      const info = after.bankInfo as Record<string, unknown>;
      expect(info.bank_name).toBe("測試銀行（假）");
      expect(info.account_no).toBe("000-000000-000");
    } finally {
      await prisma.broker.update({ where: { id: broker.id }, data: { bankInfo: original === null ? Prisma.DbNull : (original as object) } });
    }
  });
});

test.afterAll(async () => {
  await prisma.$disconnect();
});
