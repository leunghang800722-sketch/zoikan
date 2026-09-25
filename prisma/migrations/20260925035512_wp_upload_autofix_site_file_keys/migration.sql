-- WP-UPLOAD-AUTOFIX 個案 1（P2-版面重設計計劃.md §17.11）：更表上載完全
-- 自動、唔准要人手補救。「CTB 6907」檔案內盤名格寫「城巴車廠」但實際係
-- 「創富廠IC」呢個獨立盤，檔內盤名對照冇得分辨（同「城巴車廠」主檔撞
-- 名），要加一個「更表檔名鍵」畀盤，上載時檔名優先於檔內盤名。

-- AlterTable
ALTER TABLE "sites" ADD COLUMN "roster_file_keys" TEXT[] NOT NULL DEFAULT '{}';

-- Backfill：「創富廠IC」加返「CTB 6907」呢條檔名鍵——冇呢個盤（例如新
-- clone／CI 環境未 seed）就 0 行，唔 abort。
UPDATE "sites"
SET "roster_file_keys" = ARRAY['CTB 6907']
WHERE "canonical_name" = '創富廠IC'
  AND NOT ('CTB 6907' = ANY("roster_file_keys"));
