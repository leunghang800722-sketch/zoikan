-- HIST-1：歷史月份標記。2026-07 之前月份只上載更表＋對數＋落更（shift_records 含 SL／AL／SH），
-- 用嚟由更表計病假／年假結餘；標 historical 嘅月份唔跑月結／糧／介紹費／鎖月流程，排程 job 全部跳過。
-- 純加欄（NOT NULL DEFAULT false），現有資料不變。
ALTER TABLE "month_closes" ADD COLUMN "historical" BOOLEAN NOT NULL DEFAULT false;
