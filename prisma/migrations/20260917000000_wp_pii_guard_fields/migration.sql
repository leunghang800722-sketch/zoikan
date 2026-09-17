-- WP-PII（老闆 2026-09-17 拍板）：保安員個人資料欄位——身份證、出生日期、
-- 地址、緊急聯絡人、牌照（號碼／類別，到期日 sia_permit_expiry 已有）、
-- 平安卡（號碼／到期日）、入職／離職日期、銀行戶口、Blacklist check
-- 結果／日期。全部 nullable，唔逼舊記錄一次過填晒。
--
-- 唔存文件掃描檔（老闆決定2）——呢個 migration 淨係加抽取出嚟嘅結構化
-- 欄，冇任何檔案/blob 欄。
--
-- `ai.guards` view（prisma/migrations/20260912130100_wp_ai1_readonly_
-- schema）明列欄位，唔用 SELECT * ——呢 16 個新欄一律唔喺嗰個 view 出現，
-- 唔使改嗰個 migration（見 tests/wp-pii-ai-guards-view-structural.test.ts
-- 斷言）。
ALTER TABLE "guards"
  ADD COLUMN "hkid" TEXT,
  ADD COLUMN "date_of_birth" DATE,
  ADD COLUMN "address" TEXT,
  ADD COLUMN "emergency_contact_name" TEXT,
  ADD COLUMN "emergency_contact_tel" TEXT,
  ADD COLUMN "sia_permit_no" TEXT,
  ADD COLUMN "sia_permit_type" TEXT,
  ADD COLUMN "safety_card_no" TEXT,
  ADD COLUMN "safety_card_expiry" DATE,
  ADD COLUMN "hire_date" DATE,
  ADD COLUMN "leave_date" DATE,
  ADD COLUMN "bank_name" TEXT,
  ADD COLUMN "bank_account_no" TEXT,
  ADD COLUMN "bank_payee_name" TEXT,
  ADD COLUMN "blacklist_check_result" TEXT,
  ADD COLUMN "blacklist_check_date" DATE;
