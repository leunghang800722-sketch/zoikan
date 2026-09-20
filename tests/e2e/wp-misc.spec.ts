// WP-MISC（老闆 2026-09-20 拍板）Playwright e2e——QAS（基本保安訓練
// 證書）日期＋LINK（TKO Gateway 厚A/B/C）客戶直接出糧盤，喺真實 dev DB／
// 真實 UI 路徑驗證（同 staffno.spec.ts／pii.spec.ts 一樣嘅 pattern：
// `test.describe.configure({mode:"serial"})`，跑完清走測試值）。
//
// 執行前提：`PW_PORT=3000 npx playwright test tests/e2e/wp-misc.spec.ts`，
// dev DB 要已經 `npm run db:seed`（有 TKO Gateway 厚A/B/C 三個盤，
// `guards_paid_by_client=true`；有 staff_no="U…" 開頭嘅保安員）。
import { test, expect, type Page } from "@playwright/test";
import { loginAs } from "./helpers";
import { prisma, findSiteIdByName } from "./db-helpers";

test.describe.configure({ mode: "serial" });

async function findGuardWithUNumber() {
  const guard = await prisma.guard.findFirstOrThrow({
    where: { staffNo: { startsWith: "U" }, status: "active" },
    select: { id: true, nameZh: true, staffNo: true },
  });
  return guard as { id: string; nameZh: string; staffNo: string };
}

function fieldControl(page: Page, label: string) {
  return page.locator("label", { hasText: label }).first();
}

async function openEditByName(page: Page, name: string) {
  const main = page.locator("main");
  await expect(main.getByText("載入緊…")).toHaveCount(0, { timeout: 20_000 });
  const searchInput = page.getByPlaceholder("姓名 / 工號 / 電話");
  await searchInput.fill(name);
  const row = main.locator("table tbody tr", { hasText: name }).first();
  await expect(row).toBeVisible({ timeout: 20_000 });
  const detailResponse = page.waitForResponse((r) => /\/api\/guards\/[^/?]+$/.test(r.url()) && r.request().method() === "GET").catch(() => null);
  await row.getByRole("button", { name: "編輯" }).click();
  await expect(page.getByRole("heading", { name: "編輯保安員" })).toBeVisible({ timeout: 10_000 });
  await detailResponse;
}

test.afterAll(async () => {
  await prisma.$disconnect();
});

test("A：QAS 完成日期／到期日——編輯抽屜填寫、儲存、90 日內到期篩選揀到", async ({ page }) => {
  const guard = await findGuardWithUNumber();
  const soonExpiry = new Date(Date.now() + 20 * 86_400_000).toISOString().slice(0, 10);

  try {
    await loginAs(page, "老闆");
    await page.goto("/guards");
    await openEditByName(page, guard.nameZh);

    await expect(page.getByText("QAS 完成日期")).toBeVisible();
    await expect(page.getByText("QAS 到期日（如有）")).toBeVisible();

    await fieldControl(page, "QAS 完成日期").locator("input").fill("2024-01-15");
    await fieldControl(page, "QAS 到期日（如有）").locator("input").fill(soonExpiry);
    await page.getByRole("button", { name: "儲存" }).click();
    await expect(page.getByText("已更新")).toBeVisible({ timeout: 15_000 });

    // ---- 篩選「牌照／平安卡／QAS 90 日內到期」揀到呢個 guard ----
    // 呢個 checkbox 係列表 toolbar 入面淨一個（另外兩個 FilterChip 用
    // input type=text / month），直接揀第一個 checkbox 就得。
    await page.getByPlaceholder("姓名 / 工號 / 電話").fill("");
    await expect(page.getByText("牌照／平安卡／QAS 90 日內到期", { exact: true })).toBeVisible();
    await page.locator('input[type="checkbox"]').first().check();

    await page.getByPlaceholder("姓名 / 工號 / 電話").fill(guard.nameZh);
    const row = page.locator("main table tbody tr", { hasText: guard.nameZh }).first();
    await expect(row).toBeVisible({ timeout: 20_000 });

    // ---- DB 直接查證 ----
    const after = await prisma.guard.findUniqueOrThrow({ where: { id: guard.id }, select: { qasIssueDate: true, qasExpiryDate: true } });
    expect(after.qasIssueDate?.toISOString().slice(0, 10)).toBe("2024-01-15");
    expect(after.qasExpiryDate?.toISOString().slice(0, 10)).toBe(soonExpiry);
  } finally {
    await prisma.guard.update({ where: { id: guard.id }, data: { qasIssueDate: null, qasExpiryDate: null } });
  }
});

test("C：盤管理頁——LINK（TKO Gateway 厚A/B/C）列表 pill「客戶直接出糧」，相似名嘅盤唔中招", async ({ page }) => {
  await loginAs(page, "老闆");
  await page.goto("/sites");
  await expect(page.getByText("載入緊…")).toHaveCount(0, { timeout: 20_000 });

  // `hasText` 係 substring 比對——「TKO」會撞中「TKO Gateway 厚A」呢類
  // 名，所以用 `:text-is()`（第一欄盤名 exact match）先揀返準確嗰一行。
  function rowByExactSiteName(name: string) {
    return page.locator(`main table tbody tr:has(td:text-is("${name}"))`).first();
  }

  for (const name of ["TKO Gateway 厚A", "TKO Gateway 厚B", "TKO Gateway 厚C"]) {
    const row = rowByExactSiteName(name);
    await expect(row).toBeVisible({ timeout: 20_000 });
    await expect(row.getByText("客戶直接出糧")).toBeVisible();
  }

  // 相似但唔啱嘅盤名——唔應該中招（老闆原話明確列名呢三個，其他等確認）。
  for (const name of ["TKO SPOT 尚A", "TKO"]) {
    const row = rowByExactSiteName(name);
    await expect(row).toBeVisible({ timeout: 20_000 });
    await expect(row.getByText("客戶直接出糧")).toHaveCount(0);
  }

  // 編輯抽屜 checkbox 已剔選。
  const rowA = rowByExactSiteName("TKO Gateway 厚A");
  await rowA.getByRole("button", { name: "編輯" }).click();
  await expect(page.getByRole("heading", { name: "編輯盤" })).toBeVisible({ timeout: 10_000 });
  const checkbox = page.locator("label", { hasText: "客戶直接出糧" }).locator('input[type="checkbox"]');
  await expect(checkbox).toBeChecked();
});

test("C：更表編輯器——LINK 盤頂部 Notice 顯示，唔計「未定价」（就算 PR 更冇 snapshot）", async ({ page }) => {
  const siteId = await findSiteIdByName("TKO Gateway 厚A");

  // 月結鎖定與否都要見到呢個 Notice——用已鎖定嘅 2026-07（有真實 PR 記錄）。
  await loginAs(page, "老闆");
  await page.goto(`/roster/${siteId}/2026-07`);
  await expect(page.getByText("已鎖定")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("呢個盤嘅保安員由客戶直接出糧，我哋只收每月服務費")).toBeVisible();
  await expect(page.getByText(/未定价|未定價/)).toHaveCount(0);

  // API 層面雙重確認：呢個盤呢個月「未定价」統計係 0（就算 PR 更 snapshot 全 null）。
  const unpricedRes = await page.request.get(`/api/shift-records/unpriced?month=2026-07&site_id=${siteId}`);
  const unpricedBody = await unpricedRes.json();
  expect(unpricedBody.count).toBe(0);
});
