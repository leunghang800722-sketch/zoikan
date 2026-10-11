-- P9.1：長工糧人手輸入草稿。只新增、冪等；舊資料預設 confirmed（計糧結果不變）。
DO $$ BEGIN
  CREATE TYPE "LongtermInputStatus" AS ENUM ('draft', 'confirmed');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
ALTER TABLE "longterm_payroll_inputs" ADD COLUMN IF NOT EXISTS "status" "LongtermInputStatus" NOT NULL DEFAULT 'confirmed';
ALTER TABLE "longterm_payroll_inputs" ADD COLUMN IF NOT EXISTS "draft_source" TEXT;
ALTER TABLE "longterm_payroll_inputs" ADD COLUMN IF NOT EXISTS "draft_evidence" JSONB;
ALTER TABLE "longterm_payroll_inputs" ADD COLUMN IF NOT EXISTS "confirmed_at" TIMESTAMP(3);
ALTER TABLE "longterm_payroll_inputs" ADD COLUMN IF NOT EXISTS "confirmed_by" TEXT;
CREATE INDEX IF NOT EXISTS "longterm_payroll_inputs_month_status_idx" ON "longterm_payroll_inputs"("month", "status");

-- P9.2：AI 每日額度原子計數
CREATE TABLE IF NOT EXISTS "ai_daily_usage" (
    "user_id" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "used" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "ai_daily_usage_pkey" PRIMARY KEY ("user_id", "day")
);
