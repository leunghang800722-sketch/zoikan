-- WP-PRICE（老闆 2026-09-16 拍板）：老闆確認 8 月價目同 7 月一樣，等 8 月
-- 更表可以即刻入庫先審批（唔使等逐張卡重新輸入一次 8 月版本）——將 254
-- 張 effective_to=2026-07-31 嘅卡伸長做無限期（effective_to=NULL），等
-- runtime resolver（src/lib/pricing/resolve-rate.ts）8 月都揀到呢批卡。
-- 殷樺花園 K 特別卡本身已經係 effective_to IS NULL（無限期），唔會撞入
-- 呢個 WHERE，唔受影響。已作廢（voided_at 非空）嘅卡一律唔郁。
--
-- 7 月已鎖定嘅 shift_records snapshot 唔受呢個 migration 影響——呢度淨係
-- 改 rate_cards 嘅生效範圍，唔改任何 shift_records（見 WP-PRICE §5 鐵律
-- 「唔改 7 月已鎖定記錄」；gate:reports/gate:export/report:regen 7 月
-- 0-diff 應該照過）。
WITH updated AS (
  UPDATE "rate_cards"
  SET "effective_to" = NULL
  WHERE "effective_to" = DATE '2026-07-31'
    AND "voided_at" IS NULL
  RETURNING "id"
)
INSERT INTO "audit_log" ("id", "actor_user_id", "table_name", "row_id", "action", "before", "after", "ip", "created_at")
SELECT
  'migration:20260916000000:extend_rate_cards_open_ended',
  NULL,
  'rate_cards',
  'migration:2026-09-16',
  'extend_effective_to',
  NULL,
  jsonb_build_object('count', (SELECT count(*) FROM updated)),
  NULL,
  CURRENT_TIMESTAMP;
