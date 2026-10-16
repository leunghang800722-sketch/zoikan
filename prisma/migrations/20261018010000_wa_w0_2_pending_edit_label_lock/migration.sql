-- W0.2（驗收修正）：只加兩個欄，冪等。
-- whatsapp_messages.pending_edit：編輯事件先於原訊息到達時寫嘅 tombstone 行標記。
-- whatsapp_groups.label_locked：用戶手動改過群名後，WAHA 同步唔再覆蓋 label。
ALTER TABLE "whatsapp_messages" ADD COLUMN IF NOT EXISTS "pending_edit" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "whatsapp_groups" ADD COLUMN IF NOT EXISTS "label_locked" BOOLEAN NOT NULL DEFAULT false;
