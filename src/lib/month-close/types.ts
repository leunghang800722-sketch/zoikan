// WP-ONE-CLICK Phase 1（老闆 2026-09-26「一鍵全月結算」，§20）：型別
// 定義——`month_close_runs.steps_json`／`report_json` 嘅契約，`src/lib/
// month-close/one-click.ts`（job 邏輯）同 API route／頁面共用同一份型別。
//
// 鐵則：呢度嘅 `warnings`／`needsHuman` 一律唔准帶姓名／工號／電話——
// 淨係盤名／雞頭代號／數目（同 `guard-fix/plan.ts` needsBoss「盤＋格數
// ＋原因」一致紀律），因為 `report_json` 經「一鍵結算」module 嘅 view
// 會俾主管睇到（主管出廠未必有「安員個人資料」view）。

export const STEP_KEYS = [
  "precheck",
  "parse_health",
  "guard_fix",
  "longterm_settlement",
  "reconcile_apply",
  "pricing_check",
  "compute",
  "postorder_compare",
  "report",
] as const;
export type StepKey = (typeof STEP_KEYS)[number];

export const STEP_LABELS: Record<StepKey, string> = {
  precheck: "前置檢查",
  parse_health: "解析健康",
  guard_fix: "安員修復",
  longterm_settlement: "長工結算",
  reconcile_apply: "全月對數套用",
  pricing_check: "定價檢查",
  compute: "計數",
  postorder_compare: "對照（可選）",
  report: "報告",
};

export type StepStatus = "pending" | "running" | "done" | "failed" | "skipped";

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
  totals: { revenue: number; cost: number; grossMargin: number };
  payrollByBroker: Array<{ brokerCode: string; brokerName: string; shifts: number; amount: number }>;
  siteRevenue: Array<{ siteId: string; siteName: string; shifts: number; revenue: number }>;
  referralFee: { total: number; count: number };
  unpriced: { count: number; payoutCount: number; clientCount: number; noSettlementCount: number; otUnpricedCount: number };
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
    readyToLock: boolean;
  };
  longtermPayrollNote: string;
}
