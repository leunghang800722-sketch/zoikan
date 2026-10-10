# a-bundle 基準報告：建置體積／死碼／重複碼
量度對象：main @ c2b07d0（detached worktree `/Users/macbookpro/zoi-kan-wt-a-bundle`，已清走）。Next 15.5.25，`npm ci` 後 `npm run build`。
自報 model ID：claude-sonnet-5-5。原始輸出：同目錄 `a-build.log`、`a-knip.txt`、`a-depcheck.txt`、`a-jscpd.txt`、`a-tsc.txt`、`a-lint.txt`、`jscpd-out/jscpd-report.json`。
全程只讀；冇改 repo、冇碰 `.env`／`data/`／DB。

## 0. 一句睇晒
- Client JS 唔肥：共用 First Load 103 kB（gz 後），最重頁 `/month-close` 142 kB、`/triage` 135 kB。openai／@anthropic-ai／exceljs／bcryptjs／iron-session 全部唔喺 client bundle。
- 最大單一 client 依賴係 pdfjs-dist：424.6 KB chunk（gz 129 KB）＋ worker 1.18 MB（`.next/static/media/pdf.worker.min.*.mjs`），但只係 `/guards/new-from-docs` dynamic import 先載，唔拖其他頁。
- `.next/static/css` 有一份 472 KB（gz 164 KB）CSS，437 個 `@font-face`（Noto Sans HK 切片）；瀏覽器只會按 unicode-range 下載用到嗰幾個 woff2，但每頁都要載成份 CSS，係全站最大「固定成本」候選。
- src 冇「確定無人用」嘅檔案（knip 23 個 unused file 全部係 `scripts/` 入面手動跑嘅 CLI／lib）；真正低風險可刪嘅係 1 個 devDependency 型別包、約 130+ 個純 `export` 關鍵字多餘（改成唔 export）。
- 重複碼只有 2.90%（2157 行／74334 行），但集中喺「(app) 各頁嘅表格殼／載入列／狀態 state／apiPost 儲存流程」同「兩條 chat route／兩個 chat client 近乎同一份」。

## 1. 建置（`npm run build`，約 18s compile）
指令：`npm run build > a-build.log`；`.next/static` 量度用 `du -sk`、`find … -exec ls -l`。
備註：build log 有 359 行 `Retrying 1/3...`（next/font/google 下載 Noto Sans HK 切片重試），最終成功；網絡差嘅環境 build 時間會受影響（layout.tsx 已有註解講 offline build 會 throw）。

### 1.1 `(app)` 頁面（唔計 /api；Size／First Load JS 係 Next 報嘅 gzip 後數）
| Route | Size | First Load JS |
|---|---|---|
| / | 2.37 kB | 114 kB |
| /_not-found | 1 kB | 104 kB |
| /approvals | 5.67 kB | 108 kB |
| /audit-log | 4.88 kB | 108 kB |
| /brokers | 5.1 kB | 112 kB |
| /change-password | 2.81 kB | 106 kB |
| /feedback | 4.17 kB | 110 kB |
| /feedback/[id] | 4.82 kB | 111 kB |
| /guard-fix | 10.8 kB | 114 kB |
| /guards | 15.1 kB | 124 kB |
| /guards/import | 5.62 kB | 117 kB |
| /guards/new-from-docs | 9.76 kB | 121 kB |
| /login | 1.69 kB | 104 kB |
| /manifest.webmanifest | 486 B | 103 kB |
| /month-close | 17.5 kB | 142 kB |
| /my-receivable | 3.04 kB | 109 kB |
| /quotas | 4.63 kB | 110 kB |
| /rate-cards | 9.33 kB | 112 kB |
| /reports/gross-margin | 3.63 kB | 113 kB |
| /reports/longterm-payroll | 9.25 kB | 112 kB |
| /reports/monthly-close | 7.6 kB | 120 kB |
| /reports/ops-digest | 5.52 kB | 108 kB |
| /reports/payroll | 3.54 kB | 109 kB |
| /reports/shortfall | 166 B | 112 kB |
| /roles | 6.05 kB | 109 kB |
| /roster | 2.64 kB | 112 kB |
| /roster-uploads | 11 kB | 117 kB |
| /roster-uploads/[id]/reconcile | 10.2 kB | 120 kB |
| /roster/[site]/[month] | 17.4 kB | 124 kB |
| /sites | 5.43 kB | 112 kB |
| /triage | 2.03 kB | 135 kB |
| /users | 6.74 kB | 110 kB |

Shared by all：103 kB（`chunks/1255-*.js` 46.4 kB＋`chunks/4bd1b696-*.js` 54.2 kB＋其他 2.14 kB）。
觀察：`/triage` 頁本身得 2 kB 但 First Load 135 kB（比 shared 多 32 kB，應該係 TriageDialog 699 行＋依賴）；`/reports/shortfall` 166 B（內容喺 `ShortfallDashboard.tsx` 432 行，經 layout/共用 chunk 載入）。

### 1.2 `.next/static` 體積（未壓縮磁碟大小）
- `.next/static` 合共 10,028 KB；`chunks/` 2,856 KB（202 個 .js）；`media/` 6.5 MB（111 個 woff2＋pdf.worker 1.18 MB）；`css/` 2 個檔共 ~520 KB。
- 最大 10 個 chunk（KB 係未壓縮）：
  1. `9b0008ae.*.js` 424.6 KB（pdfjs-dist 本體，gz 129 KB，async）
  2. `framework-*.js` 213.9 KB（React／ReactDOM）
  3. `1255-*.js` 169.6 KB（shared，gz 46 KB）
  4. `4bd1b696-*.js` 169.0 KB（shared，gz 54 KB）
  5. `main-*.js` 125.2 KB
  6. `polyfills-*.js` 110.0 KB
  7. `1948-*.js` 90.5 KB
  8. `app/(app)/guards/page-*.js` 62.0 KB
  9. `app/(app)/month-close/page-*.js` 61.1 KB
  10. `app/(app)/roster/[site]/[month]/page-*.js` 55.5 KB
  （其後：`app/(app)/layout-*.js` 44.7 KB、`roster-uploads/page` 37.8 KB）
- 冇 `ANALYZE` 流程（next.config.ts 無 bundle-analyzer），按指示唔加依賴，用檔案大小＋grep chunk 內容代替。

### 1.3 Client 依賴檢查
指令：`grep -rlE "api\.openai|@anthropic-ai|anthropic\.com" .next/static/chunks` → 0 命中；`grep -rlE "exceljs|jszip|bcryptjs|iron-session" .next/static/chunks` → 0 命中。
- openai／@anthropic-ai/sdk：只喺 `src/lib/ai/llm.ts` 等 server 檔 import，**冇入 client bundle**。
- pdfjs-dist：只喺 `src/lib/guards/ocr/browser-images.ts:91`（`await import("pdfjs-dist")`），由 `NewFromDocsClient.tsx` 用；`react-loadable-manifest` 顯示只掛喺 `/guards/new-from-docs`。設計正確。
- 可優化（非必要）：polyfills 110 KB 係 Next 固定成本；CSS 472 KB 內 437 個 `@font-face`（見 0 節）。

## 2. 死碼
### 2.1 knip（`npx -y knip@latest`，無 config，預設 entry）
計數：Unused files 23｜Unused dependencies 1｜Unused devDependencies 1｜Unlisted dependencies 2｜Unused exports 234（其中 `src/` 約 180，其餘 `scripts/`）｜Unused exported types 101｜Duplicate exports 3。
重要：**src 零個 unused file**。knip 預設只當 package.json 嘅 scripts 做 entry，所以手動 `tsx scripts/...` 嘅 CLI 全被報 unused。

### 2.2 depcheck（`npx -y depcheck`）
- Unused devDependencies：`@tailwindcss/postcss`、`eslint-config-next`、`tailwindcss` —— **全部誤判**（postcss.config.mjs／eslint.config.mjs 的 `compat.extends("next/core-web-vitals")`／`@import "tailwindcss"` 間接引用）。
- Missing：`jszip`（tests/longterm-payroll-maxwell-import.test.ts；knip 同時報 `src/lib/longterm-payroll/maxwell-import.ts:12`）。

### 2.3 Unused file 二次確認（23 個）
方法：`grep -rIE` 搜 import 路徑（src／tests／scripts）、搜 `*.md` 提及、搜 Dockerfile、搜 package.json；`git log -1` 睇最後修改。

**誤判（有 Dockerfile／scripts／tests 引用）**
| 檔案 | 證據 |
|---|---|
| scripts/ai/assistant-startup-log.ts | Dockerfile:44 CMD 每次啟動都跑 |
| scripts/ai/guard-ocr-selftest.ts | Dockerfile:44 CMD 背景跑；`src/lib/guards/ocr/selftest-log.ts` 配套 |
| scripts/db/daemon.ts | `scripts/db/start.ts:27` 以 spawn tsx 起佢（`db:start`） |
| scripts/opening/lib/mixed-billing-sites.ts | `scripts/opening/build-aug-plan.ts` import |
| scripts/opening/lib/sources.ts、lib/types.ts | `scripts/opening/build-aug-plan.ts`／`apply-aug-plan.ts` import（路徑 grep 嘅其他命中係同名無關檔） |
| scripts/staff-import/lib/fields-locate.ts、fields-render.ts、fields-spec.ts | 被 13～16 號 script 同 `fields-*` import；`scripts/staff-import/README-STAFF-FIELDS.md` 有記載 |
| scripts/staff-import/13-fields-crops.ts、14-fields-queue.ts、15-fields-merge.ts、16-permit-ocr.ts | 彼此依賴，README-STAFF-FIELDS.md 記載流程步驟 |

**疑似（手動 CLI，冇人 import、冇 package.json 入口；文件可能仍有講；唔建議未問老闆就刪）**
| 檔案 | 最後 commit | 證據 |
|---|---|---|
| scripts/staff-import/09-dob-crops.ts | 2026-10-03 | 無 import；只喺 P2-版面重設計計劃.md 提及 |
| scripts/staff-import/10-address-second-read.ts | 2026-10-03 | 同上 |
| scripts/staff-import/11-form-address-crops.ts | 2026-10-03 | 同上 |
| scripts/staff-import/12-name-second-read.ts | 2026-10-04 | 同上，docs/api.md 有提 |
| scripts/staff-import/17-build-package-v3.ts | 2026-10-05 | 只 import `lib/package-v3`；任何 md 都冇提；最像孤兒 |
| scripts/ai/guard-ocr-smoke.ts | 2026-10-05 | 只喺 docs 提及（手動 smoke） |
| scripts/db/one-off/rotate-db-password.ts | 2026-09-25 | 一次性，已用過（名為 one-off） |
| scripts/guard-fix/verify-postorder-pairs-local.ts | 2026-10-09 | tests/wp-postorder-pairs-csv-parse.test.ts:88 註解指向佢；讀 `data/`，本機工具 |
| scripts/opening/build-aug-plan.ts／apply-aug-plan.ts | 2026-10-10 | 已套用嘅 8 月開盤 script；prisma migration 同 docs 有引；`gate:aug-e2e`（scripts/gate/aug-e2e-check.ts）會引用 → 鎖月資料來源，**唔好刪** |

**確定無人用（src 內）**：冇。

### 2.4 依賴
- `@types/bcryptjs`（package.json:50）：**確定可刪**。證據：bcryptjs@3.0.3 自帶型別（`node_modules/bcryptjs/package.json` 有 `"types"`＋`index.d.ts`／`types.d.ts`）；knip 報 unused。刪後跑 `npx tsc --noEmit` 驗證。
- `eslint-config-next`：**誤判，要保留**（eslint.config.mjs:13）。
- `jszip` unlisted：目前靠 `exceljs@4.4.0 → jszip@3.10.2` 傳遞依賴。`src/lib/longterm-payroll/maxwell-import.ts:12` 直接 import，屬 production 檔。風險：exceljs 升級換咗 jszip 就爆。建議加入 dependencies（加依賴宣告，不是新增套件）。
- 另：`exceljs`、`dotenv`、`csv-parse`、`async-exit-hook` 在 devDependencies，但 `exceljs`（src 多處）同 `csv-parse` 有被 production code 用；Dockerfile:11 用 `npm ci --include=dev` 所以現時 OK，屬宣告不準，非 bug。

### 2.5 Unused exports／types（234／101）
- 純「多餘 `export`」（內部有用、外部無人 import）：例如 `src/lib/broker-dto.ts` 的 11 個 `*_BROKER_FIELDS`、`src/lib/ai-rate-limit.ts`（DEFAULT_AI_DAILY_LIMIT／AI_QUOTA_ACTIONS／getAiDailyLimit）、`src/lib/auth/session.ts`（3 個 DEFAULT_*／SESSION_RENEW_AFTER_SECONDS／absoluteRemainingSeconds）、`src/lib/guards/import/limits.ts`（4 個）、`src/lib/guards/import/ext.ts`（5 個）、`src/lib/ai/actions.ts`（5 個）。不是死碼，只係 export 多餘；改動零 runtime 影響。
- 真正疑似死函數（定義喺度、knip 報 unused、要逐個 grep 確認同檔內有無用）：`src/lib/api/query.ts` `pickFields`／`coerceDateFields`；`src/lib/api/case.ts` `snakeToCamel`；`src/lib/guard-fix/plan.ts` `formatPlanSummaryMd`／`describeDbTarget`；`src/lib/guard-fix/sources.ts` `parseUTeamWorksheet`／`loadUTeamList`；`src/lib/guard-fix/postorder.ts` `derivePostorderLongtermPostsFromPostorderGrid`；`src/components/reconcile/data.ts` `clearReconcileDataCache`／`loadNeedsBoss`；`src/app/(app)/roster-uploads/[id]/reconcile/UnresolvedCells.tsx` `NeedsBossBox`／`reasonKinds`；`src/lib/ai/db.ts` `AiDbNotConfiguredError`。需逐個確認有冇同檔內部引用／測試用（tests 亦算 knip entry，所以 knip 已計 tests）。
- Duplicate exports：`src/components/ui/Field.tsx`（inputCls|selectCls）、`src/lib/guards/import/project.ts`（兩組 alias）。

### 2.6 tsc 未用變數（`npx tsc --noEmit --noUnusedLocals --noUnusedParameters`）
共 7 個錯誤（全部 TS6133），src 5＋tests 2：
```
src/lib/month-close/auto/pricing.ts(150,3): 'ctx' is declared but never read
src/lib/month-close/auto/pricing.ts(670,26): 'siteId' ...
src/lib/month-close/auto/triage.ts(236,3): 'ev' ...
src/lib/month-close/one-click.ts(222,49): 'actorUserId' ...
src/lib/month-close/one-click.ts(222,70): 'ip' ...
tests/e2e/roster-upload.spec.ts(333,57): 'n' ...
tests/e2e/roster-upload.spec.ts(334,54): 'n' ...
```
全部係未用參數／區域變數，清理屬低風險，但 `pricing.ts`／`settlement` 屬定價路徑，改完要跑 `gate:locked-months`（簽名改變可能波及呼叫端）。
`npm run lint`：0 warning、0 error。

## 3. 重複碼（`npx -y jscpd src --min-tokens 60 --format typescript,tsx --reporters console,json`）
總：425 檔、74,334 行；206 組 clone；重複 2,157 行（2.90%）；tsx 2.86%（666 行）、ts 2.92%（1,491 行）。

### 3.1 最大 15 組
| # | 行數 | A | B |
|---|---|---|---|
| 1 | 41 | lib/ui/ai-chat-client.ts:53-93 | lib/ui/feedback-chat-client.ts:41-84 |
| 2 | 34 | app/(app)/reports/monthly-close/page.tsx:410-443 | app/(app)/reports/payroll/PayrollReportClient.tsx:164-199 |
| 3 | 34 | app/api/ai/chat/route.ts:82-115 | app/api/feedback/session/chat/route.ts:75-110 |
| 4 | 23 | lib/month-close/auto/pricing.ts:326-348 | lib/pricing/resolve-rate.ts:243-266 |
| 5 | 22 | app/api/ai/chat/route.ts:42-63 | app/api/feedback/session/chat/route.ts:41-56 |
| 6 | 20 | app/api/ai/chat/route.ts:63-82 | app/api/feedback/session/chat/route.ts:56-75 |
| 7 | 18 | app/(app)/brokers/page.tsx:1-18 | app/(app)/sites/page.tsx:1-11 |
| 8 | 18 | lib/roster-upload/layout.ts:54-71 | lib/roster-upload/parse.ts:29-41 |
| 9 | 18 | lib/ui/api-client.ts:21-38 | lib/ui/api-client.ts:71-86 |
| 10 | 17 | app/api/ai/chat/route.ts:114-130 | app/api/feedback/session/chat/route.ts:124-143 |
| 11 | 17 | app/api/guards/[id]/phones/route.ts:21-37 | app/api/guards/[id]/staff-numbers/route.ts:19-35 |
| 12 | 17 | app/api/shift-types/route.ts:10-26 | app/api/sites/route.ts:11-23 |
| 13 | 17 | lib/roster-export.ts:324-340 | lib/roster-export.ts:962-972 |
| 14 | 16 | app/api/ai/chat/route.ts:218-233 | app/api/feedback/session/chat/route.ts:211-226 |
| 15 | 16 | app/api/roster-uploads/[id]/reconcile/apply/route.ts:14-29 | …/reconcile/resolve-subsite/route.ts:14-26 |

AI chat／feedback chat 兩條 route＋兩個 client 合共約 41+34+22+20+17+16 ≈ 150 行重複。

### 3.2 (app) 大檔之間嘅重複
- RosterEditor.tsx（2792 行）、GuardsClient.tsx（2558 行）跨檔重複只有細段（≤13 行，如 GuardsClient:1752-1764 與 approvals/page.tsx:208-220、rate-cards:512-524 一樣）；檔內自重複主要喺 RosterEditor（:298-307↔:1222-1231、:919-928↔:1121-1130 等，各 ~10 行）。即係**大檔問題主要係「單檔過大／職責太多」，唔係 copy-paste**。
- 跨頁真正重複嘅模式（jscpd 數十個 6～15 行 clone 全部落喺呢啲）：
  1. 表格殼＋「載入緊…」列（`<tr><td className={tableCls.tdMuted} colSpan={colCount}>載入緊…</td></tr>`）：approvals:208-220、brokers:377-389、sites:304-318、rate-cards:512-524、GuardsClient:1752-1764、quotas、roster-uploads:697-705。
  2. 同樣一組 state（`rows/loading/error/notice/drawerOpen/editingId/form/formError/saving`）：brokers:89-100、quotas:51-61、users:87-99、GuardsClient:298-317、sites:97-103。
  3. 儲存流程（`setSaving → apiPost → setFormError → setDrawerOpen(false) → setNotice → load()`）：brokers:303-316、sites:236-249、quotas:149-162。
  4. 頁頭 import 區（10～18 行近乎一樣）：brokers↔sites、brokers↔quotas↔GuardsClient↔rate-cards。
  5. 「未定价分組清單」: reports/monthly-close:410-443↔payroll:164-199（34 行）、gross-margin:170-182。
  6. 雞頭 EmptyState＋桌面表格 header 開頭：brokers:363-371↔sites:292-300↔rate-cards:496-504↔GuardsClient:1736-1745。

### 3.3 重複碼合併候選（估計可慳行數；粗估＝重複行數×(次數-1)，減去新共用元件本身約 20～60 行）
| 候選 | 範圍 | 估計淨慳 | 風險／會唔會觸及定價·結算·報表口徑 |
|---|---|---|---|
| A. 抽 `useChatStream`／共用 chat client（ai-chat-client＋feedback-chat-client） | lib/ui 兩檔 | ~35～40 行 | 低；不觸及數字 |
| B. 抽 chat route 共用 handler（rate-limit／session／stream 骨架） | api/ai/chat/route.ts＋api/feedback/session/chat/route.ts | ~120～150 行 | 中（API 行為要逐字一致、有 e2e 測試）；不觸及數字 |
| C. `<TableLoadingRow colSpan>`＋`<TableEmptyState>` 元件 | 約 10 頁 | ~80～120 行 | 低；純 UI |
| D. `useCrudPage` hook（rows/loading/drawer/form/saving/notice 與儲存流程） | brokers／sites／quotas／users／rate-cards／GuardsClient 部分 | ~150～250 行 | 中（表單細節各頁不同）；唔觸及數字，但 rate-cards 屬價目卡 UI，要 e2e 覆蓋 |
| E. 未定价分組清單元件（monthly-close／payroll／gross-margin） | reports 3 頁 | ~45～60 行 | 低～中：只抽顯示，唔改計算；仍屬報表頁，改完跑 `gate:reports` |
| F. `lib/month-close/auto/pricing.ts:326-348` ↔ `lib/pricing/resolve-rate.ts:243-266` 合一 | 定價 resolve 邏輯 | ~20 行 | **高：定價核心**，必須跑 `gate:pricing` 同 `gate:locked-months` |
| G. API route 小樣板（phones↔staff-numbers、shift-types↔sites、reconcile apply↔resolve-subsite） | api 6 檔 | ~50 行 | 低 |
| H. RosterEditor／GuardsClient 拆檔（非去重，係拆分） | 2792／2558 行 | 唔慳行數，改善維護 | 中；roster 屬核心 UI，需 e2e |
合計粗估 ~500～650 行（佔 src 約 0.7～0.9%）。結論：去重回報有限，大檔拆分比去重更值。

## 4. 其他指標
### 4.1 src LOC（`find … -name '*.ts' -o -name '*.tsx' | xargs cat | wc -l`）
- 總計：433 個 ts/tsx，74,453 行（`src/app` 30,816；`src/lib` 39,178；`src/components` 4,615）。
- `src/app/(app)` 19,777；`src/app/api` 10,666。
- `src/lib` 大目錄：month-close 5,771｜guards 5,122｜reports 4,717｜roster-upload 4,326｜ai 3,038｜guard-fix 2,647｜api 2,131｜longterm-payroll 2,128｜pricing 1,922｜triage 1,750｜ops 884｜ui 875｜rbac 842。
- `src/components`：ai 1,021｜month-close 879｜reconcile 541｜ui 527。
- (app) 頁面目錄：guards 3,656｜roster 2,996｜reports 2,535｜roster-uploads 2,139｜month-close 1,482｜guard-fix 1,026｜sites 782｜rate-cards 770｜brokers 660｜users 457｜quotas 425｜approvals 398。

### 4.2 `"use client"`
指令：`grep -rlE "^['\"]use client['\"]" src`。
- 66 個檔（佔 433 個 ts/tsx 嘅 15.2%；佔 90 個 tsx 嘅 73%）；client 檔合共 22,743 行＝src 嘅 30.5%。
- 每個頁面 client 檔 LOC（目錄合計）：roster/[site]/[month] 2,792（1 檔）｜guards 2,558｜month-close 1,482（14 檔）｜roster-uploads/[id]/reconcile 1,082（2）｜roster-uploads 1,046｜guard-fix 1,026｜reports/longterm-payroll 938｜sites 782｜rate-cards 746｜(root) 702（2）｜reports/monthly-close 680｜brokers 660｜guards/new-from-docs 589｜guards/import 451｜users 444｜quotas 425｜approvals 398｜reports/gross-margin 340｜roles 337｜my-receivable 301｜reports/payroll 299｜audit-log 288｜reports/ops-digest 252｜roster 184｜triage 151｜feedback/[id] 143｜feedback 136｜change-password 120。
- 其他大 client 檔：components/ai/AiAssistantSidebar.tsx 767、TriageDialog.tsx 699、MonthCloseTriageDialog.tsx 567。
- 觀察：多數 `page.tsx` 本身就係 `"use client"`（brokers／sites／quotas／approvals／roster-uploads／guard-fix 等 6～10 個），即成頁 client render；可考慮 server page＋client island，但需另行評估（呢類頁面資料本來就靠 client fetch）。

### 4.3 scripts
- `package.json` scripts：**41 條**；經 python 檢查 `tsx|zsh|node <path>` 引用嘅檔案：**0 條指向已不存在檔案**。
- `scripts/` 各目錄 .ts LOC／檔數：staff-import 4,863／41｜seed 3,211／17｜gate 2,809／10｜opening 2,386／6｜report 1,888／10｜ai 501／4｜db 484／10｜perf 208／2｜assignments 56／1｜guard-fix 29／1。
- `scripts/one-off/`：只有 **1 個**檔 `term-guard-scan.py`（118 行，最後 commit 2026-10-10）。另 `scripts/db/one-off/rotate-db-password.ts`（2026-09-25）。
- 23 個 knip 報 unused 嘅 script 都係手動 CLI，見 2.3。

### 4.4 tools／archive
- `tools/` 只有 `tools/importer/`（舊 Python 匯入工具）。**git 追蹤內容**：48 檔，33 個 .py＝17,229 行 Python、12 個 csv mapping（164 行）、README 等；總計 18,124 行。
- 「LOC 652k」原因：主 repo 工作目錄 `tools/importer/venv`（untracked，81 MB／3,966 檔，內含 635,425 行第三方 .py）＋`work/`（171 MB，238 張 png）＋`out/`（6.1 MB）＋`.pytest_cache`，全部被 `.gitignore` 排除（worktree 內冇）。真正自家 code 係 17.2k 行 Python。`tools/` 磁碟總計 261 MB。
- `archive/`（gitignored，主 repo 本機）：只有 1 個檔 `P0-執行計劃-v1.1-Fable5.md`（11 KB，2026-09-04）。
- 附帶：repo 內 md 文件 7,194 行（`P2-版面重設計計劃.md` 488 KB／3,365 行最肥）；tests 194 個 .test.ts，約 46.6k 行。

## 5. 可以安全刪除（附證據）
| 項目 | 證據 | 驗證指令 |
|---|---|---|
| devDependency `@types/bcryptjs`（package.json:50） | bcryptjs@3 自帶 .d.ts；knip＋手動確認 | 刪後 `npx tsc --noEmit`、`npm run build` |
| tsc 報嘅 7 個未用變數／參數 | 見 2.6 | `npx tsc --noEmit --noUnusedLocals --noUnusedParameters` 應為 0；`pricing.ts`／`one-click.ts` 屬結算路徑，要 `gate:locked-months` |
| 多餘 `export` 關鍵字（~180 個 src／101 個 type） | knip 報、同檔內仍使用 | 改為不 export，tsc＋vitest；零 runtime 影響 |
| `jszip`：唔係刪，係補 `dependencies` 宣告 | 見 2.4 | `npm ls jszip` |

（src 內冇「整檔確定無人用」。）

## 6. 疑似（需人手或老闆決定）
1. `scripts/staff-import/17-build-package-v3.ts`、`09`～`12` 號 script：冇 import、冇 package.json 入口，md 只有零星提及；員工證件匯入流程多數已完成，可歸檔到 `archive/`（已 gitignore）或 `scripts/one-off`。刪除前確認匯入流程已完結（涉個人資料流程，非定價）。
2. `scripts/db/one-off/rotate-db-password.ts`（2026-09-25 一次性）。
3. `scripts/ai/guard-ocr-smoke.ts`（手動 smoke，docs 有記載）。
4. 疑似死函數（見 2.5 第二點清單）：`pickFields`、`coerceDateFields`、`snakeToCamel`、`formatPlanSummaryMd`、`describeDbTarget`、`parseUTeamWorksheet`、`loadUTeamList`、`derivePostorderLongtermPostsFromPostorderGrid`、`clearReconcileDataCache`、`loadNeedsBoss`、`NeedsBossBox`、`reasonKinds`、`AiDbNotConfiguredError`。需逐個確認同檔無內部使用及非預留 API。
5. `P2-版面重設計計劃.md`（488 KB）／`README-P1.md`／`在勤系統設計文件.md` 放喺 repo root，非 code，可移 docs/（不影響 build）。
6. 不要刪：`scripts/opening/*`（Aug 開盤＋`gate:aug-e2e`）、`scripts/db/daemon.ts`、`scripts/ai/assistant-startup-log.ts`／`guard-ocr-selftest.ts`（Dockerfile 啟動時跑）、`eslint-config-next`、`tailwindcss`、`@tailwindcss/postcss`。

## 7. 建議優先序（只供參考）
1. 加 `jszip` 到 dependencies、刪 `@types/bcryptjs`、清 7 個 TS6133（最低風險）。
2. 研究 472 KB 字型 CSS：改用 `next/font/local` 自帶少量切片或限制 weight／subset（要視乎 layout.tsx 現設定；先量 Lighthouse／實際傳輸量，再決定）。
3. 合併 AI chat／feedback chat 兩份近乎重複嘅 route＋client（~150 行）。
4. 抽 `TableLoadingRow`／`useCrudPage` 減 (app) 頁面樣板；拆 RosterEditor（2792）、GuardsClient（2558）。
5. 整理 `scripts/staff-import` 已完結步驟。
所有建議皆未實施；涉定價／結算檔案（F 項、2.6 pricing.ts／one-click.ts）改動前後必跑 `npm run gate:pricing` 及 `npm run gate:locked-months`。
