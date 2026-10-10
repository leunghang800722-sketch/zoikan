// WP-POSTORDER-FREE（§34）：月結頁 ② 補齊價目卡掣＋④「冇 Postorder 都計到」一行；盤管理頁預設雞頭欄位＋建議／採用。
// 全部用 page.route 假 API（假盤名／假數字），唔依賴 dev DB 數據，亦唔郁真資料。
// 執行：PW_PORT=3000 npx playwright test tests/e2e/postorder-free.spec.ts
import { test, expect, type Page, type Route } from "@playwright/test";
import { loginAs } from "./helpers";

const MONTH = "2026-09";
const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

function runWith(over: { uploaded: boolean; withDependency: boolean }) {
  const mk = (key: string, label: string, numbers: Record<string, unknown>) => ({ key, label, status: "done", started_at: "2026-09-10T05:33:00.000Z", finished_at: "2026-09-10T05:33:02.000Z", numbers, warnings: [], needs_human: [] });
  const steps = [
    mk("precheck", "前置檢查", { prevMonthHasData: true, prevMonthLocked: true, siteMissingShiftTypeCount: 0, staffListAgeDays: 0, currentMonthLocked: false }),
    mk("parse_health", "解析健康", { uploadCount: 3, totalShiftCount: 100, varianceFlagged: 0, varianceExplained: 0 }),
    mk("auto_pricing", "自動歸屬／定價", { cardsCreated: 1, recordsPriced: 12, settlementAssigned: 3 }),
    mk("pricing_check", "定價檢查", { count: 0, payoutCount: 0, clientCount: 0, noSettlementCount: 0 }),
    mk("postorder_compare", "對照（可選）", { uploaded: over.uploaded, fileName: "PostOrder.csv", referralRowCount: 22, referralDiff: 0 }),
    mk("report", "報告", {}),
  ];
  const dependency = {
    pricing: { total: 200, unpriced: 20, by_step: { "1": 10, "2": 40, "3": 0, "4": 0, "5": 0, existing: 130 }, without_postorder: 140 },
    settlement: { total: 200, by_reason: { roster: 180, postorder: 10, unresolved: 2 }, without_postorder: 188 },
  };
  return {
    id: "run1",
    month: MONTH,
    status: "done",
    started_at: "2026-09-10T05:33:00.000Z",
    finished_at: "2026-09-10T05:33:09.000Z",
    current_step: null,
    stalled: false,
    steps,
    error_message: null,
    report: {
      month: MONTH,
      totals: { revenue: 1000, margin_revenue: 1000, cost: 500, gross_margin: 500, cost_basis: "combined", legacy_cost: 500, legacy_margin: 500 },
      payroll_by_broker: [{ broker_code: "W", broker_name: "測試雞頭", shifts: 80, amount: 1000 }],
      site_revenue: [{ site_id: "s1", site_name: "測試盤甲", shifts: 30, revenue: 90000 }],
      referral_fee: { total: 0, count: 0 },
      unpriced: { count: 0, payout_count: 0, client_count: 0, no_settlement_count: 0, ot_unpriced_count: 0, gap: null },
      auto: {
        summary: { sites_aliased: 0, sites_created: 0, shift_types_created: 0, aliases_from_postorder: 0, cards_created: 1, records_priced: 12, records_settled: 3, guard_matches_auto: 0, variances_explained: 0, variances_unexplained: 0, unpriced_records: 20, counts: { countable: 200, external: 0, internal_cash: 0 }, ...(over.withDependency ? { postorder_dependency: dependency } : {}) },
        auto_lines: [],
        review: [],
        triage_session_id: null,
        undone: false,
        undone_at: null,
      },
      postorder_compare: null,
      needs_human: [],
      lock_precondition: { current_month_already_locked: false, missing_upload_sites: [], unconfirmed_upload_sites: [], unpriced_count: 0, ready_to_lock: true },
      longterm_payroll_note: "",
      longterm_payroll: null,
      combined_cost_summary: { per_shift_cost_total: 500, referral_fee_total: 0, longterm_autopay_total: 0, combined_cost_total: 500, mpf_er_total: 0 },
    },
  };
}

async function mockMonthClose(page: Page, opts: { uploaded: boolean; withDependency: boolean; openBackfill: number }) {
  const calls: string[] = [];
  await page.route("**/api/month-close/one-click?*", (r) => json(r, { runs: [runWith(opts)] }));
  await page.route("**/api/reports/month-health?*", (r) => json(r, { month: MONTH, summary: { critical: 0, warn: 0, info: 0 }, findings: [] }));
  await page.route("**/api/rate-cards/backfill-from-postorder*", (r) => {
    if (r.request().method() === "POST") {
      calls.push(`POST ${(r.request().postDataJSON() as { month: string }).month}`);
      return json(r, { session_id: "sess-bf", created: 5, skipped_existing: 0, skipped_has_card: 0, skipped_no_records: 0, from_auto_cards: 3, from_postorder: 2, has_postorder: true });
    }
    calls.push("GET");
    return json(r, { session_id: opts.openBackfill > 0 ? "sess-bf" : null, open: opts.openBackfill, answered: 0, skipped: 0, total: opts.openBackfill });
  });
  return calls;
}

test.describe("月結頁：補齊價目卡＋唔靠 Postorder 比例", () => {
  test.use({ viewport: { width: 1440, height: 1000 } });

  test("④ 顯示『價錢：N／M … ；雞頭歸屬…』＋有未答補齊題先出『補齊價目卡 ›』；② 掣 call POST 並顯示『出咗 5 題』", async ({ page }) => {
    const calls = await mockMonthClose(page, { uploaded: true, withDependency: true, openBackfill: 4 });
    await loginAs(page, "老闆");
    await page.goto("/month-close");
    await page.getByTestId("month-close-month-input").fill(MONTH);
    await expect(page.getByTestId("auto-dependency")).toContainText("價錢：140／200 更唔靠 Postorder 都計到（70%）");
    await expect(page.getByTestId("auto-dependency")).toContainText("雞頭歸屬：188／200（94%）");
    const link = page.getByTestId("auto-dependency-backfill");
    await expect(link).toContainText("補齊價目卡 ›");
    await expect(link).toHaveAttribute("href", "/triage");
    // ② 區掣
    await expect(page.getByTestId("run-section")).toContainText("② 一鍵結算");
    await page.getByTestId("backfill-from-postorder").click();
    await expect(page.getByTestId("backfill-result")).toContainText("出咗 5 題");
    await expect(page.getByTestId("backfill-result").getByRole("link", { name: /去待答問題/ })).toHaveAttribute("href", "/triage");
    expect(calls).toContain(`POST ${MONTH}`);
  });

  test("冇補齊 session 未答題 → 唔出『補齊價目卡 ›』；冇 Postorder 上載 → 唔出 ② 掣；舊 report（冇欄）→ 唔出比例行", async ({ page }) => {
    await mockMonthClose(page, { uploaded: false, withDependency: true, openBackfill: 0 });
    await loginAs(page, "老闆");
    await page.goto("/month-close");
    await page.getByTestId("month-close-month-input").fill(MONTH);
    await expect(page.getByTestId("auto-dependency")).toBeVisible();
    await expect(page.getByTestId("auto-dependency-backfill")).toHaveCount(0);
    await expect(page.getByTestId("backfill-from-postorder")).toHaveCount(0);
    // 舊 report
    await page.unroute("**/api/month-close/one-click?*");
    await page.route("**/api/month-close/one-click?*", (r) => json(r, { runs: [runWith({ uploaded: true, withDependency: false })] }));
    await page.reload();
    await page.getByTestId("month-close-month-input").fill(MONTH);
    await expect(page.getByTestId("auto-summary")).toBeVisible();
    await expect(page.getByTestId("auto-dependency")).toHaveCount(0);
  });
});

test.describe("盤管理頁：盤預設結算雞頭", () => {
  test("開編輯抽屜見預設雞頭欄＋建議；撳採用 PATCH default_settlement_broker_id；列表 request 集合唔加 /api/brokers", async ({ page }) => {
    const patches: Array<Record<string, unknown>> = [];
    const requested: string[] = [];
    const site = { id: "s1", canonical_name: "測試預設盤", aliases: [], client_name: "測試客", billing_model: "per_shift", in_scope: true, outside_monthly_close: false, guards_paid_by_client: false, status: "active", default_settlement_broker_id: null as string | null };
    page.on("request", (r) => {
      if (r.url().includes("/api/")) requested.push(new URL(r.url()).pathname);
    });
    await page.route("**/api/sites?*", (r) => json(r, { rows: [site], total: 1, skip: 0, take: 500 }));
    await page.route("**/api/shift-types?*", (r) => json(r, { rows: [], total: 0, skip: 0, take: 500 }));
    await page.route("**/api/brokers?*", (r) => json(r, { rows: [{ id: "b1", code: "TW", name: "測試雞頭W", status: "active" }, { id: "b2", code: "TK", name: "測試雞頭K", status: "active" }], total: 2, skip: 0, take: 500 }));
    await page.route("**/api/sites/s1/default-broker-suggestion", (r) => json(r, { month: "2026-09-01", reason: "unique", current_broker_id: null, suggestion: { broker_id: "b1", broker_code: "TW", broker_name: "測試雞頭W", days: 12, source: "Postorder" } }));
    await page.route("**/api/sites/s1", (r) => {
      if (r.request().method() === "PATCH") {
        const b = r.request().postDataJSON() as Record<string, unknown>;
        patches.push(b);
        if ("default_settlement_broker_id" in b) site.default_settlement_broker_id = b.default_settlement_broker_id as string | null;
        return json(r, { ...site });
      }
      return json(r, site);
    });
    await loginAs(page, "老闆");
    await page.goto("/sites");
    await expect(page.getByText("測試預設盤").first()).toBeVisible();
    expect(requested.filter((p) => p === "/api/brokers")).toHaveLength(0); // 列表頁唔多一個 request
    await page.getByRole("button", { name: "編輯" }).first().click();
    await expect(page.getByTestId("site-default-broker")).toBeVisible();
    await expect(page.getByTestId("site-default-broker-suggestion")).toContainText("建議：TW（由 9 月 Postorder 推出");
    await page.getByRole("button", { name: "採用" }).click();
    await expect.poll(() => patches.length).toBeGreaterThan(0);
    expect(patches[0]).toEqual({ default_settlement_broker_id: "b1" });
    await expect(page.getByTestId("site-default-broker")).toHaveValue("b1");
    // 清走：揀（唔設）→ 儲存 → PATCH null
    await page.getByTestId("site-default-broker").selectOption("");
    await page.getByRole("button", { name: "儲存" }).click();
    await expect.poll(() => patches.some((p) => p.default_settlement_broker_id === null)).toBe(true);
  });
});
