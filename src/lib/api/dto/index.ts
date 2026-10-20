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
// WP-MISC（老闆 2026-09-20 拍板）：`guardsPaidByClient`——LINK（TKO
// Gateway 厚A/B/C）呢類「客戶直接出糧」嘅盤，見 prisma/schema.prisma
// Site model 大註解。
// WP-UPLOAD-AUTOFIX（老闆 2026-09-25 要求）：`rosterFileKeys`——更表檔名鍵，
// 見 prisma/schema.prisma Site model 註解／src/lib/roster-upload/match.ts。
const SITE_FIELDS = ["id", "canonicalName", "aliases", "clientName", "clientGroup", "parentSiteId", "billingModel", "monthlyFee", "monthlyPosts", "prorataBasis", "inScope", "outsideMonthlyClose", "guardsPaidByClient", "rosterFileKeys", "defaultSettlementBrokerId", "status", "createdAt", "updatedAt", "createdBy"] as const;
const SHIFT_TYPE_FIELDS = ["id", "siteId", "code", "label", "startTime", "endTime", "hours", "headcountRequired", "billingGroup", "voidedAt", "voidedBy", "createdAt", "updatedAt", "createdBy"] as const;
// S4（Opus 驗收修復）：`monthShiftCount` 係 P2-A 加嘅衍生欄（唔係
// Prisma model 本身有嘅欄，`GET /api/guards?with_month_shifts=YYYY-MM`
// 先會計出嚟 merge 落 row——加落呢個白名單先，落面 route 就可以喺
// DTO／field-group gate 之前就 merge，唔使再靠「gate 之後先手動加返」
// 嗰種繞過白名單機制嘅寫法。
// WP-PII：加 16 個保安員個人資料/牌照/銀行欄——白名單只係「呢個資源
// response 結構上准出現邊啲欄」，field-level gate（保安員個人資料/保安員
// 銀行資料 view 權限）喺呢個白名單之上再由 applyFieldGroupGate() 做
// （見 src/lib/api/field-groups.ts）。
// WP-STAFFNO（老闆 2026-09-19 拍板）：`siaPermitAExpiry`／`siaPermitBExpiry`
// 甲／乙類分開存（跟現有「保安員」module，同 `siaPermitNo`/`siaPermitType`
// 一致層級，唔屬於 PII 組）；`staffNumbers` 係 additive 衍生欄（淨係
// current，`[{scheme,number,status}]`，見 src/app/api/guards/route.ts
// `loadCurrentStaffNumbers()`）——工號本身雞頭一直見到，所以
// `GUARD_BROKER_FIELDS`（broker-dto.ts）都加埋。
const GUARD_FIELDS = [
  "id",
  "staffNo",
  "staffNoMw",
  "nameZh",
  "nameEn",
  "tel",
  "defaultBrokerId",
  "employmentType",
  "monthlySalary",
  "siaPermitExpiry",
  "poloSize",
  "mergedFrom",
  "status",
  "createdAt",
  "updatedAt",
  "createdBy",
  "monthShiftCount",
  "hkid",
  "dateOfBirth",
  "address",
  "emergencyContactName",
  "emergencyContactTel",
  "siaPermitNo",
  "siaPermitType",
  "siaPermitAExpiry",
  "siaPermitBExpiry",
  // 必修 4（Opus 驗收第三輪）：乙類因為滿 70 歲法定失效嗰陣，
  // `siaPermitExpiry`／`siaPermitType` 現算會變 null，同「完全冇填」
  // response 層面睇落一樣——呢個衍生 flag（唔係 PII，唔係 Prisma 欄）俾
  // 前端分開顯示「乙類已失效」，見 src/lib/guards/staff-numbers.ts
  // isSiaPermitBLapsedByAge()、src/app/api/guards/[id]/route.ts
  // withDerivedGuard()。
  "siaPermitBLapsedByAge",
  "safetyCardNo",
  "safetyCardExpiry",
  // WP-MISC（老闆 2026-09-20 拍板）：QAS（基本保安訓練證書）日期——跟現有
  // 「保安員」module（同 safetyCardExpiry 一致層級，唔屬於 PII 組），列表
  // 都要（90 日內到期高亮／列表最近到期 pill 用），唔放入
  // GUARD_LIST_DETAIL_ONLY_FIELDS。
  "qasIssueDate",
  "qasExpiryDate",
  "hireDate",
  "leaveDate",
  "bankName",
  "bankAccountNo",
  "bankPayeeName",
  // WP-BOSS5 §25.4：3 位 HKICL 清算銀行編號，同上面三個 bank* 欄一組
  // field group「保安員銀行資料」，一齊淨係詳情有（見下面
  // GUARD_LIST_DETAIL_ONLY_FIELDS）。
  "bankCode",
  "blacklistCheckResult",
  "blacklistCheckDate",
  // WP-GUARD-FIX（老闆 2026-09-25 要求）：「更表用名（別名）」——屬於
  // 「保安員個人資料」field group（見 field-groups.ts GUARD_PII_FIELDS），
  // 雞頭 DTO（GUARD_BROKER_FIELDS，broker-dto.ts）刻意唔加。
  "nameAliases",
  "staffNumbers",
  // WP-STAFF-IMPORT B1：識別狀態衍生欄（complete／missing_hkid／missing_tel／missing_both，
  // 淨係有冇，唔含值），見 src/lib/guards/identity.ts identityStatus()。
  "identityStatus",
  // WP-STAFF-IMPORT B3：導入後待人手核對嘅欄（["name_zh"] 等），抽屜顯示「姓名待核對」。
  "identityReviewFields",
  // S7：`?q=` 搜尋命中已取消（former）工號嗰陣先會有呢粒 key（見
  // src/app/api/guards/route.ts findNumberSearchMatches()）——前端標
  // 「已取消號命中」用。
  "formerNumberHit",
  // WP-PHASE3（§20.4 Phase 3 item 1）：長工介紹雞頭／簽證形式贊助雞頭
  // ——WP-LTSHIFT（§19）已經加落 schema，之前淨係內部寫，冇經呢個白名
  // 單出街；保安員抽屜「長工」區要顯示。跟「保安員」module，唔係 PII 組
  // （雞頭本身睇唔到呢個資源，見 broker-dto.ts GUARD_BROKER_FIELDS 冇
  // 呢兩欄，結構性隔離）。
  "referralBrokerId",
  "visaSponsoredByBrokerId",
] as const;
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
const USER_MANAGEMENT_ONLY_FIELDS = ["failedAttempts", "lockedUntil", "allowedIp"] as const;
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
// WP-PII（Opus 驗收應修 4）：列表資料最小化——`GET /api/guards`（成個
// 名冊，可以一次攞 500 行）唔應該連銀行戶口/地址/出生日期/緊急聯絡人/
// Blacklist 呢批高敏感度欄都逐行送出街（就算讀者有權，一次過送 500 個
// 人嘅呢批資料都係唔必要嘅曝露面——同 SHIFT_RECORD_LIST_FIELDS 剝
// provenance 一致嘅「列表窄一啲」精神）。field-group gate（GUARD_PII_
// FIELDS／GUARD_BANK_FIELDS，見 field-groups.ts）淨係管「有冇權見」，
// 呢度加多一層「列表結構上唔出呢批欄」，要真係要用（例如查證身份證/
// 銀行資料）先撳「編輯」叫 `GET /api/guards/:id`（詳情，仍然經同一個
// field-group gate）。`hkid` 刻意保留（列表遮罩顯示，見
// src/lib/api/guard-pii.ts maskHkidForList()）；牌照/平安卡/入職離職
// 日期跟現有「保安員」module，列表要用（到期 pill／篩選），一樣保留。
const GUARD_LIST_DETAIL_ONLY_FIELDS = [
  "dateOfBirth",
  "address",
  "emergencyContactName",
  "emergencyContactTel",
  "bankName",
  "bankAccountNo",
  "bankPayeeName",
  "bankCode",
  "blacklistCheckResult",
  "blacklistCheckDate",
] as const;
const GUARD_LIST_FIELDS = GUARD_FIELDS.filter(
  (f) => !(GUARD_LIST_DETAIL_ONLY_FIELDS as readonly string[]).includes(f),
) as unknown as readonly (typeof GUARD_FIELDS)[number][];
export const toGuardListDTO = <T extends Record<string, unknown>>(row: T) => mapRow(row, GUARD_LIST_FIELDS);
// P3-2.4（P3 §3.1 P5）：`GET /api/guards?fields=lite` 輕量白名單——下拉／對照表／姓名顯示用。
// 刻意唔帶電話、證件號、銀行、地址、出生日期、月薪等任何 PII／敏感欄（`siaPermitExpiry`
// 係牌照到期日，跟「保安員」module，唔屬 PII 組，更表編輯器「牌照已過期」提示要用）。
// `defaultBrokerCode` 係 route 補嘅衍生欄（雞頭代號，唔係 DB 欄）。
const GUARD_LITE_FIELDS = ["id", "staffNo", "nameZh", "nameEn", "status", "defaultBrokerId", "defaultBrokerCode", "siaPermitExpiry", "staffNumbers"] as const;
export const toGuardLiteDTO = <T extends Record<string, unknown>>(row: T) => mapRow(row, GUARD_LITE_FIELDS);
// WP-STAFFNO：`GET/POST/PATCH /api/guards/:id/staff-numbers*` 白名單——
// 工號本身（唔係身份證／銀行）跟「保安員」module，冇獨立 field-group。
const GUARD_STAFF_NUMBER_FIELDS = ["id", "guardId", "scheme", "number", "status", "validFrom", "validTo", "endReason", "predecessorId", "note", "source", "createdAt", "updatedAt", "createdBy"] as const;
export const toGuardStaffNumberDTO = <T extends Record<string, unknown>>(row: T) => mapRow(row, GUARD_STAFF_NUMBER_FIELDS);
// WP-PHASE3（§20.4 Phase 3 item 1）：`guard_longterm_posts` CRUD 白名單
// ——「盤名」（site）唔係 PII（見 schema.prisma 呢個 model 頂註解），
// 跟「保安員」module 一般 view/update 就夠，冇獨立 field-group。
const GUARD_LONGTERM_POST_FIELDS = ["id", "guardId", "siteId", "effectiveFrom", "effectiveTo", "source", "note", "voidedAt", "voidedBy", "createdAt", "updatedAt", "createdBy"] as const;
export const toGuardLongtermPostDTO = <T extends Record<string, unknown>>(row: T) => mapRow(row, GUARD_LONGTERM_POST_FIELDS);
// WP-MULTI（老闆 2026-09-19 拍板）：`GET/POST/PATCH/DELETE
// /api/guards/:id/phones*`／`emergency-contacts*`／`addresses*`——內部
// 角色（老闆/主管/會計）用嘅完整白名單。工號本身跟「保安員」module
// （電話），緊急聯絡人／地址跟「保安員個人資料」module（見
// src/app/api/guards/[id]/phones/route.ts 等 route 頂註解），冇獨立
// field-group（呢三個係獨立子資源，唔係 guards resource 嘅欄，field-
// groups.ts 嗰套「field-level gate」機制唔適用，直接由 route 層
// `requirePermission()` 判斷）。
const GUARD_PHONE_FIELDS = ["id", "guardId", "tel", "label", "isPrimary", "source", "note", "createdAt", "updatedAt", "createdBy"] as const;
export const toGuardPhoneDTO = <T extends Record<string, unknown>>(row: T) => mapRow(row, GUARD_PHONE_FIELDS);
const GUARD_EMERGENCY_CONTACT_FIELDS = ["id", "guardId", "name", "tel", "relationship", "sortOrder", "source", "note", "createdAt", "updatedAt", "createdBy"] as const;
export const toGuardEmergencyContactDTO = <T extends Record<string, unknown>>(row: T) => mapRow(row, GUARD_EMERGENCY_CONTACT_FIELDS);
const GUARD_ADDRESS_FIELDS = ["id", "guardId", "address", "isPrimary", "source", "note", "createdAt", "updatedAt", "createdBy"] as const;
export const toGuardAddressDTO = <T extends Record<string, unknown>>(row: T) => mapRow(row, GUARD_ADDRESS_FIELDS);
export const toRateCardFullDTO = <T extends Record<string, unknown>>(row: T) => mapRow(row, RATE_CARD_FIELDS);
export const toShiftRecordFullDTO = <T extends Record<string, unknown>>(row: T) => mapRow(row, SHIFT_RECORD_FIELDS);
// 2026-09-13：列表預設唔回傳 provenance（原檔追溯 JSON，每條 ~1.5KB，7 月一個盤三頁共 2MB+，
// 手機網絡載入極慢；畫面唔用佢）。要嘅 caller 用 `?include_provenance=1`。
const SHIFT_RECORD_LIST_FIELDS = SHIFT_RECORD_FIELDS.filter((f) => f !== "provenance") as unknown as readonly (typeof SHIFT_RECORD_FIELDS)[number][];
export const toShiftRecordListDTO = <T extends Record<string, unknown>>(row: T) => mapRow(row, SHIFT_RECORD_LIST_FIELDS);
// `?view=grid`：更表編輯器只需要呢 10 欄（每條 ~240 bytes，對比全欄 ~965）。W2 加 `source`（additive：標「來自 WhatsApp」）。
const SHIFT_RECORD_GRID_FIELDS = ["id", "workDate", "siteId", "shiftTypeId", "guardId", "settlementBrokerId", "recordType", "leaveCode", "status", "source"] as const;
export const toShiftRecordGridDTO = <T extends Record<string, unknown>>(row: T) => mapRow(row, SHIFT_RECORD_GRID_FIELDS);
export const toDailyRequirementFullDTO = <T extends Record<string, unknown>>(row: T) => mapRow(row, DAILY_REQUIREMENT_FIELDS);
export const toSpecialItemDTO = <T extends Record<string, unknown>>(row: T) => mapRow(row, SPECIAL_ITEM_FIELDS);
export const toMonthCloseDTO = <T extends Record<string, unknown>>(row: T) => mapRow(row, MONTH_CLOSE_FIELDS);
export const toRoleDTO = <T extends Record<string, unknown>>(row: T) => mapRow(row, ROLE_FIELDS);
export const toBrokerSiteAssignmentDTO = <T extends Record<string, unknown>>(row: T) => mapRow(row, BROKER_SITE_ASSIGNMENT_FIELDS);
export const toQuotaDTO = <T extends Record<string, unknown>>(row: T) => mapRow(row, QUOTA_FIELDS);
export const toReferralFeeRateDTO = <T extends Record<string, unknown>>(row: T) => mapRow(row, REFERRAL_FEE_RATE_FIELDS);
export const toAuditLogDTO = <T extends Record<string, unknown>>(row: T) => mapRow(row, AUDIT_LOG_FIELDS);

// WP-ROSTER-UPLOAD Phase A（§15.3）：`fileBytes` 刻意唔喺白名單入面——
// 冚唪唥 API 一律唔回檔案原始 bytes（雞頭連呢個 resource 都硬性 deny，
// 內部角色如果將來要「下載原檔」要另開專用 endpoint 先，唔可以經呢個
// DTO 夾帶）。
const ROSTER_UPLOAD_FIELDS = [
  "id", "month", "siteId", "siteNameRaw", "uploaderUserId", "uploadedAt",
  "fileName", "fileSha256", "fileSize", "version", "status", "parseSummary",
  "parseError", "layoutKey", "createdAt", "updatedAt", "createdBy",
  // WP-UPLOAD-VOID：voidedBy 同呢個 codebase 其他 voidedBy 一致——raw
  // user id string，冇 PII，唔使 gate。
  "voidedAt", "voidedBy", "voidReason",
] as const;
export const toRosterUploadDTO = <T extends Record<string, unknown>>(row: T) => mapRow(row, ROSTER_UPLOAD_FIELDS);

const ROSTER_UPLOAD_ROW_FIELDS = [
  "id", "uploadId", "rowIndex", "subSiteName", "workDate", "rawCode",
  "codeKind", "shiftTypeId", "resolvedSiteId", "staffNoRaw", "nameRaw", "telRaw", "rankRaw",
  "timeRaw", "brokerCodeRaw", "guardId", "guardMatch", "matchBasis", "settlementBrokerId",
  "hours", "warnings", "createdAt", "updatedAt",
] as const;
export const toRosterUploadRowDTO = <T extends Record<string, unknown>>(row: T) => mapRow(row, ROSTER_UPLOAD_ROW_FIELDS);

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
  // WP-MULTI（老闆 2026-09-19 拍板）：三張新子表嘅 audit_log 一樣要跟
  // guards 一致模型——讀出嗰陣再按讀者權限 gate 一次（`guard_
  // emergency_contacts`/`guard_addresses` 冇「保安員個人資料:view」就要
  // 剝走 name/tel/relationship/address；`guard_phones` 跟「保安員」
  // module，呢個 mapping 純粹一致性處理，實際冧走任何欄，見
  // src/lib/api/field-groups.ts GUARD_PII_FIELDS 對呢三個 resource 嘅
  // 定義）。
  guard_phones: "guard_phones",
  guard_emergency_contacts: "guard_emergency_contacts",
  guard_addresses: "guard_addresses",
  // WP-ROSTER-UPLOAD Phase A：roster_upload_rows 嘅 name_raw/tel_raw/
  // staff_no_raw 一樣要喺 GET /api/audit-log 讀出嗰陣再 gate 一次（同
  // guards/guard_phones 一致模型，唔可以淨係得寫入路徑受保護）——呢個
  // mapping 漏咗嘅話，冇「保安員個人資料:view」嘅內部角色（例如關咗呢格
  // 嘅主管）都會經操作紀錄睇到未配對保安員嘅姓名/電話/工號原文，WP-MULTI
  // 已經撞過一次呢個漏洞（見 P2-版面重設計計劃.md §12）。
  roster_uploads: "roster_uploads",
  roster_upload_rows: "roster_upload_rows",
};
