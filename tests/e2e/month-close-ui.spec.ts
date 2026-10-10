// WP-MC-UI（§32）：月結頁 1a 桌面整頁＋1e 手機一次一題 e2e。全部用 page.route 假 API（假盤名／假數字），
// 唔依賴 dev DB 數據，亦唔郁真資料。截圖：MC_UI_SHOTS=out/mc-ui 時存檔。
// 執行：PW_PORT=3000 npx playwright test tests/e2e/month-close-ui.spec.ts
import { test, expect, type Page, type Route } from "@playwright/test";
import { loginAs } from "./helpers";

const MONTH = "2026-09";
const SHOTS = process.env.MC_UI_SHOTS;

function steps() {
  const mk = (key: string, label: string, numbers: Record<string, unknown>) => ({ key, label, status: "done", started_at: "2026-09-10T05:33:00.000Z", finished_at: "2026-09-10T05:33:02.000Z", numbers, warnings: [], needs_human: [] });
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
  review: [
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
  started_at: "2026-09-10T05:33:00.000Z",
  finished_at: "2026-09-10T05:33:09.000Z",
  current_step: null,
  stalled: false,
  steps: steps().map((x) => (x.key === "reconcile_apply" ? { ...x, needs_human: ["「測試盤甲」對數套用有 1 項失敗——要人手喺對數頁覆核"] } : x)),
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
    unpriced: { count: 5, payout_count: 3, client_count: 2, no_settlement_count: 0, ot_unpriced_count: 0, gap: { records: 5, client_gap_estimate: 3333, payout_gap_estimate: 59920, no_reference_records: 0 } },
    auto: AUTO,
    postorder_compare: { uploaded: true, referral_excel_total: 54670, referral_system_total: 54580, referral_diff: -90, note: "過渡對照" },
    needs_human: ["舊紅色清單（應該唔再出現）"],
    lock_precondition: { current_month_already_locked: false, missing_upload_sites: [], unconfirmed_upload_sites: ["測試盤甲", "測試盤乙"], unpriced_count: 5, ready_to_lock: false },
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

function question(id: string, title: string, over: Record<string, unknown> = {}) {
  return {
    id,
    kind: "month_close_pricing",
    kind_label: "定價",
    title,
    status: "open",
    options: [{ id: "mc_accept", label: "一撳確認" }, { id: "skip", label: "跳過" }],
    mc: { summary: "同盤同更種最近已知價；價目表、歷史、Postorder 都冇依據", suggestion: "客價 100／工資 80", confidence: "propose", action_type: "x", count: 3, candidates: [{ id: "c1", label: "價卡 A", evidence: "Postorder 第 374 行", values_text: "100／80" }], prefill_candidate_id: "c1", needs_price_input: false, needs_broker_pick: false, broker_options: [], identity_label: null },
    ...over,
  };
}

async function mockApis(page: Page, ids: string[] = ["q1", "q2", "q3"]) {
  const state = { bodies: [] as Array<Record<string, unknown>>, answers: [] as string[], previews: [] as string[], status: { q1: "open", q2: "open", q3: "open", q4: "open" } as Record<string, string>, failNext: false };
  const qs = {
    q1: question("q1", "測試盤甲 更種 N 未定價", { options: [{ id: "mc_accept", label: "一撳確認" }, { id: "mc_pick", label: "揀" }, { id: "skip", label: "跳過" }], mc: { ...question("x", "x").mc, candidates: [{ id: "c1", label: "價卡 A", evidence: "Postorder 第 374 行", values_text: "100／80" }, { id: "c2", label: "價卡 B", evidence: "歷史", values_text: "120／90" }] } }),
    q4: question("q4", "測試盤丁 更種 M 未定價"),
    q2: question("q2", "測試盤乙 更種 E 未定價", { options: [{ id: "mc_price", label: "輸入" }, { id: "skip", label: "跳過" }], mc: { ...question("x", "x").mc, suggestion: null, confidence: "unknown", candidates: [], prefill_candidate_id: null, needs_price_input: true } }),
    q3: question("q3", "測試盤丙 更數差異", { kind: "month_close_shift_variance", kind_label: "更數差異", options: [{ id: "mc_ack", label: "我已覆核" }, { id: "skip", label: "跳過" }], mc: { ...question("x", "x").mc, suggestion: null, confidence: "unknown", candidates: [], prefill_candidate_id: null } }),
  } as Record<string, ReturnType<typeof question>>;
  const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  await page.route("**/api/month-close/one-click?*", (r) => json(r, { runs: [RUN] }));
  // P3-1.6 之後列表係摘要版，最新一個 run 再拉單一 route 攞全份 steps／report——兩個都要 mock（P3-3.8 修舊失敗）。
  await page.route("**/api/month-close/one-click/run1", (r) => json(r, { run: RUN }));
  await page.route("**/api/reports/month-health?*", (r) => json(r, HEALTH));
  await page.route("**/api/triage/sessions/sess1", (r) => json(r, { session: { id: "sess1", status: "open", counts: { open: 3, answered: 0, skipped: 0, total: 3 } }, questions: ids.map((i) => qs[i]!).map((q) => ({ ...q, status: state.status[q.id] })) }));
  await page.route("**/api/triage/questions/*/preview", (r) => {
    const id = r.request().url().split("/questions/")[1]!.split("/")[0]!;
    state.previews.push(id);
    return json(r, { preview_hash: "h", writes: false, impact: { can_confirm: true, summary: ["預覽影響"], notes: [] } });
  });
  await page.route("**/api/triage/questions/*/answer", (r) => {
    const id = r.request().url().split("/questions/")[1]!.split("/")[0]!;
    if (state.failNext) {
      state.failNext = false;
      return json(r, { error: "conflict", message: "資料已改變" }, 409);
    }
    const body = r.request().postDataJSON() as { answer: { option: string } };
    state.bodies.push(body.answer);
    state.answers.push(`${id}:${body.answer.option}`);
    state.status[id] = body.answer.option === "skip" ? "skipped" : "answered";
    return json(r, { status: "answered", impact: null });
  });
  return state;
}

async function noHScroll(page: Page) {
  const [sw, iw] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  expect(sw).toBeLessThanOrEqual(iw);
}

test.describe("月結頁 1a 桌面", () => {
  test.use({ viewport: { width: 1440, height: 1000 } });

  test("整頁結構、人話總結、自動處理摘要、要你睇、鎖定前置", async ({ page }) => {
    await mockApis(page);
    await loginAs(page, "老闆");
    await page.goto(`/month-close`);
    await page.getByTestId("month-close-month-input").fill(MONTH);

    await expect(page.getByRole("heading", { name: "一鍵全月結算" })).toBeVisible();
    await expect(page.getByText("④ 報告")).toBeVisible();
    // 五步狀態列
    const stages = page.getByTestId("stage-bar").locator("li");
    await expect(stages).toHaveCount(5);
    await expect(stages.nth(3)).toHaveAttribute("data-state", "warn");
    await expect(stages.nth(3)).toContainText("3 題要你睇");
    await expect(stages.nth(4)).toContainText("仲差 2 樣");
    // ③ 人話總結，唔直接出 key=value
    await expect(page.locator('[data-step="auto_pricing"]')).toContainText("建咗 1 張價卡、定價 12 更、3 更歸屬雞頭");
    await expect(page.locator('[data-step="pricing_check"]')).toContainText("2 題".replace("2", "2"));
    await expect(page.getByTestId("progress-section")).not.toContainText("cardsCreated=");
    await page.locator('[data-step="auto_pricing"] button').click();
    await expect(page.getByTestId("step-kv")).toContainText("cardsCreated=1");
    // ④ KPI／橫幅／刪除紅色要人決定
    await expect(page.getByTestId("cost-stack")).toBeVisible();
    await expect(page.getByTestId("unpriced-gap")).toContainText("5 更未定價");
    await expect(page.getByText("舊紅色清單")).toHaveCount(0);
    await expect(page.getByText("逐雞頭應付")).toBeVisible();
    await expect(page.getByText("逐盤收入")).toBeVisible();
    await expect(page.getByText("1 個盤本月 0 更，已收埋")).toBeVisible();
    // 自動處理摘要 tab
    await expect(page.getByTestId("auto-summary")).toContainText("系統自動幫你做咗 19 項");
    await page.getByRole("tab", { name: /歸屬結算雞頭/ }).click();
    await expect(page.getByTestId("auto-rows")).toContainText("Postorder 同崗位同日");
    await expect(page.getByTestId("auto-counts")).toContainText("冇需要處理：自動對盤 0");
    // 要你睇 4 欄
    await expect(page.getByTestId("auto-review")).toContainText("要你睇：仲有 3 題");
    await expect(page.locator('[data-review-group="pricing"]')).toContainText("2");
    await expect(page.locator('[data-review-group="variance"]')).toContainText("1");
    // 鎖定前置
    await expect(page.locator('[data-lock-req="unconfirmed"]')).toContainText("2 個盤嘅更表未對數確認");
    await expect(page.locator('[data-lock-req="unpriced"]')).toContainText("即係「要你睇」入面嘅 2 題定價題");
    await expect(page.getByTestId("month-health-card")).toContainText("30 格對唔到保安員");
    await expect(page.getByTestId("month-health-card")).toContainText("＝ 要你睇 2 題");
    await expect(page.getByTestId("month-health-card")).not.toContainText("unmatched");
    await expect(page.getByTestId("rail-lock-month")).toBeDisabled();
    // P3-3.4：主欄冇重複掣（lock-month／open-triage／undo-auto 已刪，右欄係唯一 CTA 區）
    for (const id of ["lock-month", "open-triage", "undo-auto"]) await expect(page.getByTestId(id)).toHaveCount(0);
    // 右欄
    await expect(page.getByTestId("rail-review-count")).toHaveText("3");
    // needs_human 每步直接顯示＋右欄入口
    await expect(page.locator('[data-step="reconcile_apply"]').getByTestId("step-needs-human")).toContainText("對數套用有 1 項失敗");
    await expect(page.getByTestId("rail-needs-human")).toBeVisible();
    // 禁用詞
    const bodyText = await page.locator("body").innerText();
    for (const w of ["有依據", "冇依據", "unmatched", "ambiguous", "name_only", "（external）", "（shift", "（parsed）"]) expect(bodyText).not.toContain(w);
    await expect(page.getByTestId("auto-review")).toContainText("冇參考");
    // 保留 testid
    for (const id of ["month-close-month-input", "month-close-roster-file-input", "month-close-staff-list-file-input", "month-close-postorder-file-input", "auto-summary", "auto-counts", "auto-review", "undo-auto-rail", "unpriced-gap", "rail-open-triage", "rail-lock-month", "month-health-card"]) {
      await expect(page.getByTestId(id)).toHaveCount(1);
    }
    await noHScroll(page);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/mock-1440.png`, fullPage: true });
  });

  test("桌面對話框：確認後 5 秒內撤銷 → 0 次 API；關閉對話框 → flush", async ({ page }) => {
    const st = await mockApis(page);
    await loginAs(page, "老闆");
    await page.goto(`/month-close`);
    await page.getByTestId("month-close-month-input").fill(MONTH);
    await page.getByTestId("rail-open-triage").click();
    await expect(page.getByTestId("mc-triage-dialog")).toHaveAttribute("data-mode", "desktop");
    await expect(page.getByTestId("mc-summary")).not.toContainText("冇依據");
    await page.getByTestId("mc-accept").click();
    await expect(page.getByTestId("mc-undo-toast")).toContainText("已確認「測試盤甲 更種 N 未定價」");
    await page.getByTestId("mc-undo").click();
    await expect(page.getByTestId("mc-summary")).toContainText("同盤同更種最近已知價");
    expect(st.answers).toEqual([]);
    expect(st.previews).toEqual([]);
    // 再確認，然後直接關閉 → flush
    await page.getByTestId("mc-accept").click();
    await expect(page.getByTestId("mc-undo-toast")).toBeVisible();
    expect(st.answers).toEqual([]);
    await page.getByTestId("mc-later").click();
    await expect(page.getByTestId("mc-triage-dialog")).toHaveCount(0);
    expect(st.answers).toEqual(["q1:mc_accept"]);
    expect(st.previews).toEqual(["q1"]);
  });

  test("timer 自動送出失敗 → 6.5 秒後撳遲啲先答，對話框唔關", async ({ page }) => {
    const st = await mockApis(page);
    await loginAs(page, "老闆");
    await page.goto(`/month-close`);
    await page.getByTestId("month-close-month-input").fill(MONTH);
    await page.getByTestId("rail-open-triage").click();
    st.failNext = true;
    await page.getByTestId("mc-accept").click();
    await page.waitForTimeout(6500);
    await page.getByTestId("mc-later").click();
    await expect(page.getByTestId("mc-triage-dialog")).toBeVisible();
    await expect(page.getByTestId("mc-unsent")).toContainText("未送出，請再試");
    expect(st.answers).toEqual([]);
  });

  test("揀非建議候選送出後，下一題主掣係確認建議；送出 option 正確", async ({ page }) => {
    const st = await mockApis(page, ["q1", "q4"]);
    await loginAs(page, "老闆");
    await page.goto(`/month-close`);
    await page.getByTestId("month-close-month-input").fill(MONTH);
    await page.getByTestId("rail-open-triage").click();
    await expect(page.getByTestId("mc-pick")).toHaveCount(0); // 未揀任何候選：冇「用所揀候選」
    await page.getByLabel(/價卡 B/).check();
    await expect(page.getByTestId("mc-accept")).toHaveCount(0);
    await page.getByTestId("mc-pick").click();
    await expect(page.getByTestId("mc-summary")).toBeVisible();
    await expect(page.getByTestId("mc-accept")).toBeVisible();
    await expect(page.getByTestId("mc-pick")).toHaveCount(0);
    await page.getByTestId("mc-accept").click();
    await page.getByTestId("mc-later").click();
    await expect(page.getByTestId("mc-triage-dialog")).toHaveCount(0);
    expect(st.bodies).toEqual([{ option: "mc_pick", candidate_id: "c2" }, { option: "mc_accept" }]);
  });

  test("送出失敗：dblclick 關閉／撳遮罩都唔關；撳「放棄未送出」先關，頁面有 banner", async ({ page }) => {
    const st = await mockApis(page);
    await loginAs(page, "老闆");
    await page.goto(`/month-close`);
    await page.getByTestId("month-close-month-input").fill(MONTH);
    await page.getByTestId("rail-open-triage").click();
    st.failNext = true;
    await page.getByTestId("mc-accept").click();
    await page.getByTestId("mc-later").dblclick();
    await expect(page.getByTestId("mc-failed-banner")).toContainText("有 1 題未送出");
    await expect(page.getByTestId("mc-triage-dialog")).toBeVisible();
    await page.mouse.click(5, 5);
    await expect(page.getByTestId("mc-triage-dialog")).toBeVisible();
    await page.getByTestId("mc-abandon").click();
    await expect(page.getByTestId("mc-triage-dialog")).toHaveCount(0);
    await expect(page.getByText(/有 1 題未送出，請重新答/)).toBeVisible();
    expect(st.answers).toEqual([]);
  });

  test("送出失敗 → 關閉對話框唔關，標返未送出；重試成功先可關閉", async ({ page }) => {
    const st = await mockApis(page);
    await loginAs(page, "老闆");
    await page.goto(`/month-close`);
    await page.getByTestId("month-close-month-input").fill(MONTH);
    await page.getByTestId("rail-open-triage").click();
    st.failNext = true;
    await page.getByTestId("mc-accept").click();
    await page.getByTestId("mc-later").click();
    await expect(page.getByTestId("mc-triage-dialog")).toBeVisible();
    await expect(page.getByTestId("mc-unsent")).toContainText("未送出，請再試");
    expect(st.answers).toEqual([]);
    await page.getByTestId("mc-accept").click();
    await page.getByTestId("mc-later").click();
    await expect(page.getByTestId("mc-triage-dialog")).toHaveCount(0);
    expect(st.answers).toEqual(["q1:mc_accept"]);
  });
});

test.describe("月結頁 1e 手機", () => {
  test.use({ viewport: { width: 375, height: 800 } });

  test("頁面 375 零橫向捲；一次一題：撤銷、下一題 flush、完成頁", async ({ page }) => {
    test.setTimeout(90_000);
    const st = await mockApis(page);
    await loginAs(page, "老闆");
    await page.goto(`/month-close`);
    await page.getByTestId("month-close-month-input").fill(MONTH);
    await expect(page.getByText("④ 報告")).toBeVisible();
    await noHScroll(page);
    // P3-4.4：手機一頁唔超過 3 屏（3×800）就見到報告；右欄變底部 sticky CTA（fixed，貼底）。
    const reportY = await page.getByText("④ 報告").evaluate((e) => e.getBoundingClientRect().top + window.scrollY);
    expect(reportY).toBeLessThanOrEqual(3 * 800);
    const rail = await page.getByTestId("rail-main").evaluate((e) => ({ pos: getComputedStyle(e).position, bottom: Math.round(window.innerHeight - e.getBoundingClientRect().bottom) }));
    expect(rail.pos).toBe("fixed");
    expect(rail.bottom).toBe(0);
    // KPI：營業額＋毛利同一行（成本卡 order-last）；金額唔斷行（單行高度）。
    const kpi = await page.getByTestId("report-kpis").evaluate((root) => {
      const by = (t: string) => Array.from(root.children).find((c) => (c.textContent ?? "").startsWith(t))!.getBoundingClientRect();
      const cards = [by("總收入"), by("毛利"), by("總成本")];
      const nums = Array.from(root.querySelectorAll<HTMLElement>(".whitespace-nowrap.font-bold")).map((n) => n.getBoundingClientRect().height);
      return { sameRow: Math.abs(cards[0]!.top - cards[1]!.top) < 2 && cards[2]!.top > cards[0]!.top, numHeights: nums };
    });
    expect(kpi.sameRow).toBe(true);
    for (const h of kpi.numHeights) expect(h).toBeLessThan(36);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/mock-375.png`, fullPage: true });

    await page.getByTestId("rail-open-triage").click();
    const dlg = page.getByTestId("mc-triage-dialog");
    await expect(dlg).toHaveAttribute("data-mode", "mobile");
    await expect(page.getByTestId("mc-segs").locator("span")).toHaveCount(3);
    await expect(page.getByTestId("mc-pos")).toHaveText("1 / 3");
    await expect(page.getByTestId("mc-suggest-card")).toBeVisible();
    await expect(page.getByTestId("mc-triage-dialog")).not.toContainText("冇依據");
    await expect(page.getByTestId("mc-skip")).toHaveText("跳過，留返人手");
    const h = await page.getByTestId("mc-accept").evaluate((e) => e.getBoundingClientRect().height);
    expect(h).toBe(54);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/mock-1e-question.png` });

    // 確認 → 撤銷 → 0 次 API
    await page.getByTestId("mc-accept").click();
    await expect(page.getByTestId("mc-undo-toast")).toContainText("已確認");
    await page.getByTestId("mc-undo").click();
    await expect(page.getByTestId("mc-pos")).toHaveText("1 / 3");
    expect(st.answers).toEqual([]);

    // 確認 q1 → 即刻到 q2（冇建議：揀答案 ›）→ 跳過 q2 → q1 已 flush
    await page.getByTestId("mc-accept").click();
    await expect(page.getByTestId("mc-nosuggest-card")).toBeVisible();
    await expect(page.getByTestId("mc-choose")).toHaveText("揀答案 ›");
    await expect(page.getByTestId("mc-accept")).toHaveCount(0);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/mock-1e-nosuggest.png` });
    await page.getByTestId("mc-skip").click();
    await expect.poll(() => st.answers.join(",")).toBe("q1:mc_accept");
    // q3 只可覆核
    await expect(page.getByTestId("mc-ack")).toBeVisible();
    await page.getByTestId("mc-ack").click();
    await expect.poll(() => st.answers.join(","), { timeout: 12_000 }).toBe("q1:mc_accept,q2:skip,q3:mc_ack");
    await expect(page.getByTestId("mc-finish")).toHaveText("3 題處理完", { timeout: 12_000 });
    await expect(dlg).toContainText("確認 2 · 跳過 1");
    await expect(dlg).toContainText("跳過嘅留咗喺「待答問題」");
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/mock-1e-finish.png` });
    await page.getByTestId("mc-back").click();
    await expect(dlg).toHaveCount(0);
  });
  test("1e 有建議時揀其他候選 → 主掣改用所揀答案（mc_pick＋candidate_id）", async ({ page }) => {
    test.setTimeout(60_000);
    const st = await mockApis(page, ["q1"]);
    await loginAs(page, "老闆");
    await page.goto(`/month-close`);
    await page.getByTestId("month-close-month-input").fill(MONTH);
    await page.getByTestId("rail-open-triage").click();
    await page.getByTestId("mc-other").click();
    await page.getByLabel(/價卡 B/).check();
    await expect(page.getByTestId("mc-pick")).toHaveText("用所揀答案");
    await expect(page.getByTestId("mc-accept")).toHaveCount(0);
    await page.getByTestId("mc-pick").click();
    await expect.poll(() => st.bodies.length, { timeout: 12_000 }).toBe(1);
    expect(st.bodies[0]).toEqual({ option: "mc_pick", candidate_id: "c2" });
  });
  test("1e 揀 B 後收起面板 → 清走所揀，主掣變返確認建議，送 mc_accept", async ({ page }) => {
    test.setTimeout(60_000);
    const st = await mockApis(page, ["q1"]);
    await loginAs(page, "老闆");
    await page.goto(`/month-close`);
    await page.getByTestId("month-close-month-input").fill(MONTH);
    await page.getByTestId("rail-open-triage").click();
    await page.getByTestId("mc-other").click();
    await page.getByLabel(/價卡 B/).check();
    await expect(page.getByTestId("mc-pick")).toBeVisible();
    await page.getByTestId("mc-other").click(); // 收起
    await expect(page.getByTestId("mc-accept")).toHaveText("確認建議");
    await expect(page.getByTestId("mc-pick")).toHaveCount(0);
    await page.getByTestId("mc-other").click(); // 再展開：B 冇揀住
    await expect(page.getByLabel(/價卡 B/)).not.toBeChecked();
    await page.getByTestId("mc-other").click();
    await page.getByTestId("mc-accept").click();
    await expect.poll(() => st.bodies.length, { timeout: 12_000 }).toBe(1);
    expect(st.bodies[0]).toEqual({ option: "mc_accept" });
  });
});

// 真 dev DB 截圖（驗收員睇）：MC_UI_REAL=out/mc-ui 先跑；唔斷言數字，淨係存圖＋零橫向捲。
test.describe("真數據截圖", () => {
  test.skip(!process.env.MC_UI_REAL, "MC_UI_REAL 未設");
  for (const month of ["2026-08", "2026-09"]) {
    for (const [name, vp] of [["1440", { width: 1440, height: 1000 }], ["375", { width: 375, height: 800 }]] as const) {
      test(`${month} @${name}`, async ({ page }) => {
        await page.setViewportSize(vp);
        await loginAs(page, "老闆");
        await page.goto(`/month-close?month=${month}`);
        await page.getByTestId("month-close-month-input").fill(month);
        await page.waitForTimeout(2500);
        await noHScroll(page);
        await page.screenshot({ path: `${process.env.MC_UI_REAL}/real-${month}-${name}.png`, fullPage: true });
      });
    }
  }
});
