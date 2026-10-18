-- TE-1（docs/plans/triage-evidence-crops-plan.md；Opus 條件 M1–M9／S1–S5）：分流題「覆核證據裁圖」。
-- 只存欄位裁圖（唔存成頁）、應用層 AES-256-GCM 加密（image_bytes＝密文；iv／tag 另欄）、答題即刪（見 src/lib/triage/evidence-images.ts）。
-- 全部冪等、只新增；新表放 public，**唔放 ai schema**；ai.audit_log 排除 triage_evidence_images。

CREATE TABLE IF NOT EXISTS "triage_evidence_images" (
    "id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "question_id" TEXT,
    "person_key" TEXT NOT NULL,
    "guard_id" TEXT,
    "field" TEXT NOT NULL,
    "doc_kind" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 1,
    "image_bytes" BYTEA NOT NULL,
    "iv" BYTEA NOT NULL,
    "tag" BYTEA NOT NULL,
    "enc_version" INTEGER NOT NULL DEFAULT 1,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "mime" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'batch_crops',
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "triage_evidence_images_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "triage_evidence_images_session_id_person_key_field_idx" ON "triage_evidence_images"("session_id", "person_key", "field");
CREATE INDEX IF NOT EXISTS "triage_evidence_images_expires_at_idx" ON "triage_evidence_images"("expires_at");
CREATE UNIQUE INDEX IF NOT EXISTS "triage_evidence_images_session_id_person_key_field_sha256_key" ON "triage_evidence_images"("session_id", "person_key", "field", "sha256");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'triage_evidence_images_session_id_fkey') THEN
    ALTER TABLE "triage_evidence_images" ADD CONSTRAINT "triage_evidence_images_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "triage_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AI 隔離：沿用 20261018000000_wa_w0_whatsapp_infra 嘅 view 定義（白名單＋排除清單逐字保留），淨係排除清單加 triage_evidence_images。
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
  'month_close_auto_changes',
  'whatsapp_groups', 'whatsapp_messages', 'whatsapp_intents',
  'triage_evidence_images'
);
