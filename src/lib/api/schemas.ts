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
  LongtermPayBasis,
  LongtermMpfExemptReason,
  LongtermPayrollInputKind,
} from "@prisma/client";
import { normalizeStaffNumber, STAFF_NUMBER_NUMBER_RE } from "@/lib/guards/staff-numbers";
import { normalizeTel, TEL_RE } from "@/lib/guards/contacts";

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
// 應修 2（Opus 驗收第二輪）：UI「編輯員工編號」要清得走 `note`（唔止
// 日期），同 `nullableDateOnly` 一致精神——`z.string().optional()` 唔收
// `null`，用戶打空咗個備註送 `null` 想清返，會俾 `.strict()` 400（唔係
// 「未知欄位」，係值型別唔啱）。淨係 `guard_staff_numbers.note` 呢種
// DB nullable 嘅文字欄用呢個，唔係成個檔案通改（例如 `sia_permit_no`
// 呢類跟現有「保安員」module 嘅欄暫時唔喺呢輪修復範圍）。
const nullableString = z.union([z.null(), z.string()]).optional();
const money = z.union([z.number(), z.string()]).optional();

// WP-PII：身份證格式寬鬆核對（1-2 個英文字母 + 6 位數字 + 括住 1 位
// 數字或 "A" 嘅核對碼），大小寫都收（入 DB 之前唔轉大寫，保留原文）。
// WP-STAFF-IMPORT B1：格式／check digit 改由 route 層 `prepareHkidForWrite()`
// （src/lib/guards/identity.ts）驗——`A123456(3)`／`A1234563` 都收，入庫一律 canonical；
// 護照號等要帶 `allow_invalid_hkid: true`。呢層淨係擋明顯唔係字串／過長。
const hkid = z.string().trim().min(1, "身份證唔可以空白").max(32).optional();
const allowInvalidHkid = z.boolean().optional();
// Opus 覆核（WP-MULTI 必修 4）：電話格式（`guard_phones.tel`／
// `GuardUpdateSchema.emergency_contact_tel`／`GuardEmergencyContact*
// Schema.tel`）統一用呢兩個——之前呢度嘅 `tel8`（8 位香港號硬性）成個
// 刪走，`GuardUpdateSchema.emergency_contact_tel` 淨係放寬到同 `tel`
// 一致（唔喺 schema 層驗格式，落 `applyLegacyGuardContactPatch()` 舊
// 寫法一樣容許髒值唔會撞 400，見 src/app/api/guards/[id]/route.ts「值
// 冇變就當冇改」大註解）；子資源（POST／PATCH .../emergency-contacts）
// 就用 `nullablePhoneTel`（正規化＋驗格式，可空，同電話一致）。
const phoneTel = z
  .string()
  .min(1)
  .transform((v) => normalizeTel(v))
  .refine((v) => TEL_RE.test(v), { message: "電話格式唔啱（正規化後要係 7-15 位數字，可以 + 開頭）" });
// 可空版——`null`／undefined／空白字串都當「冇提供」，非空先正規化＋驗
// 格式（緊急聯絡人「姓名／電話至少填一樣」，電話呢欄本身可以淨係得
// 姓名冇電話，同 phoneTel 唔同要容許空）。
const nullablePhoneTel = z
  .union([z.null(), z.string()])
  .optional()
  .transform((v) => (v === null || v === undefined ? v : v.trim() === "" ? null : normalizeTel(v)))
  .refine((v) => v === null || v === undefined || TEL_RE.test(v), {
    message: "電話格式唔啱（正規化後要係 7-15 位數字，可以 + 開頭）",
  });
// WP-STAFFNO：`sia_permit_type` 改做衍生值（唔再接受 API 直接寫，見
// GuardUpdateSchema 註解），之前呢度嘅 `SIA_PERMIT_TYPES`／
// `siaPermitType` zod enum 冇 call site 用喇，成組刪走。
const BLACKLIST_CHECK_RESULTS = ["clear", "flagged", "pending"] as const;
const blacklistCheckResult = z.enum(BLACKLIST_CHECK_RESULTS).optional();
const uuid = z.string().min(1);

// WP-GUARD-FIX（老闆 2026-09-25 要求）：「更表用名（別名）」——更表姓名
// 格寫法可能同系統本名唔同（花名／簡寫／曾用名），`matchGuard()` 而家
// 加多一層用呢個欄配對（見 src/lib/roster-upload/match.ts）。淨係 PATCH
// 接受（同 hkid 等 PII 欄一致，新增時未必已知有咩別名）；去空白＋去重複
// （保留原文大小寫，唔轉形，因為中文名冇大細楷可轉）；「唔可以等於本名」
// 呢個檢查要對住「呢次 PATCH 之後嘅有效本名」（可能同一次 PATCH 改埋
// `name_zh`），schema 呢層做唔到（冧唔到 `before.nameZh`），留返
// route.ts 做（見 guards/[id]/route.ts `assertAliasesDoNotMatchOwnName()`）。
const nameAliases = z
  .array(z.string())
  .optional()
  .transform((arr) => {
    if (arr === undefined) return undefined;
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of arr) {
      const v = raw.trim();
      if (!v || seen.has(v)) continue;
      seen.add(v);
      out.push(v);
    }
    return out;
  });

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
    // WP-MISC（老闆 2026-09-20 拍板）：LINK 呢類「客戶直接出糧」嘅盤——
    // 見 prisma/schema.prisma Site.guardsPaidByClient 大註解。
    guards_paid_by_client: z.boolean().optional(),
    monthly_fee: money,
    monthly_posts: z.number().int().optional(),
    prorata_basis: enumOf(ProrataBasis).optional(),
    in_scope: z.boolean().optional(),
    // WP-UPLOAD-AUTOFIX（老闆 2026-09-25 要求）：見 SiteUpdateSchema 同一個欄註解。
    roster_file_keys: z.array(z.string()).optional(),
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
    guards_paid_by_client: z.boolean().optional(),
    monthly_fee: money,
    monthly_posts: z.number().int().optional(),
    prorata_basis: enumOf(ProrataBasis).optional(),
    in_scope: z.boolean().optional(),
    status: enumOf(SiteStatus).optional(),
    // WP-UPLOAD-AUTOFIX（老闆 2026-09-25 要求：更表上載完全自動）：更表檔名
    // 鍵——上載時檔名 stem 含任一鍵（NFKC、唔分大小寫、字詞邊界）就直接用呢個盤，優先過
    // 檔內盤名對照。見 prisma/schema.prisma Site.rosterFileKeys、
    // src/lib/roster-upload/match.ts `matchSiteByFileName()`。老闆／主管可改。
    roster_file_keys: z.array(z.string()).optional(),
    // WP-POSTORDER-FREE（§34 B）：盤預設結算雞頭（null＝清走）。見 prisma Site.defaultSettlementBrokerId。
    default_settlement_broker_id: uuid.nullable().optional(),
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
    // WP-STAFF-IMPORT B1：新增時可帶身份證（需「保安員個人資料」update 權限，route 層驗）。
    hkid,
    allow_invalid_hkid: allowInvalidHkid,
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
    allow_invalid_hkid: allowInvalidHkid,
    // 應修 2（Opus 驗收第二輪）：`date_of_birth` DB 欄 nullable，同
    // `sia_permit_a/b_expiry`／`safety_card_expiry`／`hire_date`／
    // `leave_date` 一致理由——改用 `nullableDateOnly`，等用戶 PATCH
    // `null` 真係清得走已填嘅出生日期（打錯咗想清返）。
    date_of_birth: nullableDateOnly,
    address: z.string().optional(),
    emergency_contact_name: z.string().optional(),
    // Opus 覆核（WP-MULTI 必修 4）：呢個舊寫法欄放寬到同 `tel`（上面）
    // 一致——冇格式驗證（唔再 8 位硬性），真正嘅正規化＋驗格式留返落
    // `applyLegacyGuardContactPatch()`／子資源 schema（`nullablePhoneTel`）
    // 做；唔喺呢層驗嘅原因同 `tel` 一致：「值冇變（包括髒值）就當冇改」
    // 呢個判斷要喺 parseBody() 之後、真係改咗先觸發格式驗證，唔可以喺
    // parseBody() 呢一刻就因為 DB 現存嘅髒值格式唔啱而 400（見
    // src/app/api/guards/[id]/route.ts 大註解）。
    emergency_contact_tel: z.string().optional(),
    sia_permit_no: z.string().optional(),
    safety_card_no: z.string().optional(),
    // 附帶修復：平安卡到期／入職／離職日期一樣改用 `nullableDateOnly`
    // （牌照／平安卡／入離職／甲乙到期呢批，見上面 sia_permit_a/b_expiry
    // 同一段理由）。
    safety_card_expiry: nullableDateOnly,
    // WP-MISC（老闆 2026-09-20 拍板）：QAS（基本保安訓練證書）——
    // `qas_issue_date`＝完成日期、`qas_expiry_date`＝到期日（如有），
    // 跟「保安員」module（同 safety_card_expiry 一致層級），`null`＝清空。
    qas_issue_date: nullableDateOnly,
    qas_expiry_date: nullableDateOnly,
    hire_date: nullableDateOnly,
    leave_date: nullableDateOnly,
    bank_name: z.string().optional(),
    // 戶口輸入先正規化（全形數字轉半形、去空白）；淨收數字同 `-` 分隔符，其他字符 400
    bank_account_no: z
      .string()
      .transform((v) => v.normalize("NFKC").replace(/\s+/g, ""))
      .refine((v) => /^[0-9-]*$/.test(v), { message: "銀行戶口淨係可以有數字同「-」分隔符" })
      .optional(),
    bank_payee_name: z.string().optional(),
    // WP-BOSS5 §25.4：3 位 HKICL 清算銀行編號——`""` 清空、非空一定要
    // 3 位數字（BOCHK Payroll Editor 要求嘅格式）。淨係一個「建議下拉」
    // （`hkicl-bank-codes.ts`）幫會計揀，會計都可以人手打呢度冇收錄嘅
    // 3 位碼（表唔係白名單）。
    bank_code: z.union([z.literal(""), z.string().regex(/^\d{3}$/, "銀行編號要 3 位數字（HKICL 清算編號）")]).optional(),
    blacklist_check_result: blacklistCheckResult,
    // 應修 2：同 `date_of_birth` 一致，DB 欄 nullable，改用
    // `nullableDateOnly` 等 `null` 清得走。
    blacklist_check_date: nullableDateOnly,
    // WP-GUARD-FIX：見上面 `nameAliases` 定義。
    name_aliases: nameAliases,
    // WP-PHASE3（§20.4 Phase 3）：長工介紹雞頭／簽證形式贊助雞頭——呢兩
    // 欄喺 WP-LTSHIFT（§19）已經加落 schema.prisma（`guards.referral_
    // broker_id`／`visa_sponsored_by_broker_id`，之前淨係俾
    // `inferReferralBrokerFromRosters()`／guard-fix 內部寫，冇經呢個
    // PATCH schema／field-groups 白名單出街），而家保安員抽屜「長工」區
    // 要俾老闆／主管人手設／改／清空——跟「保安員」module（同 employment_
    // type 一致層級，唔係 PII/收客價/出街價 field group）。`null`＝清空
    // （例如推算錯咗想清返、或者長工唔再由雞頭供應）。
    referral_broker_id: z.union([z.null(), uuid]).optional(),
    visa_sponsored_by_broker_id: z.union([z.null(), uuid]).optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// WP-PHASE3（§20.4 Phase 3 item 1）：`guard_longterm_posts`——保安員抽屜
// 「長工」區嘅崗位盤 CRUD。跟 `GuardStaffNumberCreateSchema` 一致手法：
// 淨係內部角色（module「保安員」）先可以寫，雞頭連自己保安員都唔可以改（見
// route.ts 硬性擋雞頭）。「終止」＝PATCH `effective_to`（唔硬刪，同
// staff_numbers／rate_cards 一致「冇硬刪」精神）。
export const GuardLongtermPostCreateSchema = z
  .object({
    site_id: uuid,
    effective_from: z.coerce.date(),
    effective_to: nullableDateOnly,
    note: nullableString,
  })
  .strict();
export const GuardLongtermPostUpdateSchema = z
  .object({
    effective_to: nullableDateOnly,
    note: nullableString,
  })
  .strict();

// WP-PHASE3（item 2）：「轉長工」一步動作——`POST /api/guards/:id/
// convert-to-longterm`。`monthly_salary` 刻意 optional：冇「長工糧」
// 權限（例如主管）嘅 session 送咗都會俾 route 層忽略並警告（唔靜靜寫
// 唔到嘅嘢，見 route.ts）。
export const GuardConvertToLongtermSchema = z
  .object({
    site_id: uuid,
    effective_from: z.coerce.date(),
    referral_broker_id: z.union([z.null(), uuid]).optional(),
    monthly_salary: money,
  })
  .strict();

// WP-PHASE3（item 3）：「複製上月卡到本月」——`POST /api/rate-cards/
// copy-last-month`。`dry_run` 預設 true（預覽，唔寫入），要 `dry_run:
// false` 先真係建卡（同 `/api/shift-records/reprice` 一致「預覽→確認」
// 兩段式）。
export const RateCardCopyLastMonthSchema = z
  .object({
    month: z.string().regex(/^\d{4}-\d{2}$/, "month 格式要係 YYYY-MM"),
    site_id: uuid.optional(),
    dry_run: z.boolean().optional(),
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
    // 應修 2（Opus 驗收第二輪）：`valid_from`（DB 欄 nullable）跟
    // GuardUpdateSchema 嗰批日期欄一致改用 `nullableDateOnly`。
    valid_from: nullableDateOnly,
    note: nullableString,
  })
  .strict();
export const GuardStaffNumberUpdateSchema = z
  .object({
    status: staffNumberStatus.optional(),
    // 應修 2：`valid_from`／`valid_to` 一樣改用 `nullableDateOnly`——
    // `null`＝清空，former 行清 `valid_to` 一樣容許（呢個 route 本身冇
    // 額外「former 一定要有 valid_to」嘅限制，見
    // src/app/api/guards/[id]/staff-numbers/[numberId]/route.ts）。
    valid_from: nullableDateOnly,
    valid_to: nullableDateOnly,
    note: nullableString,
    // 打錯用呢個改，唔洗刪咗重加——同樣行 unique/prefix 檢查（見
    // src/app/api/guards/[id]/staff-numbers/[numberId]/route.ts）。
    number: staffNumberValue.optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// WP-MULTI（老闆 2026-09-19 拍板）：電話／緊急聯絡人／地址三張新子表——
// 同上面 GuardStaffNumber* 一致嘅 zod 手法（`tel` 正規化＋格式 regex 喺
// 呢層做一次 defense-in-depth，`src/lib/guards/contacts.ts` 入面嘅
// create/update 函數再驗一次，兩個 call site——route／舊 PATCH legacy
// path——都要經過）。`phoneTel`／`nullablePhoneTel` 定義喺檔案頭
// （`GuardUpdateSchema` 之前，等佢都用得到）。
export const GuardPhoneCreateSchema = z
  .object({
    tel: phoneTel,
    label: nullableString,
    is_primary: z.boolean().optional(),
    note: nullableString,
  })
  .strict();
// Opus 第三輪覆核：update 嘅 `tel` 唔喺 schema 層驗格式——自癒／舊寫法照搬落嚟嘅
// 髒 tel 行，前端編輯 label／備註時會連 tel 原值一齊送，schema 一驗就 400 鎖死。
// 改為 route／lib 層「同現值一樣就照搬、真係改咗先正規化＋驗格式」。
export const GuardPhoneUpdateSchema = z
  .object({
    tel: z.string().min(1).optional(),
    label: nullableString,
    is_primary: z.boolean().optional(),
    note: nullableString,
  })
  .strict();

// Opus 覆核（WP-MULTI 必修 4）：`tel` 之前用 `nullableString`（完全冇格式
// 驗證）——而家同電話一樣正規化＋驗格式（去空白／連字符；`^\+?[0-9]
// {7,15}$`；可空，`assertNameOrTel()` 落 src/lib/guards/contacts.ts 保證
// 姓名／電話唔會同時空）。
export const GuardEmergencyContactCreateSchema = z
  .object({
    name: nullableString,
    tel: nullablePhoneTel,
    relationship: nullableString,
    sort_order: z.number().int().optional(),
    note: nullableString,
  })
  .strict();
export const GuardEmergencyContactUpdateSchema = z
  .object({
    name: nullableString,
    tel: nullableString, // 同上：lib 層 updateGuardEmergencyContact() 先驗（冇改就照搬）
    relationship: nullableString,
    sort_order: z.number().int().optional(),
    note: nullableString,
  })
  .strict();

// Opus 覆核（必修 6）：`PUT /api/guards/:id/emergency-contacts/order`——
// 一個 transaction 重寫全部行嘅 `sort_order`（跟 `ids` 陣列順序，
// 0-based）。`ids` 要啱啱好等於現有全部行（見
// src/lib/guards/contacts.ts reorderGuardEmergencyContacts()）。
export const GuardEmergencyContactOrderSchema = z
  .object({
    ids: z.array(uuid).min(1),
  })
  .strict();

export const GuardAddressCreateSchema = z
  .object({
    address: z.string().min(1),
    is_primary: z.boolean().optional(),
    note: nullableString,
  })
  .strict();
export const GuardAddressUpdateSchema = z
  .object({
    address: z.string().min(1).optional(),
    is_primary: z.boolean().optional(),
    note: nullableString,
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
    // 應修 4：呢度嘅 `uuid` 淨係校驗格式（呢個 repo 嘅 schemas.ts 一律
    // 純同步驗證，冇 DB 查詢）——真正嘅「broker 存在？」／「雞頭 session
    // 帶咗唔係自己嘅 id？」校驗喺 route 層做（見
    // src/lib/broker-isolation.ts `assertSettlementBrokerIdsValid()`，
    // POST /api/shift-records 同 POST /api/shift-records/batch 都會call）。
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

// ---------------------------------------------------------------------------
// WP-ROSTER-UPLOAD Phase A（§15.3）：`POST /api/roster-uploads` 係
// multipart/form-data（帶檔案），唔經呢個 zod schema／`parseBody()`（嗰
// 個淨係做 JSON body）——非檔案欄位（`month`／`site_id`）由 route 自己
// 由 FormData 讀出嚟，再用呢個 schema 驗證（見 route.ts）。
export const RosterUploadFormFieldsSchema = z
  .object({
    month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])(-\d{2})?$/, "月份格式要係 YYYY-MM 或 YYYY-MM-DD"),
    site_id: uuid.optional(),
  })
  .strict();
export const RosterUploadPatchSchema = z
  .object({
    site_id: z.union([z.null(), uuid]), // 人手指定盤（清返做未指定用 null）
  })
  .strict();

// WP-UPLOAD-VOID（老闆 2026-09-25 要求）：`POST /api/roster-uploads/:id/void`
// ——`reason` 必填、≤200 字（同 `VoidReasonSchema` 唔同套——嗰個冇上限，
// 呢度任務書明文「≤200 字」）。
export const RosterUploadVoidSchema = z
  .object({
    reason: z.string().trim().min(1, "作廢一定要填原因").max(200, "原因最多 200 字"), // Opus 5.5 驗收：trim——淨係空格唔算填咗原因
  })
  .strict();

// WP-GUARD-FIX-UI：`POST /api/guard-fix/plan`——`month` 同
// `RosterUploadFormFieldsSchema` 一致（YYYY-MM 或 YYYY-MM-DD）。
export const GuardFixPlanBodySchema = z
  .object({
    month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])(-\d{2})?$/, "月份格式要係 YYYY-MM 或 YYYY-MM-DD"),
  })
  .strict();

// 驗收修正（雞頭稱呼對應）：`POST /api/guard-fix/broker-alias`——Postorder
// 對唔到嘅雞頭稱呼，頁面揀完系統雞頭之後寫入 `brokers.aliases`。`label`
// 係原文稱呼（人名，PII，唔驗格式，淨係要非空同有長度上限）；`broker_id`
// 一定係 uuid。
export const GuardFixBrokerAliasBodySchema = z
  .object({
    label: z.string().trim().min(1, "稱呼唔可以係空").max(100, "稱呼太長"),
    broker_id: uuid,
  })
  .strict();

// WP-ROSTER-UPLOAD Phase B-1（B1-2）：`POST /api/roster-uploads/:id/reconcile/apply`
// ——`key` 係 `buildReconcileKey()`/`buildUnresolvedKey()`（src/lib/
// roster-upload/reconcile.ts）砌出嚟嘅字串，唔係 uuid，故意用寬鬆
// `z.string().min(1)`（唔識嘅 key 由 service 層 400/逐項 fail，唔喺呢度
// 驗格式）。`reason` 淨係 `exception` 要非空（service 層再驗一次，呢度
// 唔擋空字串——`keep_system` 冇填係合法嘅）。
export const RosterReconcileApplySchema = z
  .object({
    actions: z
      .array(
        z
          .object({
            key: z.string().min(1).max(200),
            action: z.enum(["apply_roster", "keep_system", "exception"]),
            reason: z.string().max(2000).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(2000),
  })
  .strict();

// WP-GUARD-FIX 第二輪（老闆 2026-09-25 要求）：`POST /api/roster-uploads/
// :id/reconcile/resolve-subsite`——對數頁「批量指定子盤」／「全部歸母盤
// 確認」。`site_id=null`＝全部歸母盤確認；非 null＝批量指定嗰個子盤（要
// 係呢個上載母盤嘅子盤，service 層 `bulkResolveAmbiguousSubSite()` 驗）。
export const RosterReconcileResolveSubSiteSchema = z
  .object({
    row_ids: z.array(z.string().min(1)).min(1).max(2000),
    site_id: z.union([z.string().min(1), z.null()]),
  })
  .strict();

// ---------------------------------------------------------------------------
// WP-LTPAY §21 任務 5b：長工糧頁面——合約管理／人手輸入項／平均工資／
// 假期餘額。呢批表全部歸「長工糧」module 一致粒度（老闆／會計，見
// rbac/matrix.ts），冇獨立 field-group（同 field-groups.ts 現有機制唔
// 相關，成個 module 老闆/會計以外硬性 403）。
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "要 YYYY-MM-DD 格式");
const nullableYmd = z.union([z.null(), ymd]).optional();

export const LongtermContractCreateSchema = z
  .object({
    guard_id: uuid,
    effective_from: dateOnly,
    effective_to: nullableDateOnly,
    monthly_salary: money,
    pay_basis: enumOf(LongtermPayBasis).optional(),
    daily_rate: money,
    post_site_id: uuid.optional(),
    rest_day_paid: z.boolean().optional(),
    rest_day_rate: money,
    shift_hours: money,
    probation_months: z.number().int().optional(),
    annual_leave_days: money,
    statutory_holiday_paid_from: z.enum(["immediate", "after_3_months"]).optional(),
    mpf_exempt_reason: enumOf(LongtermMpfExemptReason).optional(),
    note: z.string().optional(),
  })
  .strict();

export const LongtermContractUpdateSchema = z
  .object({
    effective_from: dateOnly.optional(),
    effective_to: nullableDateOnly,
    monthly_salary: money,
    pay_basis: enumOf(LongtermPayBasis).optional(),
    daily_rate: money,
    post_site_id: z.union([z.string(), z.null()]).optional(),
    rest_day_paid: z.boolean().optional(),
    rest_day_rate: money,
    shift_hours: money,
    probation_months: z.union([z.number().int(), z.null()]).optional(),
    annual_leave_days: money,
    statutory_holiday_paid_from: z.enum(["immediate", "after_3_months"]).optional(),
    mpf_exempt_reason: enumOf(LongtermMpfExemptReason).optional(),
    note: nullableString,
    // 作廢／取消作廢——同「編輯」用同一個 PATCH endpoint（任務書冇要求
    // 獨立 void route，見 route.ts 檔頭註解）。
    voided: z.boolean().optional(),
  })
  .strict();

export const LongtermInputCreateSchema = z
  .object({
    month: dateOnly,
    guard_id: uuid,
    kind: enumOf(LongtermPayrollInputKind),
    amount: money,
    date_from: nullableYmd,
    date_to: nullableYmd,
    doctor_note_verified: z.boolean().optional(),
    note: z.string().optional(),
  })
  .strict();

export const LongtermInputUpdateSchema = z
  .object({
    kind: enumOf(LongtermPayrollInputKind).optional(),
    amount: money,
    date_from: nullableYmd,
    date_to: nullableYmd,
    doctor_note_verified: z.boolean().optional(),
    note: nullableString,
  })
  .strict();

export const GuardAvgWageUpsertSchema = z
  .object({
    guard_id: uuid,
    month: dateOnly,
    avg_daily_wage: money,
    source: z.string().min(1).max(200),
  })
  .strict();

export const GuardLeaveBalanceUpdateSchema = z
  .object({
    al_entitled: money,
    al_taken: money,
    al_carry: money,
    sl_accrued: money,
    sl_taken: money,
  })
  .strict();
