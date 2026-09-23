// WP-ROSTER-UPLOAD Phase A（§15.3）Playwright e2e——老闆上載合成 xlsx
// （exceljs 即場生成，唔寫落 disk）→ 見狀態＋rows；雞頭 403。
//
// 執行前提：`PW_PORT=3000 npx playwright test tests/e2e/roster-upload.spec.ts`，
// dev DB 要已經 `npm run db:seed`。鐵則：呢個檔案本身唔可以有真名／
// 工號／電話字面——盤名（業務名，唔係個人資料）同真實安員資料一律用
// `findSiteIdByName()`／`prisma` 喺 runtime 查，唔寫死落 source。
import { test, expect } from "@playwright/test";
import ExcelJS from "exceljs";
import { loginAs } from "./helpers";
import { prisma, findSiteIdByName } from "./db-helpers";

test.describe.configure({ mode: "serial" });

const TEST_MONTH = "2026-08";

async function findGuardWithUNumber() {
  const guard = await prisma.guard.findFirstOrThrow({
    where: { staffNo: { startsWith: "U" }, status: "active" },
    select: { id: true, nameZh: true, staffNo: true, tel: true },
  });
  return guard as { id: string; nameZh: string; staffNo: string; tel: string | null };
}

async function buildSyntheticRosterXlsx(siteName: string, staffNo: string, name: string, tel: string): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("2026");
  ws.getCell("A2").value = siteName;
  ws.getCell("F4").value = "Date";
  ws.getCell("G4").value = new Date(Date.UTC(2026, 7, 1));
  ws.getCell("H4").value = new Date(Date.UTC(2026, 7, 2));
  ws.getCell("A5").value = "Broker";
  ws.getCell("B5").value = "Time";
  ws.getCell("C5").value = "Rank";
  ws.getCell("D5").value = "Staff No.";
  ws.getCell("E5").value = "Tel";
  ws.getCell("F5").value = "Name";
  ws.getCell("B6").value = "1900-0700";
  ws.getCell("C6").value = "夜更保安員";
  ws.getCell("D6").value = staffNo;
  ws.getCell("E6").value = tel ?? "";
  ws.getCell("F6").value = name;
  ws.getCell("G6").value = "N";
  ws.getCell("H6").value = "N";
  return Buffer.from(await wb.xlsx.writeBuffer());
}

test.afterAll(async () => {
  await prisma.$disconnect();
});

test("老闆上載合成更表 xlsx → 見盤狀態＋rows，安員配對到現有工號", async ({ page }) => {
  const siteId = await findSiteIdByName("殷樺花園");
  const guard = await findGuardWithUNumber();
  const buffer = await buildSyntheticRosterXlsx("殷樺花園", guard.staffNo, guard.nameZh, guard.tel ?? "6100000");

  try {
    await loginAs(page, "老闆");
    await page.goto(`/roster-uploads?month=${TEST_MONTH}`);
    await expect(page.getByRole("heading", { name: "更表上載" })).toBeVisible();

    await page.locator('input[type="month"]').fill(TEST_MONTH);

    const fileInput = page.getByTestId("roster-upload-file-input");
    const uploadResponse = page.waitForResponse((r) => r.url().includes("/api/roster-uploads") && r.request().method() === "POST");
    await fileInput.setInputFiles({ name: "test-roster.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer });
    const res = await uploadResponse;
    expect(res.status()).toBe(201);

    // 逐盤狀態表——呢個盤而家應該顯示「已上載」。
    const row = page.locator("table tbody tr", { hasText: "殷樺花園" }).first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row.getByText("已上載")).toBeVisible();
    await expect(row.getByText("v1")).toBeVisible();

    // 撳「睇詳情」→ rows 表見到今次上載嘅兩格（N/N），安員配對到工號。
    await row.getByRole("button", { name: "睇詳情" }).click();
    await expect(page.getByText("工號配對").first()).toBeVisible({ timeout: 15_000 });
    const dataRows = page.locator("table tbody tr", { hasText: "工號配對" });
    await expect(dataRows).toHaveCount(2);
  } finally {
    // 清走測試上載嘅記錄，等呢個 spec 可以重跑（同盤同月幂等）。
    await prisma.rosterUploadRow.deleteMany({ where: { upload: { siteId, month: new Date(Date.UTC(2026, 7, 1)), fileName: "test-roster.xlsx" } } });
    await prisma.rosterUpload.deleteMany({ where: { siteId, month: new Date(Date.UTC(2026, 7, 1)), fileName: "test-roster.xlsx" } });
  }
});

test("雞頭：更表上載硬性 403（連導航都見唔到條連結）", async ({ page }) => {
  await loginAs(page, "雞頭A");
  await expect(page.getByRole("link", { name: "更表上載" })).toHaveCount(0);

  await page.goto(`/roster-uploads?month=${TEST_MONTH}`);
  await expect(page.getByText(/硬性禁止|冇權限|forbidden/i)).toBeVisible({ timeout: 15_000 });
});

// Opus 驗收（2026-09-23）補測：手機闊度（375px）——會計上載一個盤名對唔到
// 嘅檔，卡列表要見到「盤名未配對」＋「指定盤」下拉（之前手機版冇呢個
// 下拉，對唔到嘅上載喺手機完全處理唔到）；頁面唔可以橫向捲動；詳情見到
// 「已載入 N／共 T 格」。
test("會計（手機 375px）：上載盤名對唔到嘅檔 → 卡列表可以指定盤，冇橫向捲動", async ({ page }) => {
  const guard = await findGuardWithUNumber();
  const buffer = await buildSyntheticRosterXlsx("驗收測試對唔到嘅盤名", guard.staffNo, guard.nameZh, guard.tel ?? "6100000");
  const fileName = "test-roster-mobile.xlsx";
  await page.setViewportSize({ width: 375, height: 812 });
  try {
    await loginAs(page, "會計");
    await page.goto(`/roster-uploads?month=${TEST_MONTH}`);
    await page.locator('input[type="month"]').fill(TEST_MONTH);
    const uploadResponse = page.waitForResponse((r) => r.url().includes("/api/roster-uploads") && r.request().method() === "POST");
    await page.getByTestId("roster-upload-file-input").setInputFiles({ name: fileName, mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer });
    expect((await uploadResponse).status()).toBe(201);

    const card = page.locator("div.sm\\:hidden > div", { hasText: "驗收測試對唔到嘅盤名" }).first();
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(card.getByText("（盤名未配對）")).toBeVisible();
    await expect(card.getByRole("combobox", { name: "指定盤" })).toBeVisible();
    await expect(page.getByTestId("roster-upload-rows-count")).toContainText("共 2 格", { timeout: 15_000 });

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  } finally {
    await prisma.rosterUpload.deleteMany({ where: { month: new Date(Date.UTC(2026, 7, 1)), fileName } });
  }
});

// Phase B-0 第 5(b) 項（老闆 2026-09-23 追加答）：更新檔嘅檔名要同該盤同月
// 現有版本唔同——同名一律 400，錯誤訊息「更新檔嘅檔名必須同舊版唔同，
// 請改檔名再上載」要喺前端見到；改個檔名先成功開 v2。
test("老闆：同盤同月上載同名檔 → 400 提示改檔名；改個名先成功開 v2", async ({ page }) => {
  const siteId = await findSiteIdByName("皓日");
  const guard = await findGuardWithUNumber();
  const fileNameSame = "test-roster-dup.xlsx";
  const fileNameV2 = "test-roster-dup-v2.xlsx";
  const buffer1 = await buildSyntheticRosterXlsx("皓日", guard.staffNo, guard.nameZh, guard.tel ?? "6100000");
  const buffer2 = await buildSyntheticRosterXlsx("皓日", guard.staffNo, guard.nameZh, guard.tel ?? "6100000");

  try {
    await loginAs(page, "老闆");
    await page.goto(`/roster-uploads?month=${TEST_MONTH}`);
    await page.locator('input[type="month"]').fill(TEST_MONTH);

    const uploadResponse1 = page.waitForResponse((r) => r.url().includes("/api/roster-uploads") && r.request().method() === "POST");
    await page.getByTestId("roster-upload-file-input").setInputFiles({ name: fileNameSame, mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: buffer1 });
    expect((await uploadResponse1).status()).toBe(201);

    // 第二次用返一樣嘅檔名（同盤同月）→ 400，錯誤訊息喺前端顯示。
    const uploadResponse2 = page.waitForResponse((r) => r.url().includes("/api/roster-uploads") && r.request().method() === "POST");
    await page.getByTestId("roster-upload-file-input").setInputFiles({ name: fileNameSame, mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: buffer2 });
    expect((await uploadResponse2).status()).toBe(400);
    await expect(page.getByText("更新檔嘅檔名必須同舊版唔同")).toBeVisible({ timeout: 15_000 });

    // 改個檔名先成功——version 變 v2。
    const uploadResponse3 = page.waitForResponse((r) => r.url().includes("/api/roster-uploads") && r.request().method() === "POST");
    await page.getByTestId("roster-upload-file-input").setInputFiles({ name: fileNameV2, mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: buffer2 });
    expect((await uploadResponse3).status()).toBe(201);
    const row = page.locator("table tbody tr", { hasText: "皓日" }).first();
    await expect(row.getByText("v2")).toBeVisible({ timeout: 15_000 });
  } finally {
    await prisma.rosterUploadRow.deleteMany({ where: { upload: { siteId, month: new Date(Date.UTC(2026, 7, 1)) } } });
    await prisma.rosterUpload.deleteMany({ where: { siteId, month: new Date(Date.UTC(2026, 7, 1)) } });
  }
});
