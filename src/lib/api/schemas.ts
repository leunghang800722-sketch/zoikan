// Input validation（Opus 驗收殘留4）+ API 契約統一（body 全部
// snake_case，見「API契約統一而家做」）：每個 route 嘅 request body 經
// zod schema 驗證，非法 enum／日期／**未知欄位**（包括舊 camelCase key）
// 一律 400。全部 schema 用 `.strict()`——唔再靜默剝走唔識嘅欄位（舊做法
// `pickFields()` 淨係揀白名單、多餘欄位靜靜哋唔理，而家一律當錯）。
//
// enum 用 `Object.values(PrismaEnum)` 動態攞返 schema.prisma 定義咗嘅
// 全部值，唔喺呢度手抄一份字面陣列（避免同 schema 漂移）。
//
// parse 出嚟嘅物件保持 snake_case（同 request body 一致）；落 Prisma
//之前一律用 `src/lib/api/case.ts` 嘅 `snakeToCamelShallow()` 轉做
// camelCase——所以呢個檔案唔需要知道 Prisma 欄位名叫咩，純粹管「呢個
// API 收咩」。
import { z } from "zod";
import {
  BrokerKind,
  SettlementType,
  BillingModel,
  EmploymentType,
  ProrataBasis,
  BillingGroup,
  RecordType,
  LeaveCode,
  SiteStatus,
  SpecialItemKind,
} from "@prisma/client";

function enumOf(obj: Record<string, string>) {
  return z.enum(Object.values(obj) as [string, ...string[]]);
}

const dateOnly = z.coerce.date(); // 接受 "2026-08-01" 或完整 ISO datetime，一律轉做 Date object
const money = z.union([z.number(), z.string()]).optional();
const uuid = z.string().min(1);

// ---------------------------------------------------------------------------
export const BrokerCreateSchema = z
  .object({
    code: z.string().min(1),
    name: z.string().min(1),
    kind: enumOf(BrokerKind),
    settlement_type: enumOf(SettlementType),
    bank_info: z.unknown().optional(),
    requires_approval: z.boolean().optional(),
    is_internal: z.boolean().optional(),
    aliases: z.array(z.string()).optional(),
  })
  .strict();
export const BrokerUpdateSchema = z
  .object({
    name: z.string().min(1).optional(),
    settlement_type: enumOf(SettlementType).optional(),
    bank_info: z.unknown().optional(),
    requires_approval: z.boolean().optional(),
    aliases: z.array(z.string()).optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
export const SiteCreateSchema = z
  .object({
    canonical_name: z.string().min(1),
    aliases: z.array(z.string()).optional(),
    client_name: z.string().min(1),
    client_group: z.string().optional(),
    parent_site_id: uuid.optional(),
    billing_model: enumOf(BillingModel),
    outside_monthly_close: z.boolean().optional(),
    monthly_fee: money,
    monthly_posts: z.number().int().optional(),
    prorata_basis: enumOf(ProrataBasis).optional(),
    in_scope: z.boolean().optional(),
  })
  .strict();
export const SiteUpdateSchema = z
  .object({
    aliases: z.array(z.string()).optional(),
    client_name: z.string().min(1).optional(),
    client_group: z.string().optional(),
    parent_site_id: uuid.optional(),
    billing_model: enumOf(BillingModel).optional(),
    outside_monthly_close: z.boolean().optional(),
    monthly_fee: money,
    monthly_posts: z.number().int().optional(),
    prorata_basis: enumOf(ProrataBasis).optional(),
    in_scope: z.boolean().optional(),
    status: enumOf(SiteStatus).optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
export const ShiftTypeCreateSchema = z
  .object({
    site_id: uuid,
    code: z.string().min(1),
    label: z.string().optional(),
    start_time: z.string().optional(), // @db.Time——保留 string，時間字串解析留返 WP3 更別編輯器
    end_time: z.string().optional(),
    hours: money,
    headcount_required: z.number().int().optional(),
    billing_group: enumOf(BillingGroup).optional(),
  })
  .strict();
export const ShiftTypeUpdateSchema = z
  .object({
    code: z.string().min(1).optional(),
    label: z.string().optional(),
    start_time: z.string().optional(),
    end_time: z.string().optional(),
    hours: money,
    headcount_required: z.number().int().optional(),
    billing_group: enumOf(BillingGroup).optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
export const GuardCreateSchema = z
  .object({
    staff_no: z.string().optional(),
    staff_no_mw: z.string().optional(),
    name_zh: z.string().min(1),
    name_en: z.string().optional(),
    tel: z.string().optional(),
    default_broker_id: uuid.optional(),
    employment_type: enumOf(EmploymentType),
    monthly_salary: money,
    sia_permit_expiry: dateOnly.optional(),
    polo_size: z.string().optional(),
  })
  .strict();
export const GuardUpdateSchema = z
  .object({
    staff_no: z.string().optional(),
    staff_no_mw: z.string().optional(),
    name_zh: z.string().min(1).optional(),
    name_en: z.string().optional(),
    tel: z.string().optional(),
    employment_type: enumOf(EmploymentType).optional(),
    monthly_salary: money,
    sia_permit_expiry: dateOnly.optional(),
    polo_size: z.string().optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
export const RateCardCreateSchema = z
  .object({
    site_id: uuid,
    shift_type_id: uuid.optional(),
    broker_id: uuid.optional(),
    guard_id: uuid.optional(),
    client_rate: money,
    guard_wage: money,
    broker_fee: money,
    payout_rate: money,
    billing_model: enumOf(BillingModel).optional(),
    effective_from: dateOnly,
    effective_to: dateOnly.optional(),
    source: z.string().optional(),
    evidence: z.string().optional(),
    confidence: z.string().optional(),
    status: z.string().optional(),
    note: z.string().optional(),
  })
  .strict();
export const RateCardUpdateSchema = z
  .object({
    client_rate: money,
    guard_wage: money,
    broker_fee: money,
    payout_rate: money,
    billing_model: enumOf(BillingModel).optional(),
    effective_from: dateOnly.optional(),
    effective_to: dateOnly.optional(),
    source: z.string().optional(),
    evidence: z.string().optional(),
    confidence: z.string().optional(),
    status: z.string().optional(),
    note: z.string().optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// 內部角色（老闆/主管/會計）用嘅完整 shift_record create schema。
export const ShiftRecordCreateSchema = z
  .object({
    work_date: dateOnly,
    site_id: uuid,
    shift_type_id: uuid,
    guard_id: uuid,
    settlement_broker_id: uuid.optional(),
    operational_broker_id: uuid.optional(),
    referral_fee_snapshot: money,
    rescue_rate: money,
    record_type: enumOf(RecordType).optional(),
    leave_code: enumOf(LeaveCode).optional(),
    ot_hours: money,
    parent_shift_id: uuid.optional(),
    location_tag: z.string().optional(),
    is_external: z.boolean().optional(),
    client_rate_snapshot: money,
    guard_wage_snapshot: money,
    broker_fee_snapshot: money,
    source: z.string().optional(),
  })
  .strict();
export const ShiftRecordUpdateSchema = z
  .object({
    work_date: dateOnly.optional(),
    shift_type_id: uuid.optional(),
    guard_id: uuid.optional(),
    referral_fee_snapshot: money,
    rescue_rate: money,
    record_type: enumOf(RecordType).optional(),
    leave_code: enumOf(LeaveCode).optional(),
    ot_hours: money,
    location_tag: z.string().optional(),
    is_external: z.boolean().optional(),
    client_rate_snapshot: money,
    guard_wage_snapshot: money,
    broker_fee_snapshot: money,
    status: z.string().optional(),
  })
  .strict();

// S1（Opus 對抗式驗收）：雞頭專用嘅**窄** schema——.strict() 淨係收設計
// 文件§3 需要嘅欄，價錢欄／source／referral／rescue／parent_shift_id
// 以外嘅未知 key 直接 400（唔再靜默剝）。雞頭填更本身唔應該夾帶呢啲
// 概念（settlement/operational broker 由 server 強制、價錢由 rate_cards
// snapshot 生成），連「畀咗都靜靜剝走」都唔畀，一於當佢誤用即刻話畀佢知。
export const BrokerShiftRecordCreateSchema = z
  .object({
    guard_id: uuid,
    site_id: uuid,
    shift_type_id: uuid,
    work_date: dateOnly,
    record_type: enumOf(RecordType).optional(),
    leave_code: enumOf(LeaveCode).optional(),
    ot_hours: money,
    location_tag: z.string().optional(),
    // OT 掛靠正更（record_type=ot）結構性需要 parent_shift_id 先做得到，
    // S1 原列表冇提但唔加就 OT 呢個 §3 需要嘅功能做唔到，執行裁定加返
    // （S3 有 test 專門驗證雞頭嘅 parent 必須係自己更次）。
    parent_shift_id: uuid.optional(),
  })
  .strict();
export const BrokerShiftRecordUpdateSchema = z
  .object({
    record_type: enumOf(RecordType).optional(),
    leave_code: enumOf(LeaveCode).optional(),
    ot_hours: money,
    location_tag: z.string().optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
export const DailyRequirementCreateSchema = z
  .object({
    site_id: uuid,
    shift_type_id: uuid,
    work_date: dateOnly,
    headcount_required: z.number().int(),
  })
  .strict();
export const DailyRequirementUpdateSchema = z
  .object({
    headcount_required: z.number().int(),
  })
  .strict();

// ---------------------------------------------------------------------------
export const SpecialItemCreateSchema = z
  .object({
    month: dateOnly,
    site_id: uuid.optional(),
    broker_id: uuid.optional(),
    kind: enumOf(SpecialItemKind),
    shifts: z.number().int().optional(),
    revenue: money,
    cost: money,
    description: z.string().optional(),
  })
  .strict();
export const SpecialItemUpdateSchema = z
  .object({
    shifts: z.number().int().optional(),
    revenue: money,
    cost: money,
    description: z.string().optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
export const MonthCloseCreateSchema = z
  .object({
    month: z.string().min(4), // "YYYY-MM" 或 "YYYY-MM-DD"，monthStart() 再處理
    roster_version_note: z.string().optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
export const UserCreateSchema = z
  .object({
    name: z.string().min(1),
    tel: z.string().min(1),
    password: z.string().min(1),
    role_id: uuid,
    guard_id: uuid.optional(),
    broker_id: uuid.optional(),
    payout_approval_limit: z.number().optional(),
    allowed_ip: z.string().optional(),
    must_change_pwd: z.boolean().optional(),
  })
  .strict();
export const UserUpdateSchema = z
  .object({
    name: z.string().min(1).optional(),
    role_id: uuid.optional(),
    guard_id: uuid.optional(),
    broker_id: uuid.optional(),
    payout_approval_limit: money,
    allowed_ip: z.string().optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
export const RoleCreateSchema = z
  .object({
    source_role_id: uuid,
    name: z.string().min(1),
  })
  .strict();
export const RoleUpdateSchema = z
  .object({
    payout_approval_limit: money,
  })
  .strict();

export const RolePermissionsPatchSchema = z
  .object({
    changes: z.array(z.object({ module: z.string().min(1), action: z.string().min(1), granted: z.boolean() }).strict()).min(1),
  })
  .strict();

// ---------------------------------------------------------------------------
export const LoginSchema = z.object({ tel: z.string().min(1), password: z.string().min(1) }).strict();
export const ChangePasswordSchema = z.object({ old_password: z.string().min(1), new_password: z.string().min(1) }).strict();

// ---------------------------------------------------------------------------
export const VoidReasonSchema = z.object({ reason: z.string().min(1, "作廢一定要填原因") }).strict();

// ---------------------------------------------------------------------------
// S6：broker_site_assignments 管理 API。
export const BrokerSiteAssignmentCreateSchema = z
  .object({
    broker_id: uuid,
    site_id: uuid,
    month: z.string().min(4), // "YYYY-MM" 或 "YYYY-MM-DD"
  })
  .strict();

// ---------------------------------------------------------------------------
// P1-WP3：quotas（配額）——`配額` module。
export const QuotaCreateSchema = z
  .object({
    month: z.string().min(4), // "YYYY-MM" 或 "YYYY-MM-DD"
    site_id: uuid,
    shift_type_id: uuid,
    broker_id: uuid,
    target_shifts: z.number().int().min(0),
  })
  .strict();
export const QuotaUpdateSchema = z
  .object({
    target_shifts: z.number().int().min(0),
  })
  .strict();

// ---------------------------------------------------------------------------
// P1-WP3（E）：referral_fee_rates（雞頭介紹費率）——`雞頭` module。
// site_id 留空＝呢個雞頭全盤預設費率（DB partial unique index
// referral_fee_rates_broker_month_default_key 擋同一 broker+month 兩行
// site_id=NULL；一般 (broker_id,site_id,month) unique 擋指定盤重複）。
export const ReferralFeeRateCreateSchema = z
  .object({
    broker_id: uuid,
    site_id: uuid.optional(),
    month: z.string().min(4), // "YYYY-MM" 或 "YYYY-MM-DD"
    fee_per_shift: z.union([z.number(), z.string()]),
  })
  .strict();
export const ReferralFeeRateUpdateSchema = z
  .object({
    fee_per_shift: z.union([z.number(), z.string()]),
  })
  .strict();

// ---------------------------------------------------------------------------
// P1-WP3：審批——退回一定要填原因（同 VoidReasonSchema 精神一致）。
export const RejectReasonSchema = z.object({ reason: z.string().min(1, "退回一定要填原因") }).strict();

// ---------------------------------------------------------------------------
// P1-WP3：更表編輯器批量儲存——同一 site × month 內多格一次寫入，逐格
// 同樣過閘，任何一格失敗整批 rollback（見 src/app/api/shift-records/
// batch/route.ts）。
export const ShiftRecordBatchCellSchema = z
  .object({
    guard_id: uuid,
    shift_type_id: uuid, // 呢格所屬嘅「行」（更別／時段）
    work_date: dateOnly,
    // code=null／""＝清格（value 冇填即代表 null，"" 一律當 null 處理）；
    // 更別代號（match shift_type.code）＝正更出勤；LeaveCode 之一＝出勤狀態。
    code: z.string().nullable().optional(),
    // 內部角色（老闆/主管）填人先需要指定邊個雞頭桶——雞頭自己填一律
    // 強制用自己 broker_id（呢兩個欄由 server 覆蓋，傳咗都會被忽略）；
    // 內部角色冇填就 default 用 guard.default_broker_id。
    settlement_broker_id: uuid.optional(),
    operational_broker_id: uuid.optional(),
  })
  .strict();
export const ShiftRecordBatchSchema = z
  .object({
    site_id: uuid,
    month: z.string().min(4), // "YYYY-MM"，逐格 work_date 都要跌落呢個月
    cells: z.array(ShiftRecordBatchCellSchema).min(1).max(2000),
  })
  .strict();

// ---------------------------------------------------------------------------
// P1-WP3：開新月份——複製上月 daily_requirements／quotas／
// broker_site_assignments 結構。
export const MonthOpenSchema = z
  .object({
    roster_version_note: z.string().optional(),
  })
  .strict();
