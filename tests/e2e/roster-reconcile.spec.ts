// WP-ROSTER-UPLOAD Phase B-1（B1-3／驗收）Playwright e2e——老闆上載合成
// xlsx→對數→以更表為準套用→shift_records 出現 source='roster_upload'；
// 再上載改咗人嘅 v2→見 guard_diff→套用→舊記錄 cancelled；雞頭對數 API
// 403；鎖月後對數頁唯讀。
//
// 執行前提：`PW_PORT=3000 npx playwright test tests/e2e/roster-reconcile.spec.ts`，
// dev DB 要已經 `npm run db:seed`。鐵則：呢個檔案冇任何真名／工號／電話
// 字面——盤名／保安員資料一律 runtime 查（`findSiteIdByName()`／
// `prisma`），唔寫死。自給自足＋`finally` 清走呢個 spec 自己寫落 dev DB
// 嘅嘢（roster_uploads／roster_upload_rows／roster_reconcile_decisions／
// 呢個 spec 自己新建嘅 shift_records）。
import { test, expect } from "@playwright/test";
import ExcelJS from "exceljs";
import { loginAs } from "./helpers";
import { prisma, findSiteIdByName, TEST_TEL } from "./db-helpers";

test.describe.configure({ mode: "serial" });

const TEST_MONTH = "2026-08";
const MONTH_DATE = new Date(Date.UTC(2026, 7, 1));
const WORK_DATE_ISO = "2026-08-03"; // 揀一個唔撞現有 e2e spec 用開嘅日子

async function findTwoGuardsWithUNumber(): Promise<[{ id: string; nameZh: string; staffNo: string; tel: string | null }, { id: string; nameZh: string; staffNo: string; tel: string | null }]> {
  const guards = await prisma.guard.findMany({
    where: { staffNo: { startsWith: "U" }, status: "active" },
    select: { id: true, nameZh: true, staffNo: true, tel: true },
    take: 2,
    orderBy: { staffNo: "asc" },
  });
  if (guards.length < 2) throw new Error("e2e setup: 搵唔到兩個 staffNo 開頭係 U 嘅在職保安員");
  return [guards[0]!, guards[1]!] as [{ id: string; nameZh: string; staffNo: string; tel: string | null }, { id: string; nameZh: string; staffNo: string; tel: string | null }];
}

async function buildXlsx(siteName: string, staffNo: string, name: string, tel: string, shiftCode: string): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("2026");
  ws.getCell("A2").value = siteName;
  ws.getCell("F4").value = "Date";
  ws.getCell("G4").value = new Date(Date.UTC(2026, 7, 3));
  ws.getCell("A5").value = "Broker";
  ws.getCell("B5").value = "Time";
  ws.getCell("C5").value = "Rank";
  ws.getCell("D5").value = "Staff No.";
  ws.getCell("E5").value = "Tel";
  ws.getCell("F5").value = "Name";
  ws.getCell("B6").value = "1900-0700";
  ws.getCell("C6").value = "夜更保安員";
  ws.getCell("D6").value = staffNo;
  ws.getCell("E6").value = tel;
  ws.getCell("F6").value = name;
  ws.getCell("G6").value = shiftCode;
  return Buffer.from(await wb.xlsx.writeBuffer());
}

async function cleanupUploads(siteId: string) {
  const uploads = await prisma.rosterUpload.findMany({ where: { siteId, month: MONTH_DATE }, select: { id: true } });
  const uploadIds = uploads.map((u) => u.id);
  if (uploadIds.length) {
    await prisma.rosterReconcileDecision.deleteMany({ where: { uploadId: { in: uploadIds } } });
    await prisma.rosterUploadRow.deleteMany({ where: { uploadId: { in: uploadIds } } });
    await prisma.rosterUpload.deleteMany({ where: { id: { in: uploadIds } } });
  }
}

test.afterAll(async () => {
  await prisma.$disconnect();
});

test("老闆：上載→對數（roster_only）以更表為準套用→shift_records source=roster_upload；再上載改咗人嘅 v2→guard_diff→套用→舊記錄 cancelled", async ({ page }) => {
  const siteId = await findSiteIdByName("殷樺花園");
  const [guardA, guardB] = await findTwoGuardsWithUNumber();
  const shiftType = await prisma.shiftType.findFirstOrThrow({ where: { siteId, voidedAt: null }, select: { id: true, code: true } });

  // 保證測試由乾淨狀態開始——清走呢個（site,month）舊嘅上載/對數決定，
  // 同呢個 spec 專用嘅 work_date 上面兩個保安員嘅 shift_records（如果之前
  // 有跑漏低）。
  await cleanupUploads(siteId);
  await prisma.shiftRecord.deleteMany({ where: { siteId, workDate: new Date(`${WORK_DATE_ISO}T00:00:00.000Z`), guardId: { in: [guardA.id, guardB.id] } } });

  const key = `${WORK_DATE_ISO}|${siteId}|${guardA.id}|${shiftType.id}`;

  try {
    // ---- v1：上載 guardA，對數 roster_only，以更表為準套用 -----------
    await loginAs(page, "老闆");
    await page.goto(`/roster-uploads?month=${TEST_MONTH}`);
    await expect(page.getByRole("heading", { name: "更表上載" })).toBeVisible();
    await page.locator('input[type="month"]').fill(TEST_MONTH);

    const buf1 = await buildXlsx("殷樺花園", guardA.staffNo, guardA.nameZh, guardA.tel ?? "6100001", shiftType.code);
    const upload1Resp = page.waitForResponse((r) => r.url().includes("/api/roster-uploads") && r.request().method() === "POST");
    await page.getByTestId("roster-upload-file-input").setInputFiles({ name: "reconcile-v1.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: buf1 });
    const res1 = await upload1Resp;
    expect(res1.status()).toBe(201);
    const upload1Body = (await res1.json()) as { upload: { id: string } };

    await page.goto(`/roster-uploads/${upload1Body.upload.id}/reconcile`);
    await expect(page.getByRole("heading", { name: "更表對數" })).toBeVisible();
    // 2026-09-26 回歸：「全部」tab 之前砌錯 URL（`/reconcile&take=500`）→ 404、
    // 批量掣永遠 (0)。而家「全部」tab 一定要 200 兼見到行。
    const allTabResp = page.waitForResponse((r) => r.url().includes("/reconcile?") && r.request().method() === "GET");
    await page.getByRole("button", { name: "全部", exact: true }).click();
    expect((await allTabResp).status()).toBe(200);
    await expect(page.locator(`[data-reconcile-key="${key}"]`)).toBeVisible();
    await page.getByTestId("reconcile-tab-roster_only").click();

    const row1 = page.locator(`[data-reconcile-key="${key}"]`);
    await expect(row1).toBeVisible({ timeout: 15_000 });
    await row1.getByRole("button", { name: "以更表為準" }).click();
    await page.getByRole("button", { name: /套用決定/ }).click();
    await page.getByRole("button", { name: "確認套用" }).click();
    await expect(page.getByText(/已套用/)).toBeVisible({ timeout: 15_000 });

    const recordA = await prisma.shiftRecord.findFirstOrThrow({
      where: { siteId, guardId: guardA.id, workDate: new Date(`${WORK_DATE_ISO}T00:00:00.000Z`), shiftTypeId: shiftType.id },
    });
    expect(recordA.source).toBe("roster_upload");
    expect(recordA.status).toBe("confirmed");

    // ---- v2：改咗做 guardB（同一日同更別）——舊嗰版（v1）supersede，
    // 對數應該見 guard_diff（系統依然係 guardA，更表而家係 guardB）。
    const buf2 = await buildXlsx("殷樺花園", guardB.staffNo, guardB.nameZh, guardB.tel ?? "6100002", shiftType.code);
    const upload2Resp = page.waitForResponse((r) => r.url().includes("/api/roster-uploads") && r.request().method() === "POST");
    await page.goto(`/roster-uploads?month=${TEST_MONTH}`);
    await page.locator('input[type="month"]').fill(TEST_MONTH);
    await page.getByTestId("roster-upload-file-input").setInputFiles({ name: "reconcile-v2.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: buf2 });
    const res2 = await upload2Resp;
    expect(res2.status()).toBe(201);
    const upload2Body = (await res2.json()) as { upload: { id: string } };

    await page.goto(`/roster-uploads/${upload2Body.upload.id}/reconcile`);
    await page.getByTestId("reconcile-tab-guard_diff").click();
    // guard_diff 項嘅 key 跟更表嗰邊（guardB），唔係系統嗰邊（guardA）
    // ——見 reconcile.ts 第二輪配對用 `rKey`（roster 嗰個 key）。
    const keyV2 = `${WORK_DATE_ISO}|${siteId}|${guardB.id}|${shiftType.id}`;
    const row2 = page.locator(`[data-reconcile-key="${keyV2}"]`);
    await expect(row2).toBeVisible({ timeout: 15_000 });
    await expect(row2).toHaveAttribute("data-category", "guard_diff");
    await row2.getByRole("button", { name: "以更表為準" }).click();
    await page.getByRole("button", { name: /套用決定/ }).click();
    await page.getByRole("button", { name: "確認套用" }).click();
    await expect(page.getByText(/已套用/)).toBeVisible({ timeout: 15_000 });

    const recordAAfter = await prisma.shiftRecord.findUniqueOrThrow({ where: { id: recordA.id } });
    expect(recordAAfter.status).toBe("cancelled");
    const recordB = await prisma.shiftRecord.findFirstOrThrow({
      where: { siteId, guardId: guardB.id, workDate: new Date(`${WORK_DATE_ISO}T00:00:00.000Z`), shiftTypeId: shiftType.id },
    });
    expect(recordB.source).toBe("roster_upload");
    expect(recordB.status).toBe("confirmed");
  } finally {
    await cleanupUploads(siteId);
    await prisma.shiftRecord.deleteMany({ where: { siteId, workDate: new Date(`${WORK_DATE_ISO}T00:00:00.000Z`), guardId: { in: [guardA.id, guardB.id] } } });
  }
});

test("雞頭：對數 API 硬性 403（GET/POST 都係）", async ({ page, request }) => {
  const siteId = await findSiteIdByName("殷樺花園");
  const anyUpload = await prisma.rosterUpload.findFirst({ where: { siteId, month: MONTH_DATE } });
  // 就算冇任何上載都要 403（權限閘喺搵唔搵到之前）——用一個唔存在嘅 id
  // 都得，403 應該喺 404 之前擋住。
  const uploadId = anyUpload?.id ?? "00000000-0000-0000-0000-000000000000";

  await loginAs(page, "雞頭A");
  const cookies = await page.context().cookies();
  const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");

  const getRes = await request.get(`/api/roster-uploads/${uploadId}/reconcile`, { headers: { cookie: cookieHeader } });
  expect(getRes.status()).toBe(403);
  const postRes = await request.post(`/api/roster-uploads/${uploadId}/reconcile/apply`, {
    headers: { cookie: cookieHeader, "content-type": "application/json" },
    data: JSON.stringify({ actions: [] }),
  });
  expect(postRes.status()).toBe(403);

  // 導航都見唔到——同「更表上載」module 硬性 deny 一致。
  await expect(page.getByRole("link", { name: "更表上載" })).toHaveCount(0);
});

test("已鎖定月份：對數頁唯讀（冇套用/決定掣）", async ({ page }) => {
  const siteId = await findSiteIdByName("殷樺花園");
  // 揀一個穩陣、唔會同其他 e2e/dev 數據撞嘅測試月份（過去久遠、seed
  // 冇覆蓋），起一個 roster_upload＋鎖定 month_close，睇完即刻清走／解鎖。
  const lockTestMonth = new Date(Date.UTC(2020, 0, 1));
  await prisma.rosterUploadRow.deleteMany({ where: { upload: { siteId, month: lockTestMonth } } });
  await prisma.rosterUpload.deleteMany({ where: { siteId, month: lockTestMonth } });
  await prisma.monthClose.deleteMany({ where: { month: lockTestMonth } });

  const upload = await prisma.rosterUpload.create({
    data: {
      month: lockTestMonth,
      siteId,
      siteNameRaw: "殷樺花園",
      uploaderUserId: (await prisma.user.findUniqueOrThrow({ where: { tel: TEST_TEL["老闆"] }, select: { id: true } })).id,
      fileName: "lock-test.xlsx",
      fileSha256: "0".repeat(64),
      fileBytes: Buffer.from("x"),
      fileSize: 1,
      status: "parsed",
      createdBy: "e2e:roster-reconcile-lock-test",
    },
  });
  const monthClose = await prisma.monthClose.create({ data: { month: lockTestMonth, lockedAt: new Date(), lockedBy: "e2e:roster-reconcile-lock-test", createdBy: "e2e:roster-reconcile-lock-test" } });

  try {
    await loginAs(page, "老闆");
    await page.goto(`/roster-uploads/${upload.id}/reconcile`);
    await expect(page.getByRole("heading", { name: "更表對數" })).toBeVisible();
    await expect(page.getByText(/已鎖定——呢頁唯讀/)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("button", { name: /套用決定/ })).toHaveCount(0);
  } finally {
    await prisma.monthClose.delete({ where: { id: monthClose.id } });
    await prisma.rosterUpload.delete({ where: { id: upload.id } });
  }
});

test("驗收（Opus 5.5）：會計手機 375px 對數頁冇橫向捲、推算標記、unresolved 可標例外；首頁「更表對數待處理」卡（跨月）；雞頭首頁冇呢張卡", async ({ page }) => {
  const siteId = await findSiteIdByName("殷樺花園");
  const [guardA] = await findTwoGuardsWithUNumber();
  const shiftType = await prisma.shiftType.findFirstOrThrow({ where: { siteId, voidedAt: null }, select: { id: true } });
  await cleanupUploads(siteId);
  const owner = await prisma.user.findUniqueOrThrow({ where: { tel: TEST_TEL["老闆"] }, select: { id: true } });
  const upload = await prisma.rosterUpload.create({
    data: {
      month: MONTH_DATE,
      siteId,
      siteNameRaw: "殷樺花園",
      uploaderUserId: owner.id,
      fileName: "reconcile-mobile.xlsx",
      fileSha256: "1".repeat(64),
      fileBytes: Buffer.from("x"),
      fileSize: 1,
      status: "parsed",
      createdBy: "e2e:roster-reconcile-mobile",
    },
  });
  await prisma.rosterUploadRow.create({
    data: { uploadId: upload.id, rowIndex: 6, workDate: new Date(`${WORK_DATE_ISO}T00:00:00.000Z`), rawCode: "N", codeKind: "shift", shiftTypeId: shiftType.id, resolvedSiteId: siteId, guardId: guardA.id, guardMatch: "by_staff_no" },
  });
  await prisma.rosterUploadRow.create({
    data: { uploadId: upload.id, rowIndex: 7, workDate: new Date(`${WORK_DATE_ISO}T00:00:00.000Z`), rawCode: "N", codeKind: "shift", shiftTypeId: shiftType.id, resolvedSiteId: siteId, guardId: null, guardMatch: "unmatched" },
  });

  try {
    await page.setViewportSize({ width: 375, height: 812 });
    await loginAs(page, "會計");
    await page.goto(`/roster-uploads/${upload.id}/reconcile`);
    await expect(page.getByRole("heading", { name: "更表對數" })).toBeVisible();
    await expect(page.getByTestId("reconcile-tab-unresolved")).toBeVisible();
    // unresolved tab（預設）：手機卡有「例外」掣。
    await expect(page.getByRole("button", { name: "例外" }).first()).toBeVisible({ timeout: 15_000 });
    await page.getByTestId("reconcile-tab-roster_only").click();
    await expect(page.getByText(/・推算/).first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("button", { name: "以更表為準" }).first()).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);

    await page.goto("/");
    await expect(page.getByText("更表對數待處理").locator("visible=true").first()).toBeVisible({ timeout: 15_000 });

    await page.context().clearCookies();
    await loginAs(page, "雞頭A");
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await expect(page.getByText("更表對數待處理")).toHaveCount(0);
  } finally {
    await cleanupUploads(siteId);
  }
});
