-- P3-1.3（P3 計劃 §3.1 P10／附錄 b A-10／A-11／A-20）：效能 index，只新增、冇資料搬移、冪等。
-- 刻意唔用 CONCURRENTLY：Prisma migrate 喺 transaction 入面跑，CONCURRENTLY 唔可以喺 transaction 內。
-- 各表 <50k 行，建 index 鎖表 <1 秒，可接受（見 P3 §8.1）。
-- 下面 partial index（status／special_items）Prisma schema 表達唔到，只存在於 migration（`migrate diff` 會報呢兩條為已知差異）。

-- layout 審批 badge：COUNT(*) WHERE status='pending_approval' 由全表掃改 partial index。
CREATE INDEX IF NOT EXISTS "shift_records_pending_approval_idx" ON "shift_records"("status") WHERE "status" = 'pending_approval';
CREATE INDEX IF NOT EXISTS "shift_records_settlement_broker_id_work_date_idx" ON "shift_records"("settlement_broker_id", "work_date");
CREATE INDEX IF NOT EXISTS "shift_records_parent_shift_id_idx" ON "shift_records"("parent_shift_id");

CREATE INDEX IF NOT EXISTS "audit_log_created_at_idx" ON "audit_log"("created_at" DESC);
CREATE INDEX IF NOT EXISTS "audit_log_actor_user_id_created_at_idx" ON "audit_log"("actor_user_id", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "rate_cards_site_id_shift_type_id_broker_id_effective_from_idx" ON "rate_cards"("site_id", "shift_type_id", "broker_id", "effective_from" DESC);

CREATE INDEX IF NOT EXISTS "special_items_month_kind_active_idx" ON "special_items"("month", "kind") WHERE "voided_at" IS NULL;

CREATE INDEX IF NOT EXISTS "daily_requirements_work_date_idx" ON "daily_requirements"("work_date");
