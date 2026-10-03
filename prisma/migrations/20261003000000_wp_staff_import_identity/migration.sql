-- WP-STAFF-IMPORT Stage B1（§26.4，老闆 2026-10-03）：身份證號碼＋電話號碼
-- 做保安員唯一識別。全部冪等、唔 RAISE、唔 abort、唔用 gen_random_uuid()、
-- 唔寫死 id；重複資料入 guard_identity_conflicts（只存 sha256，唔存明文），
-- 有重複就唔建 unique index（app 層照樣擋新增）。

-- (a) guards.hkid 正規化 backfill（等同 src/lib/guards/identity.ts canonicalHkid()：
-- 大寫、去空白／全形空白／NBSP（用 replace() 字面字元，SQL_ASCII／UTF8 都啱）、去半形／全形括號）。淨係改「正規化之後符合身份證
-- 格式」嘅值；唔符合格式（例如護照號）原樣保留；空白字串變 NULL。
UPDATE "guards" SET "hkid" = NULL WHERE "hkid" IS NOT NULL AND btrim("hkid") = '';

UPDATE "guards"
SET "hkid" = upper(regexp_replace(replace(replace(replace(replace("hkid", '（', ''), '）', ''), '　', ''), ' ', ''), '[\s()]', '', 'g'))
WHERE "hkid" IS NOT NULL
  AND upper(regexp_replace(replace(replace(replace(replace("hkid", '（', ''), '）', ''), '　', ''), ' ', ''), '[\s()]', '', 'g')) ~ '^[A-Z]{1,2}[0-9]{6}[0-9A]$'
  AND "hkid" <> upper(regexp_replace(replace(replace(replace(replace("hkid", '（', ''), '）', ''), '　', ''), ' ', ''), '[\s()]', '', 'g'));

-- (b) 重複記錄表（kind: dup_hkid／dup_tel；淨存涉及嘅 guard id，**唔存**身份證／電話明文或 hash——
-- 身份證／電話空間細，hash 可窮舉）。新表放 public，唔放 ai schema（AI 助手結構上睇唔到）。
CREATE TABLE IF NOT EXISTS "guard_identity_conflicts" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "guard_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMP(3),
    CONSTRAINT "guard_identity_conflicts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "guard_identity_conflicts_kind_check" CHECK ("kind" IN ('dup_hkid', 'dup_tel'))
);
-- 唯一性：id ＝ md5(kind || 排序後 guard id)（決定性），PK 已保證同一組唔會重複記。

-- 現有重複 hkid → 記入 conflicts（id 用 kind＋排序後 guard id 決定性生成，重跑冪等）。
INSERT INTO "guard_identity_conflicts" ("id", "kind", "guard_ids")
SELECT md5('dup_hkid:' || array_to_string(array_agg("id" ORDER BY "id"), ',')),
       'dup_hkid',
       array_agg("id" ORDER BY "id")
FROM "guards"
WHERE "hkid" IS NOT NULL
GROUP BY "hkid"
HAVING count(*) > 1
ON CONFLICT ("id") DO NOTHING;

-- 現有跨 guard 重複電話 → 記入 conflicts。
INSERT INTO "guard_identity_conflicts" ("id", "kind", "guard_ids")
SELECT md5('dup_tel:' || array_to_string(g.ids, ',')), 'dup_tel', g.ids
FROM (
  SELECT array_agg(DISTINCT "guard_id" ORDER BY "guard_id") AS ids
  FROM "guard_phones"
  GROUP BY "tel"
  HAVING count(DISTINCT "guard_id") > 1
) g
ON CONFLICT ("id") DO NOTHING;

-- 冇重複先建 partial unique index（hkid 非 NULL 唯一；guard_phones.tel 全表唯一）。
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "guards" WHERE "hkid" IS NOT NULL GROUP BY "hkid" HAVING count(*) > 1) THEN
    EXECUTE 'CREATE UNIQUE INDEX IF NOT EXISTS "guards_hkid_key" ON "guards"("hkid") WHERE "hkid" IS NOT NULL';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "guard_phones" GROUP BY "tel" HAVING count(*) > 1) THEN
    EXECUTE 'CREATE UNIQUE INDEX IF NOT EXISTS "guard_phones_tel_key" ON "guard_phones"("tel")';
  END IF;
END $$;

-- (d) 更表逐格配對依據（staff_no／tel／name_tel／name_only／alias／override）。
ALTER TABLE "roster_upload_rows" ADD COLUMN IF NOT EXISTS "match_basis" TEXT;

-- AI 隔離：沿用 20260929010000_wp_boss5_bank_code 嘅 view 定義，淨係喺排除
-- 清單加 guard_identity_conflicts（其餘逐字唔變）。
CREATE OR REPLACE VIEW ai.audit_log AS
SELECT
  id, actor_user_id, table_name, row_id, action,
  ai.scrub_json(before, ARRAY[
    'password_hash', 'otp_secret', 'tel', 'bank_info',
    'hkid', 'date_of_birth', 'address', 'emergency_contact_name',
    'emergency_contact_tel', 'sia_permit_no', 'safety_card_no',
    'bank_name', 'bank_account_no', 'bank_payee_name', 'bank_code',
    'blacklist_check_result', 'blacklist_check_date'
  ]) AS before,
  ai.scrub_json(after, ARRAY[
    'password_hash', 'otp_secret', 'tel', 'bank_info',
    'hkid', 'date_of_birth', 'address', 'emergency_contact_name',
    'emergency_contact_tel', 'sia_permit_no', 'safety_card_no',
    'bank_name', 'bank_account_no', 'bank_payee_name', 'bank_code',
    'blacklist_check_result', 'blacklist_check_date'
  ]) AS after,
  ip, created_at
FROM public.audit_log
WHERE table_name NOT IN (
  'guard_phones', 'guard_emergency_contacts', 'guard_addresses',
  'roster_uploads', 'roster_upload_rows', 'roster_reconcile_decisions',
  'staff_list_uploads', 'guard_fix_runs', 'month_close_runs',
  'guard_longterm_contracts', 'guard_leave_balances', 'guard_avg_wages',
  'longterm_payroll_runs', 'longterm_payroll_lines', 'longterm_payroll_inputs',
  'guard_identity_conflicts'
);
