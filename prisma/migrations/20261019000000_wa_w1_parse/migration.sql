-- W1（WhatsApp 解析 dry-run）：只加欄／index，冪等。
-- whatsapp_groups.filter_threshold：第 0 層過濾閾值（群組層覆寫，NULL＝預設 40）。
-- whatsapp_messages.parse_attempts：解析重試次數（3 次失敗 → status=error）。
-- whatsapp_intents.superseded_by_revision：舊 revision 嘅 intents 被新 revision 取代；revoked_at：訊息撤回。
ALTER TABLE "whatsapp_groups" ADD COLUMN IF NOT EXISTS "filter_threshold" INTEGER;
ALTER TABLE "whatsapp_messages" ADD COLUMN IF NOT EXISTS "parse_attempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "whatsapp_intents" ADD COLUMN IF NOT EXISTS "superseded_by_revision" INTEGER;
ALTER TABLE "whatsapp_intents" ADD COLUMN IF NOT EXISTS "revoked_at" TIMESTAMPTZ(3);
CREATE INDEX IF NOT EXISTS "whatsapp_intents_created_at_idx" ON "whatsapp_intents"("created_at");
