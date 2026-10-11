-- P8.3：鎖月後自動出齊檔案（after_lock_exports job）。只新增，冪等。
-- 同月同 kind 只得一份 current=true；重新生成時舊嗰份變 current=false（保留 1 份舊版），更舊嘅由 job 刪走。
CREATE TABLE IF NOT EXISTS "generated_files" (
    "id" TEXT NOT NULL,
    "month" DATE NOT NULL,
    "kind" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "content" BYTEA NOT NULL,
    "size" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "generated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "generated_by" TEXT NOT NULL,
    "source_locked_at" TIMESTAMP(3),
    "current" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "generated_files_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "generated_files_month_kind_generated_at_idx" ON "generated_files"("month", "kind", "generated_at" DESC);
CREATE UNIQUE INDEX IF NOT EXISTS "generated_files_current_month_kind_key" ON "generated_files"("month", "kind") WHERE "current";
