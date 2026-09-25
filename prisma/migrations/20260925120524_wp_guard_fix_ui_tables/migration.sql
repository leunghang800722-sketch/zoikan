-- WP-GUARD-FIX-UI（老闆 2026-09-25 要求）：「未配對安員修復」做入系統
-- （老闆手機撳兩下）——`staff_list_uploads`（U Team 名單上載，同
-- `roster_uploads` 一致「存 bytes＋摘要，唔另存逐行 PII」模式）、
-- `guard_fix_runs`（一次「計劃／套用」，`plan_json` 帶 PII、
-- `summary_json`／`result_json` 淨係數目）。純 CREATE TABLE／CREATE
-- ENUM／CREATE INDEX／ADD CONSTRAINT，冇 gen_random_uuid()／RAISE／
-- abort。

-- CreateEnum
CREATE TYPE "StaffListUploadStatus" AS ENUM ('parsed', 'parse_failed');

-- CreateEnum
CREATE TYPE "GuardFixRunStatus" AS ENUM ('planned', 'applied', 'failed');

-- CreateTable
CREATE TABLE "staff_list_uploads" (
    "id" TEXT NOT NULL,
    "uploader_id" TEXT NOT NULL,
    "uploaded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "file_name" TEXT NOT NULL,
    "file_sha256" TEXT NOT NULL,
    "file_bytes" BYTEA NOT NULL,
    "file_size" INTEGER NOT NULL,
    "row_count" INTEGER NOT NULL,
    "status" "StaffListUploadStatus" NOT NULL DEFAULT 'parsed',
    "parse_summary" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "staff_list_uploads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "guard_fix_runs" (
    "id" TEXT NOT NULL,
    "month" DATE NOT NULL,
    "staff_list_upload_id" TEXT NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "plan_json" JSONB NOT NULL,
    "summary_json" JSONB NOT NULL,
    "status" "GuardFixRunStatus" NOT NULL DEFAULT 'planned',
    "applied_at" TIMESTAMP(3),
    "result_json" JSONB,

    CONSTRAINT "guard_fix_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "staff_list_uploads_status_uploaded_at_idx" ON "staff_list_uploads"("status", "uploaded_at");

-- CreateIndex
CREATE INDEX "guard_fix_runs_month_created_at_idx" ON "guard_fix_runs"("month", "created_at");

-- AddForeignKey
ALTER TABLE "staff_list_uploads" ADD CONSTRAINT "staff_list_uploads_uploader_id_fkey" FOREIGN KEY ("uploader_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guard_fix_runs" ADD CONSTRAINT "guard_fix_runs_staff_list_upload_id_fkey" FOREIGN KEY ("staff_list_upload_id") REFERENCES "staff_list_uploads"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guard_fix_runs" ADD CONSTRAINT "guard_fix_runs_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- AI 隔離（同 `roster_uploads`／`roster_upload_rows` 一致雙重做法）：
--   (1) 呢個 migration 冇 CREATE `ai.staff_list_uploads`／
--       `ai.guard_fix_runs` view——AI 助手結構上接觸唔到呢兩張新表
--       本身（`plan_json` 帶姓名/電話/身份證/候選 guardId）。
--   (2) `ai.audit_log` view 重建，喺 20260924051723_wp_roster_upload_b1_
--       reconcile 嗰個 WHERE NOT IN 清單基礎上加返呢兩張表——create/
--       update audit 記錄（`plan_json`／`result_json`）連
--       `recent_audit`／`sql_select ai.audit_log` 都讀唔到。
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
  'staff_list_uploads', 'guard_fix_runs'
);
