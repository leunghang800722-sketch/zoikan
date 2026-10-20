-- EMP-P2：工號體系設定表（純加表＋種子；冪等，唔改現有資料）。
CREATE TABLE IF NOT EXISTS "staff_schemes" (
  "code" TEXT NOT NULL,
  "label_zh" TEXT NOT NULL,
  "payer_code" TEXT,
  "payer_label_zh" TEXT,
  "pay_method" TEXT,
  "is_frontline" BOOLEAN NOT NULL DEFAULT true,
  "is_longterm" BOOLEAN NOT NULL DEFAULT false,
  "sort" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "staff_schemes_pkey" PRIMARY KEY ("code")
);

INSERT INTO "staff_schemes" ("code", "label_zh", "payer_code", "payer_label_zh", "pay_method", "is_frontline", "is_longterm", "sort") VALUES
  ('U',  'U（Wilson 盤）',     'wilson',  'Wilson 出糧',   NULL,      true,  false, 1),
  ('MP', 'MP（在勤盤）',       'maxwell', '在勤出糧',      NULL,      true,  false, 2),
  ('MG', 'MG（在勤長工）',     'maxwell', '在勤長工糧',    'autopay', false, true,  3),
  ('MW', 'MW（在勤寫字樓）',   'maxwell', '在勤出糧',      NULL,      false, false, 4)
ON CONFLICT ("code") DO NOTHING;
