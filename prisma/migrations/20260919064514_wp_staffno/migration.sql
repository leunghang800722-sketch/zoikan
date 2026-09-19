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
-- 淨係負責由現有值起新表底，唔可以反過嚟拿 sync 結果去覆蓋現有欄。
--
-- S3/S4（Opus 驗收修復）：原本版本一旦 staff_no／staff_no_mw 之間有正規
-- 化後撞號就成個 migration `RAISE EXCEPTION` 中止——歷史髒資料應該盡量
-- 兜底、留低證據俾人手跟進，唔應該令部署卡死。而家改做：
--
--   (a) dup-check 同真正 INSERT 用**同一個**候選集合（下面 `wp_staffno_
--       source` 呢張 temp table）——一個值要正規化（trim＋大寫＋去晒
--       空白，同 `normalizeStaffNumber()` app 層一致）之後符合
--       `^[A-Z]{1,4}[0-9A-Z-]+$`（scheme 前綴 1-4 位大寫英文字母 + 至少
--       一位英文字母/數字/連字符）先會被考慮 backfill。
--   (b) 格式唔啱嘅（例如冇字母前綴、淨係得個空殼）——唔起新表行、
--       `guards` 表原值原封不動，寫一行 `audit_log`
--       （`action='migration_skipped_invalid'`）俾人手跟進，`row_id`＝
--       嗰個 guard 嘅 id。
--   (c) 正規化後真係撞號（同一個值嚟自兩個唔同 guard，或者同一個 guard
--       嘅 `staff_no`／`staff_no_mw` 兩欄啱啱好正規化埋一齊）——**唔
--       abort**：`(created_at, guard_id)` 排先嗰個攞呢個號做
--       `current`；其餘全部跳過（唔起行），每個跳過嘅一樣寫一行
--       `audit_log`（`action='migration_skipped_duplicate'`）。
--
-- 兩張 temp table 用完即棄（`DROP TABLE` 喺尾——temp table 本身都會跟
-- session 结束自動清，呢度顯式 drop 純粹令個 migration 讀落去意圖清晰）。
CREATE TEMP TABLE wp_staffno_source AS
SELECT
  id AS guard_id,
  created_at,
  'staff_no' AS col_name,
  UPPER(REGEXP_REPLACE(TRIM(staff_no), '\s+', '', 'g')) AS normalized
FROM guards
WHERE staff_no IS NOT NULL AND TRIM(staff_no) <> ''
UNION ALL
SELECT
  id,
  created_at,
  'staff_no_mw',
  UPPER(REGEXP_REPLACE(TRIM(staff_no_mw), '\s+', '', 'g'))
FROM guards
WHERE staff_no_mw IS NOT NULL AND TRIM(staff_no_mw) <> '';

-- 格式啱嘅候選值，逐個 normalized 值分組，`(created_at, guard_id)`
-- 排先嗰行 rn=1 做 winner；同一個值有兩行或以上就係真撞號（rn>1 嗰啲）。
CREATE TEMP TABLE wp_staffno_ranked AS
SELECT
  guard_id,
  col_name,
  normalized,
  ROW_NUMBER() OVER (PARTITION BY normalized ORDER BY created_at ASC, guard_id ASC) AS rn
FROM wp_staffno_source
WHERE normalized ~ '^[A-Z]{1,4}[0-9A-Z-]+$';

-- winner（每個 normalized 值嘅第一個）→ 起一行 current。
INSERT INTO "guard_staff_numbers" (id, guard_id, scheme, number, status, source, created_at, updated_at)
SELECT
  gen_random_uuid(),
  guard_id,
  UPPER(substring(normalized FROM '^[A-Z]{1,4}')),
  normalized,
  'current',
  'migration:' || col_name,
  now(),
  now()
FROM wp_staffno_ranked
WHERE rn = 1;

-- 真撞號、冇攞到 winner 嗰啲（rn>1）→ 跳過，audit_log 留底俾人手跟進。
INSERT INTO audit_log (id, actor_user_id, table_name, row_id, action, before, after, ip, created_at)
SELECT
  gen_random_uuid(),
  NULL,
  'guard_staff_numbers',
  guard_id,
  'migration_skipped_duplicate',
  NULL,
  jsonb_build_object(
    'column', col_name,
    'number', normalized,
    'reason', '正規化後同另一個 guard（或自己另一欄）撞號，(created_at,guard_id) 排先嗰個已經攞咗做 current，呢個跳過，需要人手核對邊個先係啱嘅擁有人'
  ),
  NULL,
  now()
FROM wp_staffno_ranked
WHERE rn > 1;

-- 格式唔啱嘅（例如冇字母前綴）→ 跳過，同樣 audit_log 留底。
INSERT INTO audit_log (id, actor_user_id, table_name, row_id, action, before, after, ip, created_at)
SELECT
  gen_random_uuid(),
  NULL,
  'guard_staff_numbers',
  guard_id,
  'migration_skipped_invalid',
  NULL,
  jsonb_build_object(
    'column', col_name,
    'raw_normalized', normalized,
    'reason', 'format 唔啱（正規化後要係 1-4 位大寫英文字母開頭 + 至少一位英文字母/數字/連字符），legacy 欄原值保留，需要人手核對後用 API 補一行正確嘅員工編號'
  ),
  NULL,
  now()
FROM wp_staffno_source
WHERE normalized !~ '^[A-Z]{1,4}[0-9A-Z-]+$';

DROP TABLE wp_staffno_ranked;
DROP TABLE wp_staffno_source;
