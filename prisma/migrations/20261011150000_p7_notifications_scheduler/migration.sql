-- P7.1：通知表＋排程器表＋用戶通知電郵。只新增、冇資料搬移；冪等。
-- 唔入 `ai` schema（通知 body 已無 PII，但 email 屬聯絡資料，users.notify_email 唔加入 ai.users view）。
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "notify_email" TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "notify_prefs" JSONB NOT NULL DEFAULT '{}';

CREATE TABLE IF NOT EXISTS "app_notifications" (
    "id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "href" TEXT,
    "audience" JSONB NOT NULL DEFAULT '[]',
    "read_by" JSONB NOT NULL DEFAULT '[]',
    "email_sent_at" TIMESTAMP(3),
    "dedupe_key" TEXT NOT NULL,
    CONSTRAINT "app_notifications_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "app_notifications_dedupe_key_key" ON "app_notifications"("dedupe_key");
CREATE INDEX IF NOT EXISTS "app_notifications_created_at_idx" ON "app_notifications"("created_at" DESC);

CREATE TABLE IF NOT EXISTS "scheduled_jobs" (
    "id" TEXT NOT NULL,
    "job_key" TEXT NOT NULL,
    "schedule" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "next_run_at" TIMESTAMP(3),
    "last_run_at" TIMESTAMP(3),
    "last_status" TEXT,
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "scheduled_jobs_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "scheduled_jobs_job_key_key" ON "scheduled_jobs"("job_key");

CREATE TABLE IF NOT EXISTS "job_runs" (
    "id" TEXT NOT NULL,
    "job_key" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),
    "status" TEXT NOT NULL,
    "summary" JSONB,
    CONSTRAINT "job_runs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "job_runs_job_key_started_at_idx" ON "job_runs"("job_key", "started_at" DESC);
