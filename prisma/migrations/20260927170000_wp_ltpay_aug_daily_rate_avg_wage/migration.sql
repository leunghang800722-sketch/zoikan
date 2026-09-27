-- WP-LTPAY §21 任務 4b（老闆 2026-09-26 指令）：引擎缺口補丁——(a) 日薪制
-- 長工特判（Maxwell「Rest Day No＝日薪」個案，Net Basic 改用 dailyRate×
-- workDays）；(b) 平均工資表（`guard_avg_wages`，SL 4/5／AL 離職結算派彩
-- 用；未有記錄照舊 fallback「日薪＝月薪/當月曆日數」）。純 additive，
-- 冇任何 data backfill。

-- CreateEnum
CREATE TYPE "LongtermPayBasis" AS ENUM ('monthly', 'daily');

-- AlterTable
ALTER TABLE "guard_longterm_contracts" ADD COLUMN     "daily_rate" DECIMAL(10,2),
ADD COLUMN     "pay_basis" "LongtermPayBasis" NOT NULL DEFAULT 'monthly';

-- CreateTable
CREATE TABLE "guard_avg_wages" (
    "id" TEXT NOT NULL,
    "guard_id" TEXT NOT NULL,
    "month" DATE NOT NULL,
    "avg_daily_wage" DECIMAL(10,2) NOT NULL,
    "source" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT,
    "voided_at" TIMESTAMP(3),

    CONSTRAINT "guard_avg_wages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "guard_avg_wages_guard_id_idx" ON "guard_avg_wages"("guard_id");

-- CreateIndex
CREATE UNIQUE INDEX "guard_avg_wages_guard_id_month_key" ON "guard_avg_wages"("guard_id", "month");

-- AddForeignKey
ALTER TABLE "guard_avg_wages" ADD CONSTRAINT "guard_avg_wages_guard_id_fkey" FOREIGN KEY ("guard_id") REFERENCES "guards"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
