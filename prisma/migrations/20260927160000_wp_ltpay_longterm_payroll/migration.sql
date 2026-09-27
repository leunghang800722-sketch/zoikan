-- WP-LTPAY Phase 2（老闆 2026-09-26 指令；§14 規則 9／§20.4 Phase 2）：
-- 長工月薪糧（Maxwell 口徑，跟 8 月試算第十三版）。純 additive，冇任何
-- data backfill（呢個係全新功能，冇現有資料要搬）。五張新表＋`guards.
-- probation_months` 一個新欄。PII：薪金／MPF 相關表全部用系統最嚴 PII
-- 組「安員銀行資料」gate（見 src/lib/rbac/matrix.ts 新 module「長工糧」），
-- 呢啲新表**唔加入**任何 `ai` schema view（AI 助手結構上讀唔到）。

-- CreateEnum
CREATE TYPE "LongtermMpfExemptReason" AS ENUM ('none', 'over65', 'under60days', 'auto');

-- CreateEnum
CREATE TYPE "LongtermContractSource" AS ENUM ('maxwell_import', 'manual');

-- CreateEnum
CREATE TYPE "LongtermPayrollRunStatus" AS ENUM ('draft', 'computed', 'confirmed', 'void');

-- CreateEnum
CREATE TYPE "LongtermPayrollInputKind" AS ENUM ('special_allowance', 'other_allowance', 'uniform', 'deduction', 'leave', 'contract_change', 'leaver_settlement');

-- AlterTable
ALTER TABLE "guards" ADD COLUMN     "probation_months" INTEGER;

-- CreateTable
CREATE TABLE "guard_longterm_contracts" (
    "id" TEXT NOT NULL,
    "guard_id" TEXT NOT NULL,
    "effective_from" DATE NOT NULL,
    "effective_to" DATE,
    "monthly_salary" DECIMAL(12,2) NOT NULL,
    "post_site_id" TEXT,
    "rest_day_paid" BOOLEAN NOT NULL DEFAULT true,
    "rest_day_rate" DECIMAL(10,2),
    "shift_hours" DECIMAL(5,2),
    "probation_months" INTEGER,
    "annual_leave_days" DECIMAL(5,2) NOT NULL DEFAULT 7,
    "statutory_holiday_paid_from" TEXT NOT NULL DEFAULT 'immediate',
    "mpf_exempt_reason" "LongtermMpfExemptReason" NOT NULL DEFAULT 'auto',
    "note" TEXT,
    "source" "LongtermContractSource" NOT NULL DEFAULT 'manual',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT,
    "voided_at" TIMESTAMP(3),
    "voided_by" TEXT,

    CONSTRAINT "guard_longterm_contracts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "guard_leave_balances" (
    "id" TEXT NOT NULL,
    "guard_id" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "al_entitled" DECIMAL(6,2) NOT NULL DEFAULT 0,
    "al_taken" DECIMAL(6,2) NOT NULL DEFAULT 0,
    "al_carry" DECIMAL(6,2) NOT NULL DEFAULT 0,
    "sl_accrued" DECIMAL(6,2) NOT NULL DEFAULT 0,
    "sl_taken" DECIMAL(6,2) NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "guard_leave_balances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "longterm_payroll_runs" (
    "id" TEXT NOT NULL,
    "month" DATE NOT NULL,
    "status" "LongtermPayrollRunStatus" NOT NULL DEFAULT 'draft',
    "totals_json" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT,
    "confirmed_at" TIMESTAMP(3),
    "confirmed_by" TEXT,
    "voided_at" TIMESTAMP(3),
    "voided_by" TEXT,

    CONSTRAINT "longterm_payroll_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "longterm_payroll_lines" (
    "id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "guard_id" TEXT NOT NULL,
    "contract_snapshot" JSONB NOT NULL,
    "days_in_month" INTEGER NOT NULL,
    "work_days" INTEGER NOT NULL DEFAULT 0,
    "net_basic" DECIMAL(12,2) NOT NULL,
    "ot_hours" DECIMAL(8,2) NOT NULL DEFAULT 0,
    "ot_amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "rest_day_payment" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "npsh" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "npl_days" DECIMAL(6,2) NOT NULL DEFAULT 0,
    "npsl_days" DECIMAL(6,2) NOT NULL DEFAULT 0,
    "deduction" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "special_allowance" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "other_allowance" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "al_payment" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "sl_45_amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "gross" DECIMAL(12,2) NOT NULL,
    "mpf_ee" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "mpf_er" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "autopay" DECIMAL(12,2) NOT NULL,
    "notes_json" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "longterm_payroll_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "longterm_payroll_inputs" (
    "id" TEXT NOT NULL,
    "month" DATE NOT NULL,
    "guard_id" TEXT NOT NULL,
    "kind" "LongtermPayrollInputKind" NOT NULL,
    "amount" DECIMAL(12,2),
    "date_from" VARCHAR(10),
    "date_to" VARCHAR(10),
    "doctor_note_verified" BOOLEAN,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT,
    "voided_at" TIMESTAMP(3),
    "voided_by" TEXT,

    CONSTRAINT "longterm_payroll_inputs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "guard_longterm_contracts_guard_id_idx" ON "guard_longterm_contracts"("guard_id");

-- CreateIndex
CREATE INDEX "guard_longterm_contracts_post_site_id_idx" ON "guard_longterm_contracts"("post_site_id");

-- CreateIndex
CREATE INDEX "guard_longterm_contracts_guard_id_effective_from_idx" ON "guard_longterm_contracts"("guard_id", "effective_from");

-- CreateIndex
CREATE INDEX "guard_leave_balances_guard_id_idx" ON "guard_leave_balances"("guard_id");

-- CreateIndex
CREATE UNIQUE INDEX "guard_leave_balances_guard_id_year_key" ON "guard_leave_balances"("guard_id", "year");

-- CreateIndex
CREATE INDEX "longterm_payroll_runs_month_idx" ON "longterm_payroll_runs"("month");

-- CreateIndex
CREATE INDEX "longterm_payroll_lines_guard_id_idx" ON "longterm_payroll_lines"("guard_id");

-- CreateIndex
CREATE UNIQUE INDEX "longterm_payroll_lines_run_id_guard_id_key" ON "longterm_payroll_lines"("run_id", "guard_id");

-- CreateIndex
CREATE INDEX "longterm_payroll_inputs_month_guard_id_idx" ON "longterm_payroll_inputs"("month", "guard_id");

-- AddForeignKey
ALTER TABLE "guard_longterm_contracts" ADD CONSTRAINT "guard_longterm_contracts_guard_id_fkey" FOREIGN KEY ("guard_id") REFERENCES "guards"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guard_longterm_contracts" ADD CONSTRAINT "guard_longterm_contracts_post_site_id_fkey" FOREIGN KEY ("post_site_id") REFERENCES "sites"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guard_leave_balances" ADD CONSTRAINT "guard_leave_balances_guard_id_fkey" FOREIGN KEY ("guard_id") REFERENCES "guards"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "longterm_payroll_lines" ADD CONSTRAINT "longterm_payroll_lines_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "longterm_payroll_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "longterm_payroll_lines" ADD CONSTRAINT "longterm_payroll_lines_guard_id_fkey" FOREIGN KEY ("guard_id") REFERENCES "guards"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "longterm_payroll_inputs" ADD CONSTRAINT "longterm_payroll_inputs_guard_id_fkey" FOREIGN KEY ("guard_id") REFERENCES "guards"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
