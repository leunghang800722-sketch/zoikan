-- 驗收修正（Opus 5.5，2026-09-26）：20260926170000_acc_weifeng_aug_cards
-- (a) 條件寫咗 `broker_id IS NULL`，但開盤計劃（build-aug-plan.ts）起嘅
-- 蔚峰園 8 月逐更卡係 site_shift_broker 級（`S029|0730-1930|W`／
-- `S029|1930-0730|W`，broker = W）——正式站嗰兩張卡 broker_id 唔係 null，
-- 所以 170000 (a) 會 0 行、(b) 冇 8 月收客卡又 skip，兩頭都冇修到。
-- 170000 可能已經喺正式站跑咗（checksum 唔好改），所以另起呢個
-- migration 用正確條件再做一次；兩段都係條件 UPDATE、冪等、0 行唔 abort。
--   (a) 8 月（effective_from=2026-08-01）逐更卡、guard_id null、broker 係
--       null 或者 W、更種 D 07:30／N 19:30、client_rate null → 補 935.48
--       （淨係補 null，唔覆蓋已有值）。
--   (b) 8 月已有逐更收客卡 → 7 月 flat 卡（effective_from ≤ 2026-07-31、
--       effective_to IS NULL）加 effective_to=2026-07-31。

WITH weifeng AS (
  SELECT "id" FROM "sites" WHERE "canonical_name" = '淺水灣道11號蔚峰園'
),
broker_w AS (
  SELECT "id" FROM "brokers" WHERE "code" = 'W'
),
target_cards AS (
  SELECT rc."id" AS card_id
  FROM "rate_cards" rc
  JOIN weifeng w ON rc."site_id" = w."id"
  JOIN "shift_types" st ON st."id" = rc."shift_type_id"
  WHERE rc."billing_model" = 'per_shift'
    AND rc."guard_id" IS NULL
    AND (rc."broker_id" IS NULL OR rc."broker_id" IN (SELECT "id" FROM broker_w))
    AND ((st."code" = 'D' AND st."start_time" = TIME '07:30')
      OR (st."code" = 'N' AND st."start_time" = TIME '19:30'))
    AND rc."effective_from" = DATE '2026-08-01'
    AND rc."client_rate" IS NULL
    AND rc."voided_at" IS NULL
),
updated_cards AS (
  UPDATE "rate_cards" rc
  SET "client_rate" = 935.48
  FROM target_cards t
  WHERE rc."id" = t.card_id
  RETURNING rc."id" AS card_id
)
INSERT INTO "audit_log" ("id", "actor_user_id", "table_name", "row_id", "action", "before", "after", "ip", "created_at")
SELECT
  md5(random()::text || clock_timestamp()::text || u.card_id || 'acc_weifeng_fill_client_rate_broker_fix')::uuid,
  NULL,
  'rate_cards',
  u.card_id,
  'migration_fill_client_rate',
  jsonb_build_object('clientRate', NULL),
  jsonb_build_object('clientRate', 935.48, 'reason', '驗收：淺水灣道11號蔚峰園 8 月逐更收客卡（broker W）補收客價（170000 條件漏咗 broker 級卡）'),
  NULL,
  CURRENT_TIMESTAMP
FROM updated_cards u;

WITH weifeng AS (
  SELECT "id" FROM "sites" WHERE "canonical_name" = '淺水灣道11號蔚峰園'
),
has_august_per_shift_card AS (
  SELECT 1
  FROM "rate_cards" rc, weifeng w
  WHERE rc."site_id" = w."id"
    AND rc."shift_type_id" IS NOT NULL
    AND rc."client_rate" IS NOT NULL
    AND rc."voided_at" IS NULL
    AND rc."effective_from" <= DATE '2026-08-31'
    AND (rc."effective_to" IS NULL OR rc."effective_to" >= DATE '2026-08-01')
  LIMIT 1
),
target_card AS (
  SELECT rc."id" AS card_id
  FROM "rate_cards" rc, weifeng w
  WHERE rc."site_id" = w."id"
    AND rc."shift_type_id" IS NULL
    AND rc."broker_id" IS NULL
    AND rc."guard_id" IS NULL
    AND rc."billing_model" = 'monthly_fixed'
    AND rc."effective_from" <= DATE '2026-07-31'
    AND rc."effective_to" IS NULL
    AND rc."voided_at" IS NULL
    AND EXISTS (SELECT 1 FROM has_august_per_shift_card)
),
updated_card AS (
  UPDATE "rate_cards" rc
  SET "effective_to" = DATE '2026-07-31'
  FROM target_card t
  WHERE rc."id" = t.card_id
  RETURNING rc."id" AS card_id
)
INSERT INTO "audit_log" ("id", "actor_user_id", "table_name", "row_id", "action", "before", "after", "ip", "created_at")
SELECT
  md5(random()::text || clock_timestamp()::text || u.card_id || 'acc_weifeng_closejuly_broker_fix')::uuid,
  NULL,
  'rate_cards',
  u.card_id,
  'migration_set_effective_to_july',
  jsonb_build_object('effective_to', NULL),
  jsonb_build_object('effective_to', '2026-07-31', 'reason', '驗收：蔚峰園 7 月 flat 卡加到期（170000 因 8 月卡 broker 條件漏咗而 skip）'),
  NULL,
  CURRENT_TIMESTAMP
FROM updated_card u;
