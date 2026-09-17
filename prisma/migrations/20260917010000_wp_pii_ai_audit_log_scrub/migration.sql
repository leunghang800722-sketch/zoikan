-- WP-PII（Opus 驗收必修 1）：`ai.audit_log` view 冇跟 WP-PII 16 個保安員
-- 新欄（見 20260917000000_wp_pii_guard_fields）加註冊——之前 blocked_keys
-- 淨係 `password_hash`/`otp_secret`/`tel`/`bank_info` 四個（見
-- 20260912130100_wp_ai1_readonly_schema），AI 助手經 `recent_audit`／
-- `sql_select ai.audit_log` 就讀到 guards.update 嘅 audit before/after
-- JSON 入面全號 hkid／bank_account_no 等（`ai.guards` view 本身冇呢啲
-- 欄，但 audit_log 記緊嗰 16 個新欄改動嘅完整 DTO，唔受 `ai.guards`
-- 冇呢啲欄保護——兩件唔同事）。
--
-- 呢度淨係加返 12 個「唔准 AI 見」嘅新欄（snake_case，同 audit_log.
-- before/after JSON 入面嘅 key 一致——`src/lib/api/serialize.ts`
-- `pickWhitelist()` 一律將 DTO 轉做 snake_case wire format 先存落
-- audit_log，唔係 Prisma model 本身嘅 camelCase，經 dev DB 實際查證
-- 過）：hkid／date_of_birth／address／emergency_contact_name／
-- emergency_contact_tel／sia_permit_no／safety_card_no／bank_name／
-- bank_account_no／bank_payee_name／blacklist_check_result／
-- blacklist_check_date。
--
-- 刻意唔擋（老闆話「主管睇部分」、呢啲唔算「唔准 AI 見」嘅敏感資
-- 料——同 `ai.guards` view 冇加呢啲欄嘅原因唔同，audit_log 本身要保留
-- 追溯能力，牌照類別/到期、平安卡到期、入職/離職日期呢類冇 PDPO 高
-- 敏感度嘅資料一路都可以經 `guard_lookup`／`sql_select` 讀到）：
-- sia_permit_type、safety_card_expiry、hire_date、leave_date。
--
-- `ai.scrub_json()`（見 20260912130100_wp_ai1_readonly_schema）本身已經
-- 係遞歸（逐層 jsonb_each／jsonb_array_elements 落去，唔理巢狀幾深、唔
-- 理喺 object 定 array 入面）——WP-PRICE `reprice_month` 嘅
-- `after.changed_records[].before/after` 呢類 nested snapshot 一樣會被
-- 呢個新 blocked_keys 剝到，唔使改函數本身，淨係擴充呢個 view 傳落去
-- 嘅 blocked_keys 陣列就夠。
CREATE OR REPLACE VIEW ai.audit_log AS
SELECT
  id, actor_user_id, table_name, row_id, action,
  ai.scrub_json(before, ARRAY[
    'password_hash', 'otp_secret', 'tel', 'bank_info',
    'hkid', 'date_of_birth', 'address', 'emergency_contact_name',
    'emergency_contact_tel', 'sia_permit_no', 'safety_card_no',
    'bank_name', 'bank_account_no', 'bank_payee_name',
    'blacklist_check_result', 'blacklist_check_date'
  ]) AS before,
  ai.scrub_json(after, ARRAY[
    'password_hash', 'otp_secret', 'tel', 'bank_info',
    'hkid', 'date_of_birth', 'address', 'emergency_contact_name',
    'emergency_contact_tel', 'sia_permit_no', 'safety_card_no',
    'bank_name', 'bank_account_no', 'bank_payee_name',
    'blacklist_check_result', 'blacklist_check_date'
  ]) AS after,
  ip, created_at
FROM public.audit_log;
