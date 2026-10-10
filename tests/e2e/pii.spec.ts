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

// P3-3.8：身份證 check digit 驗證（identity.ts）之後，舊假值 A123456(7) 會 400——改用 check digit 啱嘅假值 A123456(3)。
const TEST_HKID = "A123456(3)"; // 填入嘅格式
const TEST_HKID_STORED = "A1234563"; // 系統存／顯示嘅規範化格式（canonicalHkid：去括號）
const TEST_HKID_MASKED = "A123***(3)"; // 列表 API 遮罩格式（maskHkid）

async function findBrokerAOwnGuard() {
  const brokerAUser = await prisma.user.findFirstOrThrow({ where: { tel: "90000004" }, select: { brokerId: true } });
  const guard = await prisma.guard.findFirstOrThrow({
    where: { defaultBrokerId: brokerAUser.brokerId, status: "active" },
    select: { id: true, nameZh: true },
  });
  return guard;
}

// Opus 覆核（WP-MULTI 必修 3）：呢個檔案幾個 test（(e)／(g)）淨係想測
// PII／field-group 邏輯，順手用真實嘅 `findBrokerAOwnGuard()` 改咗電話
// 一次，`finally` 度原本直接 `prisma.guard.update({ data: { tel: ... }
// })` raw 還原——呢種寫法唔會跟住 sync `guard_phones`（WP-MULTI 新表），
// 令 legacy `tel` 同子表嘅 primary 行唔一致（`src/lib/guards/contacts.ts
// createGuardPhone()` 頂註解都有記低呢個場景）。改用呢個 helper：
// 順手將測試起低嘅電話行清走、將原本嗰個電話行升（或者補）返做
// primary，先至還原 `guards.tel`——等 `guard_phones` 同 legacy 欄一直
// 保持一致，唔留 desync 畀下一個測試/下一次 db 檢查。
async function restoreGuardTel(guardId: string, originalTel: string | null, extraTelsToRemove: string[] = []): Promise<void> {
  const normalize = (v: string) => v.replace(/[\s-]+/g, "");
  const normalizedOriginal = originalTel ? normalize(originalTel) : null;
  const toRemove = extraTelsToRemove.map(normalize).filter((t) => t !== normalizedOriginal);
  if (toRemove.length > 0) {
    await prisma.guardPhone.deleteMany({ where: { guardId, tel: { in: toRemove } } });
  }
  if (normalizedOriginal) {
    await prisma.guardPhone.updateMany({ where: { guardId, isPrimary: true, NOT: { tel: normalizedOriginal } }, data: { isPrimary: false } });
    const existing = await prisma.guardPhone.findUnique({ where: { guardId_tel: { guardId, tel: normalizedOriginal } } });
    if (existing) {
      if (!existing.isPrimary) await prisma.guardPhone.update({ where: { id: existing.id }, data: { isPrimary: true } });
    } else {
      await prisma.guardPhone.create({
        data: { guardId, tel: normalizedOriginal, isPrimary: true, source: "e2e-restore:pii.spec", createdBy: "e2e-restore:pii.spec" },
      });
    }
  } else {
    await prisma.guardPhone.updateMany({ where: { guardId, isPrimary: true }, data: { isPrimary: false } });
  }
  await prisma.guard.update({ where: { id: guardId }, data: { tel: originalTel } });
}

async function openEditByName(page: Page, name: string) {
  const main = page.locator("main");
  await expect(main.getByText("載入緊…")).toHaveCount(0, { timeout: 20_000 });
  const searchInput = page.getByPlaceholder("姓名 / 工號 / 電話");
  await searchInput.fill(name);
  const row = main.locator("table tbody tr", { hasText: name }).first();
  await expect(row).toBeVisible({ timeout: 20_000 });
  // GuardsClient.tsx openEdit() 即刻開抽屜（用列表嗰行起草），跟住先
  // async 攞 `GET /api/guards/:id` 詳情補正確值（見該檔案註解）——呢個
  // response 一到就會成個 `fillFormFromRow()` 覆蓋返個 form。Playwright
  // 打字快過網絡一個 round trip，如果唔等呢個 response 完成先開始
  // `.fill()`，撳「編輯」之後即刻打嘅字會俾呢個遲到嘅 response 覆蓋
  // 沖走（打字冇咗）——呢度等埋先至算「真係開好」，等落面逐個 `.fill()`
  // 唔會撞正呢個覆蓋時機。
  const detailResponse = page.waitForResponse((r) => /\/api\/guards\/[^/?]+$/.test(r.url()) && r.request().method() === "GET").catch(() => null);
  await row.getByRole("button", { name: "編輯" }).click();
  await expect(page.getByRole("heading", { name: "編輯保安員" })).toBeVisible({ timeout: 10_000 });
  await detailResponse;
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
  // Opus 覆核（WP-MULTI 必修 3 連帶）：下面會經「地址」／「緊急聯絡人
  // 姓名／電話」三個舊寫法欄觸發 `applyLegacyGuardContactPatch()`，喺
  // `guard_addresses`／`guard_emergency_contacts` 起新行——記低測試開始
  // 之前呢個（真實）guard 已經有嘅行 id／legacy 欄原值，等 `finally`
  // 淨係刪走測試自己起低嘅新行、將 legacy 欄還原做「原本嘅值」（唔係
  // 一律硬寫 null——如果呢個 guard 本身已經有地址/緊急聯絡人資料，寫
  // null 會將佢哋隱藏埋，同 WP-MULTI「唔准將 legacy 值寫成 null 令佢
  // 消失」嘅鐵則相違背）。
  const beforeContacts = await prisma.guard.findUniqueOrThrow({
    where: { id: guard.id },
    select: { address: true, emergencyContactName: true, emergencyContactTel: true },
  });
  const beforeAddressIds = (await prisma.guardAddress.findMany({ where: { guardId: guard.id }, select: { id: true } })).map((r) => r.id);
  const beforeContactIds = (await prisma.guardEmergencyContact.findMany({ where: { guardId: guard.id }, select: { id: true } })).map((r) => r.id);
  try {
    await loginAs(page, "老闆");
    await page.goto("/guards");
    await openEditByName(page, guard.nameZh);

    // P3-4.3：Drawer 分 tab（基本／證件／聯絡／長工／銀行），逐個 tab 填。
    await page.getByTestId("guard-tab-docs").click();
    // 牌照與證件。WP-STAFFNO：「牌照類別」而家係衍生顯示值（唔再係
    // select，見 deriveSiaPermitExpiry()）——填甲類到期日先會令佢顯示
    // "A"。
    await fieldControl(page, "牌照號碼").locator("input").fill("SIA-E2E-01");
    await fieldControl(page, "甲類到期").locator("input").fill("2027-06-01");

    // 個人資料。
    await page.getByTestId("guard-tab-basic").click();
    await fieldControl(page, "身份證號碼").locator("input").fill(TEST_HKID);
    await fieldControl(page, "出生日期").locator("input").fill("1990-05-01");
    await fieldControl(page, "地址").locator("input").fill("測試地址一段街 1 號");
    await fieldControl(page, "緊急聯絡人姓名").locator("input").fill("測試緊急聯絡人");
    await fieldControl(page, "緊急聯絡人電話").locator("input").fill("61009900");

    // Blacklist。
    await page.getByTestId("guard-tab-docs").click();
    await fieldControl(page, "Check 結果").locator("select").selectOption("clear");
    await fieldControl(page, "Check 日期").locator("input").fill("2026-01-01");

    // 銀行——「銀行」係「戶口號碼」以外冇其他重疊 label，但要 anchor
    // 住，唔係就會撞中下面「戶口號碼」欄本身 label 冇含「銀行」呢個
    // 字，其實唔會撞，anchor 純粹保險。
    await page.getByTestId("guard-tab-bank").click();
    await fieldControl(page, "銀行", true).locator("input").fill("測試銀行");
    await fieldControl(page, "戶口號碼").locator("input").fill("123-456789-001");
    await fieldControl(page, "收款人名").locator("input").fill(guard.nameZh);

    await page.getByRole("button", { name: "儲存" }).click();
    await expect(page.getByText("已更新")).toBeVisible({ timeout: 15_000 });

    // 重開見全號（詳情/編輯有權先見全號）。
    await openEditByName(page, guard.nameZh);
    await expect(fieldControl(page, "身份證號碼").locator("input")).toHaveValue(TEST_HKID_STORED);
    await expect(fieldControl(page, "銀行", true).locator("input")).toHaveValue("測試銀行");
    await expect(fieldControl(page, "牌照號碼").locator("input")).toHaveValue("SIA-E2E-01");
    await expect(fieldControl(page, "甲類到期").locator("input")).toHaveValue("2027-06-01");
    await expect(fieldControl(page, "牌照類別（自動計）")).toContainText("A");

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
    expect(detailBody.hkid).toBe(TEST_HKID_STORED);
  } finally {
    // 清走呢個 test 填低嘅測試值——PATCH schema 嘅新欄係
    // optional（唔係 nullable），API 冇辦法「清返做 null」，直接用
    // Prisma 還原（同 pricing.spec.ts「鐵律：唔可以留低污染畀下一次
    // 跑」一致精神，見該檔案 (b) 場景嘅 finally block）。
    //
    // WP-MULTI 必修 3 連帶：淨係刪走測試自己起低嘅 `guard_addresses`／
    // `guard_emergency_contacts` 新行（`notIn` 空陣列＝冇排除任何一
    // 行，即係全刪——同「測試開始之前 0 行」嘅前提一致），`address`／
    // `emergency_contact_*` 還原返「測試之前」嘅值（一般都係 null，但
    // 保留住萬一唔係嘅可能性）。
    await prisma.guardAddress.deleteMany({ where: { guardId: guard.id, id: { notIn: beforeAddressIds } } });
    await prisma.guardEmergencyContact.deleteMany({ where: { guardId: guard.id, id: { notIn: beforeContactIds } } });
    await prisma.guard.update({
      where: { id: guard.id },
      data: {
        hkid: null,
        dateOfBirth: null,
        address: beforeContacts.address,
        emergencyContactName: beforeContacts.emergencyContactName,
        emergencyContactTel: beforeContacts.emergencyContactTel,
        blacklistCheckResult: null,
        blacklistCheckDate: null,
        bankName: null,
        bankAccountNo: null,
        bankPayeeName: null,
        siaPermitNo: null,
        siaPermitType: null,
        siaPermitAExpiry: null,
        siaPermitBExpiry: null,
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

    await page.getByTestId("guard-tab-docs").click();
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

test("(e) 主管編輯一個長工只改電話 → 儲存成功（唔會被冇改嘅 monthly_salary field-group 誤 403，見 Opus 驗收必修 2）", async ({ page }) => {
  const guard = await prisma.guard.findFirstOrThrow({
    where: { employmentType: "longterm_autopay", status: "active", monthlySalary: { not: null } },
    select: { id: true, nameZh: true, tel: true, monthlySalary: true },
  });
  const originalTel = guard.tel;
  const newTel = "61234567";
  try {
    await loginAs(page, "主管");
    await page.goto("/guards");
    await openEditByName(page, guard.nameZh);

    await fieldControl(page, "電話", true).locator("input").fill(newTel);
    await page.getByRole("button", { name: "儲存" }).click();
    await expect(page.getByText("已更新")).toBeVisible({ timeout: 15_000 });

    const after = await prisma.guard.findUniqueOrThrow({ where: { id: guard.id }, select: { tel: true, monthlySalary: true } });
    expect(after.tel).toBe(newTel);
    expect(after.monthlySalary?.toString()).toBe(guard.monthlySalary?.toString());
  } finally {
    await restoreGuardTel(guard.id, originalTel, [newTel]);
  }
});

test("(d) 到期 pill 三種狀態：已過期（紅）／90 日內（橙）／未填（灰）", async ({ page }) => {
  const guard = await findBrokerAOwnGuard();
  // 還原原值而唔係硬寫 null（可接受但順手：萬一呢個 guard 本身喺呢個
  // test 之前已經有 siaPermitAExpiry/siaPermitBExpiry，硬寫 null 會令
  // test 完咗之後同入 test 之前個狀態唔一致，留低污染）。
  //
  // WP-STAFFNO S5（Opus 驗收修復）：`sia_permit_expiry` 而家係讀取時
  // 由 `sia_permit_a_expiry`／`sia_permit_b_expiry`（+ 出生日期）現算
  // 嘅衍生值（見 src/app/api/guards/[id]/route.ts withDerivedGuard()），
  // 直接寫舊嘅 `siaPermitExpiry` 欄唔會再反映落 response——呢度改寫
  // `siaPermitAExpiry`（甲類到期）先會令現算出嚟嘅 `sia_permit_expiry`
  // 跟住變。
  const originalGuard = await prisma.guard.findUniqueOrThrow({
    where: { id: guard.id },
    select: { siaPermitAExpiry: true, siaPermitBExpiry: true },
  });
  const today = new Date();
  const expired = new Date(today.getTime() - 10 * 86_400_000).toISOString().slice(0, 10);
  const soon = new Date(today.getTime() + 30 * 86_400_000).toISOString().slice(0, 10);

  try {
    await loginAs(page, "老闆");

    // 已過期。
    await prisma.guard.update({ where: { id: guard.id }, data: { siaPermitAExpiry: new Date(expired), siaPermitBExpiry: null } });
    await page.goto("/guards");
    await page.getByPlaceholder("姓名 / 工號 / 電話").fill(guard.nameZh);
    let row = page.locator("main table tbody tr", { hasText: guard.nameZh }).first();
    await expect(row).toBeVisible({ timeout: 20_000 });
    await expect(row.getByText("已過期")).toBeVisible();

    // 90 日內。
    await prisma.guard.update({ where: { id: guard.id }, data: { siaPermitAExpiry: new Date(soon), siaPermitBExpiry: null } });
    await page.reload();
    await page.getByPlaceholder("姓名 / 工號 / 電話").fill(guard.nameZh);
    row = page.locator("main table tbody tr", { hasText: guard.nameZh }).first();
    await expect(row).toBeVisible({ timeout: 20_000 });
    await expect(row.getByText("90 日內")).toBeVisible();

    // 未填。
    await prisma.guard.update({ where: { id: guard.id }, data: { siaPermitAExpiry: null, siaPermitBExpiry: null } });
    await page.reload();
    await page.getByPlaceholder("姓名 / 工號 / 電話").fill(guard.nameZh);
    row = page.locator("main table tbody tr", { hasText: guard.nameZh }).first();
    await expect(row).toBeVisible({ timeout: 20_000 });
    await expect(row.getByText("未填")).toBeVisible();
  } finally {
    await prisma.guard.update({
      where: { id: guard.id },
      data: { siaPermitAExpiry: originalGuard.siaPermitAExpiry, siaPermitBExpiry: originalGuard.siaPermitBExpiry },
    });
  }
});

// Fable5.1（4 個細修 4，防資料被抹）：`openEdit()` 先用列表 row 起草 form
// （列表 DTO 冇 date_of_birth 等 detail-only 欄，見
// src/lib/api/dto/index.ts GUARD_LIST_DETAIL_ONLY_FIELDS），detail GET
// （`GET /api/guards/:id`）先真正攞到呢批欄嘅值。`onSubmit()` 呢批欄一律
// `|| null` 送——如果 detail GET 未完成或者失敗就撳「儲存」，會將空字串
// 當「清空」送落 DB。呢兩個 test 分別覆蓋「detail GET 遲返 → Save 掣
// disabled」／「detail GET 失敗（500）→ 儲存唔會清走已有 date_of_birth」，
// 見 src/app/(app)/guards/GuardsClient.tsx openEdit()／onSubmit() 註解。
test("(f) detail GET 遲返 → Save 掣 disabled 顯示「載入中…」，detail 到咗先解鎖", async ({ page }) => {
  const guard = await findBrokerAOwnGuard();
  await loginAs(page, "老闆");
  await page.goto("/guards");
  await expect(page.locator("main").getByText("載入緊…")).toHaveCount(0, { timeout: 20_000 });
  await page.getByPlaceholder("姓名 / 工號 / 電話").fill(guard.nameZh);
  const row = page.locator("main table tbody tr", { hasText: guard.nameZh }).first();
  await expect(row).toBeVisible({ timeout: 20_000 });

  // 攔截 detail GET，等我哋主動 release 先俾佢繼續——模擬「未返嚟」呢段
  // 空窗期，睇下 Save 掣喺呢段時間會唔會 disabled。
  let releaseDetail: () => void = () => {};
  const detailGate = new Promise<void>((resolve) => {
    releaseDetail = resolve;
  });
  await page.route(
    (url) => url.pathname === `/api/guards/${guard.id}` && url.search === "",
    async (route) => {
      await detailGate;
      await route.continue();
    },
  );

  await row.getByRole("button", { name: "編輯" }).click();
  await expect(page.getByRole("heading", { name: "編輯保安員" })).toBeVisible({ timeout: 10_000 });

  const saveBtn = page.locator('form button[type="submit"]');
  await expect(saveBtn).toHaveText("載入中…");
  await expect(saveBtn).toBeDisabled();

  releaseDetail();
  await expect(saveBtn).toHaveText("儲存", { timeout: 10_000 });
  await expect(saveBtn).toBeEnabled();

  // WP-STAFFNO（業務規則 (4)）：員工編號分區而家有一個「取消呢個號」按
  // 鈕，同呢個抽屜關閉用嘅「取消」撞 substring——用 `exact: true` 分開。
  await page.getByRole("button", { name: "取消", exact: true }).click();
});

test("(g) detail GET 失敗（500，包括冇權睇嗰類 403 一致對待）→ 儲存 DB 嘅 date_of_birth 唔會被清走", async ({ page }) => {
  const guard = await findBrokerAOwnGuard();
  const before = await prisma.guard.findUniqueOrThrow({ where: { id: guard.id }, select: { dateOfBirth: true, tel: true } });
  const originalDob = new Date("1985-03-15T00:00:00.000Z");
  await prisma.guard.update({ where: { id: guard.id }, data: { dateOfBirth: originalDob } });
  const newTel = "61009901";
  try {
    await loginAs(page, "老闆");
    await page.goto("/guards");
    await expect(page.locator("main").getByText("載入緊…")).toHaveCount(0, { timeout: 20_000 });
    await page.getByPlaceholder("姓名 / 工號 / 電話").fill(guard.nameZh);
    const row = page.locator("main table tbody tr", { hasText: guard.nameZh }).first();
    await expect(row).toBeVisible({ timeout: 20_000 });

    // 淨係攔截 GET（detail）——PATCH（儲存）同一個 URL path 唔可以一齊
    // 中招，唔係就個「儲存」request 本身都會俾呢個 500 攔截，測試唔到
    // 想驗證嘅嘢（detail 失敗之後嘅儲存應該正常成功）。
    await page.route(
      (url) => url.pathname === `/api/guards/${guard.id}` && url.search === "",
      async (route) => {
        if (route.request().method() !== "GET") {
          await route.continue();
          return;
        }
        await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "server_error", message: "e2e 模擬 500" }) });
      },
    );

    await row.getByRole("button", { name: "編輯" }).click();
    await expect(page.getByRole("heading", { name: "編輯保安員" })).toBeVisible({ timeout: 10_000 });

    const saveBtn = page.locator('form button[type="submit"]');
    // detail GET 已經完成（雖然失敗），Save 掣要解鎖返（唔可以卡死喺
    // 「載入中…」）——淨係唔送 detail-only 欄。
    await expect(saveBtn).toHaveText("儲存", { timeout: 10_000 });
    await expect(saveBtn).toBeEnabled();

    // 淨係改電話（列表 DTO 本身有嘅欄）——冇掂 date_of_birth。
    await fieldControl(page, "電話", true).locator("input").fill(newTel);
    await saveBtn.click();
    await expect(page.getByText("已更新")).toBeVisible({ timeout: 15_000 });

    const after = await prisma.guard.findUniqueOrThrow({ where: { id: guard.id }, select: { dateOfBirth: true, tel: true } });
    expect(after.dateOfBirth?.toISOString().slice(0, 10)).toBe("1985-03-15");
    expect(after.tel).toBe(newTel);
  } finally {
    await prisma.guard.update({ where: { id: guard.id }, data: { dateOfBirth: before.dateOfBirth } });
    await restoreGuardTel(guard.id, before.tel, [newTel]);
  }
});
