// WP-ONE-CLICK Phase 1（老闆 2026-09-26「一鍵全月結算」，§20）：型別
// 定義——`month_close_runs.steps_json`／`report_json` 嘅契約，`src/lib/
// month-close/one-click.ts`（job 邏輯）同 API route／頁面共用同一份型別。
//
import type { AutoReport } from "./auto/types";

// 鐵則：呢度嘅 `warnings`／`needsHuman` 一律唔准帶姓名／工號／電話——
// 淨係盤名／雞頭代號／數目（同 `guard-fix/plan.ts` needsBoss「盤＋格數
// ＋原因」一致紀律），因為 `report_json` 經「一鍵結算」module 嘅 view
// 會俾主管睇到（主管出廠未必有「保安員個人資料」view）。

export const STEP_KEYS = [
  "precheck",
  "parse_health",
  "guard_fix",
  "longterm_settlement",
  "reconcile_apply",
  "auto_pricing",
  "pricing_check",
  "compute",
  "postorder_compare",
  "report",
] as const;
export type StepKey = (typeof STEP_KEYS)[number];

const STEP_LABELS: Record<StepKey, string> = {
  precheck: "前置檢查",
  parse_health: "解析健康",
  guard_fix: "保安員修復",
  longterm_settlement: "長工結算",
  reconcile_apply: "全月對數套用",
  auto_pricing: "自動歸屬／定價",
  pricing_check: "定價檢查",
  compute: "計數",
  postorder_compare: "對照（可選）",
  report: "報告",
};

type StepStatus = "pending" | "running" | "done" | "failed" | "skipped";

export interface StepRecord {
  key: StepKey;
  label: string;
  status: StepStatus;
  startedAt: string | null;
  finishedAt: string | null;
  numbers: Record<string, unknown>;
  warnings: string[];
  needsHuman: string[];
}

export function emptySteps(): StepRecord[] {
  return STEP_KEYS.map((key) => ({ key, label: STEP_LABELS[key], status: "pending", startedAt: null, finishedAt: null, numbers: {}, warnings: [], needsHuman: [] }));
}

export interface MonthCloseReport {
  month: string;
  /** revenue＝月結總表（主表＋月結以外）營業額；marginRevenue／cost／
   * grossMargin＝毛利即時表 `totals`（唔計月結以外收入）。 */
  totals: {
    revenue: number;
    marginRevenue: number;
    /** costBasis="combined"（2026-08 起、長工糧有 run）＝合併口徑（更次成本＋
     * 介紹費＋長工 Autopay，§16.2 第一層）；"legacy"＝毛利表舊口徑（長工月薪
     * 係按更數估算分攤）。 */
    cost: number;
    grossMargin: number;
    costBasis?: "combined" | "legacy";
    /** 毛利表舊口徑成本／毛利（對照用；舊 report_json 冇呢兩欄）。 */
    legacyCost?: number;
    legacyMargin?: number;
  };
  payrollByBroker: Array<{ brokerCode: string; brokerName: string; shifts: number; amount: number }>;
  siteRevenue: Array<{ siteId: string; siteName: string; shifts: number; revenue: number }>;
  referralFee: { total: number; count: number };
  unpriced: {
    count: number;
    payoutCount: number;
    clientCount: number;
    noSettlementCount: number;
    otUnpricedCount: number;
    /** WP-ONE-CLICK-AUTO §31.3 C：未定價更數／估算缺口——報告唔准將未定價當 0 成本，分開列。
     * 估算用同盤同更種最近已知卡價，淨係提示，唔入任何金額表。 */
    gap?: { records: number; clientGapEstimate: number | null; payoutGapEstimate: number | null; noReferenceRecords: number } | null;
  };
  postorderCompare: {
    uploaded: boolean;
    referralExcelTotal: number | null;
    referralSystemTotal: number;
    referralDiff: number | null;
    note: string;
  } | null;
  needsHuman: string[];
  lockPrecondition: {
    currentMonthAlreadyLocked: boolean;
    missingUploadSites: string[];
    unconfirmedUploadSites: string[];
    unpricedCount: number;
    readyToLock: boolean;
  };
  // WP-LTPAY Phase 2 §21 任務 3d：長工月薪糧總數（`aggregate.ts`
  // `recomputeLongtermPayroll()` 呢個 run 嘅 totals，null＝重算失敗）。
  // 鐵則：呢度淨係總數，唔包含逐人資料（逐人明細有 PII，report_json
  // 俾主管都睇到，唔可以喺呢層出現姓名／工號——逐人明細留返
  // `/reports/longterm-payroll` 頁面（未起，見 §21.2）自己做 PII gate）。
  longtermPayroll: { grossTotal: number; autopayTotal: number; mpfEeTotal: number; mpfErTotal: number; guardCount: number } | null;
  longtermPayrollNote: string;
  // §21 任務 5a（老闆定案，§16.2 第一層口徑）：合併成本摘要——更次成本／
  // 長工 Autopay／介紹費／合計／MPF ER（另列，唔入合計）。淨係 2026-08
  // 起有值，7 月（或更早）恆 null（同 `longtermPayroll` 一致嘅月份閘）。
  /** WP-ONE-CLICK-AUTO §31.3 E：自動處理摘要＋要你睇＋撤銷狀態（舊 run 冇）。 */
  auto?: AutoReport;
  combinedCostSummary: {
    perShiftCostTotal: number;
    referralFeeTotal: number;
    longtermAutopayTotal: number;
    visaPassthroughAutopayExcluded?: number;
    combinedCostTotal: number;
    mpfErTotal: number;
  } | null;
}
