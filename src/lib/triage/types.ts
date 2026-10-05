// WP-AI-OPS §28.4：導入後對話式分診——共用型別／答案 schema。
// 題目由規則產生（唔經任何外部 AI）；evidence 含 PII，只存 DB，API 層按「安員個人資料」權限遮罩。
import { z } from "zod";
import type { PackagePerson } from "@/lib/guards/import/package";

export const SOURCE_TYPES = ["guard_import", "roster_upload"] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

export const QUESTION_KINDS = [
  "no_id_card", // 冇／唔合法身份證號
  "name_not_confirmed", // 姓名未確認（建人前）
  "hkid_not_confirmed", // 身份證號未確認
  "tel_only_candidate", // 淨電話對到現有安員
  "name_only_candidate", // 淨姓名對到現有安員
  "staffno_shared_by_persons", // 同一工號掛喺多個人
  "dup_tel_across_persons", // 同一電話掛喺多個人
  "group_name_differs", // 同身份證多檔姓名差異
  "package_conflict", // 其他包內衝突（例如重複身份證）
  "db_conflict", // 同現有資料矛盾（只可留返人手）
  "field_review", // 逐欄 review（姓名／英文名／出生日期／電話／地址）
  // WP-STAFF-FIELDS 第二階段
  "ext_identity_check", // 疑似重複／工號身份唔一致嘅人：新欄全部 review，先確認身份——重要層
  "ext_field_conflict", // 新欄（牌照／平安咭／QAS／入職日期／緊急聯絡人）現有值唔同——補充資料層
  "ext_field_review", // 新欄 review 狀態——補充資料層
  "bank_review", // 銀行欄 review／衝突（包括 bank_copy_disagrees）——重要層，要銀行資料權限
  "bank_identity_unknown", // Payroll Editor 有戶口但對唔到人——重要層，要銀行資料權限
  "other_review",
] as const;
export type QuestionKind = (typeof QUESTION_KINDS)[number];

export const KIND_LABEL: Record<QuestionKind, string> = {
  no_id_card: "冇可用嘅身份證號",
  name_not_confirmed: "姓名未確認",
  hkid_not_confirmed: "身份證號未確認",
  tel_only_candidate: "淨電話對到現有安員",
  name_only_candidate: "淨姓名對到現有安員",
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
};

/** 一題入面可揀嘅選項 id。`skip` 永遠有，唔經 apply。 */
export const OPTION_IDS = [
  "link", // 連去指定現有安員（要 guard_id）
  "create_new", // 新開一個安員
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
  "assign_bank", // 收款戶口歸邊個安員（bank_identity_unknown；要 guard_id）
  "skip", // 跳過，留返人手
] as const;
export type OptionId = (typeof OPTION_IDS)[number];

export interface QuestionOption {
  id: OptionId;
  label: string;
  hint?: string;
  /** 需要用戶輸入嘅類型 */
  input?: "text" | "hkid" | "guard_search";
  /** link 選項對應嘅候選安員 id（顯示時由 server 加候選卡） */
  guard_id?: string;
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

/** 存喺 triage_questions.evidence_json（DB 內，受權限保護；含 PII）。 */
export interface QuestionEvidence {
  v: 1;
  person: PackagePerson;
  reasons: string[];
  candidate_guard_ids: string[];
  /** staffno_shared／dup_tel 用：包內被別人共用嘅工號、電話係咪共用 */
  shared_staff_numbers?: string[];
  shared_tel?: boolean;
  /** field_review 用：要覆核嘅欄＋同現有值比較結果 */
  review_fields?: { field: ReviewField; check: string }[];
  /** 連去嘅現有安員（field_review） */
  guard_id?: string | null;
  /** WP-STAFF-FIELDS：ext 題要覆核／處理嘅新欄（key 見 import/ext.ts）＋同現有值比較 */
  ext_review?: { key: string; check: string; status: string }[];
  /** bank_identity_unknown：Payroll Editor 對唔到人嘅戶口（含完整戶口號——同 guards 表同級，只存 DB，API 層按銀行資料權限遮罩） */
  unassigned?: { key: string; bankCode: string; accountNo: string; payeeName: string };
}

/** 「補充資料」層：唔急，排喺要人手／衝突／銀行之後，badge 唔計。 */
export const SUPPLEMENTARY_KINDS: readonly QuestionKind[] = ["field_review", "ext_field_conflict", "ext_field_review"];
/** 銀行層：要「安員銀行資料:update」先可以睇內容／作答。 */
export const BANK_KINDS: readonly QuestionKind[] = ["bank_review", "bank_identity_unknown"];

export const EXT_CHOICES = ["use_import", "keep_current", "skip"] as const;

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
    /** assign_bank：目標安員已有唔同戶口時，明確揀「取代現有戶口」 */
    replace_existing: z.boolean().optional(),
  })
  .strict();
export type TriageAnswer = z.infer<typeof answerSchema>;

export const previewBodySchema = z.object({ answer: answerSchema }).strict();
export const answerBodySchema = z.object({ answer: answerSchema, preview_hash: z.string().length(64) }).strict();
export const reassignBodySchema = z.object({ owner_user_id: z.string().min(1).max(64) }).strict();
