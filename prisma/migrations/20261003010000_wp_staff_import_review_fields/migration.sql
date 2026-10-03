-- WP-STAFF-IMPORT B3：證件資料批量導入——導入包有未確認（review）欄時，guard 仍照建，
-- 但喺 guards.identity_review_fields 記低「邊啲欄待核對」（例如 {name_zh}），覆核頁／抽屜顯示
-- 「姓名待核對」；人手確認後移除。純 additive、冪等、冇 backfill。`ai.guards` view 明列欄位，
-- 唔含呢個欄（AI 結構上讀唔到）。
ALTER TABLE "guards" ADD COLUMN IF NOT EXISTS "identity_review_fields" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
