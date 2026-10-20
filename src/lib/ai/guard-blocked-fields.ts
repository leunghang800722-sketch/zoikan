// AI-PII-2（老闆 2026-10-20 定版）：AI 助手對保安員資料嘅專用遮罩清單。
// AI 可講：姓名／工號／人卡 id／月薪／入職離職日／僱傭類型／牌照到期／緊急聯絡人姓名／別名／黑名單查核日期。
// AI 唔可講：身份證／出生日期／住址／銀行任何欄／所有電話（含緊急聯絡人電話）／黑名單查核結果。
// 呢份清單只管 AI 路徑（guard_lookup／sql_select／scrubRowForResource 對 guards），**唔改**人類 RBAC 用嘅 `GUARD_PII_FIELDS`／`GUARD_BANK_FIELDS`。
// `ai.guards` view 結構上冇呢啲欄；呢度係應用層第二重（sql_select 引用即拒絕、回傳 row 再剝）。
export const AI_GUARD_BLOCKED_FIELDS = [
  "hkid",
  "date_of_birth",
  "address",
  "tel",
  "emergency_contact_tel",
  "bank_name",
  "bank_account_no",
  "bank_payee_name",
  "bank_code",
  "blacklist_check_result",
] as const;

