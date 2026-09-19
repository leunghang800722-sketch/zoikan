-- AlterTable
ALTER TABLE "guards" ADD COLUMN     "qas_expiry_date" DATE,
ADD COLUMN     "qas_issue_date" DATE;

-- AlterTable
ALTER TABLE "sites" ADD COLUMN     "guards_paid_by_client" BOOLEAN NOT NULL DEFAULT false;

-- ---------------------------------------------------------------------------
-- WP-MISC（老闆 2026-09-20 拍板，一個 migration 做晒老闆三個決定）：
--   (A) QAS（基本保安訓練證書）日期——`qas_issue_date`（完成日期）／
--       `qas_expiry_date`（到期日，如有），全部 nullable，冇 backfill
--       （來源資料未匯入，逐步由「安員」抽屜補）。
--   (C) LINK（TKO Gateway 厚A/B/C）——呢批盤嘅保安員由客戶直接出糧，
--       公司淨係收每月服務費，唔逐更計客價／工資，唔使價目卡（見
--       src/lib/pricing/unpriced.ts、resolve-rate.ts）。Backfill 淨係
--       呢三個 canonical_name（老闆原話明確列名，其他盤等老闆確認，
--       唔可以擴大範圍）。
--
-- 同 WP-STAFFNO／WP-MULTI 一致嘅刻意權衡：呢個 UPDATE 淨係用
-- `canonical_name IN (...)` 字面比對，冇任何會因為資料狀態（例如冇夾中
-- 任何一行）而 abort 嘅寫法——0 行受影響一樣算成功（正式站呢三個盤名
-- 可能未匯入／改咗名，migration 一樣要 `migrate deploy` 得過，見
-- worktree 鐵則）。重跑安全（UPDATE 冪等，第二次跑值已經係 true 唔會
-- 再變）。
-- ---------------------------------------------------------------------------
UPDATE "sites"
SET "guards_paid_by_client" = true
WHERE "canonical_name" IN ('TKO Gateway 厚A', 'TKO Gateway 厚B', 'TKO Gateway 厚C');
