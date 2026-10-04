-- WP-AI-OPS §28.4：導入後對話式分診（triage_sessions／triage_questions）。
-- 全部冪等、唔 RAISE、唔 abort、唔用 gen_random_uuid()、唔寫死 id／工號。
-- 新表放 public，**唔放 ai schema**；evidence_json 含 PII，ai.audit_log 排除兩個 table_name。

CREATE TABLE IF NOT EXISTS "triage_sessions" (
    "id" TEXT NOT NULL,
    "source_type" TEXT NOT NULL,
    "source_ref" TEXT NOT NULL,
    "owner_user_id" TEXT NOT NULL,
    "created_by" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "stats_json" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "completed_at" TIMESTAMP(3),
    CONSTRAINT "triage_sessions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "triage_sessions_status_check" CHECK ("status" IN ('open', 'done'))
);

CREATE TABLE IF NOT EXISTS "triage_questions" (
    "id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "group_key" TEXT NOT NULL,
    "sort" INTEGER NOT NULL DEFAULT 0,
    "title" TEXT NOT NULL,
    "evidence_json" JSONB NOT NULL DEFAULT '{}',
    "options_json" JSONB NOT NULL DEFAULT '[]',
    "impact_json" JSONB,
    "status" TEXT NOT NULL DEFAULT 'open',
    "answer_json" JSONB,
    "answered_by" TEXT,
    "answered_at" TIMESTAMP(3),
    "apply_result_json" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "triage_questions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "triage_questions_status_check" CHECK ("status" IN ('open', 'answered', 'skipped'))
);

CREATE UNIQUE INDEX IF NOT EXISTS "triage_sessions_source_type_source_ref_key" ON "triage_sessions"("source_type", "source_ref");
CREATE INDEX IF NOT EXISTS "triage_sessions_owner_user_id_status_idx" ON "triage_sessions"("owner_user_id", "status");
CREATE UNIQUE INDEX IF NOT EXISTS "triage_questions_session_id_group_key_key" ON "triage_questions"("session_id", "group_key");
CREATE INDEX IF NOT EXISTS "triage_questions_session_id_status_sort_idx" ON "triage_questions"("session_id", "status", "sort");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'triage_sessions_owner_user_id_fkey') THEN
    ALTER TABLE "triage_sessions" ADD CONSTRAINT "triage_sessions_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'triage_questions_session_id_fkey') THEN
    ALTER TABLE "triage_questions" ADD CONSTRAINT "triage_questions_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "triage_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

-- AI 隔離：沿用 20261003000000_wp_staff_import_identity 嘅 view 定義，淨係喺排除
-- 清單加 triage_sessions／triage_questions（其餘逐字唔變）。
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
  'guard_identity_conflicts', 'triage_sessions', 'triage_questions'
);
