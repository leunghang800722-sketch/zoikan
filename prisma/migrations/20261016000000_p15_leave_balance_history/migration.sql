-- P15.1：假期結餘快照（作廢月份計算時回滾）。只新增、冪等；唔入 AI 唯讀 schema。
CREATE TABLE IF NOT EXISTS "guard_leave_balance_history" (
    "id" TEXT NOT NULL,
    "guard_id" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "month" DATE NOT NULL,
    "existed" BOOLEAN NOT NULL DEFAULT true,
    "al_taken" DECIMAL(6,2) NOT NULL DEFAULT 0,
    "sl_taken" DECIMAL(6,2) NOT NULL DEFAULT 0,
    "sl_accrued" DECIMAL(6,2) NOT NULL DEFAULT 0,
    "as_of_month" DATE,
    "al_taken_opening" DECIMAL(6,2) NOT NULL DEFAULT 0,
    "sl_taken_opening" DECIMAL(6,2) NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "guard_leave_balance_history_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "guard_leave_balance_history_guard_id_year_month_key" ON "guard_leave_balance_history"("guard_id", "year", "month");
CREATE INDEX IF NOT EXISTS "guard_leave_balance_history_month_idx" ON "guard_leave_balance_history"("month");
