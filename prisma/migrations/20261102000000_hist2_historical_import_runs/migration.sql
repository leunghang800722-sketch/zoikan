-- HIST-2：歷史月份一鍵導入執行紀錄。純 CREATE TABLE／INDEX，全新表 0 行起步，冇 backfill、冇 gen_random_uuid()／RAISE。
-- 唔入 `ai` schema（AI 助手結構上接觸唔到）；`ai.audit_log` 係白名單 IN 清單，新表自動唔入。
CREATE TABLE "historical_import_runs" (
    "id" TEXT NOT NULL,
    "month" DATE NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "started_by_id" TEXT NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),
    "apply_started_at" TIMESTAMP(3),
    "current_step" TEXT,
    "steps_json" JSONB NOT NULL DEFAULT '[]',
    "report_json" JSONB,
    "error_message" TEXT,

    CONSTRAINT "historical_import_runs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "historical_import_runs_month_started_at_idx" ON "historical_import_runs"("month", "started_at");
