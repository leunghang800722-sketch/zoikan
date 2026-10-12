// P14.3：銀行對數差異原因（client／server 共用，零依賴——唔好 import SheetJS）。
export const REASON_CODES = ["paid_outside_autopay", "not_longterm", "salary_change_date", "attendance_day", "sick_leave_policy", "al_encash_basis", "rounding", "other"] as const;
export type ReasonCode = (typeof REASON_CODES)[number];
export const REASON_LABEL: Record<ReasonCode, string> = {
  paid_outside_autopay: "autopay 以外出糧",
  not_longterm: "非長工",
  salary_change_date: "調薪／轉約生效日",
  attendance_day: "出勤日數",
  sick_leave_policy: "病假處理",
  al_encash_basis: "年假結算基數",
  rounding: "四捨五入",
  other: "其他",
};
