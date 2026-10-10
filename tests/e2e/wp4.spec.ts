// P1-WP4 Playwright e2e（P1-執行計劃.md §4 WP4 item 7）。用現成 seed 數據
// （見 tests/e2e/db-helpers.ts）。斷言唔寫真名——全部用 DB 查出嚟嘅
// id/代號比對（PDPO）。月結鎖定流程用一個專用嘅新月份（2026-10，
// 由 months/open 開，唔會撞其他 e2e spec 用緊嘅 2026-08，亦唔會掂真實
// 7 月數據），流程尾聲解返鎖，留低乾淨狀態俾下次重跑。
import { test, expect } from "@playwright/test";
import { loginAs } from "./helpers";
import { prisma } from "./db-helpers";

test.describe.configure({ mode: "serial" });

const LOCK_TEST_MONTH = "2026-10";

test("(a) 老闆登入 → 毛利即時表切去 7 月 → 展開一個盤見到更別明細", async ({ page }) => {
  await loginAs(page, "老闆");
  await page.goto("/reports/gross-margin");
  await page.locator('input[type="month"]').fill("2026-07");
  // 隨便揀一個一定有活動嘅盤（啟航1331）展開，見到更別 breakdown 出現。
  const siteRow = page.getByText("啟航1331", { exact: false }).first();
  await expect(siteRow).toBeVisible({ timeout: 20_000 });
  await siteRow.click();
  await expect(page.locator("table tbody tr").first()).toBeVisible();
});

// P3-3.4（老闆 3A）：鎖月／解鎖只喺 `/month-close`（一鍵結算）頁做；`/reports/monthly-close`
// 只顯示狀態＋連結。一鍵結算 run 嘅報告用 page.route 假（ready_to_lock），但 generate／lock／unlock
// 係打真 API，鎖月結果用 API 核對。
function mcRun(month: string, locked: boolean) {
  const mk = (key: string, label: string, numbers: Record<string, unknown>) => ({ key, label, status: "done", started_at: "2026-10-10T05:33:00.000Z", finished_at: "2026-10-10T05:33:02.000Z", numbers, warnings: [], needs_human: [] });
  return {
    id: "run-e2e-wp4",
    month,
    status: "done",
    started_at: "2026-10-10T05:33:00.000Z",
    finished_at: "2026-10-10T05:33:09.000Z",
    current_step: null,
    stalled: false,
    steps_total: 10,
    steps_done: 10,
    totals: null,
    error_message: null,
    steps: [mk("precheck", "前置檢查", { currentMonthLocked: locked }), mk("report", "報告", {})],
    report: {
      month,
      totals: { revenue: 0, margin_revenue: 0, cost: 0, gross_margin: 0, cost_basis: "combined", legacy_cost: 0, legacy_margin: 0 },
      payroll_by_broker: [],
      site_revenue: [],
      referral_fee: { total: 0, count: 0 },
      unpriced: { count: 0, payout_count: 0, client_count: 0, no_settlement_count: 0, ot_unpriced_count: 0, gap: { records: 0, client_gap_estimate: 0, payout_gap_estimate: 0, no_reference_records: 0 } },
      auto: null,
      postorder_compare: null,
      needs_human: [],
      lock_precondition: { current_month_already_locked: locked, missing_upload_sites: [], unconfirmed_upload_sites: [], unpriced_count: 0, ready_to_lock: !locked },
      longterm_payroll_note: "",
      longterm_payroll: null,
      combined_cost_summary: { per_shift_cost_total: 0, referral_fee_total: 0, longterm_autopay_total: 0, combined_cost_total: 0, mpf_er_total: 0 },
    },
  };
}

test("(b) 老闆：開新月份 → 月結總表生成 → 睇對數結果（冇鎖定掣）→ 一鍵結算頁鎖定 → 改更表被擋 → 解鎖", async ({ page }) => {
  await loginAs(page, "老闆");

  // 開新月份（months/open 冇對應 UI 掣，屬於盤管理/roster 流程嘅後台
  // 步驟，呢度直接用瀏覽器已登入嘅 session 打 API 做前置 setup，同
  // db-helpers.ts 嘅角色一致——唔係應用程式本身嘅一部分）。
  const openRes = await page.request.post(`/api/months/${LOCK_TEST_MONTH}/open`, { data: { roster_version_note: "e2e wp4" } });
  expect([200, 201, 409]).toContain(openRes.status()); // 409 = 已經開過（重跑）

  await page.goto(`/reports/monthly-close?month=${LOCK_TEST_MONTH}`);
  await page.getByTestId("generate-month-close").click();

  await expect(page.getByTestId("recon-rules-title")).toHaveText("五條自動對數規則", { timeout: 20_000 });
  await expect(page.getByText(/現金糧批次總額/).first()).toBeVisible();
  await expect(page.getByText(/未啟用/).first()).toBeVisible(); // 規則4 P3 未做
  // 月結總表頁冇鎖定／解鎖掣，只有去一鍵結算嘅連結
  await expect(page.getByRole("button", { name: /^鎖定/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^解鎖/ })).toHaveCount(0);
  await expect(page.getByTestId("goto-month-close")).toHaveAttribute("href", `/month-close?month=${LOCK_TEST_MONTH}`);

  // 一鍵結算頁（run 報告假、其餘真 API）：右欄鎖定
  let reportLocked = false;
  await page.route("**/api/month-close/one-click?*", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ runs: [mcRun(LOCK_TEST_MONTH, reportLocked)] }) }));
  await page.route("**/api/month-close/one-click/run-e2e-wp4", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ run: mcRun(LOCK_TEST_MONTH, reportLocked) }) }));
  await page.goto(`/month-close?month=${LOCK_TEST_MONTH}`);
  const lockBtn = page.getByTestId("rail-lock-month");
  await expect(lockBtn).toBeEnabled({ timeout: 20_000 });
  await lockBtn.click();
  await expect(page.getByText(`${LOCK_TEST_MONTH} 已鎖定`).first()).toBeVisible({ timeout: 15_000 });
  const closes = await (await page.request.get(`/api/month-closes?month=${LOCK_TEST_MONTH}`)).json();
  expect(closes.rows[0].locked_at).toBeTruthy();

  // 鎖定之後試喺更表編輯器改呢個月嘅格——應該被擋（RosterEditor.tsx
  // 見到 monthClose.locked_at 就顯示鎖定提示，唔會俾人再改格）。
  const site = await prisma.site.findFirstOrThrow({ where: { status: "active" } });
  await page.goto(`/roster/${site.id}/${LOCK_TEST_MONTH}`);
  await expect(page.getByText(/鎖定/).first()).toBeVisible({ timeout: 20_000 });

  // 解鎖：一鍵結算頁 LockSection（已鎖定先出現）
  reportLocked = true;
  await page.goto(`/month-close?month=${LOCK_TEST_MONTH}`);
  await expect(page.getByTestId("unlock-box")).toBeVisible({ timeout: 20_000 });
  await page.getByTestId("unlock-reason").fill("e2e wp4 測試完畢解鎖");
  await page.getByTestId("unlock-month").click();
  await expect(page.getByText(`${LOCK_TEST_MONTH} 已解鎖`).first()).toBeVisible({ timeout: 15_000 });
  const after = await (await page.request.get(`/api/month-closes?month=${LOCK_TEST_MONTH}`)).json();
  expect(after.rows[0].locked_at).toBeNull();
});

test("(c) 雞頭登入 → 本月應收 → 見到自己 7 月嘅更數同金額", async ({ page }) => {
  await loginAs(page, "雞頭A");
  await page.goto("/my-receivable");
  await page.locator('input[type="month"]').fill("2026-07");
  await expect(page.getByText(/合計/).first()).toBeVisible({ timeout: 20_000 });
  // 表格應該有至少一行（代號 K 雞頭 7 月一定有出更）。
  await expect(page.locator("table tbody tr").first()).toBeVisible({ timeout: 20_000 });
});

test.afterAll(async () => {
  await prisma.$disconnect();
});
