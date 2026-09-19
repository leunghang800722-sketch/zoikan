// C2：雞頭回應每個資源逐 route 白名單 DTO（欄位明列，唔係淨係剝黑名單）。
// 用 pickWhitelist()——逐個欄位獨立 convert，唔會有「遞歸拆爛 Decimal/
// Date」嗰個 bug class（見 src/lib/api/serialize.ts 頂註解）。
import { pickWhitelist, brandSafeResponse, type Dto } from "./api/serialize";

// 安員（自己安員名冊，§6.2）：HR 基本資料，冇任何金錢/其他 broker 資料。
// S4（Opus 驗收修復）：`monthShiftCount`（P2-A「本月更數」衍生欄，
// `GET /api/guards?with_month_shifts=` 先會計出嚟）加入呢個白名單——
// 冇金錢/敏感成分，雞頭見自己安員嘅本月更數一向准，同內部角色
// GUARD_FIELDS 一致做法（見 src/lib/api/dto/index.ts 同一段註解）。
// WP-STAFFNO：`staffNumbers`（additive，淨係 current）加落嚟——工號本身
// 雞頭一直見到（`staffNo`/`staffNoMw` 舊欄本身已經喺呢個白名單），呢個
// 淨係加多個結構化版（chips 用）。`siaPermitAExpiry`／`siaPermitBExpiry`
// 刻意唔加——跟返現有做法（`siaPermitNo`／`siaPermitType` 一路都冇喺呢
// 個白名單，雞頭淨係見到衍生嘅 `siaPermitExpiry`，唔見拆開嘅甲／乙）。
export const GUARD_BROKER_FIELDS = [
  "id",
  "staffNo",
  "staffNoMw",
  "nameZh",
  "nameEn",
  "tel",
  "defaultBrokerId",
  "employmentType",
  "siaPermitExpiry",
  "poloSize",
  "status",
  "createdAt",
  "updatedAt",
  "monthShiftCount",
  "staffNumbers",
] as const;

// 雞頭（自己資料）：淨係基本資料，bankInfo 已經喺 blocklist 剝埋（defense-in-depth）。
export const BROKER_SELF_FIELDS = [
  "id",
  "code",
  "name",
  "kind",
  "settlementType",
  "requiresApproval",
  "aliases",
  "status",
  "createdAt",
] as const;

// 價目（雞頭睇自己出街價）：guard_wage/broker_fee/payout_rate 得，
// client_rate/note/evidence/source/confidence 一律唔畀（C2 硬性規則1）。
export const RATE_CARD_BROKER_FIELDS = [
  "id",
  "siteId",
  "shiftTypeId",
  "brokerId",
  "guardId",
  "guardWage",
  "brokerFee",
  "payoutRate",
  "billingModel",
  "effectiveFrom",
  "effectiveTo",
  "voidedAt",
  "createdAt",
] as const;

// 更次記錄（雞頭睇自己安員嘅更）：guard_wage_snapshot/broker_fee_snapshot
// 得，client_rate_snapshot/settlement_page/provenance/source 一律唔畀。
export const SHIFT_RECORD_BROKER_FIELDS = [
  "id",
  "workDate",
  "siteId",
  "shiftTypeId",
  "guardId",
  "settlementBrokerId",
  "operationalBrokerId",
  "referralFeeSnapshot",
  "recordType",
  "leaveCode",
  "otHours",
  "parentShiftId",
  "locationTag",
  "isExternal",
  "billed",
  "paid",
  "guardWageSnapshot",
  "brokerFeeSnapshot",
  "status",
  "createdAt",
  "updatedAt",
] as const;

// P1-WP3：盤（sites）——雞頭需要知自己有份嗰啲盤嘅名／別名先揀得到
// 更表編輯器嘅盤（見 shift-types 上面同一段註解）。刻意冇
// monthly_fee/monthly_posts/prorata_basis（財務欄，內部角色都要
// 「收客價:view」先見到，雞頭連白名單都冇呢幾欄，defense-in-depth）、
// clientGroup/parentSiteId/createdBy（後台欄，雞頭唔需要）。Opus 對抗式
// 驗收 A2（裁定）：`clientName`／`billingModel` 都剔走——雞頭揀盤淨係
// 需要 id／canonicalName／aliases／status，`clientName` 會間接洩漏客戶
// 身份（同 PDPO「客戶全名」關注一致），`billingModel` 係內部結算方式，
// 雞頭都唔需要知。
// Opus 對抗式驗收第二輪 R3：`hasRosterLayout` 加落嚟俾雞頭前端一樣可以
// 顯示「呢個盤未有更表模板，唔可以匯出」提示（同內部角色 toSiteDTO 一致
// 手法——`rosterLayout` 本身個 JSON blob 唔可以直接俾雞頭，見
// src/lib/api/dto/index.ts 對應註解）。
export const SITE_BROKER_FIELDS = ["id", "canonicalName", "aliases", "status", "hasRosterLayout"] as const;

// P1-WP3：更別（shift_types）——雞頭要睇到自己有份嗰啲盤嘅更別代號／
// 時段先填得到自己配額（設計文件§4.1「雞頭：喺自己配額內填人」），但
// 「盤」module 本身對雞頭係硬性 deny（盤管理，同雞頭角色無關）——呢個
// GET 用 module resolver 改行「更表」（見 shift-types/route.ts），呢個
// 白名單冇 createdBy/voidedBy（內部用戶 id，雞頭唔需要知邊個 admin 改嘅）。
export const SHIFT_TYPE_BROKER_FIELDS = [
  "id",
  "siteId",
  "code",
  "label",
  "startTime",
  "endTime",
  "hours",
  "headcountRequired",
  "billingGroup",
  "voidedAt",
  "createdAt",
] as const;

// 所需人手（daily_requirements）：本身冇金錢/自由文字欄，全部欄都安全。
export const DAILY_REQUIREMENT_BROKER_FIELDS = [
  "id",
  "siteId",
  "shiftTypeId",
  "workDate",
  "headcountRequired",
  "voidedAt",
  "createdAt",
] as const;

// C1（Opus 對抗式驗收第四輪）：月結鎖定狀態（month_closes）自從 GET 改用
// 「更表:view」（雞頭出廠有），雞頭而家都入得嚟——但 rosterVersionNote
// （內部備註，可能有敏感文字）／lockedBy／createdBy（內部用戶 id）唔應該
// 俾雞頭見到，佢淨係需要知「邊個月鎖咗」（月／幾時鎖，唔使知邊個做／
// 點解）。
export const MONTH_CLOSE_BROKER_FIELDS = ["id", "month", "lockedAt"] as const;

// P1-WP3：配額（雞頭 GET 只見自己——query-scope 喺 broker-isolation.ts
// scopeQuotaWhere() 做；呢個 DTO 本身冇金錢欄，白名單純粹一致性處理）。
export const QUOTA_BROKER_FIELDS = ["id", "month", "siteId", "shiftTypeId", "brokerId", "targetShifts", "createdAt"] as const;

// P1-WP3（E）：介紹費率（雞頭 GET 只見自己——query-scope 喺
// broker-isolation.ts scopeReferralFeeRateWhere() 做）。呢個 feePerShift
// 係雞頭自己攞幾多錢，同 rate_cards 嘅 payoutRate/guardWage/brokerFee
// 一致做法——雞頭見自己嘅費率一向准，唔經「出街價」field-group gate
// （嗰個 gate 係管緊內部角色見唔見到*其他*雞頭嘅成本數，唔係管雞頭見
// 自己）。
export const REFERRAL_FEE_RATE_BROKER_FIELDS = ["id", "brokerId", "siteId", "month", "feePerShift", "voidedAt", "createdAt"] as const;

function mapRow<T extends Record<string, unknown>>(row: T, fields: readonly string[]): Dto {
  return pickWhitelist(row, fields);
}

export function toBrokerGuardDTO<T extends Record<string, unknown>>(row: T) {
  return mapRow(row, GUARD_BROKER_FIELDS);
}
export function toBrokerShiftTypeDTO<T extends Record<string, unknown>>(row: T) {
  return mapRow(row, SHIFT_TYPE_BROKER_FIELDS);
}
export function toBrokerSiteDTO<T extends Record<string, unknown>>(row: T) {
  return mapRow({ ...row, hasRosterLayout: (row as Record<string, unknown>).rosterLayout != null }, SITE_BROKER_FIELDS);
}
export function toBrokerSelfDTO<T extends Record<string, unknown>>(row: T) {
  return mapRow(row, BROKER_SELF_FIELDS);
}
export function toBrokerRateCardDTO<T extends Record<string, unknown>>(row: T) {
  return mapRow(row, RATE_CARD_BROKER_FIELDS);
}
export function toBrokerShiftRecordDTO<T extends Record<string, unknown>>(row: T) {
  return mapRow(row, SHIFT_RECORD_BROKER_FIELDS);
}
export function toBrokerDailyRequirementDTO<T extends Record<string, unknown>>(row: T) {
  return mapRow(row, DAILY_REQUIREMENT_BROKER_FIELDS);
}
export function toBrokerMonthCloseDTO<T extends Record<string, unknown>>(row: T) {
  return mapRow(row, MONTH_CLOSE_BROKER_FIELDS);
}
export function toBrokerQuotaDTO<T extends Record<string, unknown>>(row: T) {
  return mapRow(row, QUOTA_BROKER_FIELDS);
}
export function toBrokerReferralFeeRateDTO<T extends Record<string, unknown>>(row: T) {
  return mapRow(row, REFERRAL_FEE_RATE_BROKER_FIELDS);
}

/** list response 常見形狀 { rows, total, skip, take }——rows 逐個過白名單，其他欄照留。 */
export function mapListForBroker<T extends Record<string, unknown>>(
  listResult: { rows: T[]; total: number; skip: number; take: number },
  mapper: (row: T) => Dto,
): Dto<{ rows: Dto[]; total: number; skip: number; take: number }> {
  return brandSafeResponse({ ...listResult, rows: listResult.rows.map(mapper) });
}
