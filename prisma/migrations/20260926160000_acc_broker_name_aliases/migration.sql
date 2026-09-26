-- 驗收（Opus 5.5，2026-09-26）：正式站嘅 brokers.aliases 冇包自己個 name——
-- WP-LTSHIFT §19 第二部分淨係喺 seed（`seedBrokers()`）補咗，全新 db:reset
-- 先有；已經上咗線嘅 DB（正式站）migrate 之後 guard-fix／介紹費費率同步嘅
-- `matchBroker()` 對唔到 Postorder「長工雞頭費 (xx)」嘅雞頭稱呼（dev 模擬
-- 「舊版先套用、後部署」實測：對唔到 3 個稱呼，介紹費得 10,000 vs 60,520）。
-- 呢度將每個雞頭自己嘅 name 加入 aliases——**唔寫死任何名／id**，純粹用
-- 同一行嘅 name 欄；name 同 code 一樣就唔加。冪等（已經有就 0 行）。
-- （Postorder 用嘅其他稱呼——private 檔 master_roster_aliases——唔可以
-- 入 git，見 scripts/opening/sync-broker-aliases.ts。）
WITH updated AS (
  UPDATE "brokers" b
  SET "aliases" = ARRAY(SELECT DISTINCT unnest(b."aliases" || ARRAY[b."name"]))
  WHERE b."name" IS NOT NULL
    AND btrim(b."name") <> ''
    AND b."name" <> b."code"
    AND NOT (b."name" = ANY(b."aliases"))
  RETURNING b."id" AS broker_id
)
INSERT INTO "audit_log" ("id", "actor_user_id", "table_name", "row_id", "action", "before", "after", "ip", "created_at")
SELECT
  md5(random()::text || clock_timestamp()::text || u.broker_id || 'acc_broker_name_alias')::uuid,
  NULL,
  'brokers',
  u.broker_id,
  'migration_add_name_to_aliases',
  NULL,
  jsonb_build_object('reason', '驗收：brokers.name 加入 aliases，令 Postorder 雞頭稱呼對得到'),
  NULL,
  CURRENT_TIMESTAMP
FROM updated u;
