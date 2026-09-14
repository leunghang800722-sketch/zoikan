// N1(a)（Opus 對抗式驗收第三輪）：`writeAudit()`（../audit.ts）之前，
// audit_log.before／after 唔准直接塞一個原始 Prisma row 落去——之前逐個
// route call site 各自記得（或者唔記得）自己轉 DTO，Opus 攻穿咗其中
// 一批（尤其係 void/unvoid/lock/unlock）。而家改成一個 table_name → DTO
// 對照表，喺 `writeAudit()` 入面自動執行，唔靠逐個 call site 自己記得：
// create/update/void/unvoid/lock_month/unlock_month 呢類「呢個值即係
// 一個完整資源 row」嘅 action，寫入之前一律自動經呢個對照表轉做嗰個
// resource 嘅完整白名單 DTO（保留埋 call site 慣常加落嚟嘅安全 meta 欄，
// 例如 void_reason/unlock_reason/copied_from）。`table_name` 唔喺呢個
// 對照表入面（未來新 resource 漏咗登記）就淨係存 `{ id }`，唔會將未知
// 形狀嘅 raw row 直接落 audit_log。
//
// login/logout/change_password/permission_denied 呢類 action 傳嘅係細個
// ad-hoc 診斷 payload（例如 `{ reason, attempts, locked }`）——唔係一個
// 完整 row，本身已經冇 PII/價錢資料，唔經呢個 mapping，原樣存（見
// AUDIT_ROW_MAPPED_ACTIONS）。role_permissions 嘅 before/after 本身已經
// 係 call site 手砌嘅安全陣列（`{module,action,granted}[]`），唔係
// Prisma row，一律原樣存（見 writeAudit() 入面嘅 Array.isArray 分支）。
import {
  toBrokerFullDTO,
  toSiteDTO,
  toShiftTypeDTO,
  toGuardFullDTO,
  toRateCardFullDTO,
  toShiftRecordFullDTO,
  toDailyRequirementFullDTO,
  toSpecialItemDTO,
  toMonthCloseDTO,
  toRoleDTO,
  toUserDTO,
  toBrokerSiteAssignmentDTO,
  toQuotaDTO,
  toReferralFeeRateDTO,
  toFeedbackReportDTO,
} from "./dto";
import type { Dto } from "./serialize";
import type { AuditAction } from "../audit";

type RowLike = Record<string, unknown>;

export const AUDIT_DTO_BY_TABLE: Record<string, (row: RowLike) => Dto> = {
  brokers: (r) => toBrokerFullDTO(r),
  sites: (r) => toSiteDTO(r),
  shift_types: (r) => toShiftTypeDTO(r),
  guards: (r) => toGuardFullDTO(r),
  rate_cards: (r) => toRateCardFullDTO(r),
  shift_records: (r) => toShiftRecordFullDTO(r),
  daily_requirements: (r) => toDailyRequirementFullDTO(r),
  special_items: (r) => toSpecialItemDTO(r),
  month_closes: (r) => toMonthCloseDTO(r),
  roles: (r) => toRoleDTO(r),
  users: (r) => toUserDTO(r, true),
  broker_site_assignments: (r) => toBrokerSiteAssignmentDTO(r),
  quotas: (r) => toQuotaDTO(r),
  // P1-WP3（E）：referral_fee_rates——之前完全冇註冊喺呢個表，void/create/
  // update 會靜靜哋跌落「未知 table_name → 淨係存 {id}」嗰個 catch-all，
  // audit 追溯唔到改咗咩費率（規劃 E 明文要求 writeAudit）。
  referral_fee_rates: (r) => toReferralFeeRateDTO(r),
  // P2.5：老闆 PATCH 報告狀態（`action="update"`）經呢個 mapping 存完整
  // DTO；`feedback_submit`（新增報告）唔喺 AUDIT_ROW_MAPPED_ACTIONS
  // （見下面），刻意原樣存 route 自己手砌嘅細個安全 payload（唔係完整
  // row），同 `ai_chat` 一致做法。
  feedback_reports: (r) => toFeedbackReportDTO(r),
};

/** 呢啲 action 代表「呢個值本身係一個完整資源 row」——先會行 DTO
 * mapping。其他 action（login/logout/change_password/permission_denied）
 * 原樣存。 */
export const AUDIT_ROW_MAPPED_ACTIONS: ReadonlySet<AuditAction> = new Set([
  "create",
  "update",
  "void",
  "unvoid",
  "lock_month",
  "unlock_month",
]);

/** DTO 轉換之後仲要保留嘅安全純文字 meta 欄——唔屬於任何 resource 嘅
 * whitelist，但係 route 自己加落嚟嘅審計備註（唔係 Prisma row 本身嘅
 * 一部分）。 */
// P1-WP4：`override_reason`／`reconciliation_summary`——月結鎖定嗰陣，
// §6.3 對數規則有紅色差異都堅持鎖嘅原因＋當刻嘅對數結果快照（見
// src/app/api/month-closes/[id]/lock/route.ts）。
export const AUDIT_META_PASSTHROUGH_KEYS = ["void_reason", "unlock_reason", "copied_from", "reject_reason", "override_reason", "reconciliation_summary"] as const;
