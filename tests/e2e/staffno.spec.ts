// WP-STAFFNO（老闆 2026-09-19 拍板）Playwright e2e——員工編號獨立表
// （方案 B）＋保安牌照甲／乙類到期日分開存，喺真實 dev DB／真實 UI 路徑
// 驗證（同 pii.spec.ts 一樣嘅 pattern：`mode:"serial"`，跑完清走測試值）。
//
// 執行前提：`PW_PORT=3000 npx playwright test tests/e2e/staffno.spec.ts`，
// dev DB 要已經 `npm run db:seed`（有 staff_no="U…" 開頭嘅保安員）。
import { test, expect, type Page } from "@playwright/test";
import { loginAs } from "./helpers";
import { prisma } from "./db-helpers";

test.describe.configure({ mode: "serial" });

async function findGuardWithUNumber() {
  const guard = await prisma.guard.findFirstOrThrow({
    where: { staffNo: { startsWith: "U" }, status: "active" },
    select: { id: true, nameZh: true, staffNo: true },
  });
  return guard as { id: string; nameZh: string; staffNo: string };
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
  // 員工編號分區靠獨立 GET .../staff-numbers（openEdit() 尾段 await
  // loadStaffNumbers()），等埋呢個 response 先開始撳，唔係就「新增」
  // 表單撳落去嗰陣個 staffNumbers state 可能仲係舊值。
  await expect(page.getByRole("heading", { name: "員工編號" })).toBeVisible({ timeout: 10_000 });
}

function fieldControl(page: Page, label: string, anchorExact = false) {
  const pattern = anchorExact ? new RegExp(`^${label}`) : label;
  return page.locator("label", { hasText: pattern }).first();
}

test.afterAll(async () => {
  await prisma.$disconnect();
});

test("老闆：加 MP 號 → 列表見兩個 chips → 再加新 U 號 → 舊 U 摺埋、chip 更新 → staff_no 同步；填甲/乙到期日 → 列表 pill", async ({ page }) => {
  const guard = await findGuardWithUNumber();
  const originalStaffNo = guard.staffNo;
  const newMpNumber = `MP${Date.now().toString().slice(-6)}`;
  const newUNumber = `U${Date.now().toString().slice(-6)}`;

  try {
    await loginAs(page, "老闆");
    await page.goto("/guards");
    await openEditByName(page, guard.nameZh);

    // ---- 加 MP 號 ----
    const schemeSelect = fieldControl(page, "種類（scheme）").locator("select");
    await schemeSelect.selectOption("MP");
    await fieldControl(page, "編號").locator("input").fill(newMpNumber);
    const postMp = page.waitForResponse(
      (r) => /\/api\/guards\/[^/]+\/staff-numbers$/.test(r.url()) && r.request().method() === "POST",
    );
    await page.getByRole("button", { name: "新增編號" }).click();
    await postMp;
    await expect(page.getByText(`已新增 MP 號`)).toBeVisible({ timeout: 10_000 });

    // 抽屜入面即刻見到新 MP 號（current）。驗收 2026-09-23：`onAddStaffNumber()`
    // 會即刻 reload 背後嘅列表（桌面表格＋手機卡各一粒 chip），唔 scope 落
    // 抽屜 form 就 strict-mode 撞 3 個元素（main 已有嘅測試問題）。
    const drawer = page.locator("form").filter({ hasText: "員工編號" });
    await expect(drawer.getByText(newMpNumber, { exact: true })).toBeVisible();

    // `onAddStaffNumber()` 成功之後自己會 `await load()` 刷新列表，唔使
    // 再手動 reload——直接關閉抽屜就搵得到最新 chips。
    // WP-STAFFNO（業務規則 (4)）：員工編號分區有「取消呢個號」按鈕，同
    // 呢個抽屜關閉用嘅「取消」撞 substring——用 `exact: true` 分開。
    await page.getByRole("button", { name: "取消", exact: true }).click();

    // ---- 列表見兩個 chips（U + MP） ----
    await page.getByPlaceholder("姓名 / 工號 / 電話").fill(guard.nameZh);
    let row = page.locator("main table tbody tr", { hasText: guard.nameZh }).first();
    await expect(row).toBeVisible({ timeout: 20_000 });
    await expect(row.getByText(originalStaffNo, { exact: true })).toBeVisible();
    await expect(row.getByText(newMpNumber, { exact: true })).toBeVisible();

    // ---- 再加新 U 號（舊 U 應該自動轉 former） ----
    await row.getByRole("button", { name: "編輯" }).click();
    await expect(page.getByRole("heading", { name: "編輯保安員" })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole("heading", { name: "員工編號" })).toBeVisible({ timeout: 10_000 });

    await fieldControl(page, "種類（scheme）").locator("select").selectOption("U");
    await fieldControl(page, "編號").locator("input").fill(newUNumber);
    const postU = page.waitForResponse((r) => /\/api\/guards\/[^/]+\/staff-numbers$/.test(r.url()) && r.request().method() === "POST");
    // 驗收 2026-09-23：`onAddStaffNumber()` 最後會重新 GET 詳情再
    // `fillFormFromRow()`（主表單「工號」由舊 U 換新 U）——唔等呢個 GET 就
    // 填日期撳「儲存」，form 仲帶住舊 U 送出 → 409「呢個工號已經有人用緊」
    // （main 已有嘅 race，乾淨 DB 穩定重現）。
    const detailAfterAddU = page.waitForResponse((r) => /\/api\/guards\/[^/?]+$/.test(r.url()) && r.request().method() === "GET");
    await page.getByRole("button", { name: "新增編號" }).click();
    await postU;
    await detailAfterAddU;
    // response 講明舊 U 已經取消。
    await expect(page.getByText(`原本嘅 ${originalStaffNo} 已取消`)).toBeVisible({ timeout: 10_000 });

    // 舊 U 摺埋（former／已取消預設摺埋）——見到「顯示已取消嘅號 N 個」，撳先見到舊值。
    const showFormerBtn = page.getByRole("button", { name: /顯示已取消嘅號 \d+ 個/ });
    await expect(showFormerBtn).toBeVisible();
    await expect(drawer.getByText(originalStaffNo, { exact: true })).toHaveCount(0);
    await showFormerBtn.click();
    await expect(drawer.getByText(originalStaffNo, { exact: true })).toBeVisible();

    // ---- 填甲／乙到期日 ----
    await fieldControl(page, "甲類到期").locator("input").fill("2028-01-01");
    await fieldControl(page, "乙類到期").locator("input").fill("2027-01-01");
    await page.getByRole("button", { name: "儲存" }).click();
    await expect(page.getByText("已更新")).toBeVisible({ timeout: 15_000 });

    // ---- 列表 chip 更新（U chip 變新號），到期 pill 反映甲/乙較早（乙）嗰個 ----
    await page.getByPlaceholder("姓名 / 工號 / 電話").fill(guard.nameZh);
    row = page.locator("main table tbody tr", { hasText: guard.nameZh }).first();
    await expect(row).toBeVisible({ timeout: 20_000 });
    await expect(row.getByText(newUNumber, { exact: true })).toBeVisible();
    await expect(row.getByText(originalStaffNo, { exact: true })).toHaveCount(0); // 舊 U 唔再喺 chips 出現（只 current）
    await expect(row.getByText("90 日內").or(row.getByText("已過期")).or(row.getByText("有效"))).toBeVisible();

    // ---- staff_no 同步（legacy 欄） ----
    const afterGuard = await prisma.guard.findUniqueOrThrow({ where: { id: guard.id }, select: { staffNo: true, siaPermitAExpiry: true, siaPermitBExpiry: true } });
    expect(afterGuard.staffNo).toBe(newUNumber);
    expect(afterGuard.siaPermitAExpiry?.toISOString().slice(0, 10)).toBe("2028-01-01");
    expect(afterGuard.siaPermitBExpiry?.toISOString().slice(0, 10)).toBe("2027-01-01");
  } finally {
    // 還原：清走測試起嘅新表行，將現用 U 改返原本嗰個號，甲/乙到期日清空。
    await prisma.guardStaffNumber.deleteMany({ where: { guardId: guard.id, number: { in: [newMpNumber, newUNumber, originalStaffNo] } } });
    await prisma.guardStaffNumber.create({
      data: { guardId: guard.id, scheme: "U", number: originalStaffNo, status: "current", source: "e2e-restore:staffno.spec" },
    });
    await prisma.guard.update({
      where: { id: guard.id },
      data: { staffNo: originalStaffNo, siaPermitAExpiry: null, siaPermitBExpiry: null, siaPermitExpiry: null, siaPermitType: null },
    });
  }
});

// Fable5.1（4 個細修 1）：`sia_permit_b_lapsed_by_age` 原本塞喺
// `licenceExpiryPill()` 嘅 `if (!expiry)` 分支——保安員平安卡
// （safety_card_expiry）仲有效嗰陣，`nearestExpiry`（牌照/平安卡取較早）
// 就唔係 falsy，成粒 pill 跌落「有效」綠色分支，完全冚蓋咗「乙類已
// 失效」呢個警示。呢個 test 專登整一個「乙類因年齡失效、但平安卡遠期
// 仍然有效」嘅情況，斷言兩粒 pill 並排出現（「有效」冚蓋唔到「乙類已
// 失效」）。
test("乙類滿70歲失效＋平安卡仍然有效 → 列表「有效」同「乙類已失效」兩粒 pill 並排，唔會被冚蓋", async ({ page }) => {
  const guard = await findGuardWithUNumber();
  const before = await prisma.guard.findUniqueOrThrow({
    where: { id: guard.id },
    select: { dateOfBirth: true, siaPermitAExpiry: true, siaPermitBExpiry: true, safetyCardExpiry: true },
  });
  const farFuture = new Date(Date.now() + 400 * 86_400_000); // 遠過 90 日——確保平安卡揀落嚟顯示「有效」唔係「90 日內」
  try {
    await prisma.guard.update({
      where: { id: guard.id },
      data: {
        dateOfBirth: new Date("1950-01-01T00:00:00.000Z"), // 已滿 70 歲
        siaPermitAExpiry: null,
        siaPermitBExpiry: new Date("2030-01-01T00:00:00.000Z"), // 乙類本身填咗但因年齡法定失效
        safetyCardExpiry: farFuture,
      },
    });
    await loginAs(page, "老闆");
    await page.goto("/guards");
    await page.getByPlaceholder("姓名 / 工號 / 電話").fill(guard.nameZh);
    const row = page.locator("main table tbody tr", { hasText: guard.nameZh }).first();
    await expect(row).toBeVisible({ timeout: 20_000 });
    await expect(row.getByText("有效")).toBeVisible();
    await expect(row.getByText("乙類已失效（滿70歲）")).toBeVisible();
  } finally {
    await prisma.guard.update({
      where: { id: guard.id },
      data: {
        dateOfBirth: before.dateOfBirth,
        siaPermitAExpiry: before.siaPermitAExpiry,
        siaPermitBExpiry: before.siaPermitBExpiry,
        safetyCardExpiry: before.safetyCardExpiry,
      },
    });
  }
});

test("雞頭A：開自己人——員工編號分區有 chips 但冇「新增編號」表單", async ({ page }) => {
  const brokerAUser = await prisma.user.findFirstOrThrow({ where: { tel: "90000004" }, select: { brokerId: true } });
  const guard = await prisma.guard.findFirstOrThrow({
    where: { defaultBrokerId: brokerAUser.brokerId, status: "active", staffNo: { not: null } },
    select: { id: true, nameZh: true },
  });
  await loginAs(page, "雞頭A");
  await page.goto("/guards");
  await openEditByName(page, guard.nameZh);

  await expect(page.getByRole("heading", { name: "員工編號" })).toBeVisible();
  // 冇「新增編號」表單（撳掣冇出現）——雞頭視角 chips 只讀。
  await expect(page.getByRole("button", { name: "新增編號" })).toHaveCount(0);
  await expect(page.locator("label", { hasText: "種類（scheme）" })).toHaveCount(0);
});
