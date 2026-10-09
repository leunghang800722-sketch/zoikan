-- WP-ONE-CLICK-AUTO（Opus 驗收修正 8）：triage_questions.status 加 'applying'
-- （month_close 題確認寫入時先 claim：open → applying，淨係一個並發請求攞到；寫失敗退返 open）。
-- status 係 TEXT＋CHECK constraint，換 constraint（冪等；唔動任何資料，唔 abort）。
ALTER TABLE "triage_questions" DROP CONSTRAINT IF EXISTS "triage_questions_status_check";
ALTER TABLE "triage_questions" ADD CONSTRAINT "triage_questions_status_check" CHECK ("status" IN ('open', 'answered', 'skipped', 'superseded', 'applying'));
