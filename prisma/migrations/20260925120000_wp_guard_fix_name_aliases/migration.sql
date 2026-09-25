-- WP-GUARD-FIX（老闆 2026-09-25 要求：8 月更表大量「未配對安員」自動
-- 修復，唔准逐條人手對）：安員加「更表用名（別名）」——更表姓名格
-- 寫法可能同系統本名唔同（花名／簡寫／曾用名），`matchGuard()` 而家
-- 加多一層「別名＋電話」／「別名唯一」配對（見 src/lib/roster-upload/
-- match.ts），呢個欄就係嗰批別名嘅存底。

-- AlterTable
ALTER TABLE "guards" ADD COLUMN "name_aliases" TEXT[] NOT NULL DEFAULT '{}';
