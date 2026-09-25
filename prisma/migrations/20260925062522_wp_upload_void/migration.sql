-- WP-UPLOAD-VOID（老闆 2026-09-25 要求）：更表上載記錄「作廢」——唔
-- hard delete（file_bytes／roster_upload_rows／roster_reconcile_
-- decisions 全部留底），加 `voided` 狀態＋作廢人/時間/原因三個欄。
-- 鐵則：enum 加值用 ALTER TYPE … ADD VALUE IF NOT EXISTS（唔准 gen_
-- random_uuid()／RAISE／abort）。

-- AlterEnum
ALTER TYPE "RosterUploadStatus" ADD VALUE IF NOT EXISTS 'voided';

-- AlterTable
ALTER TABLE "roster_uploads" ADD COLUMN     "void_reason" TEXT,
ADD COLUMN     "voided_at" TIMESTAMP(3),
ADD COLUMN     "voided_by" TEXT;
