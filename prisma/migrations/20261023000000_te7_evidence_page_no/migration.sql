-- TE-7：整頁原稿暫存圖（抽取失敗人嘅例外，plan §14）——淨加 page_no 欄（冪等、只新增）。
ALTER TABLE "triage_evidence_images" ADD COLUMN IF NOT EXISTS "page_no" INTEGER;
