-- WP-BOSS5 §25.2（老闆 2026-09-28 決定 2）：Y 唔可以做介紹雞頭。
-- `guards.referral_broker_id` 指向 `brokers.kind = 'internal_cash'`（例如
-- 代號 Y）嘅一律清 null，逐行寫 audit_log（action
-- `migration_clear_internal_referral`，before/after 淨係 broker code／
-- guard id，冇真名/工號/電話/銀行號碼）。純資料修正、條件 UPDATE、
-- 冪等（已經清咗嘅唔會再撞 target_guards）、0 行唔 abort、唔寫死任何
-- id（全部用 `kind` 判斷）。
WITH target_guards AS (
  SELECT g."id" AS guard_id, b."code" AS broker_code
  FROM "guards" g
  JOIN "brokers" b ON b."id" = g."referral_broker_id"
  WHERE b."kind" = 'internal_cash'
),
updated_guards AS (
  UPDATE "guards" g
  SET "referral_broker_id" = NULL
  FROM target_guards t
  WHERE g."id" = t.guard_id
  RETURNING g."id" AS guard_id
)
INSERT INTO "audit_log" ("id", "actor_user_id", "table_name", "row_id", "action", "before", "after", "ip", "created_at")
SELECT
  md5(random()::text || clock_timestamp()::text || u.guard_id || 'wp_boss5_clear_internal_referral')::uuid,
  NULL,
  'guards',
  u.guard_id,
  'migration_clear_internal_referral',
  jsonb_build_object('referral_broker_code', t.broker_code),
  jsonb_build_object('referral_broker_id', NULL, 'reason', '老闆 2026-09-28 決定：介紹雞頭唔可以係內部現金結算單位（Y），migration 自動清空'),
  NULL,
  CURRENT_TIMESTAMP
FROM updated_guards u
JOIN target_guards t ON t.guard_id = u.guard_id;
