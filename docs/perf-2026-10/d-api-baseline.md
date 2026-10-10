# d-api 基準報告：伺服器端 API／頁面延遲＋每 request DB 查詢數（BEFORE）

量度日期 2026-10-10；Agent D（`d-api`），model `claude-sonnet-5-5`；基於 main `c2b07d0`。

## 0. 重要前提（請先睇）
1. **`npm run db:seed` 喺 worktree 跑唔到**：seed 要讀 `tools/importer/out/wp2b/*.csv`（由私有真數據 `data/` 產生，gitignored），agent 規則唔准碰，所以報錯 `CSV 唔存在 …/wp2b/brokers.csv`。改為自己寫**純合成**生成器（`/private/tmp/claude-501/-Users-macbookpro-zoi-kan/41316f0d-3a34-4ae3-a8de-d2fb6db0b018/scratchpad/perf/d-api/gen-synth.ts`，用 `SCALE` 環境變數調規模），表結構／角色權限矩陣用 repo 嘅 `seedRolesPermissionsMatrix`，帳號用 seed 內嘅 dev fixture 老闆測試帳號（90000001，同 `scripts/perf/http-bench.sh` 一樣）。
2. 合成數據**冇定價異常、冇對數 warning、冇 triage／special_items／長工合約／長工糧**，所以報表類（尤其 longterm-payroll、gross-margin 未定價分支、guard-fix）喺真數據下可能更重；本報告係**下限**。
3. 現有量度機制：`scripts/perf/profile.ts`（`npm run perf:profile`，直接 call lib function，量牆鐘＋Prisma query event 數）、`snapshot.ts`（數字快照，驗優化冇改數）、`http-bench.sh`（`npm run perf:http`，curl 逐 URL 打 N 次取中位數）。三者都要連本機 dev DB（`.env`），我哋唔准用，所以另寫 `bench.sh`＋`qcount.py`（方法同 http-bench 一致：curl、5 次中位數）。**`http-bench.sh` 冇 DB 查詢數、冇 TTFB；profile.ts 冇 HTTP 層／layout**——本報告補呢兩樣。

## 1. 環境
- Mac：Apple M2 Pro、16 GB RAM、Darwin 25.6；Node v26.0.0；Next.js 15.5.25 `next start`（production build，`output: standalone` 警告但可行），port 3197，同機 curl（零網絡延遲）。
- DB：embedded-postgres（npm）PostgreSQL 18.4 on x86_64-apple-darwin24.6.0, compiled by Apple clang version 17.0.0 (clang-1700.6.3.2), 64-bit；port 54394，目錄 `/private/tmp/claude-501/d-api-pg`，TCP 127.0.0.1，無 pooler。Prisma 6（library engine）。
- 正式站係 Zeabur 新加坡，DB 同 app 之間有網絡 RTT；本機 RTT≈0，所以**查詢數越多嘅 endpoint，喺正式站放大越多**（每條 query 加一個 RTT，例如 1–2 ms × 查詢數）。

## 2. 方法
- 延遲：`bench.sh`——先登入拎 cookie，每個 URL warm-up 1 次，再打 5 次，取 `curl %{time_total}` 嘅 p50（第 3 個）同 max；TTFB＝`%{time_starttransfer}` p50；bytes＝`size_download`。PG statement logging 關閉（`log_min_duration_statement=-1`）時量。
- 查詢數：`qcount.py`——PG `log_min_duration_statement=0`（Prisma 6 library engine 唔受 `DEBUG=prisma:query` 控制，試過冇輸出，亦唔准改 `src/lib/db.ts`），每個 URL 打 1 次（server 已 warm），數 `execute` 行（parse／bind 唔計）。只記 SQL 形狀（`$n` 代參數），冇參數值。查詢數係**單次 request 嘅 PG round-trip 數**；已包含 `(app)/layout.tsx` 同 `requireSession`／`requirePermission`。
- 注意：頁面（`/…`）全部係**client component 殼**，SSR 只做 session＋layout，數據靠頁面 mount 後 call API（所以頁面 TTFB 近乎恆定 11–15 ms，真正慢係 API 加 client waterfall）。

## 3. 數據規模
### 3.1 合成 seed（本基準）
| 表 | 行數 |
|---|---:|
| guards | 540 |
| guard_phones | 540 |
| shift_records | 9,408 |
| roster_uploads | 180 |
| roster_upload_rows | 9,408 |
| audit_log | 20,008 |
| sites | 60 |
| shift_types | 180 |
| rate_cards | 227 |
| brokers | 8 |
| users | 4 |
| daily_requirements | 5,040 |
| month_closes | 2 |
| special_items | 0 |

（`guard_phones` 由生成器順手建；`users` 4 個：老闆／主管／會計／雞頭A；7、8 月已鎖月，9 月未鎖。）
### 3.2 同正式站差距（任務書所提數字；`docs/` 搵唔到更多確數）
- 保安員：正式站約 540 → seed 540（相若）。
- 8 月更數：正式站 3,508 → seed 8 月 3,508、7 月 3,500、9 月 2,400（總 9,408；每月級數相若）。
- 盤：seed 60（正式站未有確數，估計同級或更多）；audit_log：seed 20,001，正式站隨使用時間累積，應更大（audit-log 頁 COUNT 全表，見下）。
- **未模擬**：真實更表上載 `file_bytes`（seed 每份 30 KB 隨機）、triage 問題、長工合約／糧單、special_items、guard_phones 多筆、地址／緊急聯絡人、AI 對話、app_error_log。故 Aug 數據量級接近，但「廣度」遜於正式站。

## 4. 結果：頁面 SSR（HTTP 全頁，5 次，ms）
| URL | p50 ms | max ms | TTFB p50 ms | HTTP | bytes | DB 查詢數 | SQL 總 ms | 最大重複同形 |
|---|---:|---:|---:|---|---:|---:|---:|---:|
| `/` | 15 | 15 | 14 | 200 | 20,398 | 17 | 1.9 | 7 |
| `/roster` | 13 | 13 | 12 | 200 | 21,208 | 12 | 2.3 | 4 |
| `/roster/{SITE}/2026-08` | 15 | 17 | 14 | 200 | 19,989 | 14 | 2.1 | 5 |
| `/guards` | 14 | 14 | 13 | 200 | 24,785 | 18 | 1.7 | 9 |
| `/sites` | 12 | 13 | 11 | 200 | 21,482 | 12 | 1.7 | 4 |
| `/month-close?month=2026-08` | 12 | 13 | 12 | 200 | 28,832 | 12 | 1.7 | 4 |
| `/triage` | 12 | 15 | 12 | 200 | 20,371 | 12 | 2.3 | 4 |
| `/guard-fix` | 12 | 13 | 12 | 200 | 26,442 | 12 | 2.0 | 4 |
| `/roster-uploads` | 12 | 14 | 12 | 200 | 23,602 | 12 | 2.2 | 4 |
| `/reports/gross-margin?month=2026-08` | 12 | 13 | 11 | 200 | 23,662 | 12 | 2.1 | 4 |
| `/reports/monthly-close?month=2026-08` | 11 | 13 | 11 | 200 | 22,346 | 12 | 2.1 | 4 |
| `/reports/payroll?month=2026-08` | 12 | 13 | 11 | 200 | 23,766 | 14 | 2.1 | 5 |
| `/reports/shortfall` | 11 | 13 | 11 | 200 | 21,653 | 13 | 2.1 | 4 |
| `/reports/longterm-payroll?month=2026-08` | 12 | 13 | 11 | 200 | 34,436 | 12 | 1.8 | 4 |
| `/rate-cards` | 11 | 13 | 11 | 200 | 24,398 | 15 | 2.3 | 6 |
| `/brokers` | 11 | 13 | 11 | 200 | 22,351 | 12 | 2.1 | 4 |
| `/audit-log` | 11 | 11 | 11 | 200 | 23,719 | 12 | 2.1 | 4 |

讀法：17 個頁面 p50 11–15 ms、HTML 20–34 KB，幾乎全部由 layout 引起（見 §6）；`/` 同 `/guards` 多 5–6 條查詢。

## 5. 結果：API（GET，5 次，ms）
| URL | p50 ms | max ms | TTFB p50 ms | HTTP | bytes | DB 查詢數 | SQL 總 ms | 最大重複同形 |
|---|---:|---:|---:|---|---:|---:|---:|---:|
| `/api/roster/overview?month=2026-08` | 10 | 14 | 10 | 200 | 1,165 | 9 | 3.4 | 1 |
| `/api/shift-records?site_id={SITE}&work_date_from=2026-08-01&work_date_to=2026-08-31&view=grid` | 15 | 17 | 15 | 200 | 23,571 | 134 | 1.8 | 131 |
| `/api/shift-records/unpriced?month=2026-08&site_id={SITE}` | 5 | 5 | 5 | 200 | 103 | 9 | 0.7 | 1 |
| `/api/guards` | 29 | 35 | 29 | 200 | 87,514 | 306 | 4.8 | 301 |
| `/api/guards?take=500` | 121 | 124 | 120 | 200 | 435,914 | 1506 | 26.9 | 1501 |
| `/api/sites` | 9 | 10 | 9 | 200 | 34,122 | 64 | 0.8 | 61 |
| `/api/rate-cards` | 19 | 19 | 18 | 200 | 56,137 | 204 | 2.3 | 201 |
| `/api/brokers` | 3 | 4 | 3 | 200 | 2,496 | 12 | 0.2 | 9 |
| `/api/reports/gross-margin?month=2026-08` | 74 | 77 | 74 | 200 | 66,506 | 48 | 26.1 | 3 |
| `/api/reports/monthly-close?month=2026-08` | 34 | 35 | 34 | 200 | 18,542 | 29 | 17.7 | 3 |
| `/api/reports/payroll?month=2026-08` | 33 | 34 | 33 | 200 | 1,421 | 12 | 12.4 | 1 |
| `/api/reports/shortfall?date=2026-08-15` | 68 | 76 | 68 | 200 | 7,388 | 45 | 19.1 | 2 |
| `/api/month-close/one-click?month=2026-08` | 3 | 3 | 3 | 200 | 11 | 3 | 0.1 | 1 |
| `/api/triage/sessions` | 4 | 5 | 4 | 200 | 340 | 9 | 0.2 | 4 |
| `/api/guard-fix/runs` | 2 | 3 | 2 | 200 | 11 | 3 | 0.1 | 1 |
| `/api/roster-uploads?month=2026-08` | 15 | 24 | 15 | 200 | 46,693 | 4 | 6.1 | 1 |
| `/api/roster-uploads/pending-summary` | 432 | 441 | 432 | 200 | 132 | 894 | 70.6 | 120 |
| `/api/audit-log` | 22 | 24 | 22 | 200 | 26,554 | 262 | 7.6 | 259 |
| `/api/diagnostics/month?month=2026-08` | 63 | 67 | 63 | 200 | 18,931 | 54 | 25.0 | 2 |
| `/api/reports/month-health?month=2026-08` | 46 | 51 | 46 | 200 | 18,067 | 55 | 37.7 | 4 |
| `/api/reports/ops-digest?month=2026-08` | 47 | 48 | 47 | 200 | 5,369 | 37 | 51.2 | 3 |
| `/api/months/latest-with-data` | 3 | 3 | 3 | 200 | 26 | 3 | 0.1 | 1 |

備註：`/api/guard-fix/plan` 係 POST-only（GET 回 405）、`/api/roster-uploads` 要 `?month=`，已改量 `/api/guard-fix/runs`、`/api/roster-uploads?month=`，並加量 `/api/roster-uploads/pending-summary`（layout／上載頁都會用）。`/api/guards?take=500` 係 Guards 頁實際 call（`take=500`）。

## 6. Layout（`(app)/layout.tsx`）每頁固定查詢
任何頁面（以 `/triage`、`/brokers` 等純殼頁量）= **12 條查詢／~2 ms SQL**：
1. `users` 查 token_version／status／must_change_pwd（2 條，requireSession 同 layout 各一）
2. `roles` ＋ `role_permissions` ＋ `permissions`（getViewGrants 載入全角色權限，3 條）
3. `COUNT(*) shift_records WHERE status='pending_approval'`（審批 badge，**每頁都跑**；本機 ~1.1–1.5 ms，是 12 條中最慢，隨 shift_records 增長而升；若 `status` 無索引會全表掃）
4. `COUNT feedback_reports WHERE status='new'`
5. `role_permissions` 單項授權 `findFirst` ×4（`hasPermission`／導航，每次一條 round-trip）
6. `COUNT triage_questions`（待答 badge）
`/`、`/guards`、`/rate-cards` 等多數條 `role_permissions` 檢查（17／18／15 條）。正式站每條加 RTT，layout 單頁大約 12×RTT。

## 7. Top 10 最慢 API（p50）
| # | API | p50 ms | max ms | 查詢數 |
|---|---|---:|---:|---:|
| 1 | `/api/roster-uploads/pending-summary` | 432 | 441 | 894 |
| 2 | `/api/guards?take=500` | 121 | 124 | 1506 |
| 3 | `/api/reports/gross-margin?month=2026-08` | 74 | 77 | 48 |
| 4 | `/api/reports/shortfall?date=2026-08-15` | 68 | 76 | 45 |
| 5 | `/api/diagnostics/month?month=2026-08` | 63 | 67 | 54 |
| 6 | `/api/reports/ops-digest?month=2026-08` | 47 | 48 | 37 |
| 7 | `/api/reports/month-health?month=2026-08` | 46 | 51 | 55 |
| 8 | `/api/reports/monthly-close?month=2026-08` | 34 | 35 | 29 |
| 9 | `/api/reports/payroll?month=2026-08` | 33 | 34 | 12 |
| 10 | `/api/guards` | 29 | 35 | 306 |

## 8. Top 10 最多查詢（頁面＋API）
| # | URL | 查詢數 | 最大重複同形 | SQL 總 ms | p50 ms |
|---|---|---:|---:|---:|---:|
| 1 | `/api/guards?take=500` | 1506 | 1501 | 26.9 | 121 |
| 2 | `/api/roster-uploads/pending-summary` | 894 | 120 | 70.6 | 432 |
| 3 | `/api/guards` | 306 | 301 | 4.8 | 29 |
| 4 | `/api/audit-log` | 262 | 259 | 7.6 | 22 |
| 5 | `/api/rate-cards` | 204 | 201 | 2.3 | 19 |
| 6 | `/api/shift-records?site_id={SITE}&work_date_from=2026-08-01&work_date_to=2026-08-31&view=g` | 134 | 131 | 1.8 | 15 |
| 7 | `/api/sites` | 64 | 61 | 0.8 | 9 |
| 8 | `/api/reports/month-health?month=2026-08` | 55 | 4 | 37.7 | 46 |
| 9 | `/api/diagnostics/month?month=2026-08` | 54 | 2 | 25.0 | 63 |
| 10 | `/api/reports/gross-margin?month=2026-08` | 48 | 3 | 26.1 | 74 |

## 9. 慢 SQL 形狀（每個 endpoint 最慢 3 條，查詢數>20 者；單位 PG 側 ms）

**`/api/shift-records?site_id={SITE}&work_date_from=2026-08-01&work_date_to=2026-08`**（134 條）
- 0.451 ms：`SELECT "public"."shift_records"."id", "public"."shift_records"."work_date", "public"."shift_records"."site_id", "public"."shift_records"."shift_type_id", "public"."shift_`
- 0.151 ms：`SELECT COUNT(*) AS "_count$_all" FROM (SELECT "public"."shift_records"."id" FROM "public"."shift_records" WHERE ("public"."shift_records"."site_id" = $n AND "public"."shi`
- 0.043 ms：`SELECT "public"."users"."id", "public"."users"."token_version", "public"."users"."status"::text FROM "public"."users" WHERE ("public"."users"."id" = $n AND 1=1) LIMIT $n `

**`/api/guards`**（306 條）
- 0.616 ms：`SELECT "public"."guards"."id", "public"."guards"."staff_no", "public"."guards"."staff_no_mw", "public"."guards"."name_zh", "public"."guards"."name_en", "public"."guards".`
- 0.29 ms：`SELECT COUNT(*) AS "_count$_all" FROM (SELECT "public"."guards"."id" FROM "public"."guards" WHERE "public"."guards"."status" = CAST($n::text AS "public"."ActiveStatus") O`
- 0.284 ms：`SELECT "public"."role_permissions"."id" FROM "public"."role_permissions" LEFT JOIN "public"."permissions" AS "j0" ON ("j0"."id") = ("public"."role_permissions"."permissio`

**`/api/guards?take=500`**（1506 條）
- 1.652 ms：`SELECT "public"."guards"."id", "public"."guards"."staff_no", "public"."guards"."staff_no_mw", "public"."guards"."name_zh", "public"."guards"."name_en", "public"."guards".`
- 1.454 ms：`SELECT "public"."role_permissions"."id" FROM "public"."role_permissions" LEFT JOIN "public"."permissions" AS "j0" ON ("j0"."id") = ("public"."role_permissions"."permissio`
- 0.447 ms：`SELECT "public"."role_permissions"."id" FROM "public"."role_permissions" LEFT JOIN "public"."permissions" AS "j0" ON ("j0"."id") = ("public"."role_permissions"."permissio`

**`/api/sites`**（64 條）
- 0.143 ms：`SELECT "public"."sites"."id", "public"."sites"."canonical_name", "public"."sites"."aliases", "public"."sites"."client_name", "public"."sites"."client_group", "public"."si`
- 0.041 ms：`SELECT COUNT(*) AS "_count$_all" FROM (SELECT "public"."sites"."id" FROM "public"."sites" WHERE "public"."sites"."status" IN (CAST($n::text AS "public"."SiteStatus"),CAST`
- 0.035 ms：`SELECT "public"."users"."id", "public"."users"."token_version", "public"."users"."status"::text FROM "public"."users" WHERE ("public"."users"."id" = $n AND 1=1) LIMIT $n `

**`/api/rate-cards`**（204 條）
- 0.424 ms：`SELECT "public"."rate_cards"."id", "public"."rate_cards"."site_id", "public"."rate_cards"."shift_type_id", "public"."rate_cards"."broker_id", "public"."rate_cards"."guard`
- 0.136 ms：`SELECT "public"."role_permissions"."id" FROM "public"."role_permissions" LEFT JOIN "public"."permissions" AS "j0" ON ("j0"."id") = ("public"."role_permissions"."permissio`
- 0.072 ms：`SELECT COUNT(*) AS "_count$_all" FROM (SELECT "public"."rate_cards"."id" FROM "public"."rate_cards" WHERE "public"."rate_cards"."voided_at" IS NULL OFFSET $n) AS "sub"`

**`/api/reports/gross-margin?month=2026-08`**（48 條）
- 8.452 ms：`SELECT "public"."shift_records"."id", "public"."shift_records"."status"::text, "public"."shift_records"."record_type"::text, "public"."shift_records"."guard_wage_snapshot`
- 3.492 ms：`SELECT "public"."shift_records"."id", "public"."shift_records"."site_id", "public"."shift_records"."shift_type_id", "public"."shift_records"."client_rate_snapshot", "publ`
- 2.218 ms：`SELECT SUM("public"."shift_records"."client_rate_snapshot") AS "_sum$client_rate_snapshot", "public"."shift_records"."site_id", "public"."shift_records"."shift_type_id" F`

**`/api/reports/monthly-close?month=2026-08`**（29 條）
- 7.488 ms：`SELECT "public"."shift_records"."id", "public"."shift_records"."status"::text, "public"."shift_records"."record_type"::text, "public"."shift_records"."guard_wage_snapshot`
- 2.454 ms：`SELECT SUM("public"."shift_records"."client_rate_snapshot") AS "_sum$client_rate_snapshot", "public"."shift_records"."site_id", "public"."shift_records"."shift_type_id" F`
- 2.347 ms：`SELECT COUNT(*) AS "_count$_all", SUM("public"."shift_records"."client_rate_snapshot") AS "_sum$client_rate_snapshot", SUM("public"."shift_records"."guard_wage_snapshot")`

**`/api/reports/shortfall?date=2026-08-15`**（45 條）
- 3.933 ms：`SELECT "public"."shift_records"."id", "public"."shift_records"."site_id", "public"."shift_records"."shift_type_id", "public"."shift_records"."client_rate_snapshot", "publ`
- 2.066 ms：`SELECT SUM("public"."shift_records"."client_rate_snapshot") AS "_sum$client_rate_snapshot", "public"."shift_records"."site_id", "public"."shift_records"."shift_type_id" F`
- 1.951 ms：`SELECT "public"."shift_records"."id", "public"."shift_records"."site_id" FROM "public"."shift_records" WHERE ("public"."shift_records"."work_date" >= $n AND "public"."shi`

**`/api/roster-uploads/pending-summary`**（894 條）
- 1.846 ms：`SELECT "public"."roster_upload_rows"."id", "public"."roster_upload_rows"."guard_id", "public"."roster_upload_rows"."resolved_site_id", "public"."roster_upload_rows"."uplo`
- 1.23 ms：`SELECT "public"."roster_upload_rows"."id", "public"."roster_upload_rows"."guard_id", "public"."roster_upload_rows"."resolved_site_id", "public"."roster_upload_rows"."uplo`
- 1.019 ms：`SELECT "public"."roster_upload_rows"."id", "public"."roster_upload_rows"."guard_id", "public"."roster_upload_rows"."resolved_site_id", "public"."roster_upload_rows"."uplo`

**`/api/audit-log`**（262 條）
- 2.39 ms：`SELECT "public"."audit_log"."id", "public"."audit_log"."actor_user_id", "public"."audit_log"."table_name", "public"."audit_log"."row_id", "public"."audit_log"."action", "`
- 1.888 ms：`SELECT COUNT(*) AS "_count$_all" FROM (SELECT "public"."audit_log"."id" FROM "public"."audit_log" WHERE 1=1 OFFSET $n) AS "sub"`
- 0.353 ms：`SELECT "public"."role_permissions"."id" FROM "public"."role_permissions" LEFT JOIN "public"."permissions" AS "j0" ON ("j0"."id") = ("public"."role_permissions"."permissio`

**`/api/diagnostics/month?month=2026-08`**（54 條）
- 6.625 ms：`SELECT "public"."shift_records"."id", "public"."shift_records"."status"::text, "public"."shift_records"."record_type"::text, "public"."shift_records"."guard_wage_snapshot`
- 4.877 ms：`SELECT COUNT(*) AS "_count$_all" FROM (SELECT "public"."shift_records"."id" FROM "public"."shift_records" LEFT JOIN "public"."guards" AS "j0" ON ("j0"."id") = ("public"."`
- 2.187 ms：`SELECT COUNT("public"."shift_records"."guard_wage_snapshot") AS "_count$guard_wage_snapshot", COUNT("public"."shift_records"."client_rate_snapshot") AS "_count$client_rat`

**`/api/reports/month-health?month=2026-08`**（55 條）
- 7.441 ms：`SELECT "public"."shift_records"."id", "public"."shift_records"."status"::text, "public"."shift_records"."record_type"::text, "public"."shift_records"."guard_wage_snapshot`
- 5.252 ms：`SELECT "public"."shift_records"."id", "public"."shift_records"."work_date", "public"."shift_records"."site_id", "public"."shift_records"."shift_type_id", "public"."shift_`
- 2.319 ms：`SELECT COUNT(*) AS "_count$_all", "public"."roster_upload_rows"."upload_id", "public"."roster_upload_rows"."guard_id", "public"."roster_upload_rows"."work_date", "public"`

**`/api/reports/ops-digest?month=2026-08`**（37 條）
- 9.569 ms：`SELECT "public"."shift_records"."id", "public"."shift_records"."status"::text, "public"."shift_records"."record_type"::text, "public"."shift_records"."guard_wage_snapshot`
- 8.681 ms：`SELECT "public"."shift_records"."id", "public"."shift_records"."status"::text, "public"."shift_records"."record_type"::text, "public"."shift_records"."guard_wage_snapshot`
- 7.341 ms：`SELECT count(*) FILTER (WHERE table_name = 'rate_cards' AND action = 'create' AND (after->>'copied_from') IS NOT NULL)::int AS rate_card_copied, count(*) FILTER (WHERE ta`


## 10. 重點觀察（只量度，唔係改動建議）
1. **N+1 欄位權限檢查**：`/api/guards`（100 行→306 條）、`?take=500`（→1,506 條）、`/api/sites`（64）、`/api/rate-cards`（204）、`/api/audit-log`（262）、`/api/shift-records` 單盤（134）都係「每行 3 條或每行 1 條 `role_permissions findFirst`」，源頭係 `hasPermission()`（`src/lib/rbac/requirePermission.ts:97`）喺 DTO 逐行 scrub 時重複打同一 (role, module, action)。本機每條 ~0.02 ms，SQL 總時間細（`guards?take=500` 只 27 ms SQL，但牆鐘 121 ms，主要係 Prisma 往返＋序列化＋436 KB）；**正式站每條加跨機 RTT，呢類 endpoint 預期放大最多**。屬純讀權限判斷，改動不觸及定價／結算口徑。
2. **`/api/roster-uploads/pending-summary` 432 ms、894 條查詢**（120 次重複 `roster_uploads` 查詢＋大量逐份 `roster_upload_rows` 查詢）——全系統最慢，layout／上載頁會用。
3. 報表類單 call 本身慢（gross-margin 74 ms／66 KB、shortfall 68、diagnostics 63、ops-digest 47、month-health 46、monthly-close 34）但查詢數 12–55 條，SQL 時間只佔 ~25–50%，其餘係 JS 計算＋序列化。gross-margin 響應 66 KB。
4. 頁面殼 SSR 只 11–15 ms，但 HTML 20–34 KB／頁（`/reports/longterm-payroll` 34 KB），且數據靠 client waterfall；實際用戶感知延遲＝殼＋首批 API（例如 `/guards` 頁 =~14+121 ms）。
5. 本基準本機 RTT≈0、CPU 空閒、並發=1；正式站 = 加 RTT、冷 Prisma pool、並發。要量並發請另起 autocannon（未做）。

## 11. 重跑（優化後用同一方法量 AFTER）
全部喺 `/private/tmp/claude-501/-Users-macbookpro-zoi-kan/41316f0d-3a34-4ae3-a8de-d2fb6db0b018/scratchpad/perf/d-api/`：
- `start-server.sh`（port 3197，PID 寫入 `server.pid`；optional 參數 `debug` 冇用）；`pgdaemon.mjs`（PG，port 54394，statement log 寫 `pgstmt.log`，密碼喺 `.pgpw`）；`setlog.mjs`／`setlog-off.mjs`（開／關 `log_min_duration_statement`）。
- 步驟：①worktree 新 code `npm ci && DATABASE_URL=… npx prisma migrate deploy && npm run build`；②`node pgdaemon.mjs &`、DB 用 `gen-synth.ts` 重生（同 seed，固定亂數種子，`SCALE=1`；要複製入 worktree `scripts/_gen-synth.ts` 以解析 `@/` alias，`DATABASE_URL=… npx tsx scripts/_gen-synth.ts`）；③`./start-server.sh`；④延遲：`zsh bench.sh out.tsv 5`（出 TSV：kind／url／p50／max／TTFB／status／bytes）；⑤查詢數：`node setlog.mjs` 後 `python3 qcount.py out.json`；⑥`node setlog-off.mjs`。
- 本次原始結果：`bench2.tsv`（延遲）、`qcount1.json`（查詢，含每個 endpoint 最慢 3 條 SQL 形狀）、`counts.txt`（行數）。
- 對比 BEFORE 時請確保 `shift_records` 等行數相同（`counts.txt`）。
