-- WP-LTSHIFT §19 第二部分（老闆 2026-09-26 追加要求）：Postorder「物業
-- 名稱」短代號補做 sites.aliases，等 `matchSite()`（`src/lib/roster-
-- upload/match.ts`）撞中率由 56% 提升——短代號唔係 PII（純粹盤嘅簡稱），
-- 可以入 git。對照表嚟自 `data/2026-09/aug-payroll-trial/scripts/
-- s03_sitemap.py` 嘅 `SITE_MAP_RULES`（呢個表本身係搬字過紙由
-- `tools/importer/importer/master_roster.py` 嘅同名常數，用嚟生成
-- `tools/importer/out/wp2b/sites.csv`——即係話呢批 S0xx code 本來就係
-- 我哋 sites.csv 嘅 site_id，對照關係可信）；再交叉對照
-- `data/2026-09/aug-payroll-trial/out/po_cells_sited.json`（3,524 格
-- 已經用 SITE_MAP_RULES 逐格計低 site_id，實測驗證過）確認每個短代號
-- 真係喺 8 月 Postorder 出現過幾多格。
--
-- 純粹 UPDATE `sites.aliases`（`aliases = array(distinct unnest(aliases
-- || 新代號))`）——冪等（`SELECT DISTINCT` 保證唔會纍加重複）、對唔存在
-- 嘅盤（`canonical_name` 搵唔到）0 行受影響，唔會出錯。
--
-- CP5 特別處理：Postorder 「CP5」prop 代號喺原始邏輯（SITE_MAP_RULES
-- property_ic 規則）會根據 col A 有冇「IC」字先分流去「數碼港 CP5 IC」
-- （S012）；但 S012 喺我哋系統本身係純billing構造盤，冇自己嘅
-- shift_records（IC 崗更實際寫喺姊妹盤「數碼港 CP5」，
-- shift_type.billing_group=monthly_ic，見 WP-AUG-OPENING-2）——所以呢度
-- 淨係將「CP5」呢個代號加做「數碼港 CP5」（S011）嘅 alias，冇加去
-- 「數碼港 CP5 IC」（避免一個代號撞兩個盤，`matchSite()` 淨係做完全
-- 相等對照，一個字串淨係應該撞一個盤）；IC 崗嘅完整字句（例如「數碼港
-- CP5 IC」）已經可以直接撞中 S012 嘅 canonical_name，唔使額外 alias。
--
-- 「啟航1331 IC」／「啟航1331 K」係總表 col A 喺「啟航1331」後面加嘅
-- zone／更份代號（IC/K 唔係盤名一部分），對應 site 都係「啟航1331」
-- 本身；加做完整字串 alias（唔淨係短代號「啟航」）方便直接撞中，冇加
-- 埋單獨「OT」（太泛用，容易同其他盤嘅未來資料撞名，呢個個案得 2 格，
-- 留返 `siteLabelFallbackRaw` fallback／人手覆核）。
UPDATE "sites" SET "aliases" = ARRAY(SELECT DISTINCT unnest("aliases" || ARRAY['殷樺']::text[])) WHERE "canonical_name" = '殷樺花園';
UPDATE "sites" SET "aliases" = ARRAY(SELECT DISTINCT unnest("aliases" || ARRAY['粉嶺倉']::text[])) WHERE "canonical_name" = '粉嶺安樂村貨倉';
UPDATE "sites" SET "aliases" = ARRAY(SELECT DISTINCT unnest("aliases" || ARRAY['OL']::text[])) WHERE "canonical_name" = 'Weave OL';
UPDATE "sites" SET "aliases" = ARRAY(SELECT DISTINCT unnest("aliases" || ARRAY['港Y']::text[])) WHERE "canonical_name" = 'HKU Y更';
UPDATE "sites" SET "aliases" = ARRAY(SELECT DISTINCT unnest("aliases" || ARRAY['港C','港C1','港X']::text[])) WHERE "canonical_name" = 'HKU座頭';
UPDATE "sites" SET "aliases" = ARRAY(SELECT DISTINCT unnest("aliases" || ARRAY['醫學院']::text[])) WHERE "canonical_name" = 'HKU 醫學院';
UPDATE "sites" SET "aliases" = ARRAY(SELECT DISTINCT unnest("aliases" || ARRAY['凱和']::text[])) WHERE "canonical_name" = '屯門凱和山';
UPDATE "sites" SET "aliases" = ARRAY(SELECT DISTINCT unnest("aliases" || ARRAY['數碼']::text[])) WHERE "canonical_name" = '數碼港 CP1-4';
UPDATE "sites" SET "aliases" = ARRAY(SELECT DISTINCT unnest("aliases" || ARRAY['CP5']::text[])) WHERE "canonical_name" = '數碼港 CP5';
UPDATE "sites" SET "aliases" = ARRAY(SELECT DISTINCT unnest("aliases" || ARRAY['DC','CP5 數據中心']::text[])) WHERE "canonical_name" = '數碼港 數據中心';
UPDATE "sites" SET "aliases" = ARRAY(SELECT DISTINCT unnest("aliases" || ARRAY['ML','Weave Mid-level']::text[])) WHERE "canonical_name" = 'Weave Hospital Road';
UPDATE "sites" SET "aliases" = ARRAY(SELECT DISTINCT unnest("aliases" || ARRAY['RR']::text[])) WHERE "canonical_name" = 'Weave Robinson';
UPDATE "sites" SET "aliases" = ARRAY(SELECT DISTINCT unnest("aliases" || ARRAY['企業']::text[])) WHERE "canonical_name" = '九龍企業大廈';
UPDATE "sites" SET "aliases" = ARRAY(SELECT DISTINCT unnest("aliases" || ARRAY['啟航','啟航1331 IC','啟航1331 K']::text[])) WHERE "canonical_name" = '啟航1331';
UPDATE "sites" SET "aliases" = ARRAY(SELECT DISTINCT unnest("aliases" || ARRAY['柴廠']::text[])) WHERE "canonical_name" = '城巴-柴灣車廠';
UPDATE "sites" SET "aliases" = ARRAY(SELECT DISTINCT unnest("aliases" || ARRAY['創富廠']::text[])) WHERE "canonical_name" = '城巴-創富車廠';
UPDATE "sites" SET "aliases" = ARRAY(SELECT DISTINCT unnest("aliases" || ARRAY['屯廠']::text[])) WHERE "canonical_name" = '城巴-屯門車廠';
UPDATE "sites" SET "aliases" = ARRAY(SELECT DISTINCT unnest("aliases" || ARRAY['東廠']::text[])) WHERE "canonical_name" = '城巴-東涌車廠';
UPDATE "sites" SET "aliases" = ARRAY(SELECT DISTINCT unnest("aliases" || ARRAY['將廠']::text[])) WHERE "canonical_name" = '城巴-將軍澳車廠';
UPDATE "sites" SET "aliases" = ARRAY(SELECT DISTINCT unnest("aliases" || ARRAY['黃竹廠']::text[])) WHERE "canonical_name" = '城巴-黃竹坑車廠';
UPDATE "sites" SET "aliases" = ARRAY(SELECT DISTINCT unnest("aliases" || ARRAY['西九廠']::text[])) WHERE "canonical_name" = '城巴-西九龍車廠';
UPDATE "sites" SET "aliases" = ARRAY(SELECT DISTINCT unnest("aliases" || ARRAY['上環廠']::text[])) WHERE "canonical_name" = '城巴-上環車廠';
UPDATE "sites" SET "aliases" = ARRAY(SELECT DISTINCT unnest("aliases" || ARRAY['小欖']::text[])) WHERE "canonical_name" = '屯門小欖樂怡街5號';
UPDATE "sites" SET "aliases" = ARRAY(SELECT DISTINCT unnest("aliases" || ARRAY['怡安']::text[])) WHERE "canonical_name" = '怡安168';
UPDATE "sites" SET "aliases" = ARRAY(SELECT DISTINCT unnest("aliases" || ARRAY['蔚峰園']::text[])) WHERE "canonical_name" = '淺水灣道11號蔚峰園';
UPDATE "sites" SET "aliases" = ARRAY(SELECT DISTINCT unnest("aliases" || ARRAY['美心']::text[])) WHERE "canonical_name" = '美心集團中心';
UPDATE "sites" SET "aliases" = ARRAY(SELECT DISTINCT unnest("aliases" || ARRAY['控制室','威信控制室']::text[])) WHERE "canonical_name" = '控制室';
UPDATE "sites" SET "aliases" = ARRAY(SELECT DISTINCT unnest("aliases" || ARRAY['Patrol']::text[])) WHERE "canonical_name" = '都會大學夜巡邏';
UPDATE "sites" SET "aliases" = ARRAY(SELECT DISTINCT unnest("aliases" || ARRAY['MU']::text[])) WHERE "canonical_name" = '都會大學學生宿舍';
UPDATE "sites" SET "aliases" = ARRAY(SELECT DISTINCT unnest("aliases" || ARRAY['半更']::text[])) WHERE "canonical_name" = '恆星樓';
UPDATE "sites" SET "aliases" = ARRAY(SELECT DISTINCT unnest("aliases" || ARRAY['葵發']::text[])) WHERE "canonical_name" = '葵發大廈';
UPDATE "sites" SET "aliases" = ARRAY(SELECT DISTINCT unnest("aliases" || ARRAY['CX']::text[])) WHERE "canonical_name" = '國泰城';
UPDATE "sites" SET "aliases" = ARRAY(SELECT DISTINCT unnest("aliases" || ARRAY['CDF','機場CDF']::text[])) WHERE "canonical_name" = '免稅店';
UPDATE "sites" SET "aliases" = ARRAY(SELECT DISTINCT unnest("aliases" || ARRAY['皇崗']::text[])) WHERE "canonical_name" = '新皇崗口岸';
UPDATE "sites" SET "aliases" = ARRAY(SELECT DISTINCT unnest("aliases" || ARRAY['創科園']::text[])) WHERE "canonical_name" = '港深創新及科技園';
UPDATE "sites" SET "aliases" = ARRAY(SELECT DISTINCT unnest("aliases" || ARRAY['海洋廠']::text[])) WHERE "canonical_name" = '城巴-海洋公園車廠';
UPDATE "sites" SET "aliases" = ARRAY(SELECT DISTINCT unnest("aliases" || ARRAY['希慎']::text[])) WHERE "canonical_name" = '希慎廣場';
