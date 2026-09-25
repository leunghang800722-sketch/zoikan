-- WP-GUARD-FIX 驗收（Opus 5.5）：對數頁「批量指定子盤／全部歸母盤確認」
-- 係人手決定，但 `reparseRosterUpload()` 會 deleteMany＋重新 createMany
-- 成個上載嘅 rows——冇呢個欄，人手揀咗嘅子盤一 reparse（例如
-- run-guard-fix.sh 修復安員之後自動 reparse 全部 8 月上載）就會冇咗，
-- 行會跌返「子盤未定」要人再揀一次。`true`＝呢行 `resolved_site_id` 係
-- 人手指定，reparse 用 (row_index, work_date, raw_code, staff_no_raw,
-- name_raw) 對返同一格並保留（見 service.ts `reparseRosterUpload()`）。
-- 純 ADD COLUMN＋DEFAULT，唔 abort、唔 backfill。

-- AlterTable
ALTER TABLE "roster_upload_rows" ADD COLUMN "resolved_site_manual" BOOLEAN NOT NULL DEFAULT false;
