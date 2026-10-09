// WP-MC-UI：月結頁純推導函數（五步狀態、③ 人話總結、自動處理分類、要你睇分組、鎖定前置、體檢人話）。
import { describe, it, expect } from "vitest";
import type { AutoReportDTO, ReportDTO, RunDTO, StepDTO } from "@/components/month-close/types";
import {
  deriveAutoCategories,
  deriveStages,
  deriveUploads,
  groupReview,
  healthDupReviewCount,
  humanize,
  humanizeHealth,
  kindChip,
  needsHumanCount,
  lockRequirements,
  parsePricingLine,
  splitSiteRevenue,
  stepChips,
  stepSummary,
} from "@/components/month-close/derive";

const step = (key: string, numbers: Record<string, unknown>, status: StepDTO["status"] = "done"): StepDTO => ({ key, label: key, status, started_at: "2026-09-10T05:33:00Z", finished_at: "2026-09-10T05:33:02Z", numbers, warnings: [], needs_human: [] });

const auto = (over: Partial<AutoReportDTO> = {}): AutoReportDTO => ({
  summary: { sites_aliased: 0, sites_created: 0, shift_types_created: 2, aliases_from_postorder: 0, cards_created: 1, records_priced: 12, records_settled: 3, guard_matches_auto: 0, variances_explained: 1, variances_unexplained: 0, unpriced_records: 5, counts: { countable: 100, external: 4, internal_cash: 2 } },
  auto_lines: [
    { kind: "shift_type_created", text: "新盤更種「測試盤甲」自動建 2 個更種（由更表代號＋時段推出）" },
    { kind: "pricing", text: "盤「測試盤甲」更種「D」雞頭 W 12 更自動定價（客價 100／工資 80／雞頭費 5；Postorder 第 374 行）" },
    { kind: "pricing", text: "3 更冇結算雞頭，自動歸 W（Postorder 同崗位同日）" },
    { kind: "variance", text: "更數差異已解釋：「測試盤乙」本月 50 更 vs 上月 30 更（+20，66.7%）：雞頭組成變咗" },
  ],
  review: [
    { kind: "month_close_pricing", text: "p1", confidence: "propose", question_id: "q1" },
    { kind: "month_close_pricing", text: "p2", confidence: "unknown", question_id: "q2" },
    { kind: "month_close_pricing", text: "p3", confidence: "propose", question_id: "q3" },
    { kind: "month_close_guard_match", text: "g1", confidence: "unknown", question_id: "q4" },
  ],
  triage_session_id: "s1",
  undone: false,
  undone_at: null,
  ...over,
});

const report = (over: Partial<ReportDTO> = {}): ReportDTO => ({
  month: "2026-09",
  totals: { revenue: 1000, cost: 600, gross_margin: 400, margin_revenue: 1000 },
  payroll_by_broker: [],
  site_revenue: [],
  referral_fee: { total: 0, count: 0 },
  unpriced: { count: 5, payout_count: 3, client_count: 2, no_settlement_count: 0, ot_unpriced_count: 0 },
  auto: auto(),
  postorder_compare: null,
  needs_human: [],
  lock_precondition: { current_month_already_locked: false, missing_upload_sites: [], unconfirmed_upload_sites: ["甲", "乙"], unpriced_count: 5, ready_to_lock: false },
  longterm_payroll_note: "",
  combined_cost_summary: null,
  ...over,
});

const run = (over: Partial<RunDTO> = {}): RunDTO => ({
  id: "r1",
  month: "2026-09",
  status: "done",
  started_at: "2026-09-10T05:33:00Z",
  finished_at: "2026-09-10T05:33:09Z",
  current_step: null,
  stalled: false,
  steps: [step("precheck", { staffListAgeDays: 0 }), step("parse_health", { uploadCount: 37, totalShiftCount: 3629 }), step("postorder_compare", { uploaded: true, fileName: "PostOrder.csv", referralRowCount: 22 })],
  report: report(),
  error_message: null,
  ...over,
});

describe("deriveStages", () => {
  const none = { sessionRoster: 0, sessionStaffList: false, sessionPostorder: false };
  it("冇 run：全部 todo", () => {
    const up = deriveUploads(null, none, null);
    const st = deriveStages({ run: null, report: null, uploads: up, locked: false });
    expect(st.map((s) => s.state)).toEqual(["todo", "todo", "todo", "todo", "todo"]);
  });
  it("跑完有題：報告 warn、鎖定仲差 N 樣", () => {
    const r = run();
    const up = deriveUploads(r, none, r.report);
    const st = deriveStages({ run: r, report: r.report, uploads: up, locked: false });
    expect(st[0]!.state).toBe("ok");
    expect(st[1]!.state).toBe("ok");
    expect(st[3]).toMatchObject({ state: "warn", sub: "4 題要你睇" });
    expect(st[4]).toMatchObject({ state: "todo", sub: "仲差 2 樣" });
  });
  it("失敗 run、已鎖定", () => {
    const r = run({ status: "failed" });
    const up = deriveUploads(r, none, r.report);
    expect(deriveStages({ run: r, report: null, uploads: up, locked: false })[1]!.state).toBe("warn");
    expect(deriveStages({ run: r, report: r.report, uploads: up, locked: true })[4]).toMatchObject({ state: "ok", sub: "已鎖定" });
  });
  it("條件齊 → 鎖定 warn「可以鎖」", () => {
    const rep = report({ auto: auto({ review: [] }), lock_precondition: { current_month_already_locked: false, missing_upload_sites: [], unconfirmed_upload_sites: [], unpriced_count: 0, ready_to_lock: true } });
    const r = run({ report: rep });
    const st = deriveStages({ run: r, report: rep, uploads: deriveUploads(r, none, rep), locked: false });
    expect(st[3]!.state).toBe("ok");
    expect(st[4]).toMatchObject({ state: "warn", sub: "可以鎖" });
  });
});

describe("deriveUploads", () => {
  it("由 run 步驟數字推", () => {
    const r = run();
    const u = deriveUploads(r, { sessionRoster: 0, sessionStaffList: false, sessionPostorder: false }, r.report);
    expect(u[0]!.have).toBe(true);
    expect(u[0]!.status).toContain("37 份已上載");
    expect(u[1]!.status).toContain("今日");
    expect(u[2]!.status).toContain("PostOrder.csv");
  });
});

describe("stepSummary / stepChips", () => {
  it("人話總結，唔出 key=value", () => {
    expect(stepSummary(step("parse_health", { uploadCount: 37, totalShiftCount: 3629, varianceFlagged: 8, varianceExplained: 7 }))).toBe("37 份更表、共讀到 3,629 更；8 個盤更數同上月差好遠，7 個已搵到原因");
    expect(stepSummary(step("guard_fix", { remainingNeedsBoss: 6, autoLinkedCells: 0 }))).toBe("6 組對唔到安員，系統唔敢自己決定");
    expect(stepSummary(step("longterm_settlement", { longtermRowsScanned: 1506, longtermRowsChanged: 115 }))).toBe("掃咗 1,506 行長工資料，更新咗 115 行");
    expect(stepSummary(step("auto_pricing", { cardsCreated: 12, recordsPriced: 87, settlementAssigned: 6 }))).toBe("建咗 12 張價卡、定價 87 更、6 更歸屬雞頭");
    expect(stepSummary(step("pricing_check", { count: 103, payoutCount: 99, clientCount: 4, noSettlementCount: 0 }))).toBe("仲有 99 更未有出街價、4 更未有客價");
    expect(stepSummary(step("compute", { siteCount: 62, totalRevenue: 3115420, totalCost: 1649230 }))).toBe("62 個盤 · 收入 3,115,420 · 成本 1,649,230");
    expect(stepSummary(step("postorder_compare", { uploaded: true, referralDiff: -90 }))).toBe("介紹費同 Postorder 總表差 90 元");
    expect(stepSummary(step("precheck", { prevMonthHasData: true, prevMonthLocked: true, siteMissingShiftTypeCount: 6 }))).toBe("上月已鎖、有數；6 個盤未設更種");
    expect(stepSummary(step("report", {}, "failed"))).toBe("呢步出錯，睇技術明細");
  });
  it("chip 由 report.auto 砌", () => {
    expect(stepChips("pricing_check", auto())).toEqual({ auto: 0, q: 3 });
    expect(stepChips("guard_fix", auto())).toEqual({ auto: 0, q: 1 });
    expect(stepChips("auto_pricing", auto())).toEqual({ auto: 16, q: 0 });
    expect(stepChips("compute", auto())).toEqual({ auto: 0, q: 0 });
    expect(stepChips("guard_fix", undefined)).toEqual({ auto: 0, q: 0 });
  });
});

describe("deriveAutoCategories", () => {
  it("分類、解析、0 類併一行", () => {
    const { cats, zero, total } = deriveAutoCategories(auto());
    expect(cats.map((c) => c.key)).toEqual(["shift_types", "cards", "priced", "settled", "variance"]);
    expect(total).toBe(2 + 1 + 12 + 3 + 1);
    expect(zero).toEqual(["自動對盤 0", "自動建新盤 0", "自動安員配對 0"]);
    const priced = cats.find((c) => c.key === "priced")!;
    expect(priced.rows[0]).toMatchObject({ site: "測試盤甲", shiftType: "D", broker: "W", n: 12, price: "客價 100／工資 80／雞頭費 5", basis: "Postorder 第 374 行" });
    expect(cats.find((c) => c.key === "settled")!.rows[0]).toMatchObject({ broker: "W", n: 3 });
    expect(cats.find((c) => c.key === "variance")!.rows[0]!.site).toBe("測試盤乙");
    expect(cats.find((c) => c.key === "shift_types")!.rows[0]).toMatchObject({ site: "測試盤甲", n: 2 });
  });
  it("parsePricingLine 唔識嘅回 null", () => {
    expect(parsePricingLine("3 更按現有生效價卡補價")).toBeNull();
  });
});

describe("groupReview", () => {
  it("按 kind 分組、各頭 2 題、再多 N 題", () => {
    const g = groupReview(auto().review);
    expect(g.map((x) => x.key)).toEqual(["pricing", "guard", "settlement", "variance"]);
    const p = g[0]!;
    expect(p).toMatchObject({ count: 3, propose: 2, unknown: 1, more: 1 });
    expect(p.preview).toHaveLength(2);
    expect(g[2]!.count).toBe(0);
    const withSite = groupReview([{ kind: "month_close_site_new", text: "x", confidence: "unknown", question_id: null }]);
    expect(withSite.map((x) => x.key)).toContain("site");
  });
});

describe("lockRequirements / 體檢", () => {
  it("未對數確認＋未定價（＝ 要你睇 N 題）", () => {
    const reqs = lockRequirements(report(), 3);
    expect(reqs.map((r) => r.key)).toEqual(["unconfirmed", "unpriced"]);
    expect(reqs[0]!.title).toBe("2 個盤嘅更表未對數確認");
    expect(reqs[1]!.detail).toContain("3 題定價題");
    expect(reqs[1]!.actionLabel).toBe("去答 3 題 ›");
  });
  it("體檢人話化、重複標記", () => {
    expect(humanizeHealth("30 格安員配對唔到（unmatched）")).toBe("30 格對唔到安員");
    expect(humanizeHealth("5 格安員配對有多個候選（ambiguous）")).toBe("5 格安員有多個可能");
    expect(humanizeHealth("9 格淨靠姓名配對（建議補工號或電話）")).toBe("9 格淨靠姓名配對（建議補工號或電話）");
    const g = groupReview(auto().review);
    expect(healthDupReviewCount("unpriced_payout", g)).toBe(3);
    expect(healthDupReviewCount("unmatched_cells", g)).toBe(1);
    expect(healthDupReviewCount("over_max_shifts", g)).toBe(0);
  });
});

describe("splitSiteRevenue", () => {
  it("按收入排、頭 10、0 更盤收埋", () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({ site_id: `s${i}`, site_name: `盤${i}`, shifts: i + 1, revenue: (i + 1) * 100 }));
    rows.push({ site_id: "z1", site_name: "零", shifts: 0, revenue: 0 }, { site_id: "z2", site_name: "零2", shifts: 0, revenue: 0 });
    const r = splitSiteRevenue(rows);
    expect(r.shown).toHaveLength(10);
    expect(r.shown[0]!.site_id).toBe("s11");
    expect(r.rest).toHaveLength(2);
    expect(r.zeroCount).toBe(2);
  });
});

describe("kindChip／其他類／needs_human", () => {
  it("題型 chip 按 kind 對應，唔出禁用詞", () => {
    expect(kindChip("month_close_pricing", "未定價（有候選／冇依據）")).toBe("定價");
    expect(kindChip("month_close_guard_match", "x")).toBe("安員配對");
    expect(kindChip("month_close_site_new", "x")).toBe("盤名");
    expect(kindChip("future_kind", "未定價（有候選／冇依據）")).toBe("未定價（有候選／要你揀）");
  });
  it("未知 review kind／auto_line kind 歸入「其他」", () => {
    const g = groupReview([{ kind: "mystery", text: "原文一", confidence: "unknown", question_id: null }]);
    expect(g.find((x) => x.key === "other")).toMatchObject({ count: 1, preview: [{ text: "原文一", confidence: "unknown" }] });
    const a = auto({ auto_lines: [{ kind: "brand_new_kind", text: "新種類原文" }] });
    const { cats } = deriveAutoCategories(a);
    expect(cats.find((c) => c.key === "other")?.rows[0]?.basis).toBe("新種類原文");
  });
  it("needsHumanCount 合計各步驟", () => {
    const r = run();
    r.steps[0]!.needs_human = ["a", "b"];
    r.steps[1]!.needs_human = ["c"];
    expect(needsHumanCount(r)).toBe(3);
    expect(needsHumanCount(null)).toBe(0);
  });
});

describe("humanize（顯示 API 文字前去禁用詞）", () => {
  it("替換禁用詞，唔郁 code 識別字", () => {
    expect(humanize("價目表、歷史、Postorder 都冇依據")).toBe("價目表、歷史、Postorder 都要你揀");
    expect(humanize("有依據：unmatched／ambiguous／name_only")).toBe("有建議：對唔到安員／有多個可能／淨靠姓名配對");
    expect(humanize("shift 記錄 external leave")).toBe("更 記錄 客戶自己人 假");
    expect(humanize("測試盤（parsed）")).toBe("測試盤（已解析，未對數）");
    expect(humanize("shift_type_created")).toBe("shift_type_created");
  });
});
