-- W5（WhatsApp 運維）：只加欄，冪等。
-- whatsapp_groups.leave_word_map：群組請假詞對照 { 口語: 請假碼 }；resolve 讀群組覆寫優先於內建。
ALTER TABLE "whatsapp_groups" ADD COLUMN IF NOT EXISTS "leave_word_map" JSONB NOT NULL DEFAULT '{}';
