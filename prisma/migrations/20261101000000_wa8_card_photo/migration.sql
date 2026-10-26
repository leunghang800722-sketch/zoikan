-- WA-8（工卡相報開工）：純加欄／加表，唔改現有資料。
ALTER TABLE "whatsapp_groups" ADD COLUMN IF NOT EXISTS "card_photo_mode" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "whatsapp_messages" ADD COLUMN IF NOT EXISTS "media_state" TEXT;

CREATE TABLE IF NOT EXISTS "whatsapp_media_evidence" (
    "id" TEXT NOT NULL,
    "message_id" TEXT NOT NULL,
    "chat_jid" TEXT NOT NULL,
    "image_bytes" BYTEA NOT NULL,
    "iv" BYTEA NOT NULL,
    "tag" BYTEA NOT NULL,
    "enc_version" INTEGER NOT NULL DEFAULT 1,
    "width" INTEGER,
    "height" INTEGER,
    "mime" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "whatsapp_media_evidence_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "whatsapp_media_evidence_message_id_key" ON "whatsapp_media_evidence"("message_id");
CREATE INDEX IF NOT EXISTS "whatsapp_media_evidence_expires_at_idx" ON "whatsapp_media_evidence"("expires_at");
