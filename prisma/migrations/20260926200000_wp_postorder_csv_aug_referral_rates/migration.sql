-- WP-POSTORDER-CSV（老闆 2026-09-26 緊急）：8 月「長工雞頭費」費率
-- migration 種子——CSV 路徑冇公式可以讀 rate（Google Sheets 匯出將公式
-- 變成值，見 src/lib/guard-fix/postorder.ts CSV grid parser），所以
-- `referral-fee.ts` 嘅 rate sync 淨係喺 xlsm 路徑（有公式）先寫
-- referral_fee_rates；CSV 路徑冇公式費率就跌返用表入面已有嘅費率——
-- 呢個 migration 就係補低嗰個「已有嘅費率」，等 CSV 路徑都計到啱數。
--
-- 資料源：data/2026-09/aug-payroll-trial/out/referral_postorder.json
-- （21 行「長工雞頭費」行，逐行 broker／sites／rate，dev-only、
-- gitignored）逐 (雞頭代號, 盤 canonical_name) 去重抽出嚟嘅費率——**淨係
-- 攞 broker code／盤名／費率**，唔要人名／金額／更數（鐵則：code/test/
-- docs/migration 唔准真名）。21 行入面同一 (雞頭,盤) 組合嘅費率全部
-- 一致（冇衝突），去重之後 16 組。
--
-- 用 brokers.code／sites.canonical_name(或 aliases) 查 id（唔硬編碼
-- uuid——正式站同 dev id 唔同，鐵則）。INSERT ... WHERE NOT EXISTS：
-- 雞頭／盤對唔到就淨係少插返嗰一行（0 行），唔 abort；已經有嗰個
-- (broker,site,month) 費率（例如之前 xlsm 上載已經寫咗）就唔覆蓋、跳過
-- （保留現用嘅費率，冇兩個資料源打架）。

WITH pairs (broker_code, site_name, rate) AS (
  VALUES
    ('K', '數碼港 CP5', 50::numeric),
    ('K', '數碼港 數據中心', 50::numeric),
    ('K', '數碼港 CP1-4', 50::numeric),
    ('W', 'HKU座頭', 30::numeric),
    ('K', 'IFC 70樓', 50::numeric),
    ('T', 'ML', 50::numeric), -- referral_postorder.json 原文「Weave ML」，實際盤 alias 係短代號「ML」（見
                               -- 20260926140000_wp_ltshift_postorder_site_aliases），matchSite() 淨係完全相等，
                               -- 唔准估，跟返個 alias 原文
    ('G', '城巴-柴灣車廠', 30::numeric),
    ('W', '城巴-柴灣車廠', 30::numeric),
    ('T', '城巴-創富車廠', 30::numeric),
    ('T', '城巴-黃竹坑車廠', 30::numeric),
    ('T', '城巴-東涌車廠', 30::numeric),
    ('K', '粉嶺安樂村貨倉', 60::numeric),
    ('T', '九龍企業大廈', 30::numeric),
    ('K', '啟航1331', 60::numeric),
    ('W', '啟航1331', 50::numeric),
    ('T', '恆星樓', 30::numeric)
),
resolved AS (
  SELECT DISTINCT b."id" AS broker_id, s."id" AS site_id, p.rate
  FROM pairs p
  JOIN "brokers" b ON b."code" = p.broker_code
  JOIN "sites" s ON s."canonical_name" = p.site_name OR p.site_name = ANY(s."aliases")
),
inserted AS (
  INSERT INTO "referral_fee_rates"
    ("id", "broker_id", "site_id", "month", "fee_per_shift", "created_at", "updated_at", "created_by")
  SELECT
    md5(random()::text || clock_timestamp()::text || r.broker_id || r.site_id || 'postorder_csv_aug_referral_rate')::uuid, -- 唔用 gen_random_uuid()：PG 12 或以下冇內置
    r.broker_id,
    r.site_id,
    DATE '2026-08-01',
    r.rate,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP,
    'migration:wp_postorder_csv_aug_referral_rates'
  FROM resolved r
  WHERE NOT EXISTS (
    SELECT 1 FROM "referral_fee_rates" e
    WHERE e."broker_id" = r.broker_id
      AND e."site_id" = r.site_id
      AND e."month" = DATE '2026-08-01'
      AND e."voided_at" IS NULL
  )
  RETURNING "id" AS rate_id, "broker_id" AS broker_id, "site_id" AS site_id, "fee_per_shift" AS fee_per_shift
)
INSERT INTO "audit_log" ("id", "actor_user_id", "table_name", "row_id", "action", "before", "after", "ip", "created_at")
SELECT
  md5(random()::text || clock_timestamp()::text || i.rate_id || 'postorder_csv_aug_referral_rate_audit')::uuid,
  NULL,
  'referral_fee_rates',
  i.rate_id,
  'migration_seed_rate',
  NULL,
  jsonb_build_object(
    'brokerId', i.broker_id,
    'siteId', i.site_id,
    'month', '2026-08-01',
    'feePerShift', i.fee_per_shift,
    'reason', 'WP-POSTORDER-CSV：8 月長工雞頭費費率種子（referral_postorder.json 抽取，CSV 路徑冇公式時嘅 fallback）'
  ),
  NULL,
  CURRENT_TIMESTAMP
FROM inserted i;
