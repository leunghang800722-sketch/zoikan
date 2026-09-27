-- WP-POSTORDER-PAIRS-CSV（老闆 2026-09-27 緊急）：正式站操作員連 Google
-- Sheets 匯出完整 Roster 分頁（2,996 行、760KB）都持續 503，AI 轉錄
-- 63KB CSV 又令格位錯位。加一個極精簡、人手／AI 都可以準確轉錄嘅
-- 「(盤,人) 組合＋格數」CSV（`site_label,site_short,guard_name,
-- cell_count` 四欄，約 60 行、~3KB）代替完整 Roster CSV——見
-- src/lib/guard-fix/postorder.ts `parseLongtermPairsCsv()`。
--
-- 呢個 migration 淨係加一欄 nullable Bytes，冇任何 backfill／DML，純
-- ALTER TABLE，唔會 abort。

-- AlterTable
ALTER TABLE "postorder_uploads" ADD COLUMN "longterm_pairs_csv_bytes" BYTEA;
