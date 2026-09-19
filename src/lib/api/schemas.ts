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
import { normalizeStaffNumber, STAFF_NUMBER_NUMBER_RE } from "@/lib/guards/staff-numbers";

function enumOf(obj: Record<string, string>) {
  return z.enum(Object.values(obj) as [string, ...string[]]);
}

const dateOnly = z.coerce.date(); // 接受 "2026-08-01" 或完整 ISO datetime，一律轉做 Date object
// 附帶修復（Opus 驗收）：`dateOnly`（`z.coerce.date()`）收 `null` 會俾
// `z.coerce.date()` 將 `null` 當 `new Date(null)`＝1970-01-01，唔會 400，
// 靜靜哋錯存一個假日期——牌照／平安卡／入離職／甲乙到期呢批欄用戶要
// 「清空已填日期」呢個操作冇得做（想刪只可以打入另一個日期，唔可以留
// 空）。`nullableDateOnly` 明確容許 `null`（＝清空，落 Prisma 會存
// `null`）並拒絕真係傳漏／傳空字串一類會令 `z.coerce.date()` 出
// Invalid Date 嘅值；其他 route 嘅 `dateOnly` 行為唔變（`hire_date` 等
// 5 個欄先改用呢個，見 GuardUpdateSchema）。
// 注意：`z.union([...])` 逐個 branch 順序試，第一個成功就用嗰個——
// `z.coerce.date()` 擺前面嘅話，`null` 會俾 `new Date(null)`（＝
// 1970-01-01，唔會拋錯）静静哋「成功」咗，永遠去唔到 `z.null()` 嗰
// branch，等於冇修到（呢個正正係原本 bug 嘅成因）。`z.null()` 一定要
// 擺第一，等 `null` 輸入優先俾佢啱啱接住。
const nullableDateOnly = z.union([z.null(), z.coerce.date()]).optional();
const money = z.union([z.number(), z.string()]).optional();

// WP-PII：身份證格式寬鬆核對（1-2 個英文字母 + 6 位數字 + 括住 1 位
// 數字或 "A" 嘅核對碼），大小寫都收（入 DB 之前唔轉大寫，保留原文）。
const HKID_RE = /^[A-Za-z]{1,2}[0-9]{6}\([0-9Aa]\)$/;
const hkid = z.string().regex(HKID_RE, "身份證格式要係 A123456(7) 咁樣").optional();
// 緊急聯絡人電話——同設計文件一致，香港電話 8 位數字。
const tel8 = z.string().regex(/^\d{8}$/, "電話要係 8 位數字").optional();
// WP-STAFFNO：`sia_permit_type` 改做衍生值（唔再接受 API 直接寫，見
// GuardUpdateSchema 註解），之前呢度嘅 `SIA_PERMIT_TYPES`／
// `siaPermitType` zod enum 冇 call site 用喇，成組刪走。
const BLACKLIST_CHECK_RESULTS = ["clear", "flagged", "pending"] as const;
const blacklistCheckResult = z.enum(BLACKLIST_CHECK_RESULTS).optional();
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
    // WP-STAFFNO（老闆 2026-09-19 拍板）：甲／乙類到期日分開存，`sia_
    // permit_expiry`／`sia_permit_type` 改做衍生值——API 唔再接受直接
    // 寫呢兩個（見 schemas.ts 之前呢度有 `sia_permit_expiry`／
    // `sia_permit_type`，而家淨係得返 a／b；route 層 `guards/[id]/
    // route.ts` 額外會喺 parseBody() 之前檢查 raw body 有冇帶呢兩個
    // 舊 key，帶咗就 400 並提示用 a／b 欄——好過淨係靠 `.strict()`
    // 嘅「未知欄位」generic 錯誤訊息）。
    // 附帶修復：牌照甲／乙類到期日改用 `nullableDateOnly`——用戶可以
    // PATCH `null` 清空已填嘅到期日（例如打錯咗想清返、或者張牌照仲未
    // 有到期日資料）。
    sia_permit_a_expiry: nullableDateOnly,
    sia_permit_b_expiry: nullableDateOnly,
    polo_size: z.string().optional(),
    // WP-PII（老闆 2026-09-17 拍板）：淨係 PATCH 接受呢批新欄——新增
    // （POST）刻意唔開放，保安員 PII/銀行資料一律建好基本資料之後先
    // 用編輯抽屜逐項補（field-group gate 喺 assertFieldGroupWritable()
    // 做，見 src/app/api/guards/[id]/route.ts）。
    hkid,
    date_of_birth: dateOnly.optional(),
    address: z.string().optional(),
    emergency_contact_name: z.string().optional(),
    emergency_contact_tel: tel8,
    sia_permit_no: z.string().optional(),
    safety_card_no: z.string().optional(),
    // 附帶修復：平安卡到期／入職／離職日期一樣改用 `nullableDateOnly`
    // （牌照／平安卡／入離職／甲乙到期呢批，見上面 sia_permit_a/b_expiry
    // 同一段理由）。
    safety_card_expiry: nullableDateOnly,
    hire_date: nullableDateOnly,
    leave_date: nullableDateOnly,
    bank_name: z.string().optional(),
    bank_account_no: z.string().optional(),
    bank_payee_name: z.string().optional(),
    blacklist_check_result: blacklistCheckResult,
    blacklist_check_date: dateOnly.optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// WP-STAFFNO：員工編號獨立表（方案 B）——`scheme` 唔用 Prisma enum，呢度
// 都刻意唔寫死 enum，用 regex（1-4 位大寫英文字母；「大寫」由
// src/lib/guards/staff-numbers.ts normalizeStaffNumber() 喺寫入前正規化，
// 呢度容許細楷輸入，等前端唔使自己轉）。
const staffNumberScheme = z.string().regex(/^[A-Za-z]{1,4}$/, "scheme 要係 1-4 位英文字母");
const staffNumberStatus = z.enum(["current", "former"]);
// S2（Opus 驗收）：`number` 喺 zod 層一樣做正規化（trim＋大寫＋去晒空
// 白，`normalizeStaffNumber()`）＋格式 regex（`STAFF_NUMBER_NUMBER_RE`），
// 兩個 route（POST .../staff-numbers、PATCH .../staff-numbers/:numberId）
// 共用同一份規則，唔使各自抄一次；`upsertCurrentStaffNumber()`
// （src/lib/guards/staff-numbers.ts）入面仲有一層一樣嘅檢查做
// defense-in-depth（例如舊寫法 `applyLegacyStaffNoPatch()` 唔經呢個 zod
// schema，都要靠嗰層擋）。
const staffNumberValue = z
  .string()
  .min(1)
  .transform((v) => normalizeStaffNumber(v))
  .refine((v) => STAFF_NUMBER_NUMBER_RE.test(v), {
    message: `number 格式唔啱（正規化後要係 1-4 位大寫英文字母 + 1-16 位英文字母／數字／連字符，總長 ≤20）`,
  });
export const GuardStaffNumberCreateSchema = z
  .object({
    scheme: staffNumberScheme,
    number: staffNumberValue,
    valid_from: dateOnly.optional(),
    note: z.string().optional(),
  })
  .strict();
export const GuardStaffNumberUpdateSchema = z
  .object({
    status: staffNumberStatus.optional(),
    valid_from: dateOnly.optional(),
    valid_to: dateOnly.optional(),
    note: z.string().optional(),
    // 打錯用呢個改，唔洗刪咗重加——同樣行 unique/prefix 檢查（見
    // src/app/api/guards/[id]/staff-numbers/[numberId]/route.ts）。
    number: staffNumberValue.optional(),
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
    // 應修（Opus 第二輪驗收）：新建價目卡一定要明確揀 billing_model（唔
    // 再 optional）——之前 optional 令唔少卡冇填呢個欄，resolver
    // `isPerShiftEligible()` 將 null 當 per_shift 向下相容，某啲本來想做
    // 「月費／special」嘅卡冇填呢個欄就會靜靜被逐更 resolver 揀中（見
    // src/lib/pricing/resolve-rate.ts M1 註解）。Update schema（下面）
    // 保持 optional（改現有卡可以唔改呢個欄），但唔准設 null。
    billing_model: enumOf(BillingModel),
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
    // 應修：update 可以唔改呢個欄（optional），但 `enumOf()` 本身唔接受
    // null——傳咗就一定要係四個合法值之一，唔可以用 `null` 去清空一張
    // 卡已經定咗嘅 billing_model（避免退返做「向下相容當 per_shift」嘅
    // 灰色地帶）。
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

// WP-PRICE：`POST /api/shift-records/reprice`——重新計价，`site_id` 冇填
// 即係成個月全部盤。S5（Opus 驗收）：月份格式收緊做真日曆月（01-12），
// 唔止「四位數字」。M3：`dry_run` 預設 true——一定要用戶睇過預覽（diff
// 摘要）先至可以確認 `dry_run:false` 真係寫入。
export const ShiftRecordRepriceSchema = z
  .object({
    month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "月份格式要係 YYYY-MM（01-12）"),
    site_id: uuid.optional(),
    dry_run: z.boolean().optional(),
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
