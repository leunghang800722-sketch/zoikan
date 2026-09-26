-- WP-LTSHIFT（老闆 2026-09-26）：長工崗位盤資料表——見 prisma/schema.prisma
-- GuardLongtermPost 大註解。呢個 migration 加表＋兩個 nullable FK
-- （referral_broker_id／visa_sponsored_by_broker_id 喺 guards；
-- activity_proxy_site_id 喺 sites，§6 用），再喺尾段用 SQL join 由 7 月
-- `shift_records` 嘅 `internal_longterm` 結算單位反推 backfill 一批
-- `source='july_backfill'` 嘅崗位記錄——**唔涉及任何硬編碼 guard／site
-- uuid**（正式站同 dev id 唔同，鐵則），淨係用 broker.kind 同日期範圍
-- 篩選。冪等：`WHERE NOT EXISTS` 擋重複套用（第二次跑 0 行）。

-- CreateEnum
CREATE TYPE "GuardLongtermPostSource" AS ENUM ('manual', 'july_backfill', 'inferred');

-- AlterTable
ALTER TABLE "guards" ADD COLUMN     "referral_broker_id" TEXT,
ADD COLUMN     "visa_sponsored_by_broker_id" TEXT;

-- AlterTable
ALTER TABLE "sites" ADD COLUMN     "activity_proxy_site_id" TEXT;

-- CreateTable
CREATE TABLE "guard_longterm_posts" (
    "id" TEXT NOT NULL,
    "guard_id" TEXT NOT NULL,
    "site_id" TEXT NOT NULL,
    "effective_from" DATE NOT NULL,
    "effective_to" DATE,
    "source" "GuardLongtermPostSource" NOT NULL DEFAULT 'manual',
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT,
    "voided_at" TIMESTAMP(3),
    "voided_by" TEXT,

    CONSTRAINT "guard_longterm_posts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "guard_longterm_posts_guard_id_idx" ON "guard_longterm_posts"("guard_id");

-- CreateIndex
CREATE INDEX "guard_longterm_posts_site_id_idx" ON "guard_longterm_posts"("site_id");

-- AddForeignKey
ALTER TABLE "guard_longterm_posts" ADD CONSTRAINT "guard_longterm_posts_guard_id_fkey" FOREIGN KEY ("guard_id") REFERENCES "guards"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guard_longterm_posts" ADD CONSTRAINT "guard_longterm_posts_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guards" ADD CONSTRAINT "guards_referral_broker_id_fkey" FOREIGN KEY ("referral_broker_id") REFERENCES "brokers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guards" ADD CONSTRAINT "guards_visa_sponsored_by_broker_id_fkey" FOREIGN KEY ("visa_sponsored_by_broker_id") REFERENCES "brokers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sites" ADD CONSTRAINT "sites_activity_proxy_site_id_fkey" FOREIGN KEY ("activity_proxy_site_id") REFERENCES "sites"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Backfill：7 月 shift_records 入面 settlement_broker.kind='internal_longterm'
-- 嘅 (guard, site) 組合 → 一行 guard_longterm_posts（source=july_backfill）。
-- effective_from 取嗰個組合喺 7 月最早嘅 work_date（唔用寫死日期，跟
-- 資料本身），effective_to 留 null（現時生效，供 8 月起判斷用）。
-- WHERE NOT EXISTS 防重複套用；`ON CONFLICT` 唔啱用（呢張表冇 unique
-- (guard_id, site_id) constraint——一個長工可以喺同一盤有幾段歷史）。
-- ---------------------------------------------------------------------------
WITH july_internal_longterm_pairs AS (
  SELECT
    sr."guard_id" AS guard_id,
    sr."site_id" AS site_id,
    MIN(sr."work_date") AS effective_from
  FROM "shift_records" sr
  JOIN "brokers" b ON b."id" = sr."settlement_broker_id"
  WHERE sr."status" <> 'cancelled'
    AND b."kind" = 'internal_longterm'
    AND sr."work_date" >= DATE '2026-07-01'
    AND sr."work_date" < DATE '2026-08-01'
  GROUP BY sr."guard_id", sr."site_id"
),
inserted AS (
  INSERT INTO "guard_longterm_posts"
    ("id", "guard_id", "site_id", "effective_from", "effective_to", "source", "note", "created_at", "updated_at", "created_by")
  SELECT
    md5(random()::text || clock_timestamp()::text || p.guard_id || p.site_id || 'ltshift_july_backfill')::uuid, -- 唔用 gen_random_uuid()：PG 12 或以下冇內置
    p.guard_id,
    p.site_id,
    p.effective_from,
    NULL,
    'july_backfill'::"GuardLongtermPostSource",
    '由 7 月 shift_records 結算單位=internal_longterm 反推（WP-LTSHIFT migration backfill）',
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP,
    NULL
  FROM july_internal_longterm_pairs p
  WHERE NOT EXISTS (
    SELECT 1 FROM "guard_longterm_posts" glp
    WHERE glp."guard_id" = p.guard_id
      AND glp."site_id" = p.site_id
      AND glp."voided_at" IS NULL
  )
  RETURNING "id" AS post_id, "guard_id" AS guard_id, "site_id" AS site_id
)
INSERT INTO "audit_log" ("id", "actor_user_id", "table_name", "row_id", "action", "before", "after", "ip", "created_at")
SELECT
  md5(random()::text || clock_timestamp()::text || i.post_id || 'ltshift_backfill_audit')::uuid,
  NULL,
  'guard_longterm_posts',
  i.post_id,
  'migration_backfill_july_longterm_post',
  NULL,
  jsonb_build_object('guard_id', i.guard_id, 'site_id', i.site_id, 'source', 'july_backfill'),
  NULL,
  CURRENT_TIMESTAMP
FROM inserted i;
