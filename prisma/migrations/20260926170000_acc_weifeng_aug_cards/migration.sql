-- 驗收修正（2026-09-26，同 branch）：正式站唔准有任何 Terminal 步驟
-- （老闆指令：全部要喺 app 撳掣，`run-round2.sh` 呢類本機 script 唔可以
-- 喺正式站跑）。淺水灣道11號蔚峰園 8 月價卡本來靠 `run-round2.sh`
-- （`build-aug-plan.ts`＋`apply-aug-plan.ts`）喺正式站部署之後、老闆本機
-- 手動跑先修好——而家改為呢個 migration，`prisma migrate deploy`
-- 部署嗰陣自動做晒，唔使再跑任何 script。
--
-- 背景（同 20260926120000_wp_ltshift_cp5ic_proxy_weifeng_flatcard §7
-- 一致嘅問題，嗰個 migration 靠「8 月已有逐更收客卡（client_rate 唔係
-- null）」先幫 7 月 flat 卡加到期——但正式站舊版開盤起呢張 8 月逐更卡
-- 嗰陣「flat 收入盤唔起逐更收客」規則將 client_rate strip 咗，卡雖然
-- 存在、但 client_rate=null，令 20260926120000 嗰段 §7 邏輯喺正式站
-- 實際部署時會 skip（0 行）——8 月逐更收客卡冇价、7 月 flat 卡又冇到期，
-- 兩頭都錯）：試算 `price_site_time_broker.json` 核實
-- `S029|0730-1930|W`／`S029|1930-0730|W` 嘅 E=935.483871（→935.48，
-- D／N 兩張一樣）、F=850（出街价，呢度唔郁）。
--
-- 呢個 migration 兩段都係條件 UPDATE、冪等（可以個別重覆跑，0 行受影響
-- 一樣算成功，唔 abort）：
--   (a) 补收客价：8 月（effective_from=2026-08-01）逐更收客卡
--       client_rate 係 null → 補 935.48（D／N 逐張），淨係補 null、
--       唔覆蓋已有值。
--   (b) 7 月 flat 卡加到期：跟住 (a) 之後，8 月逐更卡已經有 client_rate
--       （唔理係呢度先補、定之前 20260926120000 已經成功過）→ 7 月
--       flat 卡（84,193.55，effective_to IS NULL）加
--       effective_to=2026-07-31（同 20260926120000 §7 一樣嘅條件，
--       呢度做多一次安全網，避免兩個 migration 部署次序或者中途失敗
--       令 7 月卡冇加到期）。

-- ---------------------------------------------------------------------
-- (a) 補 8 月逐更收客卡 client_rate（D／N 逐張，淨係補 null）
-- ---------------------------------------------------------------------
WITH weifeng AS (
  SELECT "id" FROM "sites" WHERE "canonical_name" = '淺水灣道11號蔚峰園'
),
target_cards AS (
  SELECT rc."id" AS card_id
  FROM "rate_cards" rc, weifeng w
  WHERE rc."site_id" = w."id"
    AND rc."shift_type_id" IS NOT NULL
    AND rc."billing_model" = 'per_shift'
    AND rc."broker_id" IS NULL
    AND rc."guard_id" IS NULL
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
  md5(random()::text || clock_timestamp()::text || u.card_id || 'acc_weifeng_fill_client_rate')::uuid,
  NULL,
  'rate_cards',
  u.card_id,
  'migration_fill_client_rate',
  jsonb_build_object('clientRate', NULL),
  jsonb_build_object('clientRate', 935.48, 'reason', '驗收：淺水灣道11號蔚峰園 8 月逐更收客卡補收客價（正式站舊版開盤起卡時冇价）'),
  NULL,
  CURRENT_TIMESTAMP
FROM updated_cards u;

-- ---------------------------------------------------------------------
-- (b) 7 月 flat 卡加到期（8 月逐更卡已經有 client_rate 先做，同
--     20260926120000 §7 一樣嘅條件，做多一次安全網）
-- ---------------------------------------------------------------------
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
  md5(random()::text || clock_timestamp()::text || u.card_id || 'acc_weifeng_closejuly_safety_net')::uuid,
  NULL,
  'rate_cards',
  u.card_id,
  'migration_set_effective_to_july',
  jsonb_build_object('effective_to', NULL),
  jsonb_build_object('effective_to', '2026-07-31', 'reason', '驗收：蔚峰園 7 月 flat 卡加到期（安全網，補 20260926120000 §7 喺正式站因 client_rate 未補而 skip 嘅情況）'),
  NULL,
  CURRENT_TIMESTAMP
FROM updated_card u;
