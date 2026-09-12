// P1-WP4 Playwright e2e（P1-執行計劃.md §4 WP4 item 7）。用現成 seed 數據
// （見 tests/e2e/db-helpers.ts）。斷言唔寫真名——全部用 DB 查出嚟嘅
// id/代號比對（PDPO）。月結鎖定流程用一個專用嘅新月份（2026-10，
// 由 months/open 開，唔會撞其他 e2e spec 用緊嘅 2026-08，亦唔會掂真實
// 7 月數據），流程尾聲解返鎖，留低乾淨狀態俾下次重跑。
import { test, expect } from "@playwright/test";
import { loginAs } from "./helpers";
import { prisma } from "./db-helpers";

test.describe.configure({ mode: "serial" });

const LOCK_TEST_MONTH = "2026-10";

test("(a) 老闆登入 → 毛利即時表切去 7 月 → 展開一個盤見到更別明細", async ({ page }) => {
  await loginAs(page, "老闆");
  await page.goto("/reports/gross-margin");
  await page.locator('input[type="month"]').fill("2026-07");
  // 隨便揀一個一定有活動嘅盤（啟航1331）展開，見到更別 breakdown 出現。
  const siteRow = page.getByText("啟航1331", { exact: false }).first();
  await expect(siteRow).toBeVisible({ timeout: 20_000 });
  await siteRow.click();
  await expect(page.locator("table tbody tr").first()).toBeVisible();
});

test("(b) 老闆：開新月份 → 月結工作台 Generate → 睇對數結果 → 鎖定 → 改更表被擋 → 解鎖", async ({ page }) => {
  await loginAs(page, "老闆");

  // 開新月份（months/open 冇對應 UI 掣，屬於盤管理/roster 流程嘅後台
  // 步驟，呢度直接用瀏覽器已登入嘅 session 打 API 做前置 setup，同
  // db-helpers.ts 嘅角色一致——唔係應用程式本身嘅一部分）。
  const openRes = await page.request.post(`/api/months/${LOCK_TEST_MONTH}/open`, { data: { roster_version_note: "e2e wp4" } });
  expect([200, 201, 409]).toContain(openRes.status()); // 409 = 已經開過（重跑）

  await page.goto("/reports/monthly-close");
  await page.locator('input[type="month"]').fill(LOCK_TEST_MONTH);
  await page.getByRole("button", { name: "Generate" }).click();

  await expect(page.getByText("§6.3 五條自動對數規則")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/現金糧批次總額/).first()).toBeVisible();
  await expect(page.getByText(/未啟用/).first()).toBeVisible(); // 規則4 P3 未做

  const lockBtn = page.getByRole("button", { name: "鎖定" });
  await expect(lockBtn).toBeEnabled({ timeout: 10_000 });
  await lockBtn.click();
  await expect(page.getByText("已鎖定").first()).toBeVisible({ timeout: 15_000 });

  // 鎖定之後試喺更表編輯器改呢個月嘅格——應該被擋（RosterEditor.tsx
  // 見到 monthClose.locked_at 就顯示鎖定提示，唔會俾人再改格）。
  const site = await prisma.site.findFirstOrThrow({ where: { status: "active" } });
  await page.goto(`/roster/${site.id}/${LOCK_TEST_MONTH}`);
  await expect(page.getByText(/鎖定/).first()).toBeVisible({ timeout: 20_000 });

  // 解鎖
  await page.goto("/reports/monthly-close");
  await page.locator('input[type="month"]').fill(LOCK_TEST_MONTH);
  await page.getByRole("button", { name: "Generate" }).click();
  await expect(page.getByText("已鎖定").first()).toBeVisible({ timeout: 15_000 });
  await page.locator('input[placeholder="解鎖原因"]').fill("e2e wp4 測試完畢解鎖");
  await page.getByRole("button", { name: "解鎖" }).click();
  await expect(page.getByText("未鎖定").first()).toBeVisible({ timeout: 15_000 });
});

test("(c) 雞頭登入 → 本月應收 → 見到自己 7 月嘅更數同金額", async ({ page }) => {
  await loginAs(page, "雞頭A");
  await page.goto("/my-receivable");
  await page.locator('input[type="month"]').fill("2026-07");
  await expect(page.getByText(/合計/).first()).toBeVisible({ timeout: 20_000 });
  // 表格應該有至少一行（代號 K 雞頭 7 月一定有出更）。
  await expect(page.locator("table tbody tr").first()).toBeVisible({ timeout: 20_000 });
});

test.afterAll(async () => {
  await prisma.$disconnect();
});
