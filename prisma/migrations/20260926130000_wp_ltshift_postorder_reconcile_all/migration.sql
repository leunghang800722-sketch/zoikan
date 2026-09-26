-- WP-LTSHIFT §19（老闆 2026-09-26 第二部分）：Postorder 上載表（同
-- `staff_list_uploads` 一致嘅存 bytes＋摘要模式，冇逐行 PII）＋「重新對數
-- 全月」執行紀錄表（同 `guard_fix_runs` 一致嘅背景工作／卡死復原設計）。
-- 淨係加表／加 nullable FK 欄，冇任何資料改動，冪等（重跑一次 CREATE
-- TABLE IF NOT EXISTS 唔啱用喺 prisma migration，但呢個 migration 本身
-- 冇 backfill，`prisma migrate deploy` 只會執行一次，唔會重複跑）。
-- CreateEnum
CREATE TYPE "PostorderUploadStatus" AS ENUM ('parsed', 'parse_failed');

-- CreateEnum
CREATE TYPE "ReconcileAllRunStatus" AS ENUM ('running', 'done', 'failed');

-- AlterTable
ALTER TABLE "guard_fix_runs" ADD COLUMN     "postorder_upload_id" TEXT;

-- CreateTable
CREATE TABLE "postorder_uploads" (
    "id" TEXT NOT NULL,
    "month" DATE NOT NULL,
    "uploader_id" TEXT NOT NULL,
    "uploaded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "file_name" TEXT NOT NULL,
    "file_sha256" TEXT NOT NULL,
    "file_bytes" BYTEA NOT NULL,
    "file_size" INTEGER NOT NULL,
    "row_count" INTEGER NOT NULL,
    "status" "PostorderUploadStatus" NOT NULL DEFAULT 'parsed',
    "parse_summary" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "postorder_uploads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reconcile_all_runs" (
    "id" TEXT NOT NULL,
    "month" DATE NOT NULL,
    "status" "ReconcileAllRunStatus" NOT NULL DEFAULT 'running',
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_by_id" TEXT NOT NULL,
    "finished_at" TIMESTAMP(3),
    "result_json" JSONB,
    "error_message" TEXT,

    CONSTRAINT "reconcile_all_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "postorder_uploads_month_status_uploaded_at_idx" ON "postorder_uploads"("month", "status", "uploaded_at");

-- CreateIndex
CREATE INDEX "reconcile_all_runs_month_started_at_idx" ON "reconcile_all_runs"("month", "started_at");

-- AddForeignKey
ALTER TABLE "postorder_uploads" ADD CONSTRAINT "postorder_uploads_uploader_id_fkey" FOREIGN KEY ("uploader_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guard_fix_runs" ADD CONSTRAINT "guard_fix_runs_postorder_upload_id_fkey" FOREIGN KEY ("postorder_upload_id") REFERENCES "postorder_uploads"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reconcile_all_runs" ADD CONSTRAINT "reconcile_all_runs_started_by_id_fkey" FOREIGN KEY ("started_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
