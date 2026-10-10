// WP-GUARD-FIX-UI Playwright e2e——老闆上載合成 U Team 名單 xlsx（exceljs
// 即場生成，唔寫落 disk）→ 計劃 → 套用 → 對數頁未配對行變 roster_only；
// 雞頭 403（連導航都見唔到條連結）。
//
// 執行前提：`PW_PORT=3000 npx playwright test tests/e2e/guard-fix.spec.ts`，
// dev DB 要已經 `npm run db:seed`。鐵則：呢個檔案本身唔可以有真名／
// 工號／電話字面——全部用「測試」開頭嘅合成假資料，同 roster-upload.
// spec.ts 一致風格。
import { test, expect } from "@playwright/test";
import ExcelJS from "exceljs";
import { loginAs } from "./helpers";
import { prisma, findSiteIdByName } from "./db-helpers";

test.describe.configure({ mode: "serial" });

const TEST_MONTH = "2026-08";
const TEST_MONTH_DATE = new Date(Date.UTC(2026, 7, 1));
const TEST_U_NUMBER = "U9E2E01";
const TEST_NAME = "測試散工E2E";
const TEST_TEL_NUM = "61239999";

/** 合成一份真更表 xlsx（同 roster-upload.spec.ts 一致欄位排位）——
 * `reparseRosterUpload()`（apply 完成之後自動叫）會重新解析
 * `roster_uploads.file_bytes`，一定要係真 xlsx 先可以重建到 rows；淨係
 * 直接寫 `roster_upload_rows` 唔夠（reparse 會刪晒重建）。 */
async function buildRosterXlsx(siteName: string): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("2026");
  ws.getCell("A2").value = siteName;
  ws.getCell("F4").value = "Date";
  ws.getCell("G4").value = TEST_MONTH_DATE;
  ws.getCell("A5").value = "Broker";
  ws.getCell("B5").value = "Time";
  ws.getCell("C5").value = "Rank";
  ws.getCell("D5").value = "Staff No.";
  ws.getCell("E5").value = "Tel";
  ws.getCell("F5").value = "Name";
  ws.getCell("A6").value = "TEST-BA";
  ws.getCell("B6").value = "1900-0700";
  ws.getCell("C6").value = "夜更保安員";
  ws.getCell("D6").value = TEST_U_NUMBER;
  ws.getCell("E6").value = TEST_TEL_NUM;
  ws.getCell("F6").value = TEST_NAME;
  ws.getCell("G6").value = "N";
  return Buffer.from(await wb.xlsx.writeBuffer());
}

async function buildUTeamXlsx(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("sheet1");
  ws.getRow(1).values = ["header"];
  const r = 2;
  ws.getCell(`B${r}`).value = "2026-08-01"; // idx1 入職日期
  ws.getCell(`C${r}`).value = TEST_NAME; // idx2 顯示名
  ws.getCell(`E${r}`).value = "在職"; // idx4 員工狀態
  ws.getCell(`J${r}`).value = TEST_TEL_NUM; // idx9 電話
  ws.getCell(`N${r}`).value = TEST_U_NUMBER; // idx13 員工編號
  ws.getCell(`P${r}`).value = TEST_NAME; // idx15 中文姓名
  return Buffer.from(await wb.xlsx.writeBuffer());
}

async function cleanup(siteId: string) {
  const upload = await prisma.rosterUpload.findFirst({ where: { siteId, month: TEST_MONTH_DATE, fileName: "e2e-guard-fix-roster.xlsx" } });
  if (upload) {
    await prisma.rosterUploadRow.deleteMany({ where: { uploadId: upload.id } });
    await prisma.rosterUpload.delete({ where: { id: upload.id } });
  }
  await prisma.guardFixRun.deleteMany({});
  await prisma.staffListUpload.deleteMany({ where: { fileName: "e2e-u-team.xlsx" } });
  const created = await prisma.guard.findFirst({ where: { nameZh: TEST_NAME } });
  if (created) {
    // FK RESTRICT——guard_phones/guard_staff_numbers 要先刪先可以刪 guard
    // 本身（同 guards.ts §鐵則一致：cash_casual 呢類測試保安員全部經
    // apply.ts 嘅正常路徑起，一樣要跟正常刪除順序清走）。
    // audit_log 係 append-only（DB trigger 拒絕 UPDATE/DELETE），唔清——
    // 淨係清 guard_phones/guard_staff_numbers（FK RESTRICT 擋住刪 guard）。
    await prisma.guardPhone.deleteMany({ where: { guardId: created.id } });
    await prisma.guardStaffNumber.deleteMany({ where: { guardId: created.id } });
    await prisma.guard.delete({ where: { id: created.id } });
  }
  await prisma.guardStaffNumber.deleteMany({ where: { number: TEST_U_NUMBER } });
}

test.afterAll(async () => {
  await prisma.$disconnect();
});

test("老闆：上載 U Team 名單 → 計算修復計劃 → 套用 → 對數頁未配對行變 roster_only", async ({ page }) => {
  const siteId = await findSiteIdByName("殷樺花園");
  await cleanup(siteId);

  try {
    await loginAs(page, "老闆");

    // 先經真正嘅更表上載流程（唔係直接砌 DB row）——`reparseRosterUpload()`
    // （apply 完成之後自動叫）會由 `roster_uploads.file_bytes` 重新解析，
    // 一定要係真 xlsx 先可以重建到 rows。
    const rosterBuf = await buildRosterXlsx("殷樺花園");
    await page.goto(`/roster-uploads?month=${TEST_MONTH}`);
    await page.locator('input[type="month"]').fill(TEST_MONTH);
    const uploadResponse = page.waitForResponse((r) => r.url().includes("/api/roster-uploads") && r.request().method() === "POST");
    await page.getByTestId("roster-upload-file-input").setInputFiles({ name: "e2e-guard-fix-roster.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: rosterBuf });
    const uploadRes = await uploadResponse;
    expect(uploadRes.status()).toBe(201);

    // P3-3.5：/guard-fix 已 redirect 去 /roster-uploads?tab=fix（見下面 redirect 斷言）
    await page.goto("/guard-fix");
    await expect(page).toHaveURL(/\/roster-uploads\?tab=fix/);
    await expect(page.getByRole("heading", { name: "未配對保安員修復" })).toBeVisible();

    // ① 上載 U Team 名單。
    const uTeamBuf = await buildUTeamXlsx();
    const listInput = page.locator("#staff-list-file-input");
    const listUploadResponse = page.waitForResponse((r) => r.url().includes("/api/guard-fix/staff-list") && r.request().method() === "POST");
    await listInput.setInputFiles({ name: "e2e-u-team.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: uTeamBuf });
    const listRes = await listUploadResponse;
    expect(listRes.status()).toBe(201);
    await expect(page.getByText(/現用：e2e-u-team\.xlsx/)).toBeVisible({ timeout: 15_000 });

    // ② 計算修復計劃。
    await page.locator('input[type="month"]').fill(TEST_MONTH);
    const planResponse = page.waitForResponse((r) => r.url().includes("/api/guard-fix/plan") && r.request().method() === "POST");
    await page.getByRole("button", { name: "計算修復計劃" }).click();
    const planRes = await planResponse;
    expect(planRes.status()).toBe(201);
    await expect(page.getByText("新建保安員")).toBeVisible({ timeout: 15_000 });

    // ③ 套用。
    await page.getByRole("button", { name: "③ 套用" }).click();
    await expect(page.getByRole("button", { name: "確認套用" })).toBeVisible();
    await page.getByRole("button", { name: "確認套用" }).click();
    await expect(page.getByText("已套用完成")).toBeVisible({ timeout: 30_000 });

    // 新保安員真係建咗，reparse 完之後呢行更表配到呢個新保安員。
    const created = await prisma.guard.findFirst({ where: { nameZh: TEST_NAME } });
    expect(created).not.toBeNull();
    const uploadAfter = await prisma.rosterUpload.findFirstOrThrow({ where: { siteId, month: TEST_MONTH_DATE, fileName: "e2e-guard-fix-roster.xlsx" } });
    const row = await prisma.rosterUploadRow.findFirstOrThrow({ where: { uploadId: uploadAfter.id } });
    expect(row.guardId).toBe(created!.id);
    expect(row.guardMatch).not.toBe("unmatched");
  } finally {
    await cleanup(siteId);
  }
});

test("雞頭：未配對保安員修復硬性 403（連導航都見唔到條連結）", async ({ page }) => {
  await loginAs(page, "雞頭A");
  await expect(page.getByRole("link", { name: "未配對保安員修復" })).toHaveCount(0);
  const res = await page.request.get("/api/guard-fix/staff-list");
  expect(res.status()).toBe(403);
});
