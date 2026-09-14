// Opus 對抗式驗收 M1（default-deny 白名單 DTO）：每個資源一份完整白名單
// （camelCase，對應 Prisma model 欄位），response 一律經呢度先出街——
// **內部角色都唔准 raw Prisma row 直接 `ok(row)`**。新加落 Prisma schema
// 嘅欄位預設唔會出現喺 response（要手動加入呢度嘅陣列），呢個先係
// default-deny 嘅意思。
//
// N2（第三輪）：`mapRow()`/`mapListDTO()`/`toUserDTO()` 出嚟嘅值一律帶
// `Dto` brand（見 ../serialize.ts）——`ok()`（../http.ts）嘅參數型別
// 淨係接受呢個 brand，一個原始 Prisma row 傳落去 `ok()` 會喺 tsc 層面
// 直接紅，唔使等 runtime fuzz test 先發現。
//
// 呢份係「內部角色」（老闆/主管/會計）用嘅完整結構白名單；雞頭仲有
// 額外更窄嘅白名單（`src/lib/broker-dto.ts`，本身已經淨係得結構安全嘅
// 欄，唔需要再經呢度）。收客價/出街價 field-level gate 喺 DTO 之上再行
// 一層（`src/lib/api/field-groups.ts`）。
import { pickWhitelist, brandSafeResponse, type Dto } from "../serialize";
import type { FieldGroupResource } from "../field-groups";

const BROKER_FIELDS = ["id", "code", "name", "kind", "settlementType", "bankInfo", "requiresApproval", "isInternal", "aliases", "status", "createdAt", "updatedAt", "createdBy"] as const;
const SITE_FIELDS = ["id", "canonicalName", "aliases", "clientName", "clientGroup", "parentSiteId", "billingModel", "monthlyFee", "monthlyPosts", "prorataBasis", "inScope", "outsideMonthlyClose", "status", "createdAt", "updatedAt", "createdBy"] as const;
const SHIFT_TYPE_FIELDS = ["id", "siteId", "code", "label", "startTime", "endTime", "hours", "headcountRequired", "billingGroup", "voidedAt", "voidedBy", "createdAt", "updatedAt", "createdBy"] as const;
// S4（Opus 驗收修復）：`monthShiftCount` 係 P2-A 加嘅衍生欄（唔係
// Prisma model 本身有嘅欄，`GET /api/guards?with_month_shifts=YYYY-MM`
// 先會計出嚟 merge 落 row——加落呢個白名單先，落面 route 就可以喺
// DTO／field-group gate 之前就 merge，唔使再靠「gate 之後先手動加返」
// 嗰種繞過白名單機制嘅寫法。
const GUARD_FIELDS = ["id", "staffNo", "staffNoMw", "nameZh", "nameEn", "tel", "defaultBrokerId", "employmentType", "monthlySalary", "siaPermitExpiry", "poloSize", "mergedFrom", "status", "createdAt", "updatedAt", "createdBy", "monthShiftCount"] as const;
const RATE_CARD_FIELDS = ["id", "siteId", "shiftTypeId", "brokerId", "guardId", "clientRate", "guardWage", "brokerFee", "payoutRate", "billingModel", "effectiveFrom", "effectiveTo", "source", "evidence", "confidence", "status", "note", "voidedAt", "voidedBy", "createdAt", "updatedAt", "createdBy"] as const;
const SHIFT_RECORD_FIELDS = ["id", "workDate", "siteId", "shiftTypeId", "guardId", "settlementBrokerId", "operationalBrokerId", "referralFeeSnapshot", "rescueRate", "recordType", "leaveCode", "otHours", "parentShiftId", "locationTag", "isExternal", "billed", "paid", "settlementPage", "clientRateSnapshot", "guardWageSnapshot", "brokerFeeSnapshot", "source", "provenance", "status", "createdAt", "updatedAt", "createdBy"] as const;
const DAILY_REQUIREMENT_FIELDS = ["id", "siteId", "shiftTypeId", "workDate", "headcountRequired", "voidedAt", "voidedBy", "createdAt", "updatedAt", "createdBy"] as const;
const SPECIAL_ITEM_FIELDS = ["id", "month", "siteId", "brokerId", "kind", "shifts", "revenue", "cost", "description", "voidedAt", "voidedBy", "createdAt", "updatedAt", "createdBy"] as const;
const MONTH_CLOSE_FIELDS = ["id", "month", "lockedAt", "lockedBy", "rosterVersionNote", "createdAt", "updatedAt", "createdBy"] as const;
const ROLE_FIELDS = ["id", "name", "payoutApprovalLimit", "isCustom", "baseRole", "voidedAt", "voidedBy", "createdAt", "updatedAt", "createdBy"] as const;
// P5：failed_attempts/locked_until/allowed_ip 淨係 用戶管理:view 先見到
// （route 本身已經要求呢個權限先入得嚟，但抽做獨立 field group 令呢個
// 限制唔靠「岩岩好個 route 要求緊」，係結構性保證）。
const USER_BASE_FIELDS = ["id", "name", "tel", "roleId", "guardId", "brokerId", "payoutApprovalLimit", "status", "lastLoginAt", "lastLoginIp", "mustChangePwd", "tokenVersion", "createdAt", "updatedAt", "createdBy"] as const;
export const USER_MANAGEMENT_ONLY_FIELDS = ["failedAttempts", "lockedUntil", "allowedIp"] as const;
const BROKER_SITE_ASSIGNMENT_FIELDS = ["id", "brokerId", "siteId", "month", "createdAt", "createdBy"] as const;
// P1-WP3：quotas（配額）——冇金錢欄，內部角色/雞頭白名單一致（雞頭版
// 見 broker-dto.ts 嘅 QUOTA_BROKER_FIELDS，query-scope 已限自己 broker_id）。
const QUOTA_FIELDS = ["id", "month", "siteId", "shiftTypeId", "brokerId", "targetShifts", "voidedAt", "voidedBy", "createdAt", "updatedAt", "createdBy"] as const;
// P1-WP3（E）：referral_fee_rates（雞頭介紹費率）——`fee_per_shift` 係
// 「出街價」性質嘅成本欄，field-level gate 喺 field-groups.ts 做（內部
// 角色冇「出街價:view」會被剝呢一粒數；雞頭自己嘅版本見 broker-dto.ts
// REFERRAL_FEE_RATE_BROKER_FIELDS，唔經呢個機制——雞頭見自己嘅費率
// 一向係允許嘅，同 rate_cards 嘅 payout_rate/guard_wage/broker_fee 一致）。
const REFERRAL_FEE_RATE_FIELDS = ["id", "brokerId", "siteId", "month", "feePerShift", "voidedAt", "voidedBy", "createdAt", "updatedAt", "createdBy"] as const;
// N1：audit_log 本身嘅白名單（都經呢個機制，一致對待——雖然 AuditLog
// model 目前冇任何「唔應該出街」嘅欄，但結構上一致，日後加欄唔會自動漏）。
const AUDIT_LOG_FIELDS = ["id", "actorUserId", "tableName", "rowId", "action", "before", "after", "ip", "createdAt"] as const;
// P2.5「現場反映」開會模式——feedback_reports 白名單。冇金錢欄，唔需要
// field-group gate；讀取權限（作者本人／老闆）喺 route 層判斷（見
// src/app/api/feedback/reports/**）。
const FEEDBACK_REPORT_FIELDS = [
  "id",
  "sessionId",
  "userId",
  "roleName",
  "title",
  "summaryMd",
  "fields",
  "transcriptExcerpt",
  "status",
  "reviewNote",
  "reviewedBy",
  "reviewedAt",
  "createdAt",
  "updatedAt",
] as const;
export const toFeedbackReportDTO = <T extends Record<string, unknown>>(row: T) => mapRow(row, FEEDBACK_REPORT_FIELDS);

function mapRow<T extends Record<string, unknown>>(row: T, fields: readonly string[]): Dto {
  return pickWhitelist(row, fields);
}

export const toBrokerFullDTO = <T extends Record<string, unknown>>(row: T) => mapRow(row, BROKER_FIELDS);
// Opus 對抗式驗收第二輪 R3：`has_roster_layout`（衍生 boolean，唔係
// 白名單直接抄 Prisma 欄）俾 UI 判斷要唔要顯示「呢個盤未有更表模板，
// 唔可以匯出」提示——刻意唔直接白名單 `rosterLayout` 本身（嗰個 JSON
// blob 入面 `rawRows`/`rawRow` 捕捉緊原檔逐格字面，可能含真名/電話/
// 工號，PDPO 唔可以整份俾前端）。
export const toSiteDTO = <T extends Record<string, unknown>>(row: T) =>
  mapRow({ ...row, hasRosterLayout: (row as Record<string, unknown>).rosterLayout != null }, [...SITE_FIELDS, "hasRosterLayout"]);
export const toShiftTypeDTO = <T extends Record<string, unknown>>(row: T) => mapRow(row, SHIFT_TYPE_FIELDS);
export const toGuardFullDTO = <T extends Record<string, unknown>>(row: T) => mapRow(row, GUARD_FIELDS);
export const toRateCardFullDTO = <T extends Record<string, unknown>>(row: T) => mapRow(row, RATE_CARD_FIELDS);
export const toShiftRecordFullDTO = <T extends Record<string, unknown>>(row: T) => mapRow(row, SHIFT_RECORD_FIELDS);
// 2026-09-13：列表預設唔回傳 provenance（原檔追溯 JSON，每條 ~1.5KB，7 月一個盤三頁共 2MB+，
// 手機網絡載入極慢；畫面唔用佢）。要嘅 caller 用 `?include_provenance=1`。
const SHIFT_RECORD_LIST_FIELDS = SHIFT_RECORD_FIELDS.filter((f) => f !== "provenance") as unknown as readonly (typeof SHIFT_RECORD_FIELDS)[number][];
export const toShiftRecordListDTO = <T extends Record<string, unknown>>(row: T) => mapRow(row, SHIFT_RECORD_LIST_FIELDS);
// `?view=grid`：更表編輯器只需要呢 9 欄（每條 ~230 bytes，對比全欄 ~965）。
const SHIFT_RECORD_GRID_FIELDS = ["id", "workDate", "siteId", "shiftTypeId", "guardId", "settlementBrokerId", "recordType", "leaveCode", "status"] as const;
export const toShiftRecordGridDTO = <T extends Record<string, unknown>>(row: T) => mapRow(row, SHIFT_RECORD_GRID_FIELDS);
export const toDailyRequirementFullDTO = <T extends Record<string, unknown>>(row: T) => mapRow(row, DAILY_REQUIREMENT_FIELDS);
export const toSpecialItemDTO = <T extends Record<string, unknown>>(row: T) => mapRow(row, SPECIAL_ITEM_FIELDS);
export const toMonthCloseDTO = <T extends Record<string, unknown>>(row: T) => mapRow(row, MONTH_CLOSE_FIELDS);
export const toRoleDTO = <T extends Record<string, unknown>>(row: T) => mapRow(row, ROLE_FIELDS);
export const toBrokerSiteAssignmentDTO = <T extends Record<string, unknown>>(row: T) => mapRow(row, BROKER_SITE_ASSIGNMENT_FIELDS);
export const toQuotaDTO = <T extends Record<string, unknown>>(row: T) => mapRow(row, QUOTA_FIELDS);
export const toReferralFeeRateDTO = <T extends Record<string, unknown>>(row: T) => mapRow(row, REFERRAL_FEE_RATE_FIELDS);
export const toAuditLogDTO = <T extends Record<string, unknown>>(row: T) => mapRow(row, AUDIT_LOG_FIELDS);

export function toUserDTO<T extends Record<string, unknown>>(row: T, includeManagementFields: boolean): Dto {
  const fields = includeManagementFields ? [...USER_BASE_FIELDS, ...USER_MANAGEMENT_ONLY_FIELDS] : USER_BASE_FIELDS;
  return mapRow(row, fields);
}

/** list response 常見形狀 { rows, total, skip, take }——rows 逐個過白名單。 */
export function mapListDTO<T extends Record<string, unknown>>(
  listResult: { rows: T[]; total: number; skip: number; take: number },
  mapper: (row: T) => Dto,
): Dto<{ rows: Dto[]; total: number; skip: number; take: number }> {
  return brandSafeResponse({ ...listResult, rows: listResult.rows.map(mapper) });
}

/** N1(b)：audit_log 讀出嘅 table_name → 邊個 field-group resource（收客價/
 * 出街價 gate）對照——淨係 5 個有價錢欄嘅 resource 先需要喺讀出嗰陣再
 * gate（寫入嗰陣 audit.ts 已經存咗完整 DTO，讀出先按*讀者*而唔係*作出
 * 動作嗰個人*嘅權限再剝一次，見 audit-log/route.ts）。其他 table（例如
 * guards/roles/users/shift_types/broker_site_assignments）冇價錢欄，
 * 唔喺呢個表入面就代表唔使再 gate。 */
export const AUDIT_FIELD_GROUP_RESOURCE_BY_TABLE: Record<string, FieldGroupResource> = {
  shift_records: "shift_records",
  rate_cards: "rate_cards",
  sites: "sites",
  special_items: "special_items",
  month_closes: "month_closes",
  // C2（Opus 對抗式驗收第四輪）：guards/brokers 而家都有出街價相關欄
  // （monthly_salary／bank_info），audit-log 讀出嗰陣一樣要 gate。
  guards: "guards",
  brokers: "brokers",
  // P1-WP3（E）：referral_fee_rates.fee_per_shift 係出街價性質嘅成本欄。
  referral_fee_rates: "referral_fee_rates",
};
