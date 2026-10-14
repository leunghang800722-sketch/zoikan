// P17：鎖月被未確認病假草稿擋＋老闆覆蓋——用月結頁 UI 行一次。一鍵結算 run／體檢用 page.route 假（假盤名／假數字），
// 但「生成月結 → 鎖月」係真 API（2026-05 空月、草稿直接寫 DB；afterAll 清走、不留鎖月）。
import { test, expect, type Route } from "@playwright/test";
import { loginAs } from "./helpers";
import { prisma } from "./db-helpers";

test.describe.configure({ mode: "serial" });

// 用 2026-05：更表上載覆蓋檢查只對 2026-08 起生效，咁就唔受其他 spec 留低嘅 8 月資料影響
const MONTH = "2026-05";
const MONTH_DATE = new Date(Date.UTC(2026, 4, 1));
const RAND = Math.random().toString(36).slice(2, 8);
let guardId: string;

function steps() {
  const mk = (key: string, label: string, numbers: Record<string, unknown>) => ({ key, label, status: "done", started_at: "2026-05-10T05:33:00.000Z", finished_at: "2026-05-10T05:33:02.000Z", numbers, warnings: [], needs_human: [] });
  return [
    mk("precheck", "前置檢查", { prevMonthHasData: true, prevMonthLocked: true, siteMissingShiftTypeCount: 6, staffListAgeDays: 0, currentMonthLocked: false }),
    mk("parse_health", "解析健康", { uploadCount: 37, totalShiftCount: 3629, varianceFlagged: 8, varianceExplained: 7 }),
    mk("guard_fix", "保安員修復", { remainingNeedsBoss: 1, autoLinkedCells: 0 }),
    mk("longterm_settlement", "長工結算", { longtermRowsScanned: 1506, longtermRowsChanged: 115 }),
    mk("reconcile_apply", "全月對數套用", { uploadCount: 37, uploadsWithErrors: 0 }),
    mk("auto_pricing", "自動歸屬／定價", { cardsCreated: 1, recordsPriced: 12, settlementAssigned: 3 }),
    mk("pricing_check", "定價檢查", { count: 5, payoutCount: 3, clientCount: 2, noSettlementCount: 0 }),
    mk("compute", "計數", { siteCount: 3, totalRevenue: 3115420, totalCost: 1649230 }),
    mk("postorder_compare", "對照（可選）", { uploaded: true, fileName: "PostOrder.csv", referralRowCount: 22, referralDiff: -90 }),
    mk("report", "報告", {}),
  ];
}

const AUTO = {
  summary: { sites_aliased: 0, sites_created: 0, shift_types_created: 2, aliases_from_postorder: 0, cards_created: 1, records_priced: 12, records_settled: 3, guard_matches_auto: 0, variances_explained: 1, variances_unexplained: 0, unpriced_records: 5, counts: { countable: 100, external: 4, internal_cash: 2 } },
  auto_lines: [
    { kind: "shift_type_created", text: "新盤更種「測試盤甲」自動建 2 個更種（由更表代號＋時段推出）" },
    { kind: "pricing", text: "盤「測試盤甲」更種「D」雞頭 W 12 更自動定價（客價 100／工資 80／雞頭費 5；Postorder 第 374 行）" },
    { kind: "pricing", text: "3 更冇結算雞頭，自動歸 W（Postorder 同崗位同日）" },
    { kind: "variance", text: "更數差異已解釋：「測試盤乙」本月 50 更 vs 上月 30 更（+20，66.7%）：雞頭組成變咗" },
  ],
  review: [],
  review_unused: [
    { kind: "month_close_pricing", text: "測試盤甲 更種 N 未定價 3 更（有候選）", confidence: "propose", question_id: "q1" },
    { kind: "month_close_pricing", text: "測試盤乙 更種 E 未定價 2 更，價目表都冇依據（unmatched）", confidence: "unknown", question_id: "q2" },
    { kind: "month_close_shift_variance", text: "測試盤丙 更數差異解釋唔到", confidence: "unknown", question_id: "q3" },
  ],
  triage_session_id: "sess1",
  undone: false,
  undone_at: null,
};

const RUN = {
  id: "run1",
  month: MONTH,
  status: "done",
  started_at: "2026-05-10T05:33:00.000Z",
  finished_at: "2026-05-10T05:33:09.000Z",
  current_step: null,
  stalled: false,
  steps: steps().map((x) => (x.key === "longterm_settlement" ? { ...x, needs_human: ["病假 1 段未確認（1 人）——未確認唔會出津貼，一律當無薪；去長工糧頁 › 人手輸入逐段確認醫生紙"] } : x)),
  error_message: null,
  report: {
    month: MONTH,
    totals: { revenue: 3115420.04, margin_revenue: 3115420.04, cost: 1649230, gross_margin: 1466190.04, cost_basis: "combined", legacy_cost: 1600000, legacy_margin: 1515420.04 },
    payroll_by_broker: [
      { broker_code: "W", broker_name: "測試雞頭", shifts: 80, amount: 1000 },
      { broker_code: "Z", broker_name: "公司", shifts: 5, amount: 0 },
      { broker_code: "", broker_name: "未歸屬結算單位", shifts: 5, amount: 200 },
    ],
    site_revenue: [
      { site_id: "s1", site_name: "測試盤甲", shifts: 30, revenue: 90000 },
      { site_id: "s2", site_name: "測試盤乙", shifts: 20, revenue: 50000 },
      { site_id: "s3", site_name: "測試盤零", shifts: 0, revenue: 0 },
    ],
    referral_fee: { total: 54580, count: 22 },
    unpriced: { count: 0, payout_count: 0, client_count: 0, no_settlement_count: 0, ot_unpriced_count: 0, gap: null },
    auto: AUTO,
    postorder_compare: { uploaded: true, referral_excel_total: 54670, referral_system_total: 54580, referral_diff: -90, note: "過渡對照" },
    needs_human: [],
    lock_precondition: { current_month_already_locked: false, missing_upload_sites: [], unconfirmed_upload_sites: [], unpriced_count: 0, sl_drafts_pending: 1, ready_to_lock: false },
    longterm_payroll_note: "本月 0 位長工有糧計入。",
    longterm_payroll: null,
    combined_cost_summary: { per_shift_cost_total: 1594650, referral_fee_total: 54580, longterm_autopay_total: 0, combined_cost_total: 1649230, mpf_er_total: 0 },
  },
};

const HEALTH = {
  month: MONTH,
  has_prev: true,
  summary: { critical: 2, warn: 1, info: 0, total: 3 },
  can_view_detail: true,
  findings: [
    { code: "unmatched_cells", severity: "critical", count: 30, message: "30 格保安員配對唔到（unmatched）", fix_link: "/guard-fix", detail: null, detail_truncated: false },
    { code: "unpriced_payout", severity: "critical", count: 3, message: "3 更未有出街價", fix_link: "/pricing", detail: null, detail_truncated: false },
    { code: "name_only_cells", severity: "warn", count: 9, message: "9 格淨靠姓名配對（建議補工號或電話）", fix_link: "/roster-uploads", detail: null, detail_truncated: false },
  ],
};


test.beforeAll(async () => {
  const g = await prisma.guard.create({ data: { nameZh: `測試長工-p17ui-${RAND}`, employmentType: "longterm_autopay", hireDate: new Date("2020-01-01"), createdBy: "test-e2e" } });
  guardId = g.id;
  await prisma.longtermPayrollInput.create({ data: { month: MONTH_DATE, guardId, kind: "leave", dateFrom: "2026-05-10", dateTo: "2026-05-13", doctorNoteVerified: false, status: "draft", draftSource: "roster_leave:SL", draftEvidence: { dates: ["2026-05-10"], roster_upload_ids: [] }, createdBy: "test-e2e" } });
});

test.afterAll(async () => {
  await prisma.monthClose.deleteMany({ where: { month: MONTH_DATE } });
  await prisma.longtermPayrollInput.deleteMany({ where: { guardId } });
  await prisma.guard.deleteMany({ where: { id: guardId } });
});

test("月結頁：未確認病假草稿列為鎖月前置（連去確認）；老闆勾「全部當無薪」填原因 → 真係鎖到，audit 有紀錄", async ({ page }) => {
  const json = (route: Route, b: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(b) });
  await page.route("**/api/month-close/one-click?*", (r) => json(r, { runs: [RUN] }));
  await page.route("**/api/month-close/one-click/run1", (r) => json(r, { run: RUN }));
  await page.route("**/api/reports/month-health?*", (r) => json(r, HEALTH));
  await loginAs(page, "老闆");
  await page.goto("/month-close");
  await page.getByTestId("month-close-month-input").fill(MONTH);

  // 進度步驟 needs_human 有連結；鎖定前置列出病假；右欄鎖定掣停用
  await expect(page.locator('[data-step="longterm_settlement"]').getByTestId("step-needs-human")).toContainText("病假 1 段未確認");
  await expect(page.getByTestId("needs-human-sl-link")).toHaveAttribute("href", /focus=sl-drafts/);
  const req = page.locator('[data-lock-req="sl_drafts"]');
  await expect(req).toContainText("1 段病假未確認醫生紙");
  await expect(page.getByTestId("lock-req-sl-link")).toHaveAttribute("href", `/reports/longterm-payroll?month=${MONTH}&focus=sl-drafts`);
  await expect(page.getByTestId("rail-lock-month")).toBeDisabled();

  // 老闆覆蓋：勾選 → 原因必填 → 鎖
  await page.getByTestId("sl-unpaid-check").check();
  const go = page.getByTestId("sl-unpaid-lock-month");
  await expect(go).toBeDisabled();
  await page.getByTestId("sl-unpaid-reason").fill("e2e：員工冇交紙，全部當無薪");
  await expect(go).toBeEnabled();
  await go.click();
  await expect(page.getByText(`${MONTH} 已鎖定`, { exact: true })).toBeVisible({ timeout: 15_000 });
  const mc = await prisma.monthClose.findFirstOrThrow({ where: { month: MONTH_DATE } });
  expect(mc.lockedAt).not.toBeNull();
  const audit = await prisma.auditLog.findFirst({ where: { tableName: "month_closes", rowId: mc.id, action: "lock_month" } });
  expect((audit!.after as { sl_unpaid_override: { segments: number; reason: string } }).sl_unpaid_override).toMatchObject({ segments: 1, reason: "e2e：員工冇交紙，全部當無薪" });
  // 草稿保持未確認（＝唔出津貼）
  expect(await prisma.longtermPayrollInput.count({ where: { guardId, status: "draft", voidedAt: null } })).toBe(1);
});
