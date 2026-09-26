-- WP-LTSHIFT（老闆 2026-09-26 §6／§7）：兩個獨立、互不相關嘅資料修正，
-- 一齊擺喺呢個 migration 純粹因為同一個 WP、同一次驗收，SQL 完全分開
-- 兩段、各自 idempotent（可以個別重覆跑，0 行受影響一樣算成功）。冇
-- schema 改動（`activity_proxy_site_id` 已經喺
-- 20260926110715_wp_ltshift_longterm_posts 加咗），純粹 UPDATE 現有
-- 資料，用 `canonical_name` 查 site（**唔寫死任何 uuid**——正式站同 dev
-- id 唔同，鐵則）。
--
-- ---------------------------------------------------------------------
-- §6：數碼港 CP5 IC——純月費構造盤，自己 0 條 shift_records。8 月起
-- `monthly-close.ts` 嘅「反假營業額閘」（`hasAnyRecordThisMonth`）會將
-- 佢當「完全冇活動」自動隱藏，總表有嘅 18,580.65 喺系統報表度消失。
-- 揀「proxy 盤」方案（保留 CP5 IC 獨立盤，報表照出 18,580.65；否決咗
-- 「複製 flat 卡去 CP5」方案，因為會令 CP5（per_shift 盤）多一張佢
-- 唔應該有嘅月費卡，污染咗 CP5 自己嘅收入計法）：`activity_proxy_
-- site_id` 指向「數碼港 CP5」（同一業務嘅實際更次記喺嗰度）——閘查
-- 「自己或 proxy 盤呢個月有記錄」，兩個盤其一有記錄就唔隱藏。
--
-- 淨係喺兩個盤都存在、CP5 IC 未設過 proxy 先寫（唔覆蓋人手已經設過嘅
-- 值）。
WITH target AS (
  SELECT
    ic."id" AS ic_id,
    cp5."id" AS cp5_id
  FROM "sites" ic
  JOIN "sites" cp5 ON cp5."canonical_name" = '數碼港 CP5'
  WHERE ic."canonical_name" = '數碼港 CP5 IC'
    AND ic."activity_proxy_site_id" IS NULL
),
updated AS (
  UPDATE "sites" s
  SET "activity_proxy_site_id" = t.cp5_id
  FROM target t
  WHERE s."id" = t.ic_id
  RETURNING s."id" AS site_id, t.cp5_id AS proxy_site_id
)
INSERT INTO "audit_log" ("id", "actor_user_id", "table_name", "row_id", "action", "before", "after", "ip", "created_at")
SELECT
  md5(random()::text || clock_timestamp()::text || u.site_id || 'ltshift_cp5ic_proxy')::uuid,
  NULL,
  'sites',
  u.site_id,
  'migration_set_activity_proxy_site',
  jsonb_build_object('activity_proxy_site_id', NULL),
  jsonb_build_object('activity_proxy_site_id', u.proxy_site_id, 'reason', 'WP-LTSHIFT §6：數碼港 CP5 IC 純月費構造盤，proxy 去數碼港 CP5 做活動閘判斷'),
  NULL,
  CURRENT_TIMESTAMP
FROM updated u;

-- ---------------------------------------------------------------------
-- §7：淺水灣道11號蔚峰園——7 月 flat 卡（84,193.55，effective_from=
-- 2026-07-01、effective_to=NULL 無限期）滲入 8 月，但總表 8 月口徑係
-- 逐更（92,612.90，同盤 8 月更表本身已經有逐更收客卡 935.48）。老闆
-- 2026-09-24 答過：「7 月特殊卡 8 月無就加到期」。
--
-- 呢個盤 `sites.billing_model` 本身已經係 `per_shift`（核實：唔係
-- `monthly_fixed`，同任務書原文假設嘅盤設定唔同——`monthly-close.ts`
-- 嘅 `monthlyFeeProrataRevenue()` 淨係喺 `site.billing_model=
-- 'monthly_fixed'` 先會 fallback，蔚峰園呢個盤唔會行到嗰條路；一旦
-- flat 卡唔再覆蓋 8 月，收入計法會直接跌落 `shiftAgg._sum.
-- clientRateSnapshot`——即係逐更收客價 snapshot 加總，唔使再加任何
-- mixed-billing 規則），所以呢度**淨係改呢張卡嘅 effective_to**，
-- 唔使改 `sites.billing_model`、唔使加 mixed-billing 規則（任務書
-- 原文提出嘅「核實唔會就補規則」——已核實會，唔使補）。
--
-- 條件 UPDATE：先核實（a）盤真係存在、（b）呢張 7 月 flat 卡真係
-- `effective_to IS NULL`（未改過）、（c）8 月真係有逐更收客卡覆蓋
-- （`shift_type_id IS NOT NULL`、`client_rate IS NOT NULL`、生效區間
-- 覆蓋 2026-08）先改，冇（c）就寧願保留 flat 卡唔改（避免呢個盤 8 月
-- 完全冇任何收入計法）。
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
  md5(random()::text || clock_timestamp()::text || u.card_id || 'ltshift_weifeng_flatcard')::uuid,
  NULL,
  'rate_cards',
  u.card_id,
  'migration_set_effective_to_july',
  jsonb_build_object('effective_to', NULL),
  jsonb_build_object('effective_to', '2026-07-31', 'reason', 'WP-LTSHIFT §7：蔚峰園 7 月 flat 卡滲入 8 月，8 月已有逐更收客卡，加到期日'),
  NULL,
  CURRENT_TIMESTAMP
FROM updated_card u;
