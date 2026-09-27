// WP-ONE-CLICK Phase 1（老闆 2026-09-26「一鍵全月結算」，§20）Playwright
// e2e——老闆上載合成更表 xlsx＋U Team 名單（exceljs 即場生成，唔寫落
// disk）→ 撳「一鍵結算」→ 睇進度 → 睇報告；雞頭 403（連導航都見唔到）。
//
// 執行前提：`PW_PORT=3000 npx playwright test
// tests/e2e/month-close-one-click.spec.ts`，dev DB 要已經 `npm run
// db:seed`（7 月已鎖定，見 scripts/seed/index.ts，一鍵結算 2026-08
// 先唔會撞 step0「上月未鎖」）。鐵則：合成假資料，冇真名/工號/電話。
import { test, expect } from "@playwright/test";
import ExcelJS from "exceljs";
import { loginAs } from "./helpers";
import { prisma, findSiteIdByName } from "./db-helpers";

test.describe.configure({ mode: "serial" });

const TEST_MONTH = "2026-08";
const TEST_MONTH_DATE = new Date(Date.UTC(2026, 7, 1));
const TEST_U_NUMBER = "U9E2E02";
const TEST_NAME = "測試散工E2E一鍵";
const TEST_TEL_NUM = "61239998";
const ROSTER_FILE_NAME = "e2e-one-click-roster.xlsx";
const STAFF_LIST_FILE_NAME = "e2e-one-click-u-team.xlsx";

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
  ws.getCell(`B${r}`).value = "2026-08-01";
  ws.getCell(`C${r}`).value = TEST_NAME;
  ws.getCell(`E${r}`).value = "在職";
  ws.getCell(`J${r}`).value = TEST_TEL_NUM;
  ws.getCell(`N${r}`).value = TEST_U_NUMBER;
  ws.getCell(`P${r}`).value = TEST_NAME;
  return Buffer.from(await wb.xlsx.writeBuffer());
}

async function cleanup(siteId: string) {
  const upload = await prisma.rosterUpload.findFirst({ where: { siteId, month: TEST_MONTH_DATE, fileName: ROSTER_FILE_NAME } });
  if (upload) {
    await prisma.rosterUploadRow.deleteMany({ where: { uploadId: upload.id } });
    await prisma.rosterUpload.delete({ where: { id: upload.id } });
  }
  await prisma.monthCloseRun.deleteMany({ where: { month: TEST_MONTH_DATE } });
  await prisma.guardFixRun.deleteMany({});
  await prisma.reconcileAllRun.deleteMany({ where: { month: TEST_MONTH_DATE } });
  await prisma.staffListUpload.deleteMany({ where: { fileName: STAFF_LIST_FILE_NAME } });
  const created = await prisma.guard.findFirst({ where: { nameZh: TEST_NAME } });
  if (created) {
    await prisma.shiftRecord.deleteMany({ where: { guardId: created.id } });
    await prisma.guardPhone.deleteMany({ where: { guardId: created.id } });
    await prisma.guardStaffNumber.deleteMany({ where: { guardId: created.id } });
    await prisma.guard.delete({ where: { id: created.id } });
  }
  await prisma.guardStaffNumber.deleteMany({ where: { number: TEST_U_NUMBER } });
}

test.afterAll(async () => {
  await prisma.$disconnect();
});

test("老闆：上載更表＋U Team 名單 → 一鍵結算 → 睇進度 → 睇報告", async ({ page }) => {
  const siteId = await findSiteIdByName("殷樺花園");
  await cleanup(siteId);
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  page.on("console", (msg) => {
    if (msg.type() === "error") pageErrors.push(msg.text());
  });

  try {
    await loginAs(page, "老闆");

    // 先經真正嘅更表上載流程（reparseRosterUpload() 會重新解析
    // file_bytes，要真 xlsx）。
    const rosterBuf = await buildRosterXlsx("殷樺花園");
    await page.goto(`/roster-uploads?month=${TEST_MONTH}`);
    await page.locator('input[type="month"]').fill(TEST_MONTH);
    const uploadResponse = page.waitForResponse((r) => r.url().includes("/api/roster-uploads") && r.request().method() === "POST");
    await page.getByTestId("roster-upload-file-input").setInputFiles({ name: ROSTER_FILE_NAME, mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: rosterBuf });
    const uploadRes = await uploadResponse;
    expect(uploadRes.status()).toBe(201);

    await page.goto("/month-close");
    await expect(page.getByRole("heading", { name: "一鍵全月結算" })).toBeVisible();
    await page.getByTestId("month-close-month-input").fill(TEST_MONTH);

    // U Team 名單上載（新散工建檔用）——呢頁揀檔同上載係兩步（揀檔淨係
    // set 落 state，要再撳「上載名單」先真係 POST，同 guard-fix 頁嗰種
    // 揀咗即上載嘅拖放 pattern 唔同，唔可以淨係 setInputFiles 就等
    // response）。
    const uTeamBuf = await buildUTeamXlsx();
    await page.getByTestId("month-close-staff-list-file-input").setInputFiles({ name: STAFF_LIST_FILE_NAME, mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: uTeamBuf });
    const listUploadResponse = page.waitForResponse((r) => r.url().includes("/api/guard-fix/staff-list") && r.request().method() === "POST");
    await page.getByRole("button", { name: "上載名單" }).click();
    const listRes = await listUploadResponse;
    expect(listRes.status()).toBe(201);
    await expect(page.getByText("U Team 名單已上載")).toBeVisible({ timeout: 15_000 });

    // 撳一鍵結算。
    const oneClickResponse = page.waitForResponse((r) => r.url().includes("/api/month-close/one-click") && r.request().method() === "POST");
    await page.getByRole("button", { name: `一鍵結算 ${TEST_MONTH}` }).click();
    const oneClickRes = await oneClickResponse;
    expect([200, 202]).toContain(oneClickRes.status());

    // 先直接用 API poll 到 job 伺服器端真係跑完（`status==='done'`），同
    // UI 自己嗰套 polling 分開驗證——如果呢一步都撞唔到，代表係背景 job
    // 本身嘅問題（唔係前端 UI 冧咗），錯誤訊息會清楚好多。
    await expect
      .poll(
        async () => {
          const res = await page.request.get(`/api/month-close/one-click?month=${TEST_MONTH}`);
          if (!res.ok()) return `http_${res.status()}`;
          const body = (await res.json()) as { runs: Array<{ status: string; error_message: string | null }> };
          const run = body.runs[0];
          return run ? `${run.status}${run.error_message ? `:${run.error_message}` : ""}` : "no_run";
        },
        { timeout: 60_000, intervals: [2_000] },
      )
      .toMatch(/^done/);
    if (pageErrors.length) console.log("[month-close e2e] 瀏覽器 console/page error：", pageErrors);

    // 睇進度＋報告（job 已經伺服器端完成，呢度淨係等前端 poll 追上）。
    await expect(page.getByText("④ 報告")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("逐雞頭應付")).toBeVisible();
    await expect(page.getByText("逐盤收入")).toBeVisible();

    // 新散工真係經一鍵結算建咗（安員修復 step 做嘅）。
    const created = await prisma.guard.findFirst({ where: { nameZh: TEST_NAME } });
    expect(created).not.toBeNull();
  } finally {
    await cleanup(siteId);
  }
});

test("雞頭：一鍵結算硬性 403（連導航都見唔到條連結）", async ({ page }) => {
  await loginAs(page, "雞頭A");
  await expect(page.getByRole("link", { name: "一鍵結算" })).toHaveCount(0);
  const res = await page.request.get("/api/month-close/one-click?month=2026-08");
  expect(res.status()).toBe(403);
});
