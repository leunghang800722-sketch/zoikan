// WP-LTPAY §21 任務 5b：`/api/longterm/**` 系列 route 共用嘅白名單 DTO
// （同 `src/lib/api/dto/index.ts` 同一精神——`ok()` 嘅 `Dto` brand 淨係
// 經 `pickWhitelist()`/`brandSafeResponse()` 先攞得到，內部角色都唔准
// raw Prisma row 直接出街，見 `tests/dto-brand-guard.test.ts`）。獨立
// 開一個檔（唔加落中央 `dto/index.ts`）——呢批 resource 全部歸「長工糧」
// module 一致粒度嘅硬性 gate（老闆／會計先入到 route，主管/雞頭/保安員
// 連 `requirePermission()` 都過唔到），唔需要中央檔嗰種逐 field-group
// 再細分嘅機制。
import { pickWhitelist, type Dto } from "@/lib/api/serialize";

const CONTRACT_FIELDS = [
  "id", "guardId", "effectiveFrom", "effectiveTo", "monthlySalary", "payBasis", "dailyRate",
  "postSiteId", "restDayPaid", "restDayRate", "shiftHours", "probationMonths", "annualLeaveDays",
  "statutoryHolidayPaidFrom", "mpfExemptReason", "note", "source",
  "createdAt", "updatedAt", "createdBy", "voidedAt", "voidedBy",
] as const;

const INPUT_FIELDS = [
  "id", "month", "guardId", "kind", "amount", "dateFrom", "dateTo", "doctorNoteVerified", "note",
  "createdAt", "createdBy", "voidedAt", "voidedBy",
  "status", "draftSource", "draftEvidence", "confirmedAt", "confirmedBy",
] as const;

const AVG_WAGE_FIELDS = ["id", "guardId", "month", "avgDailyWage", "source", "createdAt", "createdBy", "voidedAt"] as const;

const LEAVE_BALANCE_FIELDS = [
  "id", "guardId", "year", "alEntitled", "alTaken", "alCarry", "slAccrued", "slTaken",
  "asOfMonth", "alTakenOpening", "slTakenOpening", "updatedAt", "createdAt",
] as const;

const RUN_FIELDS = ["id", "month", "status", "totalsJson", "createdAt", "createdBy", "confirmedAt", "confirmedBy", "voidedAt", "voidedBy"] as const;

const LINE_FIELDS = [
  "id", "runId", "guardId", "contractSnapshot", "daysInMonth", "workDays", "netBasic", "otHours",
  "otAmount", "restDayPayment", "npsh", "nplDays", "npslDays", "deduction", "specialAllowance",
  "otherAllowance", "alPayment", "sl45Amount", "gross", "mpfEe", "mpfEr", "autopay", "notesJson",
  "createdAt", "updatedAt",
] as const;

// 逐人明細畀頁面顯示要 join 埋保安員姓名／工號（S4 pattern：衍生欄喺
// DTO 之前 merge 落 row，再喺呢度嘅白名單明文列出，PDPO：淨係
// nameZh／staffNo，唔夾帶其他 guard PII）；`prevGross`/`prevAutopay`/
// `grossDelta`/`autopayDelta`＝「同上月比較」欄（見 route.ts）。
const LINE_WITH_GUARD_FIELDS = [...LINE_FIELDS, "guardName", "guardStaffNo", "prevGross", "prevAutopay", "grossDelta", "autopayDelta"] as const;

const CONTRACT_WITH_GUARD_FIELDS = [...CONTRACT_FIELDS, "guardName", "guardStaffNo"] as const;

export const toLongtermContractDTO = <T extends Record<string, unknown>>(row: T): Dto => pickWhitelist(row, CONTRACT_FIELDS);
export const toLongtermContractWithGuardDTO = <T extends Record<string, unknown>>(row: T): Dto => pickWhitelist(row, CONTRACT_WITH_GUARD_FIELDS);
const INPUT_WITH_GUARD_FIELDS = [...INPUT_FIELDS, "guardName", "guardStaffNo"] as const;

export const toLongtermInputDTO = <T extends Record<string, unknown>>(row: T): Dto => pickWhitelist(row, INPUT_FIELDS);
export const toLongtermInputWithGuardDTO = <T extends Record<string, unknown>>(row: T): Dto => pickWhitelist(row, INPUT_WITH_GUARD_FIELDS);
const AVG_WAGE_WITH_GUARD_FIELDS = [...AVG_WAGE_FIELDS, "guardName", "guardStaffNo"] as const;
const LEAVE_BALANCE_WITH_GUARD_FIELDS = [...LEAVE_BALANCE_FIELDS, "guardName", "guardStaffNo"] as const;

export const toGuardAvgWageDTO = <T extends Record<string, unknown>>(row: T): Dto => pickWhitelist(row, AVG_WAGE_FIELDS);
export const toGuardAvgWageWithGuardDTO = <T extends Record<string, unknown>>(row: T): Dto => pickWhitelist(row, AVG_WAGE_WITH_GUARD_FIELDS);
export const toGuardLeaveBalanceDTO = <T extends Record<string, unknown>>(row: T): Dto => pickWhitelist(row, LEAVE_BALANCE_FIELDS);
export const toGuardLeaveBalanceWithGuardDTO = <T extends Record<string, unknown>>(row: T): Dto => pickWhitelist(row, LEAVE_BALANCE_WITH_GUARD_FIELDS);
export const toLongtermRunDTO = <T extends Record<string, unknown>>(row: T): Dto => pickWhitelist(row, RUN_FIELDS);
export const toLongtermLineWithGuardDTO = <T extends Record<string, unknown>>(row: T): Dto => pickWhitelist(row, LINE_WITH_GUARD_FIELDS);
