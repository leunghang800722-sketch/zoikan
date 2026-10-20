-- EMP-P2.1：ai.audit_log 白名單加 staff_schemes（工號體系設定改動：顯示名／出糧方／出糧方式，無 PII）。
-- 純重定義 view（沿用 20261022000000_te1_triage_evidence_images 嘅定義逐字，淨係 IN 白名單加 'staff_schemes'），冇改任何資料／權限。
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
  'rate_cards', 'referral_fee_rates', 'special_items', 'month_closes',
  'staff_schemes'
)
AND table_name NOT IN (
  'guard_phones', 'guard_emergency_contacts', 'guard_addresses',
  'roster_uploads', 'roster_upload_rows', 'roster_reconcile_decisions',
  'staff_list_uploads', 'guard_fix_runs', 'month_close_runs',
  'guard_longterm_contracts', 'guard_leave_balances', 'guard_avg_wages',
  'longterm_payroll_runs', 'longterm_payroll_lines', 'longterm_payroll_inputs',
  'guard_identity_conflicts', 'triage_sessions', 'triage_questions',
  'month_close_auto_changes',
  'whatsapp_groups', 'whatsapp_messages', 'whatsapp_intents',
  'triage_evidence_images'
);
