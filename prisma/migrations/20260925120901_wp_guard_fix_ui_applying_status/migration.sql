-- WP-GUARD-FIX-UI：apply（建人＋逐盤 reparse）可能要幾分鐘——`applying`
-- 中途狀態俾 `POST /api/guard-fix/runs/:id/apply`（用 Next `after()`
-- 響應先返、背景先做）＋頁面 poll `GET /api/guard-fix/runs/:id` 用。
-- 鐵則：ALTER TYPE ... ADD VALUE IF NOT EXISTS，唔准 gen_random_uuid()／
-- RAISE／abort。
-- AlterEnum
ALTER TYPE "GuardFixRunStatus" ADD VALUE IF NOT EXISTS 'applying';
