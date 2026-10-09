-- WP-ONE-CLICK-AUTO（§31）：一鍵結算自動改動流水帳（undo-auto 用）。
-- 全部冪等（IF NOT EXISTS／CREATE OR REPLACE）、唔 abort、id 由應用層產生（冇 DB 端隨機 uuid 預設值）、唔寫死 id／工號。
-- 新表放 public，**唔放 ai schema**；ai.audit_log 排除 month_close_auto_changes。

CREATE TABLE IF NOT EXISTS "month_close_auto_changes" (
    "id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "ref_table" TEXT,
    "ref_id" TEXT,
    "summary" TEXT NOT NULL,
    "detail_json" JSONB NOT NULL DEFAULT '{}',
    "undoable" BOOLEAN NOT NULL DEFAULT true,
    "status" TEXT NOT NULL DEFAULT 'applied',
    "undo_note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "undone_at" TIMESTAMP(3),
    "undone_by" TEXT,
    CONSTRAINT "month_close_auto_changes_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "month_close_auto_changes_status_check" CHECK ("status" IN ('applied', 'undone', 'undo_skipped'))
);

CREATE INDEX IF NOT EXISTS "month_close_auto_changes_run_id_kind_idx" ON "month_close_auto_changes"("run_id", "kind");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'month_close_auto_changes_run_id_fkey') THEN
    ALTER TABLE "month_close_auto_changes" ADD CONSTRAINT "month_close_auto_changes_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "month_close_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

-- AI 隔離：沿用 20261004000000_wp_ai_ops_triage 嘅 view 定義，淨係喺排除清單加
-- month_close_auto_changes（其餘逐字唔變）。
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
  'longterm_payroll_runs', 'longterm_payroll_lines', 'longterm_payroll_inputs',
  'guard_identity_conflicts', 'triage_sessions', 'triage_questions',
  'month_close_auto_changes'
);
