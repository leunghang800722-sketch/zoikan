-- WP-POSTORDER-CSV（老闆 2026-09-26 緊急）：正式站操作員（老闆帳號）用
-- 嘅工具處理唔到 binary（.xlsm／.xlsx），淨係可以喺 Google Drive 網頁
-- 用 Google Sheets 打開再逐個 sheet「下載為 CSV」。安員配對修復頁嘅
-- Postorder 上載要加 CSV 路徑（Roster／PostOrder 兩個 CSV），同 .xlsm
-- 路徑輸出一樣嘅解析結果——見 src/lib/guard-fix/postorder.ts。
--
-- 呢個 migration 淨係加兩欄 nullable Bytes（Roster CSV／PostOrder CSV
-- 原始 bytes），冇任何 backfill／DML，純 ALTER TABLE，唔會 abort。

-- AlterTable
ALTER TABLE "postorder_uploads" ADD COLUMN "roster_csv_bytes" BYTEA,
ADD COLUMN "postorder_csv_bytes" BYTEA;
