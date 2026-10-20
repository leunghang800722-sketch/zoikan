-- EMP-P2.2（老闆 2026-10-20 更正）：U Team 全部都係在勤出糧（Link 批盤 Wilson 畀錢在勤、在勤畀雞頭、雞頭出糧畀人；其他 Wilson 盤在勤直接出）。
-- 只更正設定表 staff_schemes 呢一行（唔係 PII）；若老闆已經自己改過 payer_code（唔再係 wilson）就唔郁，冇行匹配亦唔 abort。
UPDATE "staff_schemes" SET "payer_code" = 'maxwell', "payer_label_zh" = '在勤出糧' WHERE "code" = 'U' AND "payer_code" = 'wilson';
