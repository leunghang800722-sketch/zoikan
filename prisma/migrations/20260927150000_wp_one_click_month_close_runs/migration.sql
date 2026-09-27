-- WP-ONE-CLICK Phase 1（老闆 2026-09-26「一鍵全月結算」，§20）：新表
-- `month_close_runs`——單一伺服器端 job 嘅執行紀錄（逐步進度＋報告）。
-- 純 CREATE TYPE／CREATE TABLE／CREATE INDEX／ADD CONSTRAINT，冇
-- gen_random_uuid()／RAISE／abort，全新表 0 行起步，冇 backfill。

-- CreateEnum
CREATE TYPE "MonthCloseRunStatus" AS ENUM ('running', 'done', 'failed');

-- CreateTable
CREATE TABLE "month_close_runs" (
    "id" TEXT NOT NULL,
    "month" DATE NOT NULL,
    "status" "MonthCloseRunStatus" NOT NULL DEFAULT 'running',
    "started_by_id" TEXT NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),
    "apply_started_at" TIMESTAMP(3),
    "current_step" TEXT,
    "steps_json" JSONB NOT NULL DEFAULT '[]',
    "report_json" JSONB,
    "error_message" TEXT,

    CONSTRAINT "month_close_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "month_close_runs_month_started_at_idx" ON "month_close_runs"("month", "started_at");

-- AddForeignKey
ALTER TABLE "month_close_runs" ADD CONSTRAINT "month_close_runs_started_by_id_fkey" FOREIGN KEY ("started_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- AI 隔離（同 `roster_uploads`／`guard_fix_runs` 一致雙重做法）：
--   (1) 呢個 migration 冇 CREATE `ai.month_close_runs` view——AI 助手結構
--       上接觸唔到呢張新表（`report_json`／`steps_json` 冇 PII，但呢個
--       表本身係財務結算流程控制表，同「安員配對修復」一致粒度，唔開
--       俾 AI 助手直接查）。
--   (2) `ai.audit_log` view 重建，喺 20260925120524_wp_guard_fix_ui_tables
--       嗰個 WHERE NOT IN 清單基礎上加返 `month_close_runs`。
-- ---------------------------------------------------------------------------
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
  'staff_list_uploads', 'guard_fix_runs', 'month_close_runs'
);
