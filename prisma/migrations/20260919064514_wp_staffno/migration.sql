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
-- --create-only` 對比 schema.prisma 自動產生；下面三段係手加：
--   (1) 甲／乙類到期日 backfill（Opus 驗收第二輪必修 1a）；
--   (2) partial unique index（Prisma schema 冇 WHERE 子句表達能力）；
--   (3) 資料搬遷：由現有 guards.staff_no／staff_no_mw 起新表底。

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

-- ---------------------------------------------------------------------------
-- (1)（Opus 驗收第二輪必修 1a）：甲／乙類到期日 backfill。
--
-- 上面兩個新欄啱啱 ADD COLUMN，全部 guard 一律 NULL——如果就此收工，
-- `deriveSiaPermitExpiry()`（讀取層現算、`scripts/db/recompute-permit-
-- derived.ts`）見到 a／b 都係 null 就會計出 {null,null}，一旦冇讀取層／
-- script 嗰邊嘅安全閥（見 src/app/api/guards/route.ts withDerived()、
-- src/app/api/guards/[id]/route.ts withDerivedGuard()、
-- scripts/db/recompute-permit-derived.ts），舊有 `sia_permit_expiry`／
-- `sia_permit_type` 就會永久被覆蓋做 null——所以呢個 migration 一定要喺
-- 呢一刻就將舊值搬去新欄，唔淨係靠讀取層兜底。
--
-- `sia_permit_type` 歷史上係單選白名單 A/B/C/D（見 0a6ea87 之前
-- `src/lib/api/schemas.ts` 嘅 `SIA_PERMIT_TYPES`／GuardsClient.tsx 嘅
-- 牌照類別下拉），從嚟冇「兩類都有」嘅組合值（冇 "AB" 呢類自由文字）。
--
-- 必修 2（Opus 驗收第三輪）：原本規則淨係分「B」定「其餘」，即係
-- C／D／null／自由文字全部當「呢個人有一張牌」搬去 `sia_permit_a_
-- expiry`——但呢個做法本身唔啱：規劃師明文話咗「舊牌照資料除非用戶
-- 明確填甲／乙到期日，否則任何一層都唔准改」，C／D 呢類根本唔係甲類
-- （只係「單選白名單其餘值」，唔代表就係甲類），backfill 將佢哋搬入
-- `sia_permit_a_expiry` 屬於「改咗」，同呢個原則相反。而家收窄做：淨係
-- 正規化（trim＋大寫）之後**逐字**等於 'A' 先搬去 a 欄、等於 'B' 先搬
-- 去 b 欄；C／D／null／其他自由文字（包括呢個 type 欄本身就打錯／唔規
-- 範嘅值）一律唔 backfill——a／b 留 null，舊 `sia_permit_expiry`／
-- `sia_permit_type` 原封不動，之後靠讀取層／PATCH 寫入層／script 嗰個
-- 共用安全閥（`canOverrideDerivedSiaPermit()`，見 src/lib/guards/
-- staff-numbers.ts）保留呢批舊值，直到用戶明確補返甲／乙到期日先會用
-- 新計法。
--
-- 淨係處理「舊 `sia_permit_expiry` 有值、a／b 兩個新欄都仲係 null」嘅
-- guard——呢個 migration 啱啱先 ADD COLUMN，理論上呢一刻全部 guard 嘅
-- a／b 都係 null，`AND sia_permit_a_expiry IS NULL AND sia_permit_b_
-- expiry IS NULL` 純粹係防禦性寫法（例如呢個 migration 將來俾人手部分
-- 重跑），保證幂等、唔會用新值蓋走人手已經補好嘅 a／b。
UPDATE "guards"
SET "sia_permit_a_expiry" = "sia_permit_expiry"
WHERE "sia_permit_expiry" IS NOT NULL
  AND "sia_permit_a_expiry" IS NULL
  AND "sia_permit_b_expiry" IS NULL
  AND UPPER(TRIM(COALESCE("sia_permit_type", ''))) = 'A';

UPDATE "guards"
SET "sia_permit_b_expiry" = "sia_permit_expiry"
WHERE "sia_permit_expiry" IS NOT NULL
  AND "sia_permit_a_expiry" IS NULL
  AND "sia_permit_b_expiry" IS NULL
  AND UPPER(TRIM(COALESCE("sia_permit_type", ''))) = 'B';

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
-- (2) Partial unique index：同一個 guard 同一個 scheme 最多一行
-- status='current'（例如唔可以同時有兩個 current 嘅 U 號——舊嗰個一定
-- 要先轉 former）。
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX "guard_staff_numbers_guard_scheme_current_key"
  ON "guard_staff_numbers" ("guard_id", "scheme")
  WHERE "status" = 'current';

-- ---------------------------------------------------------------------------
-- (3) 資料搬遷：guards.staff_no／staff_no_mw 非空 → 一行 guard_staff_
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
--       app 嘅 scheme／number 格式先會被考慮 backfill（見下面
--       Opus 驗收第二輪應修 3）。
--   (b) 格式唔啱嘅（例如冇字母前綴、淨係得個空殼）——唔起新表行、
--       `guards` 表原值原封不動，寫一行 `audit_log`
--       （`action='migration_skipped_invalid'`）俾人手跟進，`row_id`＝
--       嗰個 guard 嘅 id。
--   (c) 正規化後真係撞號（同一個值嚟自兩個唔同 guard，或者同一個 guard
--       嘅 `staff_no`／`staff_no_mw` 兩欄啱啱好正規化埋一齊）——**唔
--       abort**：`(created_at, guard_id, col_name)` 排先嗰個攞呢個號做
--       `current`；其餘全部跳過（唔起行），每個跳過嘅一樣寫一行
--       `audit_log`（`action='migration_skipped_duplicate'`）。
--
-- 應修 3（Opus 驗收第二輪）：格式／scheme 判斷逐字對齊 app 邏輯——唔可以
-- 淨係用一個 regex 「食晒」，因為 `[0-9A-Z-]` 呢個字符類本身都包含
-- A-Z，令 regex engine 可以將本來應該屬於 scheme 嘅字母倒流去「number
-- 尾段」（例如 "ABCDE123"：`^[A-Z]{1,4}` 貪心咁淨攞 4 位 "ABCD"，跟住
-- "E123" 一樣匹配 `[0-9A-Z-]+`，成串照樣過關，但呢個唔啱——`schemeFromNumber()`
-- （src/lib/guards/staff-numbers.ts）會攞晒**成串連續**嘅開頭大寫字母
-- （唔止 4 位）先驗證長度係咪 1-4，"ABCDE123" 攞到 "ABCDE"（5 位）already
-- 唔啱，一定係 invalid，唔可以誤判做 scheme="ABCD"）。下面用
-- `regexp_match(normalized, '^([A-Z]+)')` 攞返「成串連續」嘅開頭字母做
-- `scheme` 呢一個獨立欄，先分開驗證：
--   - `scheme` 要存在，並且長度 1-4（對齊 `STAFF_NUMBER_SCHEME_RE`
--     `^[A-Z]{1,4}$`）；
--   - 成個 `normalized` 要符合 `scheme || '[0-9A-Z-]{1,16}$'`（對齊
--     `STAFF_NUMBER_NUMBER_RE` `^[A-Z]{1,4}[0-9A-Z-]{1,16}$`——連埋上限
--     16 位都對齊，舊版呢度冇上限，會漏收超長工號）。
--
-- 兩張 temp table 用完即棄（`DROP TABLE` 喺尾——temp table 本身都會跟
-- session 结束自動清，呢度顯式 drop 純粹令個 migration 讀落去意圖清晰）。
--
-- 必修 5（Opus 驗收第三輪）：正規化 regex 由 `'\s+'` 改做
-- `'[\s<NBSP>]+'`（下面字符類入面 `\s` 後面嗰個唔係普通空格，係一個
-- literal NBSP／U+00A0 字符——同 `src/lib/guards/staff-numbers.ts`
-- `normalizeStaffNumber()` 對齊：JS 嘅 `\s` regex class 本身已經包含
-- NBSP，但 Postgres 嘅 `\s`（ARE）淨係 ASCII 空白，唔包 NBSP，實測
-- `regexp_replace(x, '\s+', '', 'g')` 唔會除得走一個 NBSP；貼字元 class
-- 入面一個真正嘅 NBSP 之後就會，兩邊（JS／SQL）正規化結果先至一致——
-- 舊員工編號可能係人手喺 Excel／輸入法貼過嚟，帶 NBSP 唔罕見）。
CREATE TEMP TABLE wp_staffno_source AS
SELECT
  id AS guard_id,
  created_at,
  'staff_no' AS col_name,
  UPPER(REGEXP_REPLACE(TRIM(staff_no), '[\s ]+', '', 'g')) AS normalized
FROM guards
WHERE staff_no IS NOT NULL AND TRIM(staff_no) <> ''
UNION ALL
SELECT
  id,
  created_at,
  'staff_no_mw',
  UPPER(REGEXP_REPLACE(TRIM(staff_no_mw), '[\s ]+', '', 'g'))
FROM guards
WHERE staff_no_mw IS NOT NULL AND TRIM(staff_no_mw) <> '';

-- 逐個候選值計返個 scheme（開頭連續大寫字母，可能 0 位／可能 >4 位，
-- 兩種都要喺下面篩走）——呢張 temp table 加返一個 `scheme` 欄，畀下面
-- 「格式啱嘅先入 ranked」同「格式唔啱寫 invalid audit」共用同一份計法，
-- 唔使兩處各自重複 `regexp_match()`。
ALTER TABLE wp_staffno_source ADD COLUMN scheme TEXT;
UPDATE wp_staffno_source SET scheme = (regexp_match(normalized, '^([A-Z]+)'))[1];

-- 格式啱嘅候選值，逐個 normalized 值分組，`(created_at, guard_id,
-- col_name)` 排先嗰行 rn=1 做 winner；同一個值有兩行或以上就係真撞號
-- （rn>1 嗰啲）。順手（Opus 驗收第二輪）：`col_name` 加做第三個
-- tie-break（'staff_no' 字母序排 'staff_no_mw' 之前）——`created_at`／
-- `guard_id` 都相同嗰種邊緣情況（同一個 guard 嘅 staff_no／staff_no_mw
-- 兩欄正規化埋一齊撞號，用嗰個 guard 自己 `created_at` 做兩邊嘅
-- created_at，先前純靠 guard_id 排唔到呢種「自己撞自己」嘅決定性）下，
-- 令邊個欄贏唔再取決於 DB 掃描順序。
CREATE TEMP TABLE wp_staffno_ranked AS
SELECT
  guard_id,
  col_name,
  normalized,
  scheme,
  ROW_NUMBER() OVER (PARTITION BY normalized ORDER BY created_at ASC, guard_id ASC, col_name ASC) AS rn
FROM wp_staffno_source
WHERE scheme IS NOT NULL
  AND length(scheme) BETWEEN 1 AND 4
  AND normalized ~ ('^' || scheme || '[0-9A-Z-]{1,16}$');

-- winner（每個 normalized 值嘅第一個）→ 起一行 current（`scheme` 直接
-- 用上面已經計好嘅欄，唔再用 `substring(normalized FROM '^[A-Z]{1,4}')`
-- 咁樣「貪心截頭 4 位」——嗰種寫法喺 scheme 剛好啱 4 位嘅時候會啱，但
-- 邏輯上唔啱，同 `wp_staffno_ranked` 嘅篩選條件唔對齊）。
INSERT INTO "guard_staff_numbers" (id, guard_id, scheme, number, status, source, created_at, updated_at)
SELECT
  gen_random_uuid(),
  guard_id,
  scheme,
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
    'reason', '正規化後同另一個 guard（或自己另一欄）撞號，(created_at,guard_id,col_name) 排先嗰個已經攞咗做 current，呢個跳過，需要人手核對邊個先係啱嘅擁有人'
  ),
  NULL,
  now()
FROM wp_staffno_ranked
WHERE rn > 1;

-- 格式唔啱嘅（scheme 攞唔到、scheme 長度唔啱 1-4、或者成個 number 格式
-- 唔啱）→ 跳過，同樣 audit_log 留底。
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
    'reason', 'format 唔啱（正規化後開頭連續大寫英文字母要係 1-4 位，之後要跟 1-16 位大寫英文字母/數字/連字符），legacy 欄原值保留，需要人手核對後用 API 補一行正確嘅員工編號'
  ),
  NULL,
  now()
FROM wp_staffno_source
WHERE scheme IS NULL
  OR length(scheme) NOT BETWEEN 1 AND 4
  OR normalized !~ ('^' || scheme || '[0-9A-Z-]{1,16}$');

DROP TABLE wp_staffno_ranked;
DROP TABLE wp_staffno_source;
