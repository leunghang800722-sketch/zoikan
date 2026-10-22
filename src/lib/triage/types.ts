// WP-AI-OPS §28.4：導入後對話式分診——共用型別／答案 schema。
// 題目由規則產生（唔經任何外部 AI）；evidence 含 PII，只存 DB，API 層按「保安員個人資料」權限遮罩。
import { z } from "zod";
import type { PackagePerson } from "@/lib/guards/import/package";

export type QuestionKind =
  | "no_id_card" // 冇／唔合法身份證號
  | "name_not_confirmed" // 姓名未確認（建人前）
  | "hkid_not_confirmed" // 身份證號未確認
  | "tel_only_candidate" // 淨電話對到現有保安員
  | "name_only_candidate" // 淨姓名對到現有保安員
  | "staffno_shared_by_persons" // 同一工號掛喺多個人
  | "dup_tel_across_persons" // 同一電話掛喺多個人
  | "group_name_differs" // 同身份證多檔姓名差異
  | "package_conflict" // 其他包內衝突（例如重複身份證）
  | "db_conflict" // 同現有資料矛盾（只可留返人手）
  | "field_review" // 逐欄 review（姓名／英文名／出生日期／電話／地址）
  // WP-STAFF-FIELDS 第二階段
  | "ext_identity_check" // 疑似重複／工號身份唔一致嘅人：新欄全部 review，先確認身份——重要層
  | "ext_field_conflict" // 新欄（牌照／平安咭／QAS／入職日期／緊急聯絡人）現有值唔同——補充資料層
  | "ext_field_review" // 新欄 review 狀態——補充資料層
  | "bank_review" // 銀行欄 review／衝突（包括 bank_copy_disagrees）——重要層，要銀行資料權限
  | "bank_identity_unknown" // Payroll Editor 有戶口但對唔到人——重要層，要銀行資料權限
  | "other_review"
  // WP-ONE-CLICK-AUTO §31.3 E：一鍵結算自我修復——propose／unknown 項目入分診，預填建議答案，一撳確認
  | "month_close_site_alias" // 更表盤名似現有盤（propose）
  | "month_close_site_new" // 新盤冇價可推
  | "month_close_pricing" // 未定價（候選價／冇依據）
  | "month_close_settlement" // 冇結算雞頭
  | "month_close_guard_match" // 保安員配對要核實
  | "month_close_shift_variance" // 更數差異解釋唔到
  // W2（WhatsApp 報更分流題，docs/plans/whatsapp-roster-plan.md §6.3）
  | "wa_person_ambiguous" // 名／花名／電話對到多位保安員
  | "wa_person_unknown" // 搵唔到呢位保安員
  | "wa_site_ambiguous" // 盤口唔肯定
  | "wa_date_ambiguous" // 日期唔肯定
  | "wa_shift_conflict" // 同現有排更撞（撞更／請假／額滿／鎖月）
  | "wa_unparsed" // 未能自動理解
  // W4（替更／取消，首階段一律 Triage）
  | "wa_cover" // 替更：確認被替者該更取消＋替更者入更
  | "wa_cancel"; // 取消：取消自己當日更／請假，或改為請假

export const KIND_LABEL: Record<QuestionKind, string> = {
  no_id_card: "冇可用嘅身份證號",
  name_not_confirmed: "姓名未確認",
  hkid_not_confirmed: "身份證號未確認",
  tel_only_candidate: "淨電話對到現有保安員",
  name_only_candidate: "淨姓名對到現有保安員",
  staffno_shared_by_persons: "同一工號出現喺多個人",
  dup_tel_across_persons: "同一電話出現喺多個人",
  group_name_differs: "同一身份證嘅姓名唔一致",
  package_conflict: "導入包內衝突",
  db_conflict: "同現有資料矛盾",
  field_review: "待覆核欄位",
  ext_identity_check: "呢份文件嘅工號／身份同另一位唔一致，請確認",
  ext_field_conflict: "新增資料同現值唔同",
  ext_field_review: "新增資料待覆核",
  bank_review: "銀行資料待覆核",
  bank_identity_unknown: "收款戶口對唔到人",
  other_review: "要人手判斷",
  month_close_site_alias: "更表盤名似現有盤",
  month_close_site_new: "新盤冇價可推",
  month_close_pricing: "未定價",
  month_close_settlement: "冇結算雞頭",
  month_close_guard_match: "保安員配對要核實",
  month_close_shift_variance: "更數差異解釋唔到",
  wa_person_ambiguous: "WhatsApp 報更：人名對到多位保安員",
  wa_person_unknown: "WhatsApp 報更：搵唔到呢位保安員",
  wa_site_ambiguous: "WhatsApp 報更：盤口唔肯定",
  wa_date_ambiguous: "WhatsApp 報更：日期唔肯定",
  wa_shift_conflict: "WhatsApp 報更：同現有排更撞",
  wa_unparsed: "WhatsApp 報更：未能自動理解",
  wa_cover: "WhatsApp 報更：替更要你確認",
  wa_cancel: "WhatsApp 報更：取消要你確認",
};

/** W2：WhatsApp 分診題 kind（session.sourceType="whatsapp"）；evidence 含原話＋姓名（PII，只存 DB）。 */
export const WA_KINDS: readonly QuestionKind[] = ["wa_person_ambiguous", "wa_person_unknown", "wa_site_ambiguous", "wa_date_ambiguous", "wa_shift_conflict", "wa_unparsed", "wa_cover", "wa_cancel"];

/** 一題入面可揀嘅選項 id。`skip` 永遠有，唔經 apply。 */
export const OPTION_IDS = [
  "link", // 連去指定現有保安員（要 guard_id）
  "create_new", // 新開一個保安員
  "use_package_hkid", // 用導入包嘅身份證號
  "enter_hkid", // 輸入身份證號
  "use_package_name", // 用導入包嘅姓名（確認）
  "enter_name", // 輸入姓名
  "keep_pending", // 照建但標「姓名待核對」
  "keep", // 照包內資料套用（確認冇問題）
  "drop_shared", // 唔寫有爭議嘅工號／電話
  "apply_fields", // 逐欄決定（field_review）
  "apply_ext_fields", // 新欄逐欄決定（用導入值／保留現值／跳過）
  "confirm_ext_identity", // 確認身份冇錯，照包內新欄寫入（只補空欄）
  "assign_bank", // 收款戶口歸邊個保安員（bank_identity_unknown；要 guard_id）
  // WP-ONE-CLICK-AUTO：month_close_* 題專用
  "mc_accept", // 一撳確認預填建議答案
  "mc_pick", // 揀指定候選（candidate_id）
  "mc_new", // 當新盤（site_alias 題）
  "mc_price", // 自己輸入價錢（pricing／site_new 題）
  "mc_ack", // 我已覆核，冇問題（更數差異題）
  // W2：wa_* 題專用
  "wa_pick_guard", // 揀候選／搜尋嘅保安員（guard_id；remember_alias 可選）
  "wa_pick_site", // 揀盤口（site_id）
  "wa_set_date", // 定日子（value＝YYYY-MM-DD）
  "wa_use_whatsapp", // 以 WhatsApp 為準（取消舊記錄再寫新）
  "wa_keep_old", // 保留舊記錄（唔寫）
  "wa_force_write", // 額滿／超配額仍然入更
  "wa_accept", // 照解析結果入更（待批核）
  "wa_manual", // 人手入更（去排更頁）
  "wa_ignore", // 忽略（唔入更，答完）
  // W4
  "wa_cover_confirm", // 確認替更（被替者該更取消＋替更者入更，同 tx）
  "wa_cover_add_only", // 只加替更者，唔改被替者
  "wa_cancel_apply", // 取消該更／請假
  "wa_cancel_to_leave", // 取消該更並改為請假（value＝請假碼）
  "skip", // 跳過，留返人手
] as const;
type OptionId = (typeof OPTION_IDS)[number];

export interface QuestionOption {
  id: OptionId;
  label: string;
  hint?: string;
  /** 需要用戶輸入嘅類型 */
  input?: "text" | "hkid" | "guard_search" | "date" | "leave_code";
  /** link 選項對應嘅候選保安員 id（顯示時由 server 加候選卡） */
  guard_id?: string;
  /** W2：wa_pick_site 選項對應嘅盤 id；wa_set_date 選項對應嘅候選日子（YYYY-MM-DD） */
  site_id?: string;
  date?: string;
}

export const REVIEW_FIELDS = ["nameZh", "nameEn", "dateOfBirth", "phone", "address"] as const;
export type ReviewField = (typeof REVIEW_FIELDS)[number];
export const REVIEW_FIELD_LABEL: Record<ReviewField, string> = {
  nameZh: "中文姓名",
  nameEn: "英文姓名",
  dateOfBirth: "出生日期",
  phone: "電話",
  address: "地址",
};

export interface SharedWithEntry {
  /** 伺服器 person key（serverPersonKey，同題目 personKey 一致） */
  person_key: string;
  name_zh: string | null;
  name_en: string | null;
  hkid_status: string;
  has_docs: boolean;
  doc_count: number;
  staff_numbers: string[];
  tel_status: string;
}

/** 存喺 triage_questions.evidence_json（DB 內，受權限保護；含 PII）。 */
export interface QuestionEvidence {
  v: 1;
  person: PackagePerson;
  reasons: string[];
  candidate_guard_ids: string[];
  /** staffno_shared／dup_tel 用：包內被別人共用嘅工號、電話係咪共用 */
  shared_staff_numbers?: string[];
  shared_tel?: boolean;
  /** TE-13：同一工號／電話嘅「其他人」（只放狀態同工號，唔放 HKID／電話值）；view 按 pii 遮罩姓名，加 question_id（同 session 同 kind 嘅題） */
  shared_with?: SharedWithEntry[];
  /** field_review 用：要覆核嘅欄＋同現有值比較結果 */
  review_fields?: { field: ReviewField; check: string }[];
  /** 連去嘅現有保安員（field_review） */
  guard_id?: string | null;
  /** WP-STAFF-FIELDS：ext 題要覆核／處理嘅新欄（key 見 import/ext.ts）＋同現有值比較 */
  ext_review?: { key: string; check: string; status: string; held?: string }[];
  /** bank_identity_unknown：Payroll Editor 對唔到人嘅戶口（含完整戶口號——同 guards 表同級，只存 DB，API 層按銀行資料權限遮罩） */
  unassigned?: { key: string; bankCode: string; accountNo: string; payeeName: string };
  /** TE-13：已自動併入呢個人嘅空記錄（ghost）說明——唔含 PII，只有工號 */
  note?: string;
  /** TE-7：來源檔案線索（證據圖上載時由本機腳本帶入；只補唔覆蓋） */
  doc_ref?: { file_name: string; page_count: number; pages_by_kind: Record<string, number> };
}

/** 「補充資料」層：唔急，排喺要人手／衝突／銀行之後，badge 唔計。 */
export const SUPPLEMENTARY_KINDS: readonly QuestionKind[] = ["field_review", "ext_field_conflict", "ext_field_review"];
/** 銀行層：要「保安員銀行資料:update」先可以睇內容／作答。 */
export const BANK_KINDS: readonly QuestionKind[] = ["bank_review", "bank_identity_unknown"];

const EXT_CHOICES = ["use_import", "keep_current", "skip"] as const;

const fieldAnswer = z
  .object({ action: z.enum(["confirm", "replace", "skip"]), value: z.string().trim().max(500).optional() })
  .strict();

export const answerSchema = z
  .object({
    option: z.enum(OPTION_IDS),
    guard_id: z.string().min(1).max(64).optional(),
    value: z.string().trim().max(500).optional(),
    fields: z.partialRecord(z.enum(REVIEW_FIELDS), fieldAnswer).optional(),
    /** apply_ext_fields：key → 用導入值／保留現值／跳過 */
    ext_fields: z.record(z.string().regex(/^[A-Za-z.0-9-]{1,60}$/), z.enum(EXT_CHOICES)).optional(),
    /** assign_bank：目標保安員已有唔同戶口時，明確揀「取代現有戶口」 */
    replace_existing: z.boolean().optional(),
    /** assign_bank：目標保安員英文名同收款人唔夾／唔係長工 autopay 時，要額外確認「我確認呢個戶口屬於呢位保安員」 */
    confirm_identity: z.boolean().optional(),
    /**
     * TE-3：補資料——建人類選項（use_package_hkid／enter_hkid／create_new／keep）而包內冇姓名時，人手對住證據圖補中文／英文姓名
     * （寫入前確認為 confirmed；preview 同 answer 行同一條 code path）。
     */
    extra: z.object({ name_zh: z.string().trim().max(100).optional(), name_en: z.string().trim().max(100).optional(), dob: z.string().trim().max(10).optional(), link_guard_id: z.string().min(1).max(64).optional(), create_new: z.boolean().optional() }).strict().optional(),
    /** W2：wa_pick_site 揀咗邊個盤 */
    site_id: z.string().min(1).max(64).optional(),
    /** W4：wa_cover_confirm／wa_cover_add_only／wa_use_whatsapp（替更題）揀咗邊個做被替者（替更者用 guard_id） */
    replaced_guard_id: z.string().min(1).max(64).optional(),
    /** W2：wa_pick_guard 同時「記住呢個花名」（將原話人名加做佢嘅別名） */
    remember_alias: z.boolean().optional(),
    /** month_close_*：揀咗邊個候選（evidence.candidates[].id） */
    candidate_id: z.string().min(1).max(64).optional(),
    /** month_close_pricing／site_new：自己輸入嘅價（元／更） */
    price: z
      .object({ client_rate: z.number().min(0).max(1_000_000).optional(), guard_wage: z.number().min(0).max(1_000_000).optional(), broker_fee: z.number().min(0).max(1_000_000).optional() })
      .strict()
      .optional(),
  })
  .strict();
export type TriageAnswer = z.infer<typeof answerSchema>;
/** TE-3：容許帶 `extra`（補姓名）嘅選項——即係會建立／確認一個人嘅選項。 */
export const EXTRA_NAME_OPTIONS: readonly string[] = ["use_package_hkid", "enter_hkid", "create_new", "keep"];

export const previewBodySchema = z.object({ answer: answerSchema }).strict();
export const answerBodySchema = z.object({ answer: answerSchema, preview_hash: z.string().length(64) }).strict();
export const reassignBodySchema = z.object({ owner_user_id: z.string().min(1).max(64) }).strict();
