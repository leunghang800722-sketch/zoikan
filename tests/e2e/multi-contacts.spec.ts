// WP-MULTI（老闆 2026-09-19 拍板「全部資料都要保留，唔好揀一個」）
// Playwright e2e——電話／緊急聯絡人／地址三張新子表，喺真實 dev DB／
// 真實 UI 路徑驗證（同 tests/e2e/staffno.spec.ts／pii.spec.ts 一樣嘅
// pattern：`mode:"serial"`，跑完清走測試值）。
//
// 執行前提：`PW_PORT=3000 npx playwright test tests/e2e/multi-contacts.spec.ts`，
// dev DB 要已經 `npm run db:seed`（有雞頭A/90000004 掛住嘅保安員）。
import { test, expect, type Page } from "@playwright/test";
import { loginAs } from "./helpers";
import { prisma } from "./db-helpers";

test.describe.configure({ mode: "serial" });

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
  const detailResponse = page.waitForResponse((r) => /\/api\/guards\/[^/?]+$/.test(r.url()) && r.request().method() === "GET").catch(() => null);
  await row.getByRole("button", { name: "編輯" }).click();
  await expect(page.getByRole("heading", { name: "編輯保安員" })).toBeVisible({ timeout: 10_000 });
  await detailResponse;
}

function fieldControl(page: Page, label: string, anchorExact = false) {
  const pattern = anchorExact ? new RegExp(`^${label}`) : label;
  return page.locator("label", { hasText: pattern }).first();
}

async function cleanupContactTables(guardId: string) {
  // 呢個 test 自給自足——清走呢個 test 起低嘅新表行，唔留污染畀下次跑
  // （guard_phones 有 UNIQUE(guard_id, tel)，唔清會令下次跑撞號）。
  await prisma.guardPhone.deleteMany({ where: { guardId } });
  await prisma.guardEmergencyContact.deleteMany({ where: { guardId } });
  await prisma.guardAddress.deleteMany({ where: { guardId } });
  await prisma.guard.update({ where: { id: guardId }, data: { tel: null, emergencyContactName: null, emergencyContactTel: null, address: null } });
}

test.afterAll(async () => {
  await prisma.$disconnect();
});

test("老闆：加第二個電話 → 設主要 → 列表電話變 → 舊電話仲喺度", async ({ page }) => {
  const guard = await findBrokerAOwnGuard();
  const originalTel = "6" + Date.now().toString().slice(-7);
  const secondTel = "6" + (Date.now() + 1).toString().slice(-7);

  try {
    await loginAs(page, "老闆");
    await page.goto("/guards");
    await openEditByName(page, guard.nameZh);

    // 主要電話照舊喺頂——用頂部「電話」快速填第一個電話。
    await fieldControl(page, "電話", true).locator("input").fill(originalTel);
    await page.getByRole("button", { name: "儲存" }).click();
    await expect(page.getByText("已更新")).toBeVisible({ timeout: 15_000 });

    // 重開，加第二個電話（「所有電話」分區）。
    await openEditByName(page, guard.nameZh);
    await expect(page.getByRole("heading", { name: "所有電話" })).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("form").getByText(originalTel, { exact: true })).toBeVisible();

    await fieldControl(page, "新增電話號碼").locator("input").fill(secondTel);
    const postPhone = page.waitForResponse((r) => /\/api\/guards\/[^/]+\/phones$/.test(r.url()) && r.request().method() === "POST");
    await page.getByRole("button", { name: "新增電話" }).click();
    await postPhone;
    await expect(page.getByText("已新增電話")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("form").getByText(secondTel, { exact: true })).toBeVisible();

    // 設第二個電話做主要——呢一刻淨係第二個電話（非 primary）先有「設為
    // 主要」掣，用返粒掣本身（唔靠 div hasText 呢種容易撞中外層 wrapper
    // 嘅 locator）。
    const patchPrimary = page.waitForResponse((r) => /\/api\/guards\/[^/]+\/phones\/[^/]+$/.test(r.url()) && r.request().method() === "PATCH");
    await page.getByRole("button", { name: "設為主要" }).click();
    await patchPrimary;
    await expect(page.getByText("已將", { exact: false })).toBeVisible({ timeout: 10_000 });

    // 主表單頂部「電話」（primary）已經變咗。
    await expect(fieldControl(page, "電話", true).locator("input")).toHaveValue(secondTel);

    // 舊電話仲喺度（唔係俾清走）。
    await expect(page.locator("form").getByText(originalTel, { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "取消", exact: true }).click();

    // 列表（主要電話欄）反映新值。
    await page.getByPlaceholder("姓名 / 工號 / 電話").fill(guard.nameZh);
    const row = page.locator("main table tbody tr", { hasText: guard.nameZh }).first();
    await expect(row).toBeVisible({ timeout: 20_000 });
    await expect(row.getByText(secondTel, { exact: true })).toBeVisible();

    // 舊電話喺 DB 仲喺度、非 primary。
    const oldRow = await prisma.guardPhone.findFirstOrThrow({ where: { guardId: guard.id, tel: originalTel } });
    expect(oldRow.isPrimary).toBe(false);
  } finally {
    await cleanupContactTables(guard.id);
  }
});

test("老闆：加兩個緊急聯絡人", async ({ page }) => {
  const guard = await findBrokerAOwnGuard();
  try {
    await loginAs(page, "老闆");
    await page.goto("/guards");
    await openEditByName(page, guard.nameZh);
    await expect(page.getByRole("heading", { name: "緊急聯絡人列表" })).toBeVisible({ timeout: 10_000 });

    await fieldControl(page, "姓名（新增聯絡人）").locator("input").fill("測試聯絡人一");
    await fieldControl(page, "電話（新增聯絡人）").locator("input").fill("69800001");
    const post1 = page.waitForResponse((r) => /\/api\/guards\/[^/]+\/emergency-contacts$/.test(r.url()) && r.request().method() === "POST");
    await page.getByRole("button", { name: "新增緊急聯絡人" }).click();
    await post1;
    await expect(page.getByText("已新增緊急聯絡人")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("測試聯絡人一")).toBeVisible();

    await fieldControl(page, "姓名（新增聯絡人）").locator("input").fill("測試聯絡人二");
    await fieldControl(page, "電話（新增聯絡人）").locator("input").fill("69800002");
    const post2 = page.waitForResponse((r) => /\/api\/guards\/[^/]+\/emergency-contacts$/.test(r.url()) && r.request().method() === "POST");
    await page.getByRole("button", { name: "新增緊急聯絡人" }).click();
    await post2;
    await expect(page.getByText("測試聯絡人二")).toBeVisible();

    const rows = await prisma.guardEmergencyContact.findMany({ where: { guardId: guard.id }, orderBy: { sortOrder: "asc" } });
    expect(rows.length).toBe(2);
    expect(rows[0]!.name).toBe("測試聯絡人一");
    expect(rows[1]!.name).toBe("測試聯絡人二");
  } finally {
    await cleanupContactTables(guard.id);
  }
});

test("雞頭：睇自己安員——見電話但冇新增/編輯/刪除掣，見唔到緊急聯絡人／地址分區", async ({ page }) => {
  const guard = await findBrokerAOwnGuard();
  const tel = "6" + Date.now().toString().slice(-7);
  try {
    // 老闆先幫呢個安員加一個電話，等雞頭有嘢好睇。
    await loginAs(page, "老闆");
    await page.goto("/guards");
    await openEditByName(page, guard.nameZh);
    await fieldControl(page, "電話", true).locator("input").fill(tel);
    await page.getByRole("button", { name: "儲存" }).click();
    await expect(page.getByText("已更新")).toBeVisible({ timeout: 15_000 });
    await page.getByRole("button", { name: "登出" }).click();
    await page.waitForURL((u) => u.pathname.startsWith("/login"), { timeout: 15_000 });

    await loginAs(page, "雞頭A");
    await page.goto("/guards");
    await openEditByName(page, guard.nameZh);

    // 見到「所有電話」分區＋電話本身，但冇任何寫入掣。
    await expect(page.getByRole("heading", { name: "所有電話" })).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("form").getByText(tel, { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "新增電話" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "設為主要" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "刪除" })).toHaveCount(0);

    // 「安員個人資料」module 對雞頭硬性拒——緊急聯絡人／地址分區完全
    // 唔顯示（response 403，`hasPiiField` 為 false）。
    await expect(page.getByRole("heading", { name: "緊急聯絡人列表" })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "地址列表" })).toHaveCount(0);
  } finally {
    await cleanupContactTables(guard.id);
  }
});
