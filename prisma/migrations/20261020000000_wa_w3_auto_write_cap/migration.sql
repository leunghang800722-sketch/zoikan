-- W3（WhatsApp 自動寫入）：只加欄，冪等。
-- whatsapp_groups.auto_write_daily_cap：每群每日自動寫入上限（預設 50；超過 → 改 Triage）。
ALTER TABLE "whatsapp_groups" ADD COLUMN IF NOT EXISTS "auto_write_daily_cap" INTEGER NOT NULL DEFAULT 50;
