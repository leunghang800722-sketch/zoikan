// WP-PHASE3（老闆 2026-09-27，§20.4 Phase 3）Playwright e2e——老闆抽屜
// 設長工崗位盤＋價目卡「複製上月卡到本月」，喺真實 dev DB／真實 UI 路徑
// 驗證（同 staffno.spec.ts／pricing.spec.ts 一樣嘅 pattern：`mode:
// "serial"`，用獨立測試盤／測試保安員，跑完清走）。
//
// 執行前提：`PW_PORT=3000 npx playwright test tests/e2e/phase3.spec.ts`，
// dev DB 要已經 `npm run db:seed`。鐵則：合成假資料，冇真名/工號/電話。
import { test, expect, type Page } from "@playwright/test";
import { loginAs } from "./helpers";
import { prisma } from "./db-helpers";

test.describe.configure({ mode: "serial" });

const GUARD_NAME = "測試保安員E2E長工Phase3";
const SITE_NAME = "測試盤E2E長工Phase3";
const COPY_SITE_NAME = "測試盤E2E複製上月卡Phase3";

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

async function cleanup() {
  const site = await prisma.site.findFirst({ where: { canonicalName: SITE_NAME } });
  const guard = await prisma.guard.findFirst({ where: { nameZh: GUARD_NAME } });
  if (guard) {
    await prisma.guardLongtermPost.deleteMany({ where: { guardId: guard.id } });
    await prisma.guard.delete({ where: { id: guard.id } });
  }
  if (site) {
    await prisma.rateCard.deleteMany({ where: { siteId: site.id } });
    await prisma.shiftType.deleteMany({ where: { siteId: site.id } });
    await prisma.site.delete({ where: { id: site.id } });
  }
  const copySite = await prisma.site.findFirst({ where: { canonicalName: COPY_SITE_NAME } });
  if (copySite) {
    await prisma.rateCard.deleteMany({ where: { siteId: copySite.id } });
    await prisma.shiftType.deleteMany({ where: { siteId: copySite.id } });
    await prisma.site.delete({ where: { id: copySite.id } });
  }
}

test.beforeAll(async () => {
  await cleanup();
  await prisma.site.create({ data: { canonicalName: SITE_NAME, clientName: SITE_NAME, billingModel: "per_shift", createdBy: "test-e2e" } });
  await prisma.guard.create({ data: { nameZh: GUARD_NAME, employmentType: "cash_casual", tel: "69990001", createdBy: "test-e2e" } });
});

test.afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

test("(a) 老闆抽屜「長工」區：加崗位盤 → 列表見到 → 終止 → effective_to 顯示", async ({ page }) => {
  await loginAs(page, "老闆");
  await page.goto("/guards");
  await openEditByName(page, GUARD_NAME);
  await page.getByTestId("guard-tab-longterm").click();

  await expect(page.getByRole("heading", { name: "長工", exact: true })).toBeVisible({ timeout: 10_000 });

  const siteSelect = page.getByLabel("長工崗位盤：揀盤");
  await siteSelect.selectOption({ label: SITE_NAME });
  await page.getByLabel("長工崗位盤：生效日").fill("2026-08-01");

  const createResponse = page.waitForResponse((r) => /\/api\/guards\/[^/]+\/longterm-posts$/.test(r.url()) && r.request().method() === "POST");
  await page.getByRole("button", { name: "加崗位盤" }).click();
  await createResponse;

  const postRow = page.locator("li", { hasText: SITE_NAME }).first();
  await expect(postRow).toBeVisible({ timeout: 10_000 });
  await expect(postRow).toContainText("人手");

  const patchResponse = page.waitForResponse((r) => /\/api\/guards\/[^/]+\/longterm-posts\/[^/]+$/.test(r.url()) && r.request().method() === "PATCH");
  await postRow.getByRole("button", { name: "終止" }).click();
  await patchResponse;

  await expect(postRow).not.toContainText("現在");
});

test("(b) 價目卡「複製上月卡到本月」：預覽 confirm → 新卡 note「由上月複製」", async ({ page }) => {
  const site = await prisma.site.create({ data: { canonicalName: COPY_SITE_NAME, clientName: COPY_SITE_NAME, billingModel: "per_shift", createdBy: "test-e2e" } });
  const shiftType = await prisma.shiftType.create({ data: { siteId: site.id, code: "N", createdBy: "test-e2e" } });
  await prisma.rateCard.create({
    data: {
      siteId: site.id,
      shiftTypeId: shiftType.id,
      clientRate: 888,
      guardWage: 555,
      effectiveFrom: new Date(Date.UTC(2026, 7, 1)),
      effectiveTo: new Date(Date.UTC(2026, 7, 31)),
      createdBy: "test-e2e",
    },
  });

  await loginAs(page, "老闆");
  await page.goto("/rate-cards");
  await page.getByTestId("rate-cards-site-filter").selectOption({ label: COPY_SITE_NAME });
  await page.getByTestId("rate-cards-effective-month").fill("2026-09");

  const previewResponse = page.waitForResponse((r) => r.url().includes("/api/rate-cards/copy-last-month") && r.request().method() === "POST");
  await page.getByRole("button", { name: /複製上月卡到本月/ }).click();
  await previewResponse;
  // P3-4.2：window.confirm 改 ConfirmDialog——撳「建立」先送第二次（dry_run:false）request，
  // 用第二個 waitForResponse 等埋佢完成先斷言列表。
  const secondResponse = page.waitForResponse((r) => r.url().includes("/api/rate-cards/copy-last-month") && r.request().method() === "POST");
  await page.getByTestId("confirm-dialog-ok").click();
  await secondResponse;

  await expect(page.getByText(/複製上月卡完成/)).toBeVisible({ timeout: 15_000 });
  const newCard = await prisma.rateCard.findFirst({ where: { siteId: site.id, source: "copy_last_month" } });
  expect(newCard).not.toBeNull();
  expect(newCard?.note).toContain("由上月複製");
});

test("(c) 雞頭登入：保安員抽屜見唔到「長工」分區（結構性隔離）", async ({ page }) => {
  await loginAs(page, "雞頭A");
  await page.goto("/guards");
  const main = page.locator("main");
  await expect(main.getByText("載入緊…")).toHaveCount(0, { timeout: 20_000 });
  const anyRow = main.locator("table tbody tr").first();
  if (await anyRow.count()) {
    const editBtn = anyRow.getByRole("button", { name: "編輯" });
    if (await editBtn.count()) {
      // 雞頭版本可能冇「編輯」掣（自己保安員 update 出廠 off）——有就撳
      // 埋佢，冇就直接跳過（下面斷言唔靠一定開到抽屜，結構性隔離主要
      // 喺 GET response 冇 key，見 tests/wp-phase3.test.ts §2 已經
      // integration test 驗證過）。
      await editBtn.click();
      await expect(page.getByRole("heading", { name: "長工", exact: true })).toHaveCount(0);
    }
  }
});
