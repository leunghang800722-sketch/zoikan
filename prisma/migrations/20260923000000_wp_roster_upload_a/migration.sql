-- CreateEnum
CREATE TYPE "RosterUploadStatus" AS ENUM ('uploaded', 'parsed', 'parse_failed', 'superseded', 'confirmed');

-- CreateEnum
CREATE TYPE "RosterUploadCodeKind" AS ENUM ('shift', 'leave', 'ot', 'marker', 'unknown');

-- CreateEnum
CREATE TYPE "RosterUploadGuardMatch" AS ENUM ('by_staff_no', 'by_name_tel', 'by_name', 'unmatched', 'ambiguous');

-- CreateTable
CREATE TABLE "roster_uploads" (
    "id" TEXT NOT NULL,
    "month" DATE NOT NULL,
    "site_id" TEXT,
    "site_name_raw" TEXT NOT NULL,
    "uploader_user_id" TEXT NOT NULL,
    "uploaded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "file_name" TEXT NOT NULL,
    "file_sha256" TEXT NOT NULL,
    "file_bytes" BYTEA NOT NULL,
    "file_size" INTEGER NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" "RosterUploadStatus" NOT NULL DEFAULT 'uploaded',
    "parse_summary" JSONB,
    "parse_error" TEXT,
    "layout_key" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT,

    CONSTRAINT "roster_uploads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roster_upload_rows" (
    "id" TEXT NOT NULL,
    "upload_id" TEXT NOT NULL,
    "row_index" INTEGER NOT NULL,
    "sub_site_name" TEXT,
    "work_date" DATE NOT NULL,
    "raw_code" TEXT NOT NULL,
    "code_kind" "RosterUploadCodeKind" NOT NULL,
    "shift_type_id" TEXT,
    "staff_no_raw" TEXT,
    "name_raw" TEXT,
    "tel_raw" TEXT,
    "rank_raw" TEXT,
    "time_raw" TEXT,
    "broker_code_raw" TEXT,
    "guard_id" TEXT,
    "guard_match" "RosterUploadGuardMatch" NOT NULL DEFAULT 'unmatched',
    "settlement_broker_id" TEXT,
    "hours" DECIMAL(5,2),
    "warnings" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "roster_upload_rows_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "roster_uploads_month_site_id_idx" ON "roster_uploads"("month", "site_id");

-- CreateIndex
CREATE INDEX "roster_upload_rows_upload_id_work_date_idx" ON "roster_upload_rows"("upload_id", "work_date");

-- AddForeignKey
ALTER TABLE "roster_uploads" ADD CONSTRAINT "roster_uploads_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "roster_uploads" ADD CONSTRAINT "roster_uploads_uploader_user_id_fkey" FOREIGN KEY ("uploader_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "roster_upload_rows" ADD CONSTRAINT "roster_upload_rows_upload_id_fkey" FOREIGN KEY ("upload_id") REFERENCES "roster_uploads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "roster_upload_rows" ADD CONSTRAINT "roster_upload_rows_shift_type_id_fkey" FOREIGN KEY ("shift_type_id") REFERENCES "shift_types"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "roster_upload_rows" ADD CONSTRAINT "roster_upload_rows_guard_id_fkey" FOREIGN KEY ("guard_id") REFERENCES "guards"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "roster_upload_rows" ADD CONSTRAINT "roster_upload_rows_settlement_broker_id_fkey" FOREIGN KEY ("settlement_broker_id") REFERENCES "brokers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- WP-ROSTER-UPLOAD Phase A（老闆 2026-09-21/23 拍板，§15）：逐盤更表檔案
-- 上載——`roster_upload_rows` 嘅 `name_raw`/`tel_raw`/`staff_no_raw` 係
-- PII（安員姓名/電話/工號原文，可能未配對成功嘅人）。AI 隔離同 WP-MULTI
-- 一致嘅雙重做法：
--   (1) `ai.*` schema 完全冇 `ai.roster_uploads`／`ai.roster_upload_rows`
--       view（呢個 migration 冇 CREATE 呢兩個 view）——`guard_lookup`／
--       `sql_select ai.*` 呢類工具結構上接觸唔到呢兩張新表本身。
--   (2) `ai.audit_log` view 重建，喺 20260919154450_wp_multi 嗰個 WHERE
--       NOT IN 清單基礎上加返 'roster_uploads'／'roster_upload_rows'，
--       等呢兩張表嘅 create/update/void 記錄（before/after 有姓名/電話/
--       工號）連 `recent_audit`／`sql_select ai.audit_log` 都讀唔到。
-- `scrub_json()` 嘅 blocked_keys 保持同 20260919154450 一致唔加減（呢個
-- WHERE 子句已經係獨立多一重防線，唔靠 key 名比對）。
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
  'roster_uploads', 'roster_upload_rows'
);
