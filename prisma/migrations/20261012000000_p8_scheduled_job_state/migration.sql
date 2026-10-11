-- P8.1：scheduled_jobs.state——job 自己記住「上次處理到邊」（例如 auto_one_click 每月份最後觸發嘅上載時間）。只新增，冪等。
ALTER TABLE "scheduled_jobs" ADD COLUMN IF NOT EXISTS "state" JSONB NOT NULL DEFAULT '{}';
