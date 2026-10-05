-- WP-STAFF-FIELDS（Opus 第四輪）：分診「只有最近一次包含呢個人嘅導入包所出嘅題先答得」嘅結構性記錄。
--  * triage_person_applies：每次自動 apply 一個導入包，對包內每個人（同 Payroll Editor 對唔到人嘅戶口）記一行（人 key＋目標 guard＋包 hash＋是否 v3＋時間）。
--  * triage_questions 加 person_key／target_guard_id（題目建立時嘅人 key 同鎖定嘅目標 guard）。
--  * triage_sessions 加 key_fp（HMAC key 版本指紋，SESSION_SECRET 輪換偵測）／last_applied_at。
-- 全部 IF NOT EXISTS（冪等），只加新嘢，唔動現有資料，唔 abort；新表唔入 ai schema。
ALTER TABLE "triage_questions" ADD COLUMN IF NOT EXISTS "person_key" TEXT;
ALTER TABLE "triage_questions" ADD COLUMN IF NOT EXISTS "target_guard_id" TEXT;
CREATE INDEX IF NOT EXISTS "triage_questions_person_key_idx" ON "triage_questions"("person_key");
CREATE INDEX IF NOT EXISTS "triage_questions_target_guard_id_idx" ON "triage_questions"("target_guard_id");
CREATE INDEX IF NOT EXISTS "triage_questions_group_key_idx" ON "triage_questions"("group_key");

ALTER TABLE "triage_sessions" ADD COLUMN IF NOT EXISTS "key_fp" TEXT;
ALTER TABLE "triage_sessions" ADD COLUMN IF NOT EXISTS "last_applied_at" TIMESTAMP(3);

CREATE TABLE IF NOT EXISTS "triage_person_applies" (
    "id" SERIAL NOT NULL,
    "person_key" TEXT NOT NULL,
    "guard_id" TEXT,
    "source_ref" TEXT NOT NULL,
    "is_v3" BOOLEAN NOT NULL DEFAULT false,
    "applied_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "triage_person_applies_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "triage_person_applies_person_key_source_ref_key" ON "triage_person_applies"("person_key", "source_ref");
CREATE INDEX IF NOT EXISTS "triage_person_applies_guard_id_idx" ON "triage_person_applies"("guard_id");
CREATE INDEX IF NOT EXISTS "triage_person_applies_person_key_applied_at_idx" ON "triage_person_applies"("person_key", "applied_at");
