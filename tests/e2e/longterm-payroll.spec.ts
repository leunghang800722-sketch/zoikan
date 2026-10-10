// WP-LTPAY §21 任務 5d：`/reports/longterm-payroll` Playwright e2e。
// 2026-07 喺標準 dev seed 已經鎖定（`scripts/seed/index.ts`，其餘 e2e
// spec 好似 month-close-one-click.spec.ts 一致做法：長工糧要寫入
// （合約/人手輸入/重算）嘅測試一律用 2026-08——未鎖定）。
//
// 為咗完全唔靠任何真實保安員資料（PDPO：合成保安員，冇真名/真工號/真電話/
// 個別月薪/銀行帳號），呢個 spec 自己起一個獨立嘅測試盤／更別／長工
// （用 `test-e2e-longterm-payroll` 前綴，`afterAll` 清走），淨係借用
// 標準 seed 已經有嘅 `kind=internal_longterm`（B07）結算單位。
//
// 覆蓋：老闆開頁→重算→逐人結算出現→加一項津貼→重算→Autopay 合計數字變
// →下載 autopay CSV 存在；雞頭 403（nav 見唔到連結，直接打 URL 見錯誤
// banner）。
import { test, expect } from "@playwright/test";
import { loginAs } from "./helpers";
import { prisma } from "./db-helpers";

test.describe.configure({ mode: "serial" });

const AUG = new Date(Date.UTC(2026, 7, 1));
const RAND = Math.random().toString(36).slice(2, 8);
let guardId: string;
let contractId: string;
let siteId: string;
let shiftTypeId: string;

test.beforeAll(async () => {
  const b07 = await prisma.broker.findFirstOrThrow({ where: { kind: "internal_longterm", status: "active" } });

  const site = await prisma.site.create({ data: { canonicalName: `測試長工盤-e2e-${RAND}`, clientName: "測試客戶-e2e", billingModel: "per_shift", createdBy: "test-e2e" } });
  siteId = site.id;
  const shiftType = await prisma.shiftType.create({ data: { siteId, code: "N", label: "測試夜更", hours: 12, createdBy: "test-e2e" } });
  shiftTypeId = shiftType.id;

  const guard = await prisma.guard.create({
    data: {
      nameZh: `測試長工-e2e-${RAND}`,
      employmentType: "longterm_autopay",
      hireDate: new Date("2020-01-01"),
      bankName: "測試銀行",
      bankAccountNo: "6008887776",
      // WP-BOSS5 §25.4：BOCHK Payroll Editor 賬戶名稱淨係收 HKICL 字元
      // （0-9/空格/a-z/A-Z/&'()*+,-./$=），中文會被列做缺資料，改用英文
      // 合成名；bank_code（3 位 HKICL 編號）而家係必填先出到明細。
      bankPayeeName: "TEST PAYEE E2E",
      bankCode: "004",
      createdBy: "test-e2e",
    },
  });
  guardId = guard.id;

  const contract = await prisma.guardLongtermContract.create({
    data: { guardId, monthlySalary: 15000, effectiveFrom: new Date("2020-01-01"), effectiveTo: null, annualLeaveDays: 7, source: "manual", createdBy: "test-e2e" },
  });
  contractId = contract.id;

  for (let d = 1; d <= 20; d++) {
    await prisma.shiftRecord.create({
      data: {
        workDate: new Date(Date.UTC(2026, 7, d)),
        siteId,
        shiftTypeId,
        guardId,
        settlementBrokerId: b07.id,
        operationalBrokerId: b07.id,
        recordType: "shift",
        createdBy: "test-e2e",
      },
    });
  }
});

test.afterAll(async () => {
  await prisma.longtermPayrollLine.deleteMany({ where: { guardId } });
  await prisma.longtermPayrollRun.deleteMany({ where: { month: AUG } });
  await prisma.longtermPayrollInput.deleteMany({ where: { guardId } });
  await prisma.guardLeaveBalance.deleteMany({ where: { guardId } });
  await prisma.guardLongtermContract.deleteMany({ where: { id: contractId } });
  await prisma.shiftRecord.deleteMany({ where: { guardId } });
  await prisma.guard.deleteMany({ where: { id: guardId } });
  await prisma.shiftType.deleteMany({ where: { id: shiftTypeId } });
  await prisma.site.deleteMany({ where: { id: siteId } });
});

test("老闆：開頁→重算→逐人結算出現→加津貼→重算→Autopay 數字變→下載 autopay CSV", async ({ page }) => {
  await loginAs(page, "老闆");
  await page.goto("/reports/longterm-payroll");
  await page.locator('input[type="month"]').fill("2026-08");

  await page.getByRole("button", { name: "重算本月" }).click();
  await expect(page.getByText("重算完成")).toBeVisible({ timeout: 15_000 });

  const guardRowLocator = page.locator("tbody tr", { hasText: "／31" }).first();
  await expect(guardRowLocator).toBeVisible({ timeout: 10_000 });
  await expect(guardRowLocator).toContainText("20／31");

  const autopayCardValue = page.locator("text=Autopay 合計").locator("xpath=following-sibling::div").first();
  const autopayCardBefore = await autopayCardValue.innerText();

  // ③ 人手輸入區：加一項津貼
  await page.locator("select").first().selectOption({ index: 1 }); // 「請揀」之後嗰個就係我哋起嘅測試長工（呢個月淨係佢有合約）
  await page.locator("select").nth(1).selectOption("special_allowance");
  await page.locator('input[placeholder*="deduction"]').fill("500");
  await page.getByRole("button", { name: "新增" }).click();
  // getByText 會撞埋「種類」select 入面嗰個 <option>（strict mode
  // violation），用 cell role 淨係揀列表表格嗰行。
  await expect(page.getByRole("cell", { name: "津貼（勤工獎）" })).toBeVisible({ timeout: 10_000 });

  await page.getByRole("button", { name: "重算本月" }).click();
  // 「重算完成」呢句喺兩次重算之間文字可能一樣（都係嗰 1 人），單靠
  // getByText(...).toBeVisible() 唔可以保證真係等到*呢一次*嘅重算完成
  // （個 banner 可能一早已經喺度）。改用 Autopay 卡數值本身自動
  // polling 等到真係變咗（`recompute()` 成功之後會 `load()` 重新攞
  // 埋最新 totals），唔靠 banner 文字判斷。
  await expect(autopayCardValue).not.toHaveText(autopayCardBefore, { timeout: 15_000 });

  // ⑥ BOCHK autopay 檔（WP-BOSS5 §25.4：BOCHK Payroll Editor 格式
  // xlsx，唔再係 CSV）：下載（有齊銀行資料嘅保安員應該出現喺明細入面）
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("link", { name: "下載 BOCHK Payroll Editor 格式（貼入 Editor 產生 .DAT）" }).click(),
  ]);
  const path = await download.path();
  expect(path).toBeTruthy();
  expect(download.suggestedFilename()).toBe("longterm-autopay-BOCHK-PayrollEditor-2026-08.xlsx");
});

test("雞頭：nav 見唔到「長工糧」連結，直接打 URL 見 403 banner", async ({ page }) => {
  await loginAs(page, "雞頭A");
  await expect(page.getByRole("link", { name: "長工糧" })).toHaveCount(0);

  await page.goto("/reports/longterm-payroll");
  await expect(page.getByText(/硬性禁止 長工糧:view/)).toBeVisible({ timeout: 10_000 });
});

// Opus 5.5 驗收（2026-09-27）：主管／保安員都要 403（任務書「雞頭／主管／
// 保安員 403」）；Maxwell CSV 路徑（正式站操作員淨係可以傳 CSV）。
test("主管／保安員：nav 見唔到「長工糧」，直接打 URL 見 403 banner", async ({ page }) => {
  for (const who of ["主管", "安員"] as const) {
    await page.context().clearCookies();
    await loginAs(page, who);
    await expect(page.getByRole("link", { name: "長工糧" })).toHaveCount(0);
    await page.goto("/reports/longterm-payroll");
    await expect(page.getByText(/硬性禁止 長工糧:view/)).toBeVisible({ timeout: 10_000 });
  }
});

test("老闆：Maxwell 導入（CSV）——在職／離職兩個 CSV 上載，通知顯示行數（對唔到嘅行列出，唔會亂配）", async ({ page }) => {
  await loginAs(page, "老闆");
  await page.goto("/reports/longterm-payroll");
  const header = Array.from({ length: 30 }, (_, i) => (i === 2 ? "Staff No." : i === 4 ? "Name" : "")).join(",");
  const row = Array.from({ length: 30 }, (_, i) => (i === 2 ? `MG9${RAND.slice(0, 3)}` : i === 4 ? `測試對唔到-${RAND}` : i === 17 ? "1/3/2024" : i === 22 ? '"$15,000"' : "")).join(",");
  await page.getByTestId("maxwell-active-csv").setInputFiles({ name: "active.csv", mimeType: "text/csv", buffer: Buffer.from(`Maxwell\r\n${header}\r\n${row}\r\n`) });
  await page.getByTestId("maxwell-left-csv").setInputFiles({ name: "left.csv", mimeType: "text/csv", buffer: Buffer.from(`Maxwell\r\n${header}\r\n`) });
  await page.getByRole("button", { name: "導入 CSV" }).click();
  await expect(page.getByText(/Maxwell 導入完成：1 行，建 0／更新 0，1 行對唔到保安員/)).toBeVisible({ timeout: 15_000 });
});
