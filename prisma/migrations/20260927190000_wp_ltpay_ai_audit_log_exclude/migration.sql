-- WP-LTPAY（Opus 5.5 驗收 2026-09-27，鐵則「`ai.audit_log` 排除」）：長工糧
-- 六張新表嘅 audit_log 行（合約 before/after 有月薪、人手輸入項有金額、
-- 平均工資、假期結餘、run totals）原本冇排除，`zoikan_ai_ro` 經
-- `ai.audit_log` 讀得到——薪金屬最嚴 PII（同「安員銀行資料」一致）。
-- 做法同 20260927150000_wp_one_click_month_close_runs 一致：重建 view，
-- WHERE 加入呢六個 table_name。純 view 重建，冇改任何資料、冇用 id。
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
FROM public.audit_log
WHERE table_name NOT IN (
  'guard_phones', 'guard_emergency_contacts', 'guard_addresses',
  'roster_uploads', 'roster_upload_rows', 'roster_reconcile_decisions',
  'staff_list_uploads', 'guard_fix_runs', 'month_close_runs',
  'guard_longterm_contracts', 'guard_leave_balances', 'guard_avg_wages',
  'longterm_payroll_runs', 'longterm_payroll_lines', 'longterm_payroll_inputs'
);
