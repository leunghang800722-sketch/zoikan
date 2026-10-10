// 更表編輯器共用型別／常數（P3-5.1：由 RosterEditor.tsx 原樣搬出，行為零改變）。

// 型別（wire format，一律 snake_case，同 request/response body 一致——見
// docs/api.md「欄位命名」；淨係列出呢個畫面用得到嘅欄）。

type RecordStatus = "draft" | "pending_approval" | "confirmed" | "completed" | "cancelled";
type RecordType = "shift" | "leave" | "ot";

export type SiteDto = {
  id: string;
  canonical_name: string;
  status: string;
  // 淨係內部角色 DTO（toSiteDTO）先有呢個欄，雞頭 DTO（toBrokerSiteDTO）
  // 冇——用嚟判斷而家呢個 session 係咪雞頭（畫面要剝走「雞頭」欄同啲
  // 內部專用操作）。
  created_by?: string;
  // Opus 對抗式驗收第二輪 R3：呢個盤有冇 roster_layout 模板——冇就
  // GET roster-export 會 409 no_roster_layout，匯出掣要顯示提示
  // 唔可以照樣當連結掣使（見底下匯出按鈕嗰段）。
  has_roster_layout?: boolean;
  // WP-MISC（老闆 2026-09-20 拍板，LINK：TKO Gateway 厚A/B/C）：呢類盤
  // 嘅保安員由客戶直接出糧，我哋淨係收每月服務費——頁頂顯示 Notice，
  // 呢個更表唔計工資／客價。內部＋雞頭 DTO 都有（見 src/lib/api/dto/
  // index.ts、src/lib/broker-dto.ts SITE_BROKER_FIELDS）。
  guards_paid_by_client?: boolean;
};

export type ShiftTypeDto = {
  id: string;
  site_id: string;
  code: string;
  label: string;
  headcount_required?: number;
  voided_at: string | null;
};

export type GuardDto = {
  id: string;
  staff_no: string | null;
  name_zh: string;
  default_broker_id: string | null;
  sia_permit_expiry: string | null;
  status: string;
};

export type ShiftRecordDto = {
  id: string;
  work_date: string;
  site_id: string;
  shift_type_id: string;
  guard_id: string;
  settlement_broker_id: string | null;
  operational_broker_id: string | null;
  record_type: RecordType;
  leave_code: string | null;
  status: RecordStatus;
};

export type DailyRequirementDto = {
  id: string;
  site_id: string;
  shift_type_id: string;
  work_date: string;
  headcount_required: number;
};

export type QuotaDto = {
  id: string;
  month: string;
  site_id: string;
  shift_type_id: string;
  broker_id: string;
  target_shifts: number;
};

export type MonthCloseDto = {
  id: string;
  month: string;
  locked_at: string | null;
};

export type BrokerDto = {
  id: string;
  code: string;
  name: string;
};

// WP-PRICE（老闆 2026-09-16 拍板）：batch 儲存回應加咗 pricing 統計——
// 「未定價」＝清楚警告，唔准靜靜 0（見 src/app/api/shift-records/
// batch/route.ts）。
type UnpricedCellSummary = { key: string; site_name?: string; shift_type_code: string; broker_code: string | null; reason?: string; count: number };
export type BatchResponse = {
  results: { key: string; id: string; action: string; settlement_inferred?: boolean }[];
  warnings: string[];
  pricing?: { priced: number; unpriced: number; unpriced_cells: UnpricedCellSummary[] };
  // P0（Opus 驗收重現）：呢次儲存完之後仲有幾多個 shift 格
  // settlement_broker_id 係 NULL（會喺糧明細完全消失，唔止未定價）。
  no_settlement_count?: number;
  // B1-5（WP-ATTRIB）：呢次儲存幾多格結算單位係靠 fallback 推算出嚟
  // （唔係人手/更表明確指定）。
  settlement_inferred_count?: number;
};
// S3：`category` 分「出街價未定」／「收客價未定」／（P0）「冇結算單位」
// （見 src/lib/pricing/unpriced.ts）。`payoutCount`/`clientCount` 用
// `?? 0` fallback——`/api/shift-records/reprice` 嘅 `groups`（handleReprice
// 撳完之後 setUnpricedSummary 用嗰批）冇呢兩個欄，向下相容。
export type UnpricedGroup = { site_id: string; site_name: string; shift_type_code: string; broker_code: string | null; broker_display: string; category?: "payout_unpriced" | "client_unpriced" | "no_settlement"; count: number };
export type UnpricedSummary = { count: number; groups: UnpricedGroup[]; payoutCount?: number; clientCount?: number; noSettlementCount?: number };

// P1-WP3 第三輪規劃裁定（point B(4)）：同步 `prisma/schema.prisma` 嘅
// `LeaveCode` enum（已經由 `tools/importer/mappings/status_codes.csv`
// 擴充咗保留原始字面嘅 OFF/NPL，見 schema 頂註解）。
export const LEAVE_CODES: readonly string[] = ["RD", "OFF", "AL", "SL", "NL", "NPL", "SH"];
// WP-R2 第 8 項：手機鍵盤唔出 OFF／NPL——呢兩個係歷史保留代號（schema
// 註解：OFF＝RD、NPL＝NL），batch API 照舊接受（`LEAVE_CODES` 冇改，舊
// 資料／桌面打字都照樣得），淨係手機鍵盤按鍵收窄做實際會用嘅代號。
export const MOBILE_KEYPAD_LEAVE_CODES: readonly string[] = LEAVE_CODES.filter((c) => c !== "OFF" && c !== "NPL");

export type CellState = {
  code: string | null;
  id: string | null;
  status: RecordStatus | null;
  recordType: RecordType | null;
};

export type RowMeta = {
  key: string; // `${shiftTypeId}|${guardId}`
  shiftTypeId: string;
  guardId: string;
  shiftTypeCode: string;
  guardName: string;
  staffNo: string;
  tel: string;
  brokerId: string | null;
};

export type SelRange = { a: { r: number; d: number }; b: { r: number; d: number } };

