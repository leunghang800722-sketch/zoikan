-- WP-GUARD-FIX-UI Opus 5.5 驗收：`applying` 卡死復原——記低幾時開始
-- 套用，`applying` 超過 15 分鐘（server 中途重啟／部署，`after()` 背景
-- 工作冇咗）老闆可以喺頁面撳「重新套用」（apply 本身冪等＋advisory
-- lock，安全）。純 ADD COLUMN（nullable），冇 gen_random_uuid()／RAISE／
-- abort。
-- AlterTable
ALTER TABLE "guard_fix_runs" ADD COLUMN IF NOT EXISTS "apply_started_at" TIMESTAMP(3);
