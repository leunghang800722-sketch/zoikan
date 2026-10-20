-- EMP-P1：「一份個人資料＋N 張工號卡」第一期——純加欄／加表（nullable，冪等），不改任何現有資料。
-- 語意：guard_staff_numbers.valid_from＝入職日、valid_to＝離職／停用日（P1 唔回填舊行）。

-- 1. 工號卡：結束原因＋換號前身
ALTER TABLE "guard_staff_numbers" ADD COLUMN IF NOT EXISTS "end_reason" TEXT;
ALTER TABLE "guard_staff_numbers" ADD COLUMN IF NOT EXISTS "predecessor_id" TEXT;
DO $$ BEGIN
  ALTER TABLE "guard_staff_numbers" ADD CONSTRAINT "guard_staff_numbers_predecessor_id_fkey"
    FOREIGN KEY ("predecessor_id") REFERENCES "guard_staff_numbers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
CREATE INDEX IF NOT EXISTS "guard_staff_numbers_predecessor_id_idx" ON "guard_staff_numbers"("predecessor_id");

-- 2. 更次：用邊張工號卡（歸屬資訊，無金額）
ALTER TABLE "shift_records" ADD COLUMN IF NOT EXISTS "staff_number_id" TEXT;
ALTER TABLE "shift_records" ADD COLUMN IF NOT EXISTS "staff_scheme" TEXT;
ALTER TABLE "shift_records" ADD COLUMN IF NOT EXISTS "staff_number_source" TEXT;
DO $$ BEGIN
  ALTER TABLE "shift_records" ADD CONSTRAINT "shift_records_staff_number_id_fkey"
    FOREIGN KEY ("staff_number_id") REFERENCES "guard_staff_numbers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
CREATE INDEX IF NOT EXISTS "shift_records_staff_number_id_idx" ON "shift_records"("staff_number_id");

-- 3. 盤：用邊種工號（U／MP；null＝未設定）
ALTER TABLE "sites" ADD COLUMN IF NOT EXISTS "staff_scheme" TEXT;

-- 4. 已鎖月更次歸屬側表（回填專用；shift_records 鎖月後一欄都唔寫）
CREATE TABLE IF NOT EXISTS "shift_record_staff_attributions" (
  "shift_record_id" TEXT NOT NULL,
  "staff_number_id" TEXT NOT NULL,
  "staff_scheme" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "shift_record_staff_attributions_pkey" PRIMARY KEY ("shift_record_id")
);
DO $$ BEGIN
  ALTER TABLE "shift_record_staff_attributions" ADD CONSTRAINT "shift_record_staff_attributions_shift_record_id_fkey"
    FOREIGN KEY ("shift_record_id") REFERENCES "shift_records"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "shift_record_staff_attributions" ADD CONSTRAINT "shift_record_staff_attributions_staff_number_id_fkey"
    FOREIGN KEY ("staff_number_id") REFERENCES "guard_staff_numbers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
CREATE INDEX IF NOT EXISTS "shift_record_staff_attributions_staff_number_id_idx" ON "shift_record_staff_attributions"("staff_number_id");
