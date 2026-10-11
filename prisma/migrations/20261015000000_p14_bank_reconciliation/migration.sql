-- P14.3：長工糧「銀行 Payroll Editor 對數」。只新增、冪等；唔入 AI 唯讀 schema（audit 白名單，新表預設唔入）。
-- 銀行賬戶名稱只存 sha256（bank_name_norm_hash），唔存原文。
CREATE TABLE IF NOT EXISTS "longterm_bank_reconciliations" (
    "id" TEXT NOT NULL,
    "month" DATE NOT NULL,
    "run_id" TEXT NOT NULL,
    "file_name" TEXT NOT NULL,
    "file_sha256" TEXT NOT NULL,
    "uploaded_by" TEXT,
    "uploaded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "summary_json" JSONB,
    CONSTRAINT "longterm_bank_reconciliations_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "longterm_bank_reconciliations_month_uploaded_at_idx" ON "longterm_bank_reconciliations"("month", "uploaded_at");

CREATE TABLE IF NOT EXISTS "longterm_bank_reconciliation_rows" (
    "id" TEXT NOT NULL,
    "reconciliation_id" TEXT NOT NULL,
    "guard_id" TEXT,
    "bank_row_no" INTEGER NOT NULL,
    "bank_name_norm_hash" TEXT,
    "bank_amount" DECIMAL(12,2),
    "system_line_id" TEXT,
    "system_autopay" DECIMAL(12,2),
    "diff" DECIMAL(12,2),
    "match_by" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "reason_code" TEXT,
    "reason_note" TEXT,
    "resolved_by" TEXT,
    "resolved_at" TIMESTAMP(3),
    CONSTRAINT "longterm_bank_reconciliation_rows_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "longterm_bank_reconciliation_rows_reconciliation_id_idx" ON "longterm_bank_reconciliation_rows"("reconciliation_id");
CREATE INDEX IF NOT EXISTS "longterm_bank_reconciliation_rows_guard_id_idx" ON "longterm_bank_reconciliation_rows"("guard_id");

DO $$ BEGIN
  ALTER TABLE "longterm_bank_reconciliations" ADD CONSTRAINT "longterm_bank_reconciliations_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "longterm_payroll_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "longterm_bank_reconciliation_rows" ADD CONSTRAINT "longterm_bank_reconciliation_rows_reconciliation_id_fkey" FOREIGN KEY ("reconciliation_id") REFERENCES "longterm_bank_reconciliations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "longterm_bank_reconciliation_rows" ADD CONSTRAINT "longterm_bank_reconciliation_rows_guard_id_fkey" FOREIGN KEY ("guard_id") REFERENCES "guards"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
