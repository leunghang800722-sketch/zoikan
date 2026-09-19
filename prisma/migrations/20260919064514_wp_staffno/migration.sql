-- WP-STAFFNO（老闆 2026-09-19 拍板）：員工編號獨立表（方案 B）＋保安牌照
-- 甲／乙類到期日分開存。
--
-- 員工編號並存唔取代：U＝去 Wilson 盤做散工必須有；MP＝去第二間公司嘅
-- 盤做散工用；MG＝轉咗長工；MW 意思未確認（老闆仲未答）。同一人可以
-- 同時有 U／MP／MG；同一種入面亦可能有多個號（臨時號→正式號、離職再
-- 入職攞新號）——舊號存底但摺埋（status=former）。仲未答：邊個盤顯示
-- 邊種號、轉長工後 U／MP 係咪繼續有效、MW 係咩——所以 `scheme` 用
-- String（1-4 位大寫英文字母，app 層 zod regex 管，唔用 Prisma enum），
-- 將來加新種類唔使 migration。
--
-- 呢個 migration 頭半（CREATE TYPE／ALTER TABLE guards／CREATE TABLE
-- guard_staff_numbers／一般 index／FK）由 `prisma migrate dev
-- --create-only` 對比 schema.prisma 自動產生；下面兩段係手加：
--   (1) partial unique index（Prisma schema 冇 WHERE 子句表達能力）；
--   (2) 資料搬遷：由現有 guards.staff_no／staff_no_mw 起新表底。

-- CreateEnum
CREATE TYPE "GuardStaffNumberStatus" AS ENUM ('current', 'former');

-- AlterTable：甲／乙類到期日分開存（乙類過 70 歲失效，淨返甲類仍要存
-- 底，兩個都要存，唔係二揀一）。`sia_permit_expiry`（已有嘅舊欄）保留
-- 做**衍生值**＝兩個入面「仍然有效而最早到期」嗰個，由
-- `deriveSiaPermitExpiry()`（src/lib/guards/staff-numbers.ts）計，PATCH
-- 甲／乙／出生日期都會自動重算——`ai.guards` view／90 日篩選繼續讀
-- `sia_permit_expiry` 呢個舊欄，唔使改。
ALTER TABLE "guards" ADD COLUMN     "sia_permit_a_expiry" DATE,
ADD COLUMN     "sia_permit_b_expiry" DATE;

-- CreateTable
CREATE TABLE "guard_staff_numbers" (
    "id" TEXT NOT NULL,
    "guard_id" TEXT NOT NULL,
    "scheme" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "status" "GuardStaffNumberStatus" NOT NULL DEFAULT 'current',
    "valid_from" DATE,
    "valid_to" DATE,
    "note" TEXT,
    "source" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT,

    CONSTRAINT "guard_staff_numbers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex：全表 unique——同一個工號唔可以掛喺兩個唔同 guard／同一個
-- guard 兩行（POST /api/guards/:id/staff-numbers 撞號 409）。
CREATE UNIQUE INDEX "guard_staff_numbers_number_key" ON "guard_staff_numbers"("number");

-- CreateIndex（一般 index，幫查詢，唔係約束本身）
CREATE INDEX "guard_staff_numbers_guard_id_scheme_idx" ON "guard_staff_numbers"("guard_id", "scheme");

-- AddForeignKey：RESTRICT——唔准刪 guard 過手留低斷咗嘅工號歷史（同設計
-- 一致，冇硬刪 guard_staff_numbers 呢個表本身）。
ALTER TABLE "guard_staff_numbers" ADD CONSTRAINT "guard_staff_numbers_guard_id_fkey" FOREIGN KEY ("guard_id") REFERENCES "guards"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- (1) Partial unique index：同一個 guard 同一個 scheme 最多一行
-- status='current'（例如唔可以同時有兩個 current 嘅 U 號——舊嗰個一定
-- 要先轉 former）。
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX "guard_staff_numbers_guard_scheme_current_key"
  ON "guard_staff_numbers" ("guard_id", "scheme")
  WHERE "status" = 'current';

-- ---------------------------------------------------------------------------
-- (2) 資料搬遷：guards.staff_no／staff_no_mw 非空 → 一行 guard_staff_
-- numbers（scheme＝前綴大寫英文字母，status=current，source=
-- migration:staff_no／migration:staff_no_mw）。
--
-- 刻意唔改 guards.staff_no／staff_no_mw 本身呢兩個值——由呢個 migration
-- 之後起，呢兩個舊欄先變做「由新表算返嚟」嘅同步值（見
-- src/lib/guards/staff-numbers.ts syncLegacyStaffNoColumns()）。呢一刻
-- 淨係負責由現有值起新表底，唔可以反過嚟拿 sync 結果去覆蓋現有欄：如果
-- 現有 staff_no 冇 letter 前綴（理論上唔應該發生——staff_no 本身直到
-- 而家一律 "U00xxx" 呢種格式，見 tools/importer/out/wp2b/guards.csv
-- 實測 201 個 staff_no 全部 "U" 開頭、48 個 staff_no_mw 全部
-- "MG"／"MW" 開頭），下面 WHERE 子句會跳過嗰行（唔會插入任何 scheme
-- 為空嘅 garbage row），令嗰個 guard 冇對應 current 行、legacy 欄原樣
-- 保留——日後由人手用 API 補一行正確嘅號先會令兩邊一致。
--
-- 撞號檢查：dev DB 應該冇任何 staff_no／staff_no_mw 撞號（staff_no 本身
-- 已經有 unique 約束防重複，但 staff_no 同 staff_no_mw 之間理論上未防
-- 過——例如萬一 staff_no="MG001" 撞正另一個人嘅 staff_no_mw="MG001"），
-- 呢度用 PL/pgSQL 顯式 RAISE EXCEPTION 中止，唔靠插入一半先俾 unique
-- constraint 拋錯（減少殘缺 migration state）。
DO $$
DECLARE
  dup_count INT;
BEGIN
  SELECT COUNT(*) INTO dup_count FROM (
    SELECT UPPER(TRIM(staff_no)) AS number FROM guards WHERE staff_no IS NOT NULL AND TRIM(staff_no) <> ''
    UNION ALL
    SELECT UPPER(TRIM(staff_no_mw)) AS number FROM guards WHERE staff_no_mw IS NOT NULL AND TRIM(staff_no_mw) <> ''
  ) t
  GROUP BY number
  HAVING COUNT(*) > 1
  LIMIT 1;

  IF dup_count IS NOT NULL AND dup_count > 0 THEN
    RAISE EXCEPTION 'WP-STAFFNO 搬遷：staff_no／staff_no_mw 之間有重複值，要人手核對再搬（見 migration.sql 頭註解）';
  END IF;
END $$;

INSERT INTO "guard_staff_numbers" (id, guard_id, scheme, number, status, source, created_at, updated_at)
SELECT
  gen_random_uuid(),
  id,
  UPPER(substring(TRIM(staff_no) FROM '^[A-Za-z]+')),
  UPPER(TRIM(staff_no)),
  'current',
  'migration:staff_no',
  now(),
  now()
FROM guards
WHERE staff_no IS NOT NULL
  AND TRIM(staff_no) <> ''
  AND substring(TRIM(staff_no) FROM '^[A-Za-z]+') IS NOT NULL
  AND length(substring(TRIM(staff_no) FROM '^[A-Za-z]+')) BETWEEN 1 AND 4;

INSERT INTO "guard_staff_numbers" (id, guard_id, scheme, number, status, source, created_at, updated_at)
SELECT
  gen_random_uuid(),
  id,
  UPPER(substring(TRIM(staff_no_mw) FROM '^[A-Za-z]+')),
  UPPER(TRIM(staff_no_mw)),
  'current',
  'migration:staff_no_mw',
  now(),
  now()
FROM guards
WHERE staff_no_mw IS NOT NULL
  AND TRIM(staff_no_mw) <> ''
  AND substring(TRIM(staff_no_mw) FROM '^[A-Za-z]+') IS NOT NULL
  AND length(substring(TRIM(staff_no_mw) FROM '^[A-Za-z]+')) BETWEEN 1 AND 4;
