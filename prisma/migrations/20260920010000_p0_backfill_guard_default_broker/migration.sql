-- P0（嚴重 pre-existing bug，Opus 驗收重現）：`guards.default_broker_id`
-- IS NULL 嘅安員（長工／公司兵，93/265）——新月份「複製上月」／新增格
-- 之前冇送 `settlement_broker_id`，跌落 batch/route.ts 嘅
-- `guard.default_broker_id ?? null` fallback，令新建記錄
-- `settlement_broker_id` 都係 NULL。`buildPayrollTotals()`
-- （src/lib/reports/payroll.ts）逐 broker 查，冇雞頭嘅記錄喺糧明細
-- **完全消失**（唔止「未定价」）。前端／batch route／單筆 POST 嘅
-- fallback 鏈已經喺 code 度修好（見 src/lib/pricing/
-- settlement-broker-fallback.ts），呢個 migration 負責補返現有資料：
--
--   1. `default_broker_id IS NULL` 嘅安員，喺 `shift_records`（非作廢、
--      `settlement_broker_id` 非 null）出現最多次嘅結算單位 → 設做佢嘅
--      `default_broker_id`（同票取最近 `work_date`，再同票用 broker id
--      做穩定 tie-break）。
--   2. 完全冇非作廢記錄嘅安員，`employment_type = 'longterm_autopay'`
--      （長工）→ 設做 kind=internal_longterm 嗰個 broker（唔寫死 id／
--      code，用 kind 搵——同 settlement-broker-fallback.ts 一致）。
--   3. 其他（冇記錄、又唔係長工——例如 cash_casual／casual_event 新
--      入職未派過更嘅安員）保持 NULL，唔臆測。
--
-- 逐個被改嘅安員寫一行 `audit_log`（action=migration_backfill_
-- default_broker，before/after），等會計/老闆查得到邊個安員嘅
-- default_broker_id 係呢個 migration 補嘅、補成點。
--
-- 雞頭隔離覆核（詳細分析見 P2-版面重設計計劃.md §13）：`scopeGuardWhere()`
-- （src/lib/broker-isolation.ts）淨係喺 `isBrokerRole(session)` 為 true
-- （即 base_role="雞頭" 嘅 session）先會用 `default_broker_id = 自己
-- session 嘅 broker_id` 呢個 OR 分支擴大安員可見性。呢個 migration 淨係
-- 會將 `default_broker_id` 設做（a）kind=broker 嘅真雞頭（如果嗰個安員
-- 過往記錄嘅結算單位本身就係嗰個雞頭——即係「本來就屬於嗰個雞頭」，
-- 唔係新畀佢），或者（b）kind=internal_longterm 嘅內部結算單位（Y／
-- B07 呢類，冇雞頭 login session 用呢個 broker_id 做自己嘅
-- session.broker_id——雞頭帳號一律掛 kind=broker 嘅真判頭，見
-- scripts/seed/index.ts seedUsers()／seedRealUsers()：雞頭帳號必須有
-- broker_csv_id，對應真判頭）。所以（b）呢批唔會令任何雞頭 session
-- 多睇到人；（a）呢批本身唔算「新增可見性」——嗰個安員嘅記錄本來就
-- 已經屬於嗰個雞頭（scopeGuardWhere() 嘅另一個 OR 分支「shiftRecords.
-- some(settlementBrokerId=brokerId 或 operationalBrokerId=brokerId 且
-- site 喺白名單）」本身已經令嗰個雞頭見到呢個安員），呢度淨係將
-- `default_broker_id` 追返做同一個值，唔係擴大範圍。
--
-- 冪等／唔 abort：淨係 UPDATE `default_broker_id IS NULL` 嘅行，跑完
-- 之後呢啲行唔再係 NULL，第二次跑 WHERE 夾唔中任何行——0 行受影響
-- 一樣算成功（同 WP-MULTI／WP-STAFFNO／WP-MISC 一致嘅刻意權衡，見
-- 嗰幾個 migration 頂註解），冇任何 `gen_random_uuid()` 或者會令
-- `migrate deploy` abort 嘅寫法。
WITH guard_broker_counts AS (
  SELECT
    sr."guard_id" AS guard_id,
    sr."settlement_broker_id" AS broker_id,
    COUNT(*) AS cnt,
    MAX(sr."work_date") AS latest_date
  FROM "shift_records" sr
  WHERE sr."status" <> 'cancelled'
    AND sr."settlement_broker_id" IS NOT NULL
  GROUP BY sr."guard_id", sr."settlement_broker_id"
),
guard_top_broker AS (
  -- 出現最多次嘅結算單位；同票取最近 work_date；再同票用 broker_id
  -- 做穩定 tie-break（唔留俾查詢計劃隨機決定）。
  SELECT DISTINCT ON (guard_id)
    guard_id,
    broker_id
  FROM guard_broker_counts
  ORDER BY guard_id, cnt DESC, latest_date DESC, broker_id ASC
),
internal_longterm_broker AS (
  SELECT "id" FROM "brokers" WHERE "kind" = 'internal_longterm' ORDER BY "code" ASC LIMIT 1
),
guard_backfill AS (
  SELECT
    g."id" AS guard_id,
    COALESCE(
      gtb.broker_id,
      CASE
        WHEN g."employment_type" = 'longterm_autopay' THEN (SELECT "id" FROM internal_longterm_broker)
        ELSE NULL
      END
    ) AS new_broker_id
  FROM "guards" g
  LEFT JOIN guard_top_broker gtb ON gtb.guard_id = g."id"
  WHERE g."default_broker_id" IS NULL
),
updated AS (
  UPDATE "guards" g
  SET "default_broker_id" = gb.new_broker_id
  FROM guard_backfill gb
  WHERE g."id" = gb.guard_id
    AND gb.new_broker_id IS NOT NULL
  RETURNING g."id" AS guard_id, gb.new_broker_id AS new_broker_id
)
INSERT INTO "audit_log" ("id", "actor_user_id", "table_name", "row_id", "action", "before", "after", "ip", "created_at")
SELECT
  md5(random()::text || clock_timestamp()::text || u.guard_id::text || 'default_broker_backfill')::uuid, -- 唔用 gen_random_uuid()：PG 12 或以下冇內置
  NULL,
  'guards',
  u.guard_id,
  'migration_backfill_default_broker',
  jsonb_build_object('default_broker_id', NULL),
  jsonb_build_object('default_broker_id', u.new_broker_id),
  NULL,
  CURRENT_TIMESTAMP
FROM updated u;
