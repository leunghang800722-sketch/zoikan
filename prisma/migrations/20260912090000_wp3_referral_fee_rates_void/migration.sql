-- P1-WP3（E）：referral_fee_rates 補「只作廢冇刪除」欄（同 quotas/rate_cards
-- 等主數據表一致 pattern）——CRUD API（GET/POST /api/referral-fee-rates、
-- PATCH/void/unvoid /api/referral-fee-rates/:id）先做得到 void/unvoid。
-- init migration 已經幫呢個表開咗 partial unique index
-- referral_fee_rates_broker_month_default_key（見 20260911142332_init
-- migration.sql 底部手寫 SQL 一節），呢度唔重複、唔改動嗰個 migration。
ALTER TABLE "referral_fee_rates" ADD COLUMN "voided_at" TIMESTAMP(3);
ALTER TABLE "referral_fee_rates" ADD COLUMN "voided_by" TEXT;
