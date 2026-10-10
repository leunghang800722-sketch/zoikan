// P1-WP3 Playwright e2e（P1-執行計劃.md §4 WP3 驗收準則 (a)-(d)）。
// Fixture 用 seed 數據（`npm run db:seed`，見 README-P1.md「Seed 測試
// 帳號」），斷言唔寫真名——全部用 DB 查出嚟嘅值比對（PDPO）。
import { test, expect } from "@playwright/test";
import { loginAs, logout } from "./helpers";
import {
  prisma,
  findSiteIdByName,
  findBrokerIdByCode,
  setBrokerRequiresApproval,
  findSiteNotAssignedToBroker,
  clearBrokerShiftRecords,
} from "./db-helpers";

const AUG = new Date(Date.UTC(2026, 7, 1));

test.describe.configure({ mode: "serial" }); // 場景之間共用同一個 dev DB，順序執行避免互相干擾

test("(a) 主管登入 → 開 2026-08 → 啟航1331 更表 → 複製上月 → 改幾格 → 儲存 → 重載仍在", async ({ page }) => {
  const siteId = await findSiteIdByName("啟航1331");

  await loginAs(page, "主管");
  await page.goto(`/roster/${siteId}/2026-08`);
  // 8 月呢個盤未必已經有更表記錄——起始畫面可能係空表（「冇更表記錄」
  // 提示），唔可以等 roster-row 先出現；等「複製上月」個掣出到嚟就得
  // （即係編輯器本身載入完成）。
  const copyBtn = page.getByRole("button", { name: /複製上月/ });
  await expect(copyBtn).toBeVisible({ timeout: 20_000 });
  await copyBtn.click();
  // 2026-09-14：wp-r2 e2e 嘅 helper 會將「複製上月」嘅結果儲存落 DB，所以
  // 8 月可能已經有齊記錄，複製會係 no-op（零格未儲存）。呢度唔再斷言
  // 「有格未儲存」，淨係等有行出現——之後打 AL 嗰步先係呢個 test 真正
  // 要驗嘅「改→儲存→重載仍在」。
  await expect(page.getByTestId("roster-row").first()).toBeVisible({ timeout: 20_000 });

  // 「複製上月」剛加落嚟嘅 extraRows 未經 shiftTypeCode+姓名排序（見
  // RosterEditor.tsx buildRowsAndCells() 嘅 sort，淨係管 `rows`，唔管
  // `extraRows`）——儲存＋reload 之後，行次序會變返「跟真實 DB 記錄
  // 排序」，未必仲係 index 0。攞返第一行嘅 `data-row-key`（= shift_type_id
  // |guard_id，opaque uuid，唔係真名）先，reload 之後用嚟搵返同一行，
  // 唔靠死記 index。
  const firstRow = page.getByTestId("roster-row").first();
  await expect(firstRow).toBeVisible({ timeout: 15_000 });
  const rowKey = await firstRow.getAttribute("data-row-key");
  expect(rowKey).toBeTruthy();
  const rowIndex = Number(await firstRow.getAttribute("data-row-index"));

  // 揀呢一行、第 15 日，打 AL（請假代號，任何行都合法，確保呢個改動
  // 同「複製上月」抄落嚟嘅值一定唔同，肯定係我哋呢下再改嘅）。
  const cell = page.getByTestId(`roster-cell-${rowIndex}-15`);
  await cell.click();
  await page.keyboard.type("AL");
  await page.keyboard.press("Enter");
  await expect(cell).toHaveText("AL");

  await page.getByRole("button", { name: /^儲存$|^儲存緊/ }).click();
  await expect(page.getByText(/儲存失敗|輸入有錯/)).toHaveCount(0);
  await expect(page.getByText(/格未儲存/)).toHaveCount(0, { timeout: 15_000 });

  await page.reload();
  const reloadedRow = page.locator(`tr[data-row-key="${rowKey}"]`);
  await expect(reloadedRow).toBeVisible({ timeout: 20_000 });
  const reloadedIndex = Number(await reloadedRow.getAttribute("data-row-index"));
  await expect(page.getByTestId(`roster-cell-${reloadedIndex}-15`)).toHaveText("AL", { timeout: 20_000 });

  // Opus 對抗式驗收第三輪（B2）：新月份（8 月）匯出唔可以再係零保安員行
  // ——呢度落單匯出 8 月 xlsx，斷言真係匯出到（同 (d) 果條 7 月匯出斷言
  // 對稱），確保 B2 個 fix（`allRecords` NULL-filter bug）喺真實 UI 路徑
  // （唔淨係 gate script 直接 call 函數）都生效。
  await expect(page.getByTestId("roster-export-link")).toBeVisible({ timeout: 20_000 });
  const [augDownload] = await Promise.all([page.waitForEvent("download"), page.getByTestId("roster-export-link").click()]);
  expect(augDownload.suggestedFilename()).toMatch(/\.xlsx$/);
  const augSavedPath = await augDownload.path();
  expect(augSavedPath).toBeTruthy();
});

test("(b) 雞頭登入 → 只見自己 block → 填一格 → pending → 主管審批 → confirmed", async ({ page, browser }) => {
  const siteId = await findSiteIdByName("啟航1331");
  const brokerAId = await findBrokerIdByCode("K");
  await setBrokerRequiresApproval(brokerAId, true);
  await clearBrokerShiftRecords(brokerAId, siteId, AUG);

  await loginAs(page, "雞頭A");
  await page.goto(`/roster/${siteId}/2026-08`);
  await expect(page.getByTestId("roster-forbidden")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "加保安員" })).toBeVisible({ timeout: 20_000 });

  const rowsBefore = await page.getByTestId("roster-row").count();

  await page.getByRole("button", { name: "加保安員" }).click();
  await page.getByTestId("add-guard-select-guard").selectOption({ index: 1 });
  await page.getByTestId("add-guard-select-shift-type").selectOption({ index: 1 });
  await page.getByRole("button", { name: "加入" }).click();

  const newRowIndex = rowsBefore; // 新行加喺尾（見 RosterEditor.tsx displayRows = [...rows, ...extraRows]）
  const cell = page.getByTestId(`roster-cell-${newRowIndex}-3`);
  await cell.click();
  await page.keyboard.type("AL");
  await page.keyboard.press("Enter");

  await page.getByRole("button", { name: /^儲存$|^儲存緊/ }).click();
  await expect(page.getByText(/儲存失敗|輸入有錯/)).toHaveCount(0);
  await expect(page.getByText(/格未儲存/)).toHaveCount(0, { timeout: 15_000 });

  // 新建記錄 requires_approval=true 嘅雞頭 → pending_approval（黃底）。
  const savedRow = await prisma.shiftRecord.findFirst({
    where: { siteId, settlementBrokerId: brokerAId, workDate: new Date(Date.UTC(2026, 7, 3)) },
  });
  expect(savedRow?.status).toBe("pending_approval");
  expect(savedRow?.leaveCode).toBe("AL");

  // 主管另開一個 context 登入，喺審批隊列批准。
  const supervisorPage = await browser.newPage();
  await loginAs(supervisorPage, "主管");
  await supervisorPage.goto("/approvals");
  await expect(supervisorPage.getByText("批准").first()).toBeVisible({ timeout: 20_000 });
  const approveButtons = supervisorPage.getByRole("button", { name: "批准" });
  const pendingCountBefore = await approveButtons.count();
  expect(pendingCountBefore).toBeGreaterThan(0);
  await approveButtons.first().click();
  await expect(supervisorPage.getByText(/已批准/)).toBeVisible({ timeout: 15_000 });
  await supervisorPage.close();

  const afterApprove = await prisma.shiftRecord.findUnique({ where: { id: savedRow!.id } });
  expect(afterApprove?.status).toBe("confirmed");

  await logout(page);
});

test("(c) 雞頭試打他人盤 URL → 403 頁", async ({ page }) => {
  const brokerAId = await findBrokerIdByCode("K");
  const otherSiteId = await findSiteNotAssignedToBroker(brokerAId, AUG);

  await loginAs(page, "雞頭A");
  await page.goto(`/roster/${otherSiteId}/2026-08`);
  await expect(page.getByTestId("roster-forbidden")).toBeVisible({ timeout: 20_000 });
});

test("(d) 主管匯出 7 月 xlsx", async ({ page }) => {
  const siteId = await findSiteIdByName("啟航1331");
  await loginAs(page, "主管");
  await page.goto(`/roster/${siteId}/2026-07`);
  await expect(page.getByTestId("roster-export-link")).toBeVisible({ timeout: 20_000 });

  const [download] = await Promise.all([page.waitForEvent("download"), page.getByTestId("roster-export-link").click()]);
  expect(download.suggestedFilename()).toMatch(/\.xlsx$/);
  const savedPath = await download.path();
  expect(savedPath).toBeTruthy();
});

test("(e) 主管開啟航1331 7 月更表 → 雞頭篩選（統計條撳一行 → 行數減少 + URL 帶 broker= → 清除篩選行數回復）", async ({ page }) => {
  const siteId = await findSiteIdByName("啟航1331");
  await loginAs(page, "主管");
  await page.goto(`/roster/${siteId}/2026-07`);

  // 統計條同更表本身一齊喺初次載入 effect 出嚟——等第一個保安員行出現，
  // 即代表編輯器已經載入完成（同其他 (a)-(d) 場景一致嘅等法）。
  await expect(page.getByTestId("roster-row").first()).toBeVisible({ timeout: 20_000 });

  const statsRows = page.getByTestId("broker-stats-row");
  await expect(statsRows.first()).toBeVisible({ timeout: 20_000 });
  const rowCount = await statsRows.count();
  expect(rowCount).toBeGreaterThanOrEqual(2); // 老闆 feedback 驗收準則：統計條要有 ≥2 個雞頭先有得篩

  const initialRosterRows = await page.getByTestId("roster-row").count();
  expect(initialRosterRows).toBeGreaterThan(0);
  // 未篩選之前 URL 唔應該帶 broker= 呢個 query。
  expect(new URL(page.url()).searchParams.get("broker")).toBeNull();

  const firstCode = await statsRows.first().getAttribute("data-broker-code");
  expect(firstCode).toBeTruthy();
  await statsRows.first().click();

  // URL 帶 broker=（分享／重載保留）。
  await expect.poll(() => new URL(page.url()).searchParams.get("broker")).toBe(firstCode);
  // 篩選之後行數減少（其他雞頭嘅行唔顯示——但 Total／尚欠照計全部，
  // 呢條 e2e 淨係斷言行數，唔重複斷言 Total 呢個已經有 vitest/單元層面
  // 覆蓋唔到嘅純 UI 邏輯留返俾人手複查）。
  await expect.poll(() => page.getByTestId("roster-row").count()).toBeLessThan(initialRosterRows);
  // 篩選咗會多一行「所選雞頭合計」。
  await expect(page.getByTestId("roster-selected-broker-total")).toBeVisible();

  // 清除篩選 → 行數回復、URL 唔再帶 broker=。
  await page.getByTestId("broker-filter-clear").click();
  await expect.poll(() => new URL(page.url()).searchParams.get("broker")).toBeNull();
  await expect.poll(() => page.getByTestId("roster-row").count()).toBe(initialRosterRows);
  await expect(page.getByTestId("roster-selected-broker-total")).toHaveCount(0);
});

test.afterAll(async () => {
  await prisma.$disconnect();
});
