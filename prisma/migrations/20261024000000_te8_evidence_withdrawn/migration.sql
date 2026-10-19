-- TE-8：證據圖軟刪（錯圖撤回／取代上載）——淨加兩欄（冪等、只新增）。
ALTER TABLE "triage_evidence_images" ADD COLUMN IF NOT EXISTS "withdrawn_at" TIMESTAMPTZ(3);
ALTER TABLE "triage_evidence_images" ADD COLUMN IF NOT EXISTS "withdrawn_reason" TEXT;
