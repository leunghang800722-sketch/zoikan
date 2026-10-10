// WP-MC-UI：月結頁用嘅 DTO 型別（對應 GET /api/month-close/one-click 回傳，
// 只做型別，唔改 API 合約）。

export interface StepDTO {
  key: string;
  label: string;
  status: "pending" | "running" | "done" | "failed" | "skipped";
  started_at: string | null;
  finished_at: string | null;
  numbers: Record<string, unknown>;
  warnings: string[];
  needs_human: string[];
}

export interface PostorderDependencyDTO {
  pricing: { total: number; unpriced: number; by_step: { "1": number; "2": number; "3": number; "4": number; "5": number; existing: number }; without_postorder: number };
  settlement: { total: number; by_reason: Record<string, number>; without_postorder: number };
}

export interface AutoReportDTO {
  summary: {
    sites_aliased: number;
    sites_created: number;
    shift_types_created: number;
    aliases_from_postorder: number;
    cards_created: number;
    records_priced: number;
    records_settled: number;
    guard_matches_auto: number;
    variances_explained: number;
    variances_unexplained: number;
    unpriced_records: number;
    counts: { countable: number; external: number; internal_cash: number };
    /** WP-POSTORDER-FREE（§34 C）：舊 report 冇。 */
    postorder_dependency?: PostorderDependencyDTO;
  };
  auto_lines: Array<{ kind: string; text: string }>;
  review: Array<{ kind: string; text: string; confidence: "propose" | "unknown"; question_id: string | null }>;
  triage_session_id: string | null;
  undone: boolean;
  undone_at: string | null;
  voided_card_price_check?: { count: number; record_ids: string[] };
}

export interface ReportDTO {
  month: string;
  totals: { revenue: number; margin_revenue?: number; cost: number; gross_margin: number; cost_basis?: "combined" | "legacy"; legacy_cost?: number; legacy_margin?: number };
  payroll_by_broker: Array<{ broker_code: string; broker_name: string; shifts: number; amount: number }>;
  site_revenue: Array<{ site_id: string; site_name: string; shifts: number; revenue: number }>;
  referral_fee: { total: number; count: number };
  unpriced: {
    count: number;
    payout_count: number;
    client_count: number;
    no_settlement_count: number;
    ot_unpriced_count: number;
    gap?: { records: number; client_gap_estimate: number | null; payout_gap_estimate: number | null; no_reference_records: number } | null;
  };
  auto?: AutoReportDTO;
  postorder_compare: { uploaded: boolean; referral_excel_total: number | null; referral_system_total: number; referral_diff: number | null; note: string } | null;
  needs_human: string[];
  health?: { critical: number; warn: number; info: number } | null;
  lock_precondition: { current_month_already_locked: boolean; missing_upload_sites: string[]; unconfirmed_upload_sites: string[]; unpriced_count?: number; ready_to_lock: boolean };
  longterm_payroll_note: string;
  longterm_payroll?: { gross_total: number; autopay_total: number; mpf_ee_total: number; mpf_er_total: number; guard_count: number } | null;
  combined_cost_summary: {
    per_shift_cost_total: number;
    referral_fee_total: number;
    longterm_autopay_total: number;
    combined_cost_total: number;
    mpf_er_total: number;
    visa_passthrough_autopay_excluded?: number;
  } | null;
}

export interface RunDTO {
  id: string;
  month: string;
  status: "running" | "done" | "failed";
  started_at: string;
  finished_at: string | null;
  current_step: string | null;
  stalled: boolean;
  steps: StepDTO[];
  report: ReportDTO | null;
  error_message: string | null;
}
