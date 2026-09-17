// WP-PII（老闆 2026-09-17 拍板）Playwright e2e——保安員個人資料欄位＋
// 權限，喺真實 dev DB／真實 UI 路徑驗證（同 pricing.spec.ts 一樣嘅
// pattern：`test.describe.configure({mode:"serial"})`，跑完清走測試值）。
//
// 執行前提：`PW_PORT=3000 npx playwright test tests/e2e/pii.spec.ts`，
// dev DB 要已經 `npm run db:seed`（有雞頭A/90000004 掛住嘅保安員）。
//
// 測試用嘅身份證／地址／銀行資料一律明顯假值（PDPO：唔用真人格式意外
// 撞中真人資料，`A123456(7)` 淨係示範格式）。
import { test, expect, type Page } from "@playwright/test";
import { loginAs } from "./helpers";
import { prisma } from "./db-helpers";

test.describe.configure({ mode: "serial" });

const TEST_HKID = "A123456(7)";
const TEST_HKID_MASKED = "A123***(7)";

async function findBrokerAOwnGuard() {
  const brokerAUser = await prisma.user.findFirstOrThrow({ where: { tel: "90000004" }, select: { brokerId: true } });
  const guard = await prisma.guard.findFirstOrThrow({
    where: { defaultBrokerId: brokerAUser.brokerId, status: "active" },
    select: { id: true, nameZh: true },
  });
  return guard;
}

async function openEditByName(page: Page, name: string) {
  const main = page.locator("main");
  await expect(main.getByText("載入緊…")).toHaveCount(0, { timeout: 20_000 });
  const searchInput = page.getByPlaceholder("姓名 / 工號 / 電話");
  await searchInput.fill(name);
  const row = main.locator("table tbody tr", { hasText: name }).first();
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.getByRole("button", { name: "編輯" }).click();
  await expect(page.getByRole("heading", { name: "編輯保安員" })).toBeVisible({ timeout: 10_000 });
}

/** Field 元件將 label span + input 一齊包喺 `<label>` 入面——用
 * hasText 揀返嗰個 label，再喺入面搵 input/select。`anchorExact` 用嚟
 * 避免「電話」呢類短 label 撞中「緊急聯絡人電話」呢類長 label（兩者都
 * 含「電話」呢個substring）。 */
function fieldControl(page: Page, label: string, anchorExact = false) {
  const pattern = anchorExact ? new RegExp(`^${label}`) : label;
  return page.locator("label", { hasText: pattern }).first();
}

test.afterAll(async () => {
  await prisma.$disconnect();
});

test("(a) 老闆：填牌照／身份證／銀行資料 → 儲存 → 重開見全號；列表 API 遮罩身份證", async ({ page }) => {
  const guard = await findBrokerAOwnGuard();
  try {
    await loginAs(page, "老闆");
    await page.goto("/guards");
    await openEditByName(page, guard.nameZh);

    // 牌照與證件。
    await fieldControl(page, "牌照號碼").locator("input").fill("SIA-E2E-01");
    await fieldControl(page, "牌照類別").locator("select").selectOption("A");

    // 個人資料。
    await fieldControl(page, "身份證號碼").locator("input").fill(TEST_HKID);
    await fieldControl(page, "出生日期").locator("input").fill("1990-05-01");
    await fieldControl(page, "地址").locator("input").fill("測試地址一段街 1 號");
    await fieldControl(page, "緊急聯絡人姓名").locator("input").fill("測試緊急聯絡人");
    await fieldControl(page, "緊急聯絡人電話").locator("input").fill("61009900");

    // Blacklist。
    await fieldControl(page, "Check 結果").locator("select").selectOption("clear");
    await fieldControl(page, "Check 日期").locator("input").fill("2026-01-01");

    // 銀行——「銀行」係「戶口號碼」以外冇其他重疊 label，但要 anchor
    // 住，唔係就會撞中下面「戶口號碼」欄本身 label 冇含「銀行」呢個
    // 字，其實唔會撞，anchor 純粹保險。
    await fieldControl(page, "銀行", true).locator("input").fill("測試銀行");
    await fieldControl(page, "戶口號碼").locator("input").fill("123-456789-001");
    await fieldControl(page, "收款人名").locator("input").fill(guard.nameZh);

    await page.getByRole("button", { name: "儲存" }).click();
    await expect(page.getByText("已更新")).toBeVisible({ timeout: 15_000 });

    // 重開見全號（詳情/編輯有權先見全號）。
    await openEditByName(page, guard.nameZh);
    await expect(fieldControl(page, "身份證號碼").locator("input")).toHaveValue(TEST_HKID);
    await expect(fieldControl(page, "銀行", true).locator("input")).toHaveValue("測試銀行");
    await expect(fieldControl(page, "牌照號碼").locator("input")).toHaveValue("SIA-E2E-01");

    // 列表（GET /api/guards）身份證一律遮罩——直接打 API（同一個已登入
    // browser context，帶住 session cookie）核對 response body，唔靠
    // UI 表格有冇顯示呢一欄（呢頁列表表格本身冇身份證欄，遮罩係 API
    // response 層面嘅保證，見 src/lib/api/guard-pii.ts）。
    const listRes = await page.request.get("/api/guards?take=500");
    expect(listRes.ok()).toBeTruthy();
    const listBody = (await listRes.json()) as { rows: Array<{ id: string; hkid?: string }> };
    const row = listBody.rows.find((r) => r.id === guard.id);
    expect(row?.hkid).toBe(TEST_HKID_MASKED);

    // 詳情 API 見全號。
    const detailRes = await page.request.get(`/api/guards/${guard.id}`);
    const detailBody = (await detailRes.json()) as { hkid?: string };
    expect(detailBody.hkid).toBe(TEST_HKID);
  } finally {
    // 清走呢個 test 填低嘅測試值——PATCH schema 嘅新欄係
    // optional（唔係 nullable），API 冇辦法「清返做 null」，直接用
    // Prisma 還原（同 pricing.spec.ts「鐵律：唔可以留低污染畀下一次
    // 跑」一致精神，見該檔案 (b) 場景嘅 finally block）。
    await prisma.guard.update({
      where: { id: guard.id },
      data: {
        hkid: null,
        dateOfBirth: null,
        address: null,
        emergencyContactName: null,
        emergencyContactTel: null,
        blacklistCheckResult: null,
        blacklistCheckDate: null,
        bankName: null,
        bankAccountNo: null,
        bankPayeeName: null,
        siaPermitNo: null,
        siaPermitType: null,
        safetyCardNo: null,
        safetyCardExpiry: null,
        hireDate: null,
        leaveDate: null,
        siaPermitExpiry: null,
      },
    });
  }
});

test("(b) 主管：開同一人——見牌照分區，冇個人資料／銀行分區", async ({ page }) => {
  const guard = await findBrokerAOwnGuard();
  // 先用老闆填一個牌照號碼，等主管有嘢好核對「見到牌照」。
  await prisma.guard.update({ where: { id: guard.id }, data: { siaPermitNo: "SIA-E2E-02" } });
  try {
    await loginAs(page, "主管");
    await page.goto("/guards");
    await openEditByName(page, guard.nameZh);

    await expect(page.getByRole("heading", { name: "牌照與證件" })).toBeVisible();
    await expect(fieldControl(page, "牌照號碼").locator("input")).toHaveValue("SIA-E2E-02");

    await expect(page.getByRole("heading", { name: "個人資料" })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "銀行" })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Blacklist" })).toHaveCount(0);
  } finally {
    await prisma.guard.update({ where: { id: guard.id }, data: { siaPermitNo: null } });
  }
});

test("(c) 雞頭A：開自己人——只有基本資料＋電話，冇牌照/個人資料/銀行分區", async ({ page }) => {
  const guard = await findBrokerAOwnGuard();
  await loginAs(page, "雞頭A");
  await page.goto("/guards");
  await openEditByName(page, guard.nameZh);

  await expect(fieldControl(page, "電話").locator("input")).toBeVisible();
  await expect(page.getByRole("heading", { name: "牌照與證件" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "個人資料" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "銀行" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Blacklist" })).toHaveCount(0);

  // 雞頭嘅 FilterChip toolbar 亦都完全唔變（冇「牌照 90 日內到期」呢個
  // checkbox filter——page subtitle 本身有「牌照 90 日內到期」呢句純文
  // 字描述（內部角色/雞頭都有，純粹描述高亮行為，唔係新 UI 控件），
  // 所以呢度直接斷言冇 checkbox 呢個互動控件，唔靠 getByText 撞中
  // subtitle）。
  await page.getByRole("button", { name: "取消" }).click();
  await expect(page.locator('input[type="checkbox"]')).toHaveCount(0);
});

test("(d) 到期 pill 三種狀態：已過期（紅）／90 日內（橙）／未填（灰）", async ({ page }) => {
  const guard = await findBrokerAOwnGuard();
  const today = new Date();
  const expired = new Date(today.getTime() - 10 * 86_400_000).toISOString().slice(0, 10);
  const soon = new Date(today.getTime() + 30 * 86_400_000).toISOString().slice(0, 10);

  try {
    await loginAs(page, "老闆");

    // 已過期。
    await prisma.guard.update({ where: { id: guard.id }, data: { siaPermitExpiry: new Date(expired) } });
    await page.goto("/guards");
    await page.getByPlaceholder("姓名 / 工號 / 電話").fill(guard.nameZh);
    let row = page.locator("main table tbody tr", { hasText: guard.nameZh }).first();
    await expect(row).toBeVisible({ timeout: 20_000 });
    await expect(row.getByText("已過期")).toBeVisible();

    // 90 日內。
    await prisma.guard.update({ where: { id: guard.id }, data: { siaPermitExpiry: new Date(soon) } });
    await page.reload();
    await page.getByPlaceholder("姓名 / 工號 / 電話").fill(guard.nameZh);
    row = page.locator("main table tbody tr", { hasText: guard.nameZh }).first();
    await expect(row).toBeVisible({ timeout: 20_000 });
    await expect(row.getByText("90 日內")).toBeVisible();

    // 未填。
    await prisma.guard.update({ where: { id: guard.id }, data: { siaPermitExpiry: null } });
    await page.reload();
    await page.getByPlaceholder("姓名 / 工號 / 電話").fill(guard.nameZh);
    row = page.locator("main table tbody tr", { hasText: guard.nameZh }).first();
    await expect(row).toBeVisible({ timeout: 20_000 });
    await expect(row.getByText("未填")).toBeVisible();
  } finally {
    await prisma.guard.update({ where: { id: guard.id }, data: { siaPermitExpiry: null } });
  }
});
