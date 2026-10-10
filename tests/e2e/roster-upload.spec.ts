// WP-ROSTER-UPLOAD Phase A（§15.3）Playwright e2e——老闆上載合成 xlsx
// （exceljs 即場生成，唔寫落 disk）→ 見狀態＋rows；雞頭 403。
//
// 執行前提：`PW_PORT=3000 npx playwright test tests/e2e/roster-upload.spec.ts`，
// dev DB 要已經 `npm run db:seed`。鐵則：呢個檔案本身唔可以有真名／
// 工號／電話字面——盤名（業務名，唔係個人資料）同真實保安員資料一律用
// `findSiteIdByName()`／`prisma` 喺 runtime 查，唔寫死落 source。
import { test, expect } from "@playwright/test";
import ExcelJS from "exceljs";
import { loginAs } from "./helpers";
import { prisma, findSiteIdByName, TEST_TEL } from "./db-helpers";

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

test("老闆上載合成更表 xlsx → 見盤狀態＋rows，保安員配對到現有工號", async ({ page }) => {
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

    // 撳「睇詳情」→ rows 表見到今次上載嘅兩格（N/N），保安員配對到工號。
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

// -----------------------------------------------------------------------
// WP-UPLOAD-VOID（老闆 2026-09-25 要求）：正式站揀錯月份（09 月）上載咗
// 8 月更表，之前 UI 完全冇刪除／撤銷。作廢＋正確月份再上載同名檔。
// -----------------------------------------------------------------------
test("老闆：上載去錯月份 → 作廢 → 正確月份再上載同名檔成功", async ({ page }) => {
  const siteId = await findSiteIdByName("都會大學學生宿舍");
  const guard = await findGuardWithUNumber();
  const wrongMonth = "2026-09";
  const fileName = "test-roster-void.xlsx";
  const buffer = await buildSyntheticRosterXlsx("都會大學學生宿舍", guard.staffNo, guard.nameZh, guard.tel ?? "6100000");

  try {
    await loginAs(page, "老闆");

    // 揀錯月份（老闆情境：想上載 8 月更表，手快手震揀咗 09 月）上載。
    await page.goto(`/roster-uploads?month=${wrongMonth}`);
    await page.locator('input[type="month"]').fill(wrongMonth);
    const uploadResponse = page.waitForResponse((r) => r.url().includes("/api/roster-uploads") && r.request().method() === "POST");
    await page.getByTestId("roster-upload-file-input").setInputFiles({ name: fileName, mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer });
    expect((await uploadResponse).status()).toBe(201);

    const row = page.locator("table tbody tr", { hasText: "都會大學學生宿舍" }).first();
    await expect(row.getByText("已上載")).toBeVisible({ timeout: 15_000 });

    // 作廢——強制填原因先可以確認。
    await row.getByRole("button", { name: "作廢" }).click();
    await row.getByPlaceholder("填原因先可以確認").fill("揀錯月份，應該係 8 月更表");
    const voidResponse = page.waitForResponse((r) => r.url().includes("/void") && r.request().method() === "POST");
    await row.getByRole("button", { name: "確認作廢" }).click();
    expect((await voidResponse).status()).toBe(200);

    // 作廢之後：9 月呢個盤變返「未上載」（唔會再顯示「已上載」）。
    await expect(row.getByText("未上載")).toBeVisible({ timeout: 15_000 });

    // 「顯示已作廢」開關開返嚟——見到灰色行（版本、原因）。
    await page.getByText("顯示已作廢").click();
    await expect(page.getByText("已作廢記錄")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("揀錯月份，應該係 8 月更表").first()).toBeVisible();

    // 正確月份（8 月）再上載同一個檔名——冇撞名問題（唔同（盤,月）組別），成功。
    await page.locator('input[type="month"]').fill(TEST_MONTH);
    const uploadResponse2 = page.waitForResponse((r) => r.url().includes("/api/roster-uploads") && r.request().method() === "POST");
    await page.getByTestId("roster-upload-file-input").setInputFiles({ name: fileName, mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer });
    expect((await uploadResponse2).status()).toBe(201);
    const correctRow = page.locator("table tbody tr", { hasText: "都會大學學生宿舍" }).first();
    await expect(correctRow.getByText("已上載")).toBeVisible({ timeout: 15_000 });
  } finally {
    await prisma.rosterUploadRow.deleteMany({ where: { upload: { siteId } } });
    await prisma.rosterUpload.deleteMany({ where: { siteId } });
  }
});

// -----------------------------------------------------------------------
// WP-UPLOAD-VOID（老闆 2026-09-25 追加要求）：多檔拖放／多選上載——一次
// 拖 3 個合成 xlsx（1 個正常、1 個同名檔 400、1 個盤對唔到）→ 三行各自
// 狀態啱、列表刷新、總結數目啱。
// -----------------------------------------------------------------------
test("老闆：一次過拖 3 個檔——1 成功／1 同名 400／1 盤對唔到，隊列逐行狀態啱＋總結數啱", async ({ page }) => {
  const guard = await findGuardWithUNumber();
  const normalSiteId = await findSiteIdByName("葵發大廈");
  const dupSiteId = await findSiteIdByName("恆星樓");
  const dupFileName = "test-roster-batch-dup.xlsx";
  const owner = await prisma.user.findUniqueOrThrow({ where: { tel: TEST_TEL["老闆"] }, select: { id: true } });

  // 前置：「恆星樓」8 月已經有一個叫呢個名嘅上載——隊列入面第二個同名檔
  // 會撞 400（同 §14 撞名邏輯一致，唔係 WP-UPLOAD-VOID 新增，淨係俾隊列
  // 有一個真實 400 場景測）。
  await prisma.rosterUploadRow.deleteMany({ where: { upload: { siteId: dupSiteId, month: new Date(Date.UTC(2026, 7, 1)) } } });
  await prisma.rosterUpload.deleteMany({ where: { siteId: dupSiteId, month: new Date(Date.UTC(2026, 7, 1)) } });
  const preexisting = await prisma.rosterUpload.create({
    data: {
      month: new Date(Date.UTC(2026, 7, 1)),
      siteId: dupSiteId,
      siteNameRaw: "恆星樓",
      uploaderUserId: owner.id,
      fileName: dupFileName,
      fileSha256: "b".repeat(64),
      fileBytes: Buffer.from("x"),
      fileSize: 1,
      status: "parsed",
      createdBy: "e2e:roster-upload-batch",
    },
  });

  const bufferNormal = await buildSyntheticRosterXlsx("葵發大廈", guard.staffNo, guard.nameZh, guard.tel ?? "6100000");
  const bufferDup = await buildSyntheticRosterXlsx("恆星樓", guard.staffNo, guard.nameZh, guard.tel ?? "6100000");
  const bufferUnresolved = await buildSyntheticRosterXlsx("驗收測試多檔冇盤", guard.staffNo, guard.nameZh, guard.tel ?? "6100000");

  try {
    await loginAs(page, "老闆");
    await page.goto(`/roster-uploads?month=${TEST_MONTH}`);
    await page.locator('input[type="month"]').fill(TEST_MONTH);

    // 一次過揀 3 個檔（`<input multiple>`）——一個 change event 帶齊 3 個。
    await page.getByTestId("roster-upload-file-input").setInputFiles([
      { name: "test-roster-batch-normal.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: bufferNormal },
      { name: dupFileName, mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: bufferDup },
      { name: "test-roster-batch-unresolved.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: bufferUnresolved },
    ]);

    const queue = page.getByTestId("roster-upload-queue");
    await expect(queue).toBeVisible({ timeout: 15_000 });

    const normalRow = queue.locator("div", { hasText: "test-roster-batch-normal.xlsx" }).first();
    await expect(normalRow.getByText("成功")).toBeVisible({ timeout: 20_000 });

    const dupRow = queue.locator("div", { hasText: dupFileName }).first();
    await expect(dupRow.getByText("失敗")).toBeVisible({ timeout: 20_000 });
    await expect(dupRow.getByText(/更新檔嘅檔名必須同舊版唔同/)).toBeVisible();

    const unresolvedRow = queue.locator("div", { hasText: "test-roster-batch-unresolved.xlsx" }).first();
    await expect(unresolvedRow.getByText("盤對唔到")).toBeVisible({ timeout: 20_000 });
    await expect(unresolvedRow.getByRole("combobox", { name: "指定盤" })).toBeVisible();

    // 全部跑完先出總結——成功 1／失敗 1／要指定盤 1。
    const summary = page.getByTestId("roster-upload-queue-summary");
    await expect(summary).toBeVisible({ timeout: 20_000 });
    await expect(summary).toContainText("成功 1");
    await expect(summary).toContainText("失敗 1");
    await expect(summary).toContainText("要指定盤 1");

    // 列表刷新咗——正常嗰個盤而家顯示「已上載」。
    const normalListRow = page.locator("table tbody tr", { hasText: "葵發大廈" }).first();
    await expect(normalListRow.getByText("已上載")).toBeVisible({ timeout: 15_000 });
  } finally {
    await prisma.rosterUploadRow.deleteMany({ where: { upload: { siteId: normalSiteId, month: new Date(Date.UTC(2026, 7, 1)) } } });
    await prisma.rosterUpload.deleteMany({ where: { siteId: normalSiteId, month: new Date(Date.UTC(2026, 7, 1)) } });
    await prisma.rosterUploadRow.deleteMany({ where: { uploadId: preexisting.id } });
    await prisma.rosterUpload.deleteMany({ where: { siteId: dupSiteId, month: new Date(Date.UTC(2026, 7, 1)) } });
    await prisma.rosterUploadRow.deleteMany({ where: { upload: { siteId: null, siteNameRaw: "驗收測試多檔冇盤" } } });
    await prisma.rosterUpload.deleteMany({ where: { siteId: null, siteNameRaw: "驗收測試多檔冇盤" } });
  }
});

// -----------------------------------------------------------------------
// Opus 5.5 驗收補測：多檔隊列——(1) 並發（跨批次）最多 2 個 request 在途
// （攔截 POST 人為延遲，記錄同時在途最高數）；(2) 取消未開始嘅檔（唔會
// 送出）；(3) 「盤對唔到」行嘅「指定盤」下拉揀咗即刻 PATCH，行轉「成功」；
// (4) 單檔上載仍然自動開詳情。
// -----------------------------------------------------------------------
test("老闆：多檔隊列——並發 ≤2（跨批次）、取消未開始檔、隊列內指定盤、單檔自動開詳情", async ({ page }) => {
  const guard = await findGuardWithUNumber();
  const assignSiteId = await findSiteIdByName("都會大學學生宿舍");
  const month = new Date(Date.UTC(2026, 7, 1));
  const rawNames = [1, 2, 3, 4, 5].map((i) => `驗收測試並發盤${i}`);
  const xlsxMime = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  const buffers = await Promise.all(rawNames.map((n) => buildSyntheticRosterXlsx(n, guard.staffNo, guard.nameZh, guard.tel ?? "6100000")));

  let inFlight = 0;
  let maxInFlight = 0;
  let postCount = 0;
  await page.route("**/api/roster-uploads", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    postCount += 1;
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 1200));
    const response = await route.fetch();
    inFlight -= 1;
    await route.fulfill({ response });
  });

  try {
    await loginAs(page, "老闆");
    await page.goto(`/roster-uploads?month=${TEST_MONTH}`);
    await page.locator('input[type="month"]').fill(TEST_MONTH);
    const input = page.getByTestId("roster-upload-file-input");

    // 第一批 3 個，即刻再嚟第二批 2 個（跨批次）。
    await input.setInputFiles(rawNames.slice(0, 3).map((_n, i) => ({ name: `acc-conc-${i + 1}.xlsx`, mimeType: xlsxMime, buffer: buffers[i]! })));
    await input.setInputFiles(rawNames.slice(3).map((_n, i) => ({ name: `acc-conc-${i + 4}.xlsx`, mimeType: xlsxMime, buffer: buffers[i + 3]! })));

    const queue = page.getByTestId("roster-upload-queue");
    // 取消最後一個（仲喺「等緊」）。
    const lastRow = queue.locator("div", { hasText: "acc-conc-5.xlsx" }).first();
    await lastRow.getByRole("button", { name: "取消" }).click();
    await expect(lastRow.getByText("已取消")).toBeVisible();

    const summary = page.getByTestId("roster-upload-queue-summary");
    await expect(summary).toBeVisible({ timeout: 30_000 });
    await expect(summary).toContainText("要指定盤 4");
    expect(postCount).toBe(4);
    expect(maxInFlight).toBeLessThanOrEqual(2);
    expect(maxInFlight).toBe(2);

    // 隊列內「指定盤」。
    const firstRow = queue.locator("div", { hasText: "acc-conc-1.xlsx" }).first();
    const patchResp = page.waitForResponse((r) => r.url().includes("/api/roster-uploads/") && r.request().method() === "PATCH");
    await firstRow.getByRole("combobox", { name: "指定盤" }).selectOption(assignSiteId);
    expect((await patchResp).status()).toBe(200);
    await expect(firstRow.getByText("成功")).toBeVisible({ timeout: 15_000 });
    await expect(page.locator("table tbody tr", { hasText: "都會大學學生宿舍" }).first().getByText("已上載")).toBeVisible({ timeout: 15_000 });

    // 單檔上載：自動開詳情。
    await page.unroute("**/api/roster-uploads");
    await input.setInputFiles({ name: "acc-single.xlsx", mimeType: xlsxMime, buffer: buffers[4]! });
    await expect(page.getByText("acc-single.xlsx").last()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("button", { name: "收起" })).toBeVisible({ timeout: 15_000 });
  } finally {
    await prisma.rosterUploadRow.deleteMany({ where: { upload: { month, siteNameRaw: { in: rawNames } } } });
    await prisma.rosterUpload.deleteMany({ where: { month, siteNameRaw: { in: rawNames } } });
    await prisma.rosterUploadRow.deleteMany({ where: { upload: { siteId: assignSiteId, month } } });
    await prisma.rosterUpload.deleteMany({ where: { siteId: assignSiteId, month } });
  }
});
