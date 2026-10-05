-- WP-STAFF-FIELDS（Opus 覆核第三輪 R1）：triage_questions.status 加 'superseded'
-- （同 group_key＋kind 有較新嘅 open 題時，舊 session 嘅 open 題標做 superseded：唔計待答、唔可以預覽／作答）。
-- status 係 TEXT＋CHECK constraint，所以要換 constraint（冪等：先 DROP IF EXISTS 再 ADD；唔動任何資料，唔 abort）。
ALTER TABLE "triage_questions" DROP CONSTRAINT IF EXISTS "triage_questions_status_check";
ALTER TABLE "triage_questions" ADD CONSTRAINT "triage_questions_status_check" CHECK ("status" IN ('open', 'answered', 'skipped', 'superseded'));
