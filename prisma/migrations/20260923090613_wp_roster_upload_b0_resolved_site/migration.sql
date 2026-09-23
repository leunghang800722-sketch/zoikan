-- WP-ROSTER-UPLOAD Phase B-0（§15.3 第 3 項）：一檔多子盤（城巴車廠 9 個
-- 子盤／CP5 夾數據中心）逐格「解析後實際盤」——nullable，冇資料搬遷／
-- backfill（全新欄，0 行起步，現有行一律 null，之後 reparse 先補）。
-- AlterTable
ALTER TABLE "roster_upload_rows" ADD COLUMN     "resolved_site_id" TEXT;

-- AddForeignKey
ALTER TABLE "roster_upload_rows" ADD CONSTRAINT "roster_upload_rows_resolved_site_id_fkey" FOREIGN KEY ("resolved_site_id") REFERENCES "sites"("id") ON DELETE SET NULL ON UPDATE CASCADE;
