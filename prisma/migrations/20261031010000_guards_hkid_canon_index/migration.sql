-- S-batch-1021：storedPhonesForHkid（OCR-6.3）按 canonical HKID 配對（upper(regexp_replace(hkid,'[^A-Za-z0-9]','','g'))）——加 expression index。
-- 普通 CREATE INDEX（CONCURRENTLY 唔可以喺 migration 交易內）；IF NOT EXISTS；唔改資料。
CREATE INDEX IF NOT EXISTS "guards_hkid_canon_idx" ON "guards" (upper(regexp_replace("hkid", '[^A-Za-z0-9]', '', 'g')));
