-- W0（WhatsApp 報更模組基建，docs/plans/whatsapp-roster-plan.md §3／§4／§9）：
-- whatsapp_groups／whatsapp_messages／whatsapp_intents 三張新表（只加）。
-- 全部冪等、只新增、id 由應用程式端產生、唔寫死 id。
-- 新表放 public，**唔放 ai schema**；訊息原文含 PII，ai.audit_log 排除三個 table_name。

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'WhatsappGroupKind') THEN
    CREATE TYPE "WhatsappGroupKind" AS ENUM ('site', 'multi_site', 'broker', 'office', 'ignored');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'WhatsappMessageStatus') THEN
    CREATE TYPE "WhatsappMessageStatus" AS ENUM ('received', 'filtered', 'parsed', 'routed', 'done', 'ignored', 'error', 'revoked');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'WhatsappIntentKind') THEN
    CREATE TYPE "WhatsappIntentKind" AS ENUM ('shift', 'leave', 'cover', 'cancel', 'unclear', 'question_only');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'WhatsappIntentRouted') THEN
    CREATE TYPE "WhatsappIntentRouted" AS ENUM ('auto_write', 'triage', 'ignored', 'pending');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "whatsapp_groups" (
    "id" TEXT NOT NULL,
    "group_jid" TEXT NOT NULL,
    "label" TEXT NOT NULL DEFAULT '',
    "kind" "WhatsappGroupKind" NOT NULL DEFAULT 'ignored',
    "site_id" TEXT,
    "broker_id" TEXT,
    "shift_word_map" JSONB NOT NULL DEFAULT '{}',
    "auto_write" BOOLEAN NOT NULL DEFAULT false,
    "auto_confirm" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "last_message_at" TIMESTAMPTZ(3),
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "whatsapp_groups_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "whatsapp_messages" (
    "id" TEXT NOT NULL,
    "session" TEXT NOT NULL,
    "chat_jid" TEXT NOT NULL,
    "message_id" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "sender_jid" TEXT NOT NULL,
    "sender_tel_norm" TEXT,
    "sender_guard_id" TEXT,
    "ts" TIMESTAMPTZ(3) NOT NULL,
    "text" TEXT NOT NULL DEFAULT '',
    "text_history" JSONB NOT NULL DEFAULT '[]',
    "media_type" TEXT,
    "quoted_message_id" TEXT,
    "status" "WhatsappMessageStatus" NOT NULL DEFAULT 'received',
    "ignore_reason" TEXT,
    "filter_score" INTEGER,
    "filter_reasons" JSONB NOT NULL DEFAULT '[]',
    "parsed_json" JSONB,
    "llm_provider" TEXT,
    "llm_model" TEXT,
    "llm_tokens_in" INTEGER,
    "llm_tokens_out" INTEGER,
    "error" TEXT,
    "edited_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),
    "redacted_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "whatsapp_messages_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "whatsapp_intents" (
    "id" TEXT NOT NULL,
    "message_id" TEXT NOT NULL,
    "message_revision" INTEGER NOT NULL,
    "idx" INTEGER NOT NULL,
    "kind" "WhatsappIntentKind" NOT NULL,
    "work_date" DATE,
    "site_id" TEXT,
    "guard_id" TEXT,
    "shift_type_id" TEXT,
    "leave_code" TEXT,
    "hours" DECIMAL(6,2),
    "confidence" DECIMAL(4,3),
    "resolution" JSONB NOT NULL DEFAULT '{}',
    "routed" "WhatsappIntentRouted" NOT NULL DEFAULT 'pending',
    "result_ref" TEXT,
    "source_changed" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "whatsapp_intents_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "whatsapp_groups_group_jid_key" ON "whatsapp_groups"("group_jid");
CREATE UNIQUE INDEX IF NOT EXISTS "whatsapp_messages_message_id_key" ON "whatsapp_messages"("message_id");
CREATE UNIQUE INDEX IF NOT EXISTS "whatsapp_messages_message_id_revision_key" ON "whatsapp_messages"("message_id", "revision");
CREATE INDEX IF NOT EXISTS "whatsapp_messages_chat_jid_ts_idx" ON "whatsapp_messages"("chat_jid", "ts");
CREATE INDEX IF NOT EXISTS "whatsapp_messages_status_idx" ON "whatsapp_messages"("status");
CREATE UNIQUE INDEX IF NOT EXISTS "whatsapp_intents_message_id_message_revision_idx_key" ON "whatsapp_intents"("message_id", "message_revision", "idx");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'whatsapp_groups_site_id_fkey') THEN
    ALTER TABLE "whatsapp_groups" ADD CONSTRAINT "whatsapp_groups_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'whatsapp_groups_broker_id_fkey') THEN
    ALTER TABLE "whatsapp_groups" ADD CONSTRAINT "whatsapp_groups_broker_id_fkey" FOREIGN KEY ("broker_id") REFERENCES "brokers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'whatsapp_messages_sender_guard_id_fkey') THEN
    ALTER TABLE "whatsapp_messages" ADD CONSTRAINT "whatsapp_messages_sender_guard_id_fkey" FOREIGN KEY ("sender_guard_id") REFERENCES "guards"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'whatsapp_intents_message_id_fkey') THEN
    ALTER TABLE "whatsapp_intents" ADD CONSTRAINT "whatsapp_intents_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "whatsapp_messages"("message_id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AI 隔離：沿用 20261011120000_p6_ai_audit_log_whitelist 嘅 view 定義（白名單＋舊排除清單逐字保留），
-- 淨係喺排除清單加 whatsapp_groups／whatsapp_messages／whatsapp_intents（其餘逐字唔變）。
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
  'whatsapp_groups', 'whatsapp_messages', 'whatsapp_intents'
);
