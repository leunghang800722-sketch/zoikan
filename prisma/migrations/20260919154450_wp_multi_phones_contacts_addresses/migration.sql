-- CreateTable
CREATE TABLE "guard_phones" (
    "id" TEXT NOT NULL,
    "guard_id" TEXT NOT NULL,
    "tel" TEXT NOT NULL,
    "label" TEXT,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "source" TEXT,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT,

    CONSTRAINT "guard_phones_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "guard_emergency_contacts" (
    "id" TEXT NOT NULL,
    "guard_id" TEXT NOT NULL,
    "name" TEXT,
    "tel" TEXT,
    "relationship" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "source" TEXT,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT,

    CONSTRAINT "guard_emergency_contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "guard_addresses" (
    "id" TEXT NOT NULL,
    "guard_id" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "source" TEXT,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT,

    CONSTRAINT "guard_addresses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "guard_phones_guard_id_idx" ON "guard_phones"("guard_id");

-- CreateIndex
CREATE UNIQUE INDEX "guard_phones_guard_id_tel_key" ON "guard_phones"("guard_id", "tel");

-- CreateIndex
CREATE INDEX "guard_emergency_contacts_guard_id_idx" ON "guard_emergency_contacts"("guard_id");

-- CreateIndex
CREATE INDEX "guard_addresses_guard_id_idx" ON "guard_addresses"("guard_id");

-- AddForeignKey
ALTER TABLE "guard_phones" ADD CONSTRAINT "guard_phones_guard_id_fkey" FOREIGN KEY ("guard_id") REFERENCES "guards"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guard_emergency_contacts" ADD CONSTRAINT "guard_emergency_contacts_guard_id_fkey" FOREIGN KEY ("guard_id") REFERENCES "guards"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guard_addresses" ADD CONSTRAINT "guard_addresses_guard_id_fkey" FOREIGN KEY ("guard_id") REFERENCES "guards"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- WP-MULTI（老闆 2026-09-19 拍板「全部資料都要保留，唔好揀一個」）：電話／
-- 緊急聯絡人／地址三張新子表——同 WP-STAFFNO（guard_staff_numbers）一樣嘅
-- 「獨立子表＋legacy 欄自動同步」pattern（見 20260919064514_wp_staffno）。
-- 上面 CREATE TABLE／一般 index／FK（RESTRICT，同 guard_staff_numbers 一
-- 致——唔准刪 guard 過手留低斷咗嘅聯絡資料歷史）由 `prisma migrate dev
-- --create-only` 對比 schema.prisma 自動產生；下面四段係手加：
--   (1) CHECK constraint：guard_emergency_contacts.name／tel 唔可以同時空
--       （Prisma schema 冇 CHECK 表達能力）；
--   (2) partial unique index（guard_phones／guard_addresses 各自最多一行
--       is_primary=true，Prisma schema 冇 WHERE 子句表達能力）；
--   (3) 資料搬遷：guards.tel／address／emergency_contact_name／
--       emergency_contact_tel → 三張新表起底（primary phone／primary
--       address／一個 emergency contact）。
--
-- 同 WP-STAFFNO 一致嘅刻意權衡：呢個 migration**唔驗格式、唔 abort**——
-- 「髒值照搬」，因為正式站 Dockerfile CMD 係 `prisma migrate deploy &&
-- …`，一旦 migration 失敗成個網站起唔到（呢個係鐵則，見 worktree 指
-- 示）。真正嘅格式驗證（電話正規化／8 位香港號或者 `+` 開頭國際號）
-- 淨係喺 app 層（`src/lib/guards/contacts.ts`）新增／編輯嗰陣先做，唔
-- 影響呢個一次性 backfill。
-- ---------------------------------------------------------------------------

-- (1) CHECK constraint：name／tel 唔可以同時空（跟 zod 層一致，DB 層再
-- 加一重）。`NOT VALID` 唔用——呢個係新表，冚唪唥現有行（0 行）一定滿足，
-- 唔使分開驗證現有資料嗰步。
ALTER TABLE "guard_emergency_contacts"
  ADD CONSTRAINT "guard_emergency_contacts_name_or_tel_check"
  CHECK ("name" IS NOT NULL OR "tel" IS NOT NULL);

-- (2) Partial unique index：同一個 guard 最多一行 is_primary=true（電話／
-- 地址各自獨立）。
CREATE UNIQUE INDEX "guard_phones_guard_id_primary_key"
  ON "guard_phones" ("guard_id")
  WHERE "is_primary";

CREATE UNIQUE INDEX "guard_addresses_guard_id_primary_key"
  ON "guard_addresses" ("guard_id")
  WHERE "is_primary";

-- ---------------------------------------------------------------------------
-- (3) 資料搬遷：guards.tel／address／emergency_contact_name／
-- emergency_contact_tel 非空 → 起一行新表底（primary phone／primary
-- address／一個 emergency contact，source='migration:<col>'）。刻意唔郁
-- guards 表本身呢幾個值——由呢個 migration 之後起，呢幾個舊欄先變做「由
-- 新表 sync 返嚟」嘅同步值（見 src/lib/guards/contacts.ts
-- syncLegacyGuardContactColumns()）。空白（trim 之後係空字串）一律跳過，
-- 唔起行——呢個 migration 幂等（重跑：`guard_phones` 有
-- `UNIQUE(guard_id, tel)`，重複執行會撞呢個 constraint 而 fail 成個
-- migration statement，但 `prisma migrate deploy` 本身唔會重跑已經
-- apply 咗嘅 migration，呢度純粹俾將來人手核對時心裡有數）。
-- ---------------------------------------------------------------------------

-- guards.tel → guard_phones（primary=true）。
INSERT INTO "guard_phones" (id, guard_id, tel, is_primary, source, created_at, updated_at)
SELECT
  md5(random()::text || clock_timestamp()::text || id::text || 'tel')::uuid, -- 唔用 gen_random_uuid()：PG 12 或以下冇內置
  id,
  TRIM(tel),
  true,
  'migration:tel',
  now(),
  now()
FROM guards
WHERE tel IS NOT NULL AND TRIM(tel) <> '';

-- guards.address → guard_addresses（primary=true）。
INSERT INTO "guard_addresses" (id, guard_id, address, is_primary, source, created_at, updated_at)
SELECT
  md5(random()::text || clock_timestamp()::text || id::text || 'address')::uuid,
  id,
  TRIM(address),
  true,
  'migration:address',
  now(),
  now()
FROM guards
WHERE address IS NOT NULL AND TRIM(address) <> '';

-- guards.emergency_contact_name／emergency_contact_tel → 一行
-- guard_emergency_contacts（`sort_order=0`）。淨係兩者其中一個非空先起
-- 行（同 CHECK constraint 一致：唔可以兩個都空）——`NULLIF(TRIM(...), '')`
-- 將空字串正規化做 NULL，等空白值都當「冇填」處理（唔會存一行兩個欄都
-- 係空字串嘅垃圾記錄）。
INSERT INTO "guard_emergency_contacts" (id, guard_id, name, tel, sort_order, source, created_at, updated_at)
SELECT
  md5(random()::text || clock_timestamp()::text || id::text || 'emergency')::uuid,
  id,
  NULLIF(TRIM(emergency_contact_name), ''),
  NULLIF(TRIM(emergency_contact_tel), ''),
  0,
  'migration:emergency_contact',
  now(),
  now()
FROM guards
WHERE (emergency_contact_name IS NOT NULL AND TRIM(emergency_contact_name) <> '')
   OR (emergency_contact_tel IS NOT NULL AND TRIM(emergency_contact_tel) <> '');

-- ---------------------------------------------------------------------------
-- (4) AI 隔離：`ai.audit_log` view 重建——WP-MULTI 三張新表嘅 audit_log
-- 行（table_name IN ('guard_phones','guard_emergency_contacts',
-- 'guard_addresses')）一律 WHERE 排除（結構性——AI 助手連 row 都讀唔
-- 到，唔淨係靠 scrub_json 剝個別 key）。`ai.*` schema 本身冇 `ai.guard_
-- phones`／`ai.guard_emergency_contacts`／`ai.guard_addresses` 呢三個
-- view（見 20260912130100_wp_ai1_readonly_schema／20260917000000 之後
-- 一路都冇加），所以 `guard_lookup`／`sql_select ai.*` 呢類工具結構上已
-- 經完全接觸唔到呢三張表本身；呢度加嘅 WHERE 係補埋 `ai.audit_log`
-- （記緊「邊張表邊一行點樣改咗」嘅審計表，唔受「表冇對應 ai.* view」
-- 保護——`recent_audit`/`sql_select ai.audit_log` 一直讀得到任何
-- table_name 嘅 before/after，唔擋就會漏電話/姓名/地址出去）。
-- scrub_json() 嘅 blocked_keys（見 20260917010000_wp_pii_ai_audit_log_
-- scrub）保留原班（唔加減），WHERE 子句係獨立多一重防線。
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW ai.audit_log AS
SELECT
  id, actor_user_id, table_name, row_id, action,
  ai.scrub_json(before, ARRAY[
    'password_hash', 'otp_secret', 'tel', 'bank_info',
    'hkid', 'date_of_birth', 'address', 'emergency_contact_name',
    'emergency_contact_tel', 'sia_permit_no', 'safety_card_no',
    'bank_name', 'bank_account_no', 'bank_payee_name',
    'blacklist_check_result', 'blacklist_check_date'
  ]) AS before,
  ai.scrub_json(after, ARRAY[
    'password_hash', 'otp_secret', 'tel', 'bank_info',
    'hkid', 'date_of_birth', 'address', 'emergency_contact_name',
    'emergency_contact_tel', 'sia_permit_no', 'safety_card_no',
    'bank_name', 'bank_account_no', 'bank_payee_name',
    'blacklist_check_result', 'blacklist_check_date'
  ]) AS after,
  ip, created_at
FROM public.audit_log
WHERE table_name NOT IN ('guard_phones', 'guard_emergency_contacts', 'guard_addresses');
