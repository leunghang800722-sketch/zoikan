-- P6.4 / H9（2026-10-11）：ai.audit_log 由「黑名單（NOT IN 排除清單）」改成
-- 「白名單（IN 清單）＋保留舊排除清單」。
--
-- 之前只排除指定嘅幾十張表，新加嘅表（ai_chat 存咗用戶問題原文、
-- guard_staff_numbers 工號、guard_ocr、guard_import 等）預設就會入 view。
-- 而家只列 AI 助手准睇嘅「業務主檔／月結」表；其餘任何表（含 PII、對話、
-- 工號、OCR、導入、用戶／角色、登入事件）一律唔入，日後新加嘅表預設唔入。
-- 舊 NOT IN 排除清單逐字保留（belt-and-braces，亦令既有結構性測試照過）。
-- 只重定義 view（欄位、順序、scrub_json blocked keys 逐字唔變），冇改任何資料／權限。
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
WHERE table_name IN (
  'sites', 'shift_types', 'brokers', 'broker_site_assignments',
  'guards', 'shift_records', 'daily_requirements', 'quotas',
  'rate_cards', 'referral_fee_rates', 'special_items', 'month_closes'
)
AND table_name NOT IN (
  'guard_phones', 'guard_emergency_contacts', 'guard_addresses',
  'roster_uploads', 'roster_upload_rows', 'roster_reconcile_decisions',
  'staff_list_uploads', 'guard_fix_runs', 'month_close_runs',
  'guard_longterm_contracts', 'guard_leave_balances', 'guard_avg_wages',
  'longterm_payroll_runs', 'longterm_payroll_lines', 'longterm_payroll_inputs',
  'guard_identity_conflicts', 'triage_sessions', 'triage_questions',
  'month_close_auto_changes'
);
