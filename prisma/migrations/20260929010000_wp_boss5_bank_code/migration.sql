-- WP-BOSS5 §25.4（老闆 2026-09-28 決定 6）：guards 加 bank_code（3 位
-- HKICL 清算銀行編號，nullable，PII field group「安員銀行資料」，同
-- bank_name/bank_account_no/bank_payee_name 一組）——BOCHK Payroll
-- Editor 明細要呢個編號先出得到 xlsx。純 additive，冇 backfill（全部
-- guard 起步 NULL，會計逐個喺安員抽屜銀行區揀返啱嘅編號）。
ALTER TABLE "guards" ADD COLUMN "bank_code" TEXT;

-- AI 隔離：同 bank_name/bank_account_no/bank_payee_name 一組 blocked
-- key，`ai.audit_log` 嘅 `scrub_json()` 兩個 array（before／after）都要
-- 加返 'bank_code'，唔可以淨係得 schema 層面加咗欄、audit trail 度就
-- 走漏——沿用 20260927190000_wp_ltpay_ai_audit_log_exclude 嗰個版本嘅
-- view 定義（現時最新），淨係加呢一個 key，其餘逐字唔變。
CREATE OR REPLACE VIEW ai.audit_log AS
SELECT
  id, actor_user_id, table_name, row_id, action,
  ai.scrub_json(before, ARRAY[
    'password_hash', 'otp_secret', 'tel', 'bank_info',
    'hkid', 'date_of_birth', 'address', 'emergency_contact_name',
    'emergency_contact_tel', 'sia_permit_no', 'safety_card_no',
    'bank_name', 'bank_account_no', 'bank_payee_name', 'bank_code',
    'blacklist_check_result', 'blacklist_check_date'
  ]) AS before,
  ai.scrub_json(after, ARRAY[
    'password_hash', 'otp_secret', 'tel', 'bank_info',
    'hkid', 'date_of_birth', 'address', 'emergency_contact_name',
    'emergency_contact_tel', 'sia_permit_no', 'safety_card_no',
    'bank_name', 'bank_account_no', 'bank_payee_name', 'bank_code',
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
