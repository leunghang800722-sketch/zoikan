-- WP-STAFF-FIELDS（Opus 第五輪）：分診簡化——每次自動 apply 「作廢舊 open 題＋由今次評估重新出新 row」，唔再搬移／重開舊 row。
--  * triage_person_applies 加 weak_ids（身份證 HMAC＋工號 HMAC，弱身份重疊偵測用）同 has_bank（呢個包有冇銀行段）。
--  * triage_questions 嘅 (session_id, group_key) 唯一索引改為普通索引（同一 session 可以有已作廢嘅舊 row 同新 row 共存）。
-- 全部 IF NOT EXISTS／IF EXISTS（冪等），只加／放寬，唔動現有資料，唔 abort。
ALTER TABLE "triage_person_applies" ADD COLUMN IF NOT EXISTS "weak_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "triage_person_applies" ADD COLUMN IF NOT EXISTS "has_bank" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS "triage_person_applies_weak_ids_idx" ON "triage_person_applies" USING GIN ("weak_ids");
DROP INDEX IF EXISTS "triage_questions_session_id_group_key_key";
CREATE INDEX IF NOT EXISTS "triage_questions_session_id_group_key_idx" ON "triage_questions"("session_id", "group_key");
