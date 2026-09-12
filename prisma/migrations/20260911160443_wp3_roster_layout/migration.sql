-- P1-WP3：sites.roster_layout——更表版面模板（見
-- src/lib/roster-layout-template.ts、scripts/seed/lib/roster-layout.ts、
-- src/lib/roster-export.ts）。由 seed 時由 data/ 讀出反推寫入，匯出用嚟
-- 出到同原檔一致嘅 block 分組／橫額／表頭裝飾字；null=未有模板，匯出
-- 跌返用 generic 邏輯。
-- AlterTable
ALTER TABLE "sites" ADD COLUMN     "roster_layout" JSONB;
