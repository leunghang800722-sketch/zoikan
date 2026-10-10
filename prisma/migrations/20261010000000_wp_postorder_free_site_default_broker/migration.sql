-- WP-POSTORDER-FREE（§34）：盤預設結算雞頭。只加 nullable 欄＋FK，冇資料搬移、冇 backfill，
-- 冪等（IF NOT EXISTS／pg_constraint 檢查），跑兩次或者半套都唔會 abort。
-- ai.sites view 用顯式欄名清單，所以新欄唔會自動出現喺 AI 唯讀 schema（照舊規則，唔需要改 view）。
ALTER TABLE "sites" ADD COLUMN IF NOT EXISTS "default_settlement_broker_id" TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sites_default_settlement_broker_id_fkey') THEN
    ALTER TABLE "sites" ADD CONSTRAINT "sites_default_settlement_broker_id_fkey" FOREIGN KEY ("default_settlement_broker_id") REFERENCES "brokers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END
$$;
