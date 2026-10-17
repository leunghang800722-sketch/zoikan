# P3：zoikan 全系統 UI/UX 重構＋效能優化計劃（分析報告＋架構草案＋清理清單）

- 規劃：Fable 5.1（2026-10-10 晚）。分析由 4 個子 agent 並行做（A 建置體積／死碼：Sonnet 5.5；B 效能＋bug 靜態審計：Opus 5.5；C UI/UX＋導覽盤點：Opus 5.5；D 本機 API／查詢數基準：Sonnet 5.5），正式站前端基準由規劃者用老闆 Chrome 唯讀量度。
- 附錄（原始報告，`docs/perf-2026-10/`）：`a-bundle-baseline.md`、`b-code-audit.md`、`c-ux-inventory.md`、`d-api-baseline.md`、`p-prod-baseline.md`。
- **呢份係規劃階段產出。未經老闆確認 §2 架構同 §3 清理清單之前，唔會大規模改 UI／刪 code。**
- 前提：正式站已喺 Zeabur 新加坡；全系統用詞「保安員」；鎖月（2026-07、08）數字唔准變，凡觸及 `src/lib/reports|pricing|month-close` 必跑 `gate:locked-months`。

---

## 0. 一頁總結

**系統規模**：29 頁、148 條 API、433 個 ts/tsx（74,453 行）、194 個測試檔（3,323 條）＋26 個 e2e。Client JS 唔肥（共用 103 kB gz，最重頁 142 kB），測試覆蓋好。

**真正嘅問題唔係「code 太多」，係四樣：**

1. **權限檢查逐行打 DB（N+1）**：`/api/guards?take=500` 一次 request 打 **1,506 條查詢**（保安員頁、價目、雞頭、審批、更表編輯器 5 頁都載呢個 API，正式站每次 2.0–2.4 秒）。`/api/sites` 64 條、`/api/rate-cards` 204 條、`/api/audit-log` 262 條、單盤 `/api/shift-records` 134 條，全部同一個根源（`src/lib/api/field-groups.ts:161-191` 每行每欄組 `hasPermission()` 打一次 DB）。
2. **首頁太重**：`pending-summary` 對全部月份未對完嘅上載逐份序列對數（**894 條查詢、本機 432 ms、正式站 1.1–1.6 秒**），尚欠卡又跑成份毛利表；老闆身份 layout 每頁仲自己 HTTP 打自己攞權限。
3. **UI 唔一致、入口太多、導覽太長**：老闆側欄 23 條連結 5 組（700px 高度要捲）；月份選擇器 16 頁 5 種寫法（換頁月份唔保留）；按鈕 3 套主色＋198 個手寫 `<button>`；色值寫死 398 次、字號寫死 662 次；同一件事（上載更表、上載 Postorder、鎖月、重算、新增保安員）各有 2–7 個入口；「待處理」喺 9 個地方各自計。
4. **每頁固定成本**：一份 472 KB（gz 164 KB）字型 CSS 每頁必載（437 段 Noto Sans HK `@font-face`），比全部 JS 仲大；AI 側欄對話紀錄每頁載（7.5 KB），側欄收埋都載。

**另外揪出 1 個鎖月保護漏洞（確定）**：`POST /api/reports/referral-fee/recompute` 冇鎖月檢查，可以重算已鎖嘅 8 月介紹費（§3.2 B-1）。建議列做第一件事。

**死碼結論**：`src/` 入面**冇**整個檔案係無人用嘅；可以安全刪嘅係 1 個型別依賴、7 個未用變數、約 180 個多餘 `export`；重複碼只有 2.9%，最值得做嘅係拆兩個超大檔（更表編輯器 2,792 行、保安員頁 2,558 行）同合併兩條幾乎一樣嘅 chat route（~150 行）。

**量得到嘅目標（§4）**：保安員 API 查詢 1,506 → ≤20 條；首頁 pending-summary 1,150 ms → <400 ms；老闆側欄 23 → 17 條、唔使捲；字型 CSS 193 KB → <40 KB；月份選擇器 5 種 → 1 種；色值寫死 398 → <40。

---

## 1. 系統優化分析報告

### 1.1 現況數字（2026-10-10，main `c2b07d0`）

| 項目 | 數字 | 來源 |
|---|---|---|
| 頁面／API／元件／lib 檔 | 29／148／30 tsx／187 ts | 規劃者 |
| src 行數 | 74,453（app 30,816、lib 39,178、components 4,615） | A |
| `"use client"` | 66 個檔、22,743 行（src 30.5%）；18 個 page 成頁 client | A、B |
| 最大檔 | RosterEditor 2,792；GuardsClient 2,558；roster-uploads 1,046；guard-fix 1,026；longterm-payroll 938；AiAssistantSidebar 767；TriageDialog 699 | A |
| 測試 | 194 vitest 檔／3,323 條；26 e2e（6,037 行）；lint 0；tsc 0 | A |
| Client JS | 共用 103 kB gz；最重 `/month-close` 142、`/triage` 135、`/guards` 124、更表編輯器 124 | A |
| CSS | 472 KB（gz 164 KB）＋47 KB：437 段 Noto Sans HK `@font-face`，每頁載 | A、規劃者 |
| 重複碼 | 2.90%（2,157／74,334 行），206 組 | A |
| 死碼 | src 整檔 0；unused export 234＋type 101；TS6133 7 個；`@types/bcryptjs` 多餘；`jszip` 用咗但冇宣告 | A |
| Prisma index | 40 個 `@@index`；`shift_records.status`、`audit_log.created_at`、`rate_cards`（全冇）缺 | B、D |

### 1.2 正式站前端基準（香港→新加坡，老闆帳號，單次）

| 頁 | TTFB | load | 頁內 API 總等候（最慢一條） | 備註 |
|---|---|---|---|---|
| 首頁 | 1,815（冷）| 2,128 | pending-summary **1,587** ms | 每個內部角色都開 |
| /guards | 492 | 595 | guards **2,221** ms／47 KB | DOM 17,934 節點（540 人一次 render） |
| /month-close | 537 | 683 | one-click 698 ms／**191 KB** | 一個 run 嘅全部步驟＋報告都傳 |
| /sites | 448 | **2,629** | shift-types 447／56 KB | DOM 2,464 |
| /rate-cards | 576 | 982 | guards **2,409**；sites 839／45 KB；shift-types 636／56 KB | 6 個 API |
| /brokers | 482 | 1,084 | guards **2,006** | 4 個 API |
| /approvals | 496 | 922 | guards **2,036** | 5 個 API |
| 更表編輯器 | 674 | 1,096 | guards **2,325**（載兩次） | **11 個 API** |
| /guard-fix | 479 | 980 | postorder 打兩次（648＋1,086） | |
| 其餘報表頁 | 450–660 | 580–1,050 | 370–850 ms | |

API 單獨 p50（3 次）：最輕 API 地板 ~360 ms（香港→新加坡 TLS＋session＋權限）；`/api/guards` 643 ms／103 KB；`/api/sites` 490／45 KB；`/api/rate-cards` 565／74 KB；`/api/audit-log` 654／97 KB；`pending-summary` **1,151**；gross-margin 730（8 月 803）；month-health 771；diagnostics 746；ops-digest 640。完整表見附錄 p。

### 1.3 本機伺服器端基準（合成數據：540 保安員、60 盤、9,408 更、20k audit；RTT≈0）

| API | p50 | DB 查詢數 | 觀察 |
|---|---|---|---|
| `/api/guards?take=500`（保安員頁實際 call） | 121 ms | **1,506** | 1,501 條同形 `role_permissions` 查詢；回 436 KB |
| `/api/roster-uploads/pending-summary` | **432 ms** | **894** | 120 次重複 `roster_uploads`＋逐份 `roster_upload_rows`（連 `file_bytes`） |
| `/api/guards`（100 行） | 29 | 306 | |
| `/api/audit-log` | 22 | 262 | 全表 COUNT＋每行 before/after 再 gate |
| `/api/rate-cards` | 19 | 204 | |
| `/api/shift-records`（單盤月） | 15 | 134 | 更表編輯器 |
| `/api/sites` | 9 | 64 | |
| gross-margin／shortfall／diagnostics／ops-digest／month-health | 46–74 | 37–55 | SQL 只佔 25–50%，其餘 JS 計算＋序列化 |
| 任何頁面 layout | 11–15 | **12** | 每頁：session 查 2 次、權限 3 條、審批 badge `COUNT shift_records WHERE status=…`（冇 index，全表掃）、feedback count、4 條 `hasPermission`、triage count；老闆再加 1 次 loopback HTTP |

正式站每條查詢加一個容器間 RTT，所以查詢數多嘅 endpoint 放大最多——呢個就係點解本機 121 ms 嘅 guards API 喺正式站要 2 秒。

### 1.4 UI/UX 分析（摘自 C，完整見附錄 c）

**導覽列**：老闆 5 組 23 條（排更 5、主檔 6、財務 7、系統 4＋首頁），分組按「資料類型」唔係「做嘢次序」——「尚欠總覽」（今日人手）喺財務、「待答問題」（一半係月結題）喺主檔、財務組次序同實際流程倒轉（一鍵結算排喺月結工作台後面）。分組真相散喺 3 個地方（`nav.ts`、`nav-active.ts`、各頁 kicker），改一處易漏兩處。29 頁有 6 頁唔喺導覽（對數頁、更表編輯器都要兩層先到）。

**重複入口**（同一 API 多個 UI）：上載更表 xlsx ×2、上載 U Team／Postorder ×2、鎖月 ×2（＋RightRail）、下載 Postorder Excel ×2、「重算」掣 ×7、新增／補保安員 ×5、「未定價／冇結算單位」Notice 複製 ×5、尚欠 dashboard 同首頁 100% 一樣、「待處理」9 處各自計（單位有題／更／格／盤／項）、答題框兩套外觀。

**一致性**：月份選擇器 16 頁 5 種寫法，只有 3 頁讀網址月份（換頁跳返本月，會計做 9 月月結每頁都要再揀）；按鈕 `Button primary` 藍 vs Drawer `btnPrimary` 近黑 vs 198 個手寫 `<button>`（76 種 className）；錯誤提示 `Banner`／`Notice` 兩套；確認方式 4 套（`window.confirm` 14 處、ConfirmVoidButton、inline 框、UndoBar）；色值寫死 398 次（331 次其實等於現有 `zk-*` token）、Tailwind 原生色 321 次、字號寫死 662 次 20 種；手機斷點 5 個門檻（平板 768–1023 外殼係手機、內容係桌面）；簡體「价」30 行；畫面「安員」殘留 0 ✓。

**顯示層 bug（確定）**：月結頁「去長工糧 ›」連去 `/longterm-payroll`（404）；雞頭導覽多咗一組「其他 › 雞頭」（`BROKER_GROUP_ORDER` 漏 `/brokers`，test fixture 冇包）；首頁 KPI 卡冇按權限顯示（會計見「待審批」、主管見「毛利進度」，撳落去 403）。

**可收起／刪走嘅面板**（22 項，附錄 c §2）：Postorder「兩個 CSV」同「精簡 CSV」過渡面板、重新對數全月結果嘅英文 key、`layout:` 技術字、「§6.3」章節號、月結頁 4 個頁首掣、RightRail 同主欄重複三個掣、10 步進度技術明細、已處理晒嘅分診卡、ops-digest 基線指標、雞頭銀行資料要手打 JSON、保安員 Drawer 9 個子區直排、長工糧 7 區直排、「登出會同時登出所有裝置」常駐字、更表上載 60 幾行大半「未上載」等。

### 1.5 根因歸納

| 根因 | 症狀 | 一次過解決嘅做法 |
|---|---|---|
| 權限冇 per-request 快取 | 所有 list API N+1；layout 12 條查詢；loopback | `loadPermissionSet(session)` 一次讀晒該角色權限做 Set，下游全部讀 Set（B C-1） |
| 報表 builder 互相內嵌、冇記憶化 | 月結工作台同一月 `buildMonthlyClose` ×4；一鍵結算 step6 ×3；首頁跑成份毛利表 | request-scoped memo（`AsyncLocalStorage`／`react cache()`），數字唔變（B C-2） |
| bytea 欄混喺 metadata 表 | 上載列表／guard-fix 歷史讀晒檔案 bytes（最壞 20×30 MB）| 統一 `*_META_SELECT`；長遠拆 `*_files` 子表（B C-4） |
| 成頁 client、每頁自己 fetch 參考資料 | 9 頁重複拉 sites／brokers／shift-types／guards；白屏→loading→資料 | server 預取參考資料＋共用 `useLookups()` 快取；guards 出輕量版 API（B C-3） |
| 冇設計系統真相來源 | 3 套按鈕、2 套提示、5 種月份選擇器、398 個寫死色值 | `NAV_SCHEMA`、`<MonthPicker>`、`<Button>` 唯一、`Banner` 唯一、token 機械替換（C §5.0） |
| 緊急 WP 留低嘅過渡 UI | guard-fix CSV 面板、§6.3、英文 key、runs | 收起／刪（C §2 H1–H22） |

---

## 2. 新導覽列與頁面架構草案

### 2.1 原則
1. 第一層跟**老闆每月做嘢次序**（排更 → 上載對數 → 一鍵月結 → 出糧／鎖 → 設定），唔跟資料類型。
2. 第一層 ≤6 項、每組 ≤5 條，老闆 700px 高度唔使捲。
3. 同一件事只有一個正式入口；其他地方係「去做 ›」連結。
4. 一個月份選擇貫穿「對數」同「月結」（網址 `?month=` ＋記住上次揀嘅月）。
5. 「待處理」集中首頁一個收件箱，單位統一寫清楚。
6. 唔改 API、唔改計算；舊路徑保留 redirect，e2e 逐個改 selector。

### 2.2 內部角色（老闆／主管／會計）

| 第一層 | 第二層（側欄連結） | 頁內合併 | 老 | 主 | 會 |
|---|---|---|---|---|---|
| **首頁** | 首頁 | 待辦收件箱（審批 N 更／待答 N 題／未對數 N 盤／要老闆決定 N 項／本月月結進度）＋今日尚欠（原 `/reports/shortfall` 併入，舊路徑 redirect） | ✓ | ✓ | ✓ |
| **排更** | 更表、配額、審批〔badge〕 | 更表索引＋編輯器照舊；「最近開過」提升做首屏 | ✓ | ✓ | ✓（審批按權限） |
| **對數** | 更表上載、未配對保安員修復 | 上載列表預設只顯示「有嘢要做」（未上載摺成一行計數）；對數頁由上載行展開；guard-fix 嘅 CSV 過渡面板收入「其他上載方式」 | ✓ | ✓ | ✓ |
| **月結** | 一鍵結算、待答問題〔badge〕、報表 | 鎖月／解鎖只留喺一鍵結算；「報表」一頁 5 個 tab（月結總表＝原月結工作台唯讀＋生成／毛利／糧明細／長工糧／修正摘要）共用月份；舊 5 條路徑 redirect 去 tab | ✓ | 一鍵結算（只睇） | ✓ |
| **資料** | 盤、保安員、雞頭、價目 | 保安員頁頂一個「新增 ▾」（手動／用證件新增／批量導入）——`/guards/import`、`/guards/new-from-docs` 由導覽降級為頁內入口；盤頁含更別；雞頭頁含介紹費率；雞頭銀行資料改兩格 | ✓ | ✓ | ✓ |
| **設定** | 用戶、角色權限、操作紀錄、現場意見〔badge〕 | — | ✓ | ✗ | ○（操作紀錄） |

老闆連結數：23 → **17**（首頁 1＋排更 3＋對數 2＋月結 3＋資料 4＋設定 4），6 組；改密碼／登出留喺用戶區；AI 助手照舊右邊 tab。

### 2.3 雞頭

| 第一層 | 第二層 |
|---|---|
| 首頁 | 4 KPI＋我有份嘅盤（照舊） |
| 排更 | 更表、配額 |
| 我的 | 本月應收、我的保安員、價目 |

（修正：唔再出「其他 › 雞頭」；`/brokers` 對雞頭唔入導覽。）

### 2.4 保安員角色
出廠 0 個 module，首頁永遠「未開任何模組權限」。建議：登入後顯示一頁簡單說明（「你嘅帳號係保安員，功能稍後開放」）＋改密碼；或者由老闆決定暫時唔開放登入。**要老闆決定。**

### 2.5 頁面級改動（跟架構走，唔改 API）
- **月結頁（老闆手機最常用）**：手機專用版面——StageBar 一行、每段一張卡、10 步進度跑完摺成一行、RightRail 做唯一 CTA 區（主欄重複掣刪）、HistorySection 改「過往執行紀錄」。
- **統一元件**：`<MonthPicker>`（‹ 月 ›＋網址同步＋記住）、`<Button>` 唯一（Drawer 嘅 `btnPrimary` 改用）、`Banner` 唯一（`Notice` 退役）、`<TableLoadingRow>`／`<TableEmpty>`、`<UnpricedNotice>` 共用（5 份合 1，報表頁一行＋「去處理 ›」）、確認一律 `ConfirmVoidButton`／UndoBar（`window.confirm` 14 處退役）。
- **Design token**：331 個寫死色值機械替換做 `zk-*`；字號收斂做 type scale（11／12／13／14／16／20）；手機斷點統一 `lg`（外殼）＋`sm`（表↔卡）兩個。
- **面板清理**：附錄 c §2 H1–H22 逐項（刪／收起／改字），全部顯示層。
- **文字**：「价」→「價」30 行；「Generate」「runs」「layout:」「§6.3」改人話（§6.3 要先改 e2e selector）。

### 2.6 舊路徑對照（全部 301 redirect，e2e 同步改）
`/reports/shortfall` → `/`；`/reports/gross-margin|monthly-close|payroll|longterm-payroll|ops-digest` → `/month-close/reports?tab=…`（或保留路徑只改導覽——**實作時揀改動細嗰個**）；`/guard-fix` → `/roster-uploads?tab=fix`；`/guards/import`、`/guards/new-from-docs` 路徑保留，只由導覽拎走。

---

## 3. 程式碼瓶頸同多餘部分清單

### 3.1 效能瓶頸（按影響排序；完整 20 項＋修法見附錄 b §A）

| # | 位置 | 問題 | 基準 | 修法 | 觸及口徑／gate | 大小 |
|---|---|---|---|---|---|---|
| P1 | `src/lib/api/field-groups.ts:161-191`、`rbac/requirePermission.ts:96-103` | 每行每欄組 `hasPermission()` 打 DB；`Promise.all` 一次射出塞爆 pool | guards?take=500 **1,506** 條；audit-log 262；rate-cards 204；shift-records 134；sites 64 | per-request 權限 Set（`loadPermissionSet`），gate 變純函數 | 唔觸及；單元測試覆蓋剝欄語意 | M |
| P2 | `src/lib/roster-upload/pending-summary.ts:24-48`、`reconcile.ts:251,712` | 全部月份逐份序列對數，每份讀兩次連 `file_bytes` | **894** 條／432 ms 本機；正式站 1.15–1.59 s | `select` 唔讀 bytes；只計本月＋上月；對數完寫 `pending_count` 快取 | 唔觸及 | S→M |
| P3 | `src/lib/rbac/nav.ts:48-73`、`(app)/layout.tsx:16-47`、`current-session.ts` | 老闆 layout 每頁 loopback HTTP 打自己；session 查 2 次；4 段序列；審批 badge 全表 COUNT | layout 12 條／頁；老闆 +1 HTTP | 直讀 DB＋`react cache()`；badge `Promise.all`；`shift_records(status)` partial index | 唔觸及 | S |
| P4 | `src/app/layout.tsx:24`（next/font Noto Sans HK 4 weights） | 472 KB CSS 每頁載 | 193 KB gz／頁 | 減 weight（400＋700）、改 `next/font/local` 只帶常用切片，或系統字型優先 | 無 | S |
| P5 | 5 頁載全表 `/api/guards`；9 頁各自拉 sites／brokers／shift-types | 每頁 2–2.4 s 等 guards；45–56 KB 參考資料重複 | 正式站 /guards 頁 2.2 s、更表編輯器 11 個 API | 輕量 `GET /api/guards?fields=lite`（id＋顯示名＋工號）；共用 `useLookups()` 快取；更表儲存後就地更新唔重拉 | 唔觸及（新增 query 參數，additive） | M |
| P6 | `src/lib/reports/*` 互相內嵌 | 月結工作台同一月 `buildMonthlyClose` ×4；一鍵 step6 ×3；首頁跑成份毛利表 | gross-margin 730–803 ms；month-health 771 | request-scoped memo；首頁拆日級／月級兩條 API | **觸及 reports → 必跑 gate；數字必須 bit-for-bit 一樣** | M |
| P7 | `src/app/api/month-close/one-click/route.ts`（GET 回 20 個 run 全份 steps＋report）＋ 5 秒 polling | 191 KB／次 | list 只回摘要，報告另開 `GET /one-click/:id`；polling 只拉 running | additive | S |
| P8 | `roster-uploads/route.ts:52`、`guard-fix/postorder/route.ts:85`、`staff-list/route.ts:36` | 冇 `select`，讀晒檔案 bytes（最壞 20×30 MB） | OOM 風險 | 加 `*_META_SELECT` | 無 | S |
| P9 | `shift-records/batch/route.ts:441-509`、`months/[month]/open/route.ts:63` | tx 內逐格 find+update、逐條 audit、預設 5 s timeout | 2,000 格 ≈ 6,000 條序列查詢 | 批量化＋`createMany`＋tx timeout 60 s | 寫入快照路徑 → 跑 gate | M |
| P10 | `prisma/schema.prisma` | 缺 index：`shift_records(status)`、`(settlement_broker_id, work_date)`、`audit_log(created_at)`、`rate_cards(site,shift_type,broker,effective_from)` | 隨數據增長變慢 | 新 migration，`CONCURRENTLY` | 只加 index | S |
| P11 | `GuardsClient.tsx:441-479`、`RosterEditor.tsx:671-689`、polling 冇 unmount 取消 | 每次搜尋重拉 brokers／sites；儲存後全表重拉；離開頁面照 poll | 打 5 個字 ≈ 15 個 API | mount 拉一次、AbortController、unmount 取消 | 無 | S |
| P12 | AI 側欄每頁載對話 | 7.5 KB／頁 | 開側欄先載 | 無 | S |

### 3.2 潛在 bug（附錄 b §B 13 項，列重點）

| # | 位置 | 問題 | 確定／疑似 | 建議 |
|---|---|---|---|---|
| **B-1** | `api/reports/referral-fee/recompute/route.ts:22-32`、`lib/reports/referral-fee.ts:321-361` | **冇鎖月檢查**，已鎖 8 月可被重算介紹費（void 舊 special_items 再建新行） | **確定** | 加 `assertMonthNotLocked`，lib 內 tx 再查一次；改完跑 gate 確認 8 月未動 |
| B-2 | `shift-records/batch/route.ts:107→441`、`month-closes/[id]/lock/route.ts:35` | 鎖月檢查喺 tx 外（TOCTOU）；兩個同時 lock 都通過 | 疑似 | tx 內 `FOR SHARE`；lock 用 `updateMany where lockedAt null` |
| B-3 | batch／open／bulkResolve 三處 interactive tx 冇 timeout | 2,000 格儲存可能 P2028 | 疑似 | 設 60 s＋批量化（P9） |
| B-4 | 分頁 `orderBy` 冇 `id` tie-breaker | >500 行盤月可能重複／漏行 | 疑似 | 加 `id` 次序 |
| B-5 | sites／rate-cards／brokers／quotas 用 `take=500` 攞全盤更種 | 超過 500 靜默截斷 | 疑似 | `apiGetAll` 或警告 |
| B-7 | 5 處預設月份用 UTC | 每月 1 號 00:00–07:59 當上月 | **確定** | `hkMonthStart()` |
| B-10 | 3 頁 polling 冇 unmount 取消 | 背景多餘請求 | **確定** | cancelled flag |
| B-11 | `nav.ts` loopback 失敗靜靜 fallback | 老闆客製權限喺導航失效冇 log | 疑似 | 跟 P3 直讀 DB |
| B-12／13 | xlsx 匯出 tmp 檔同毫秒衝突；batch audit 喺 commit 後寫 | 低 | 疑似 | `writeBuffer()`；audit 入 tx |
| B-8／B-9 | `round2` 負數捨入；7 月 OT fallback 卡冇生效日期篩 | 疑似、影響細 | — | **唔建議郁**（觸及鎖月口徑），記錄做已知差異 |

### 3.3 多餘／可刪（附錄 a §5–6）

| 類別 | 項目 | 證據 | 風險 |
|---|---|---|---|
| 確定可刪 | devDependency `@types/bcryptjs` | bcryptjs 3 自帶型別 | 無 |
| 確定可刪 | 7 個 TS6133 未用變數／參數（`month-close/auto/pricing.ts:150,670`、`auto/triage.ts:236`、`one-click.ts:222` ×2、`tests/e2e/roster-upload.spec.ts:333-334`） | tsc | pricing／one-click 屬結算路徑：改完跑 gate |
| 確定可改 | ~180 個多餘 `export`（src）＋101 個 type | knip；同檔內仍用 | 零 runtime |
| 要補 | `jszip` 加入 `dependencies`（`maxwell-import.ts:12` 直接 import，而家靠 exceljs 傳遞） | depcheck | exceljs 升級會爆 |
| 疑似死函數（逐個 grep 確認後刪） | `api/query.ts` `pickFields`／`coerceDateFields`；`api/case.ts` `snakeToCamel`；`guard-fix/plan.ts` `formatPlanSummaryMd`／`describeDbTarget`；`guard-fix/sources.ts` `parseUTeamWorksheet`／`loadUTeamList`；`guard-fix/postorder.ts` `derivePostorderLongtermPostsFromPostorderGrid`；`components/reconcile/data.ts` `clearReconcileDataCache`／`loadNeedsBoss`；`UnresolvedCells.tsx` `NeedsBossBox`／`reasonKinds`；`ai/db.ts` `AiDbNotConfiguredError` | knip | 低 |
| 疑似（歸檔，問老闆） | `scripts/staff-import/09–12、17`（證件導入已完結步驟）、`scripts/ai/guard-ocr-smoke.ts`、`scripts/db/one-off/rotate-db-password.ts` | 冇 import、冇 package.json 入口 | 涉個人資料流程，非定價 |
| **唔好刪** | `scripts/opening/*`（8 月開盤＋`gate:aug-e2e`）、`scripts/db/daemon.ts`、`scripts/ai/assistant-startup-log.ts`／`guard-ocr-selftest.ts`（Dockerfile 啟動）、`eslint-config-next`、`tailwindcss`、`@tailwindcss/postcss` | 工具誤判 | — |
| 重複碼合併 | 兩條 chat route＋兩個 client（~150 行）；`<TableLoadingRow>`／`useCrudPage`（~250 行）；未定價清單元件（~50 行）；API 小樣板（~50 行）；**唔好**合併 `auto/pricing.ts:326-348`↔`pricing/resolve-rate.ts:243-266`（定價核心） | jscpd | 中／低 |
| 拆大檔（非去重） | RosterEditor 2,792 → 格仔表／工具列／手機鍵盤／右鍵選單／資料層；GuardsClient 2,558 → 列表／Drawer 各 tab／子資源 | A、C | 中：核心 UI，靠 e2e |

---

## 4. 可量測目標（before → after）

| 指標 | Before | 目標 | 量法 |
|---|---|---|---|
| `/api/guards?take=500` DB 查詢數 | 1,506 | ≤20 | 附錄 d `qcount.py` |
| `/api/audit-log`／`rate-cards`／`shift-records`（單盤）查詢數 | 262／204／134 | ≤15／≤10／≤10 | 同上 |
| `pending-summary` 正式站 p50 | 1,151 ms | <400 ms | 附錄 p 方法（Chrome fetch ×3） |
| 正式站 `/guards` 頁最慢 API | 2,221 ms | <800 ms | 同上 |
| 更表編輯器頁內 API 數 | 11 | ≤6 | 同上 |
| layout 每頁查詢數（老闆） | 12＋1 HTTP | ≤4，0 HTTP | 附錄 d |
| 月結工作台同一月 `buildMonthlyClose` 呼叫 | 4 | 1 | 計數器 |
| 字型 CSS（gz）每頁 | 193 KB | <40 KB | Chrome resource timing |
| `/api/month-close/one-click` 回應 | 191 KB | <20 KB | 同上 |
| 老闆側欄連結／組 | 23／5 | 17／6，700px 唔使捲 | 計數＋截圖 |
| 月份選擇器實作 | 5 種／16 頁 | 1 元件 | grep |
| 色值寫死／字號寫死 | 398／662 | <40／<60 | grep（附錄 c §3 指令） |
| 按鈕：手寫 `<button>` className 種類 | 76 | <10 | grep |
| 「待處理」計法 | 9 處 | 1 收件箱＋各頁引用 | code review |
| 「价」 | 30 行 | 0 | grep |
| 鎖月 gate | 12/12 | 12/12、0 差 | `npm run gate:locked-months` |
| 測試 | 3,323 過 | 不減，新增覆蓋 | vitest |

每個階段完結：用附錄 d（本機）＋附錄 p（正式站）**同一 script** 量 after，寫入本文件 §6。

---

## 5. 建議執行階段（等老闆批 §2／§3 先開工；每階段 Sonnet 5.5 執行 → Opus 5.5 驗收 → gate → 部署新加坡 → 量 after）

| 階段 | 內容 | 估時 | 風險 |
|---|---|---|---|
| **0. 即修**（細、無爭議） | B-1 鎖月漏洞；死連結 `/longterm-payroll`；雞頭導覽「其他」組；首頁 KPI 按權限；B-7 UTC 月份；B-10 polling 取消；「价」→「價」；`@types/bcryptjs`／`jszip`／7 個 TS6133 | 0.5 日 | 低（B-1 改完跑 gate） |
| **1. 效能（伺服器）** | P1 權限 Set；P3 layout 直讀＋`cache()`；P10 index；P8 `select`；P2 pending-summary；P7 one-click 摘要；B-3／B-4／B-5 | 1.5 日 | 低–中；P1 要權限語意測試 |
| **2. 效能（報表＋前端）** | P6 報表 memo（必跑 gate）；P4 字型；P5 輕量 guards＋`useLookups`＋編輯器唔重拉；P11；P12；P9 batch 批量化 | 1.5 日 | 中：P6／P9 觸及快照／報表路徑，bit-for-bit 對比 |
| **3. 導覽＋架構** | `NAV_SCHEMA` 單一真相；§2.2／2.3 分組；首頁收件箱；報表 5 tab 共用月份；`<MonthPicker>`；redirect；e2e 改 selector | 2 日 | 中：e2e 路徑／selector 大改 |
| **4. UI 一致性＋面板清理** | token 機械替換；`Button`／`Banner` 唯一；確認方式統一；`UnpricedNotice`；H1–H22；月結頁手機版；Drawer／長工糧 tab 化 | 2–3 日 | 低–中（純顯示；靠截圖對比＋e2e） |
| **5. 瘦身** | 拆 RosterEditor／GuardsClient；合併 chat route；`useCrudPage`；多餘 export；疑似死函數；scripts 歸檔 | 1.5 日 | 中：核心 UI，靠 e2e |

每階段部署後做「真環境核對」（登入、8 月鎖月數字、9 月報告、自檢 log）先算完成。

---

## 6. 老闆要決定嘅嘢（其餘我自己定）

1. §2.2 第一層六組（首頁／排更／對數／月結／資料／設定）同連結名稱——照呢個做，定係想改名／改分組？
2. 報表 5 頁合成「月結 › 報表」一頁 5 tab（共用月份）——接受？（會計日常用；舊路徑會 redirect）
3. 鎖月／解鎖只留喺「一鍵結算」頁，月結工作台改唯讀總表——接受？
4. `/guard-fix` 降級做「對數」入面一個 tab；Postorder「兩個 CSV」過渡面板 10 月之後仲要唔要？
5. 保安員角色登入後見咩（§2.4）。
6. 首頁毛利進度卡：改做只喺月份變先計（可能遲 ≤60 秒反映），定係照舊每次即時計？
7. §3.3「疑似」scripts（證件導入 09–12、17）可唔可以歸檔？
8. 階段次序：建議 0 → 1 → 2 → 3 → 4 → 5（先快後靚）；如果老闆想先見到介面變，可以 0 → 3 → 4 → 1 → 2 → 5。

批咗之後：階段 0 即日做；每階段完結報 before/after 數字。

---

## 7. 老闆決定（2026-10-10 晚，經 Dispatch）
1 A 六組新選單；2 A 五報表合一頁；3 A 鎖月只留一鍵結算頁；4 A CSV 上載方式收埋；5 A 保安員登入見說明頁；**6 B 首頁毛利進度卡保持每次開即時重計（唔接受 ≤60 秒延遲快取）**；7 A 舊證件導入 script 歸檔；8 A 次序 0→1→2→3→4→5。全部批准開工。
- 第 6 條落實方式（唔用 TTL cache）：毛利卡同日級尚欠表拆做兩條 API 並行載入（唔互相等）；卡每次開首頁都即時重計，但只計卡需要嘅聚合（唔跑成份逐盤毛利表嘅逐筆 JS 聚合），加 request-scoped memo（同一 request 內唔重複計）。結果數字必須同毛利表 totals 一樣（test 斷言）。


### 8.0 階段 0 落實紀錄（Sonnet 5.5，2026-10-10，branch p3-phase0）
逐項獨立 commit（P3-0.1 至 P3-0.9）。API 合約（request／response、錯誤 code、JSON key）不變；冇 migration。

1. **P3-0.1 B-1 鎖月**：`api/reports/referral-fee/recompute/route.ts` 加 `assertMonthNotLocked`（403 `month_locked`＋audit `permission_denied`）；`lib/reports/referral-fee.ts` `recomputeReferralFees` 喺費率同步（sync 本身亦係寫入）之前先查一次、`$transaction` 開頭再查一次，拋 `Locked`。Test：`tests/referral-fee-recompute-route.test.ts` +2（鎖咗 2026-08 經 route／直接 call lib，special_items 同 referral_fee_rates 數量零改動）；原有 5 條不變。
2. **P3-0.2 死連結**：`month-close/ReportSection.tsx` → `/reports/longterm-payroll`；新 `tests/app-hrefs-resolve.test.ts` 掃 `src/app/(app)` 全部 `href="/…"`／``href={`/…`}``（跳過 `/api/`，允許 query／動態段）對應 `src/app` 現有 page；已驗證未修前會 fail。
3. **P3-0.3 雞頭導覽**：`rbac/nav.ts` 雞頭 base role 唔 push `/brokers`（頁面權限不變）；`tests/rbac-nav-groups.test.ts` +1（雞頭有「雞頭:view」→ 無 `/brokers`、分組後冇「其他」；老闆照有）；已驗證未修前 fail。
4. **P3-0.4 首頁 KPI 按權限**：新 `src/lib/ui/shortfall-cards.ts`（`shortfallCardVisibility(grants)`）；`(app)/page.tsx`、`reports/shortfall/page.tsx` 用 `getViewGrants` 傳 `showApprovals`／`showMargin` 落 `ShortfallDashboard`（桌面＋手機兩組卡都跟）。新 `tests/shortfall-card-visibility.test.ts`（出廠矩陣：老闆 2 張可選卡、主管只有待審批、會計只有毛利進度；會計被開「審批」→ 兩張）。
5. **P3-0.5 B-7**：新 `src/lib/dates.ts` `hkMonthStart(now)`（`Intl` Asia/Hong_Kong）；5 處改用（broker dashboard、month-health、ops-digest、ops-digest/ai-summary、`month-lock.ts` 鎖月區間上界）。新 `tests/hk-month-start.test.ts`（`2026-10-31T17:00:00Z` → 2026-11-01，另加 3 條邊界）。報表計算口徑冇改。
6. **P3-0.6 B-10**：`roster-uploads`／`month-close`／`guard-fix` 三頁加 `unmountedRef`，polling 每輪（sleep 前後）檢查，unmount 即停，停後唔再 `setState`／fetch；間隔同 API 不變。
7. **P3-0.7 价→價**：`src` 同 `tests`（含 e2e）共 49 檔、313 行／364 字全改（`grep -rn '价' src tests` ＝ 0）。簡報估 30 行顯示文字，實際大部分係註解；全部一併改。冇碰 JSON key、錯誤 code、enum、DB 值、permission key；`prisma/`、`scripts/`、`docs/` 入面嘅「价」（schema 註解、舊 migration、build-aug-plan 註解／gate 輸出）刻意冇改（migration 不可改；scripts 唔喺範圍）。
8. **P3-0.8 依賴／死碼**：`@types/bcryptjs` 實際喺 `dependencies`（唔係 devDependencies），已移除（bcryptjs 3 自帶型別，tsc 過）；`jszip` 釘 `3.10.2` 入 `dependencies`；7 個 TS6133 全部用 `_` 前綴（`auto/pricing.ts` ×2、`auto/triage.ts`、`one-click.ts` ×2、`roster-upload.spec.ts` ×2），冇改 call site；`tsc --noUnusedLocals --noUnusedParameters` ＝ 0。
9. **P3-0.9 歸檔**：`git mv` 七個 script 去 `scripts/archive/`；**路徑偏離簡報字面**：用「相對 `scripts/` 保留」（`scripts/archive/staff-import/09…12、17`、`scripts/archive/ai/guard-ocr-smoke.ts`、`scripts/archive/db/one-off/rotate-db-password.ts`），唔係 `scripts/archive/scripts/…`。歸檔前 grep 確認冇 package.json／Dockerfile／tests／其他 script 引用；archive 內嘅相對 import（`./lib/…`、`../../src/…`）已跟住改，tsc 照過。`README-STAFF-FIELDS.md` 加一句已歸檔；新增 `scripts/archive/README.md`（原本被 `.gitignore` 嘅 `archive/` 規則連 `scripts/archive/` 都 ignore 埋，驗收 M1 發現；已改做 `/archive/` 只 ignore 根目錄嗰個，README 同日後新加嘅歸檔檔都會入 git）。

**偏離／備註**
- 第 4 項：簡報提「亦唔 fetch 相關數據如果可以分開」——`/api/reports/shortfall` 一個 endpoint 同時回尚欠、待審批數、月進度（合約不變），所以只做 UI 層隱藏，冇拆 fetch；拆 API 屬階段 1（§7 第 6 條）。
- 第 1 項 lib 檢查用 `prisma.monthClose.findUnique`／`tx.monthClose.findUnique` 直接查 `lockedAt`（同 `isMonthLocked` 一致），因為 tx 內要用 tx client。

**驗證**
- `npx vitest run`（隔離 PG）：196 passed｜1 skipped（197 檔），3336 passed｜15 skipped；`tsc --noEmit` 0；`tsc --noUnusedLocals --noUnusedParameters` 0；`npm run lint` 0；`npm run build` 過。
- `npm run gate:locked-months`：12/12 rc=0（需要 `DATABASE_URL` 喺 shell 環境，用 `set -a; . ./.env` 載入先跑得；gate 會重設共用 dev DB）。
- Playwright（port 3196）：`pricing wp-misc home mobile month-close-ui p2b-finance-pages p2a-master-pages` ＝ 59 passed、4 skipped、3 failed；3 failed 喺未改嘅 main（`7a8b401`）同樣 fail（已逐條對照），屬舊問題：`mobile.spec.ts:44`（`getByRole link 更表` strict mode 撞「更表上載」）、`p2a-master-pages.spec.ts:76`（雞頭A保安員列數 133 vs 159，數據狀態）、`pricing.spec.ts:217`（dialog 期望「會改變」，現數據係「冇變」措辭）。

**未測**
- 冇起 production 做視覺／手感驗證；P3-0.3／0.4 冇 e2e 新 case（單元 test 覆蓋）；P3-0.6 polling 取消冇自動化 test（純 unmount 行為，靠 code review）；冇跑全部 e2e spec（只跑涉及「價」同首頁／導覽／報表嘅 spec）。

#### 8.0.1 驗收＋部署（2026-10-10 深夜）
- Opus 5.5 驗收：有條件通過（1 必修＝`scripts/archive/README.md` 被 `.gitignore` 嘅 `archive/` 規則 ignore；已改做 `/archive/`，README 入 git）。(ii) 6 項記入下一輪：referral-fee test snapshot 只數行數；lib 鎖月 message 同 `month-lock.ts` 措辭唔同、唔寫 audit、已鎖且早過 2026-08 嘅月由 400 變 403；href 掃描未覆蓋 `router.push`／nav.ts；worktree 殘留 symlink。驗收員自跑：vitest 196 檔／3,336 條過、tsc（含 noUnused）0、lint 0、build 過；3 條 Playwright fail 經 `7a8b401` 臨時 worktree 核實係 main 既有（`mobile.spec.ts:44` strict mode、`p2a-master-pages.spec.ts:76` 行數 133 vs 159、`pricing.spec.ts:217` 措辭）——記入階段 3／4 一齊修。
- merge main `91df5f6`；部署新加坡 deployment `6aca3925c0a5252069b82944` RUNNING（13:17Z）：No pending migrations、sync-permissions 新增 0、`[ai-assistant] provider=claude`、兩個 OCR 自檢 ok、login 200。
- 正式站唯讀核對（老闆 Chrome）：月結頁兩條長工糧連結都係 `/reports/longterm-payroll`、無 `/longterm-payroll`；首頁／月結頁／價目頁「价」0、「價」78／45；價目頁掣「重新計價（本月）」；老闆首頁 KPI 卡齊（主管／會計按權限隱藏靠單元 test）。**未喺正式站實測介紹費重算嘅鎖月 403**（唯讀原則，唔對正式站發寫入 POST）；靠 2 條新 test＋Opus 核實。
- 階段 0 冇效能目標；before/after 數字由階段 1 起。

### 8.1 階段 1 落實紀錄（Sonnet 5.5，2026-10-10，branch p3-phase1）
逐項獨立 commit（P3-1.1 至 P3-1.9）。API 合約只 additive（見偏離）；migration 只新增（`20261011000000_p3_perf_indexes`，冪等）。Before／after 用附錄 d 同一套 script（`bench.sh`、`qcount.py`，同一份合成 DB：540 保安員、60 盤、9,408 更、20k audit，另加 6 份 Postorder／U Team 假 bytes 同 20 個 one-click run；本機 PG 54391、server 3194；p50 係 5 次）。

1. **P3-1.1 權限 per-request Set**：`loadPermissionSet(session)`（`WeakMap<session, Promise<Set<"module:action">>>`，一條 SQL：由 `permissions` 出發 `rolePermissions: { some }`——用 `role_permissions` 做 relation select 會被 Prisma 拆成 2 條）；`hasPermission`／`requirePermission` 讀 Set（硬性 deny 照用 `isHardDenied`）；`applyFieldGroupGate`／`applyFieldGroupGateToList` 先一次砌四個 view flag，逐行 gate 係純函數；`dropUnchangedFieldGroupValues`／`assertFieldGroupWritable` 經 `hasPermission` 自動受惠。保留 async 簽名，38 個 call site 冇改。session 物件每個 request 新 unseal 一次，cache 隨 request 結束 GC，改角色權限下個 request 即生效。測試：`tests/p3-1-permission-set.test.ts`（500 行 gate 整個 request 只 1 條 role_permissions 查詢、語意對照、改權限新 session 即生效、`GET /api/sites` ≤2）。
2. **P3-1.2 layout**：`getViewGrants` 老闆分支直讀 Set（刪 loopback `fetch`、`cookies()`／`headers()`；失敗 `console.error` 後 fallback，B-11）；`getCurrentSession`、`getViewGrants`、`countOpenFor` 用 `react` `cache()`（layout＋page＋`TriageHomeNotice` 共用）；審批＋現場意見兩個 count 合成一條 `$queryRaw`，同待答 count `Promise.all`。老闆任何頁 layout：users 1 ＋ 權限 Set 1 ＋ 兩個 badge count 1 ＋ 待答 count 1 ＝ **4 條，0 HTTP**。
3. **P3-1.3 index**：`shift_records`（`status` partial `WHERE status='pending_approval'`、`(settlement_broker_id, work_date)`、`(parent_shift_id)`）、`audit_log`（`created_at DESC`、`(actor_user_id, created_at DESC)`）、`rate_cards(site_id, shift_type_id, broker_id, effective_from DESC)`、`special_items(month, kind) WHERE voided_at IS NULL`、`daily_requirements(work_date)`。**唔用 `CONCURRENTLY`**（Prisma migrate 喺 transaction 內跑；各表 <50k 行，鎖表 <1 秒）。`schema.prisma` 加對應 `@@index`；兩條 partial index 只存在於 migration（`prisma migrate diff` 對 live DB 只剩階段前已有嘅 `guard_phones_tel_key`、`triage_person_applies_weak_ids_idx` 兩項已知差異）。
4. **P3-1.4 bytea**：`src/lib/roster-upload/meta-select.ts`（`ROSTER_UPLOAD_META_SELECT`／`POSTORDER_UPLOAD_META_SELECT`／`STAFF_LIST_UPLOAD_META_SELECT`）；`roster-uploads` 列表／詳情／PATCH／reparse、`reconcile.ts`、`reconcile-apply.ts`、`service.ts` 內不需原檔嘅讀取、`guard-fix/postorder`、`guard-fix/staff-list` 全部加 `select`。`tests/p3-1-upload-meta-select.test.ts` 掃 `src`：三個 model 嘅 `find*` 冇 `select` 必須喺白名單（9 項，皆為解析原檔：reparse、guard-fix plan／apply、一鍵結算 Postorder／U Team、auto context）並寫明原因。
5. **P3-1.5 pending-summary**：(a) 用 P8 select；(b) 不帶 month 預設只計「本月＋上月」（`?months=N` additive，`0`＝全部月份＝舊行為；`name_only` 同範圍）；(c) 新 `loadReconcileInputs(uploadIds[])` 批量 loader——整批上載共用 rows／更種／保安員／盤／長工崗位／系統更次各一條 `IN` 查詢（`loadReconcileInput(id)` ＝ 批量 of 1，`reconcileUpload` 重用已讀 upload，不再重複查 `roster_uploads`；系統更次只讀對數用到嘅 11 欄）；(d) 15 份一批、批與批 4 併發（自寫 `src/lib/async/map-limit.ts`）。測試：批量結果同逐份 `loadReconcileInput` deep-equal、`reconcileRosterUpload` 結果同 `reconcileUpload` 一致、窗口行為、`mapLimit`。
6. **P3-1.6 one-click**：`GET /api/month-close/one-click?month=` 預設只回摘要（id、month、status、started_at、finished_at、current_step、stalled、error_message，另加 `steps_total`／`steps_done`／`totals{revenue,cost,gross_margin}|null`，jsonb 運算喺 DB 側，唔讀整份報告）；`?include=full` 同舊版逐 key 一樣；新 `GET /api/month-close/one-click/:id`（同 permission）回 `{ run }`。月結頁：列表摘要＋最新 run 拉單一 route，polling 只拉 running run 嘅單一 route（取代每 5 秒 20 個 run 全份）。
7. **P3-1.7 B-3**：`shift-records/batch`、`months/[month]/open`、`roster-upload/service.ts bulkResolveAmbiguousSubSite` 三個 interactive tx 加 `{ timeout: 60_000, maxWait: 10_000 }`。
8. **P3-1.8 B-4**：16 條分頁 list route（guards×2、sites、shift-records、rate-cards、audit-log、brokers、quotas、users、roles、special-items、shift-types、referral-fee-rates、month-closes、daily-requirements、broker-site-assignments、feedback、roster-uploads 行）`orderBy` 加 `{ id: "asc" }` 做第二序；structural test 防回退。
9. **P3-1.9 B-5**：`ui/api-client.ts` 加 `apiGetAll()`（逐頁拉齊 `total`）；`sites`、`rate-cards`、`brokers`、`quotas` 四頁嘅 sites／brokers／guards／shift-types／assignments 查詢改用佢。

**Before → after（本機合成數據，p50 ms／DB 查詢數／bytes）**

| 對象 | p50 | 查詢數 | bytes |
|---|---|---|---|
| `/api/guards?take=500` | 124 → 26 | 1,506 → 6 | 435,914 → 435,854 |
| `/api/guards` | 31 → 8 | 306 → 6 | 87,514 → 87,197 |
| `/api/sites` | 9 → 4 | 64 → 4 | 34,122 → 34,122 |
| `/api/rate-cards` | 19 → 5 | 204 → 4 | 56,137 → 56,310 |
| `/api/audit-log` | 23 → 4 | 270 → 4 | 26,473 → 26,594 |
| `/api/shift-records?…view=grid`（單盤月） | 15 → 5 | 134 → 4 | 23,571 → 23,571 |
| `/api/roster-uploads/pending-summary` | 462 → 51 | 894 → 62 | 132 → 132 |
| `/api/roster-uploads?month=` | 15 → 5 | 4 → 4 | 46,693 → 46,693 |
| `/api/month-close/one-click?month=` | 7 → 3 | 3 → 3 | **160,310 → 6,130**（`?include=full` 160,310，同舊版 byte 一樣） |
| `/api/guard-fix/postorder?month=` | 57 → 3 | 4 → 4 | 2,039 → 2,039（DB 讀取由 6×~2.7 MB 降到只 metadata） |
| `/api/guard-fix/staff-list?month=` | 23 → 3 | 4 → 4 | 1,829 → 1,829 |
| 頁面殼（老闆）`/sites`、`/` | 12 → 5、14 → 6 | 12 → 4、17 → 4（0 HTTP） | 不變 |
| `/api/reports/gross-margin|monthly-close|payroll|shortfall` | 同階段前（before 嗰輪機器較忙，75 ms 同附錄 d 一致） | 48→46、29→27、12→12、45→45 | 不變 |

對照 §4 目標：guards?take=500 ≤20（6 ✓）；audit-log／rate-cards／shift-records ≤15／≤10／≤10（4／4／4 ✓）；layout ≤4 且 0 HTTP（4 ✓）；pending-summary 894 → <150（62 ✓）、432 ms → <120（51 ✓）；one-click 回應 <20 KB（6.1 KB ✓）。正式站（Zeabur RTT）p50 未量。

**偏離／備註**
- 簡報 P8 提及 `reconcile.ts:251,712`：兩處都加 `select`，另 `reconcileUpload` 直接重用 `loadReconcileInputs` 已讀 upload（第 712 行 query 刪除）。
- P2 做咗批量 loader（簡報原案「重用已讀資料＋4 併發」唔夠壓到 <150：每份上載仍約 15 條）；`name_only` 一齊套用同一範圍。唔帶 month 預設由「全部月份」改「本月＋上月」係簡報指定行為，3 個舊 test 嘅斷言改為 `?months=0`（`wp-roster-upload-pending-summary`、`staff-import-b2-match`）。
- P1：`getViewGrants` 老闆分支改用 Set 後，「`permissions` 缺格就跌返出廠預設」呢個舊 fallback 唔再存在（`syncPermissions` 保證 module×action 全有格）。同一 request 內第二次 `requirePermission`（例如 audit-log `export=1`）因為係新 session 物件，會多讀一次 Set。
- one-click 預設列表 additive 加 `steps_total`／`steps_done`／`totals` 三個 key；舊 client 無 `include=full` 會見唔到 `steps`／`report`（月結頁已同步改；`ai-diagnostics` 直接用 lib，不經 route）。
- B-4 令同 `createdAt`／`workDate` 嘅行次序變成確定（`id`）；before／after 對比 `guards?take=500` 前 500 行嘅集合有 36 行出入，屬原本 tie 次序不穩（bulk seed 全部同一個 `createdAt`）嘅表現，逐 id 對比行內容 0 差異。
- 額外：`tests/p3-1-*.test.ts`（permission-set、upload-meta-select、pending-summary、one-click-list、pagination-tiebreak）。

**驗證**
- `tsc --noEmit` 0；`npm run lint` 0；`npm run build` 過；`npx vitest run`（隔離 PG 54392）：201 passed｜1 skipped（202 檔），3359 passed｜15 skipped。
- 修前修後（同一份 synth DB）`/api/reports/gross-margin|monthly-close|payroll?month=2026-08`、`/api/month-close/one-click?month=2026-08&include=full`、`/api/reports/shortfall`、`/api/roster-uploads/pending-summary`（含 `?months=99`）、`/api/sites`、`/api/roster-uploads?month=`：回應 body `cmp` byte-for-byte 一樣。
- `npm run gate:locked-months`：12/12 rc=0（db-reset、db-seed、gate-reports、gate-export、report-regen、gate-pricing、gate-roster-parse、gate-ltpay-aug、gate-postorder-export-aug、gate-aug-e2e、perf-snapshot、perf-profile）。另在階段 0 merge 基線（`91df5f6`）同一環境跑多一次 gate，比對 `snapshot.json`（7／8 月報表、對數、診斷）：5,080 個數字葉全部相同（multiset 相等）；剩低差異只係 sha（內容含每次重 seed 嘅 UUID）、時間戳同 UUID。
- gate 需要 `.env`（`ln -s`）、`tools/importer/out`、`tools/importer/venv`、`data/*`（逐項 `ln -s` 去主 repo，冇讀／印內容）；`db:reset` 會重設主 repo 共用嘅 dev DB（`zoikan`，port 54329），並對佢套用 `20261011000000_p3_perf_indexes`（只新增 index）。

**未測**
- 正式站（Zeabur）RTT 下嘅 p50；Chrome 實機；Playwright e2e 冇跑（月結頁 polling／摘要＋單一 route 只有 API 層 test 同 build/tsc/lint，冇瀏覽器驗證）；並發負載（autocannon）；真實數據下 pending-summary（合成數據只有 9 月 60 份 `parsed`）；`apiGetAll` 喺 >500 行真實 API 嘅頁面（只有 mock fetch test）；migration 喺正式站嘅鎖表時間（本機合成表細）。

#### 8.1.1 驗收、部署、正式站 after（2026-10-10 深夜）
- Opus 5.5 驗收通過（0 必修）：自寫對照 test 證明權限 Set 同舊 `findFirst`＋硬性 deny 喺 5 角色×725 格（含篡改 DB：強開 105、刪 41、`granted=false` 100）結果全部一樣；批量 reconcile 對 6 份上載 102 個 item 同逐份版一樣；migration 冪等、8 條 index 都在、合成數據鎖表 7–136 ms；`migrate diff` 只剩階段前已有嘅 2 項。(ii)：pending-summary test 加查詢數斷言、META_SELECT test 只認頂層 `select`、tie-breaker test 用括號配對、`approvals` 等 7 處仍 `take=500`（保安員已 >500——階段 2 修）、`one-click-read.ts:80` `::date` 依賴 PG session TimeZone、文件小錯 3 處。7 項偏離全部接受。
- merge main `d5b24c6`（P3 文件兩邊各加一節衝突，保留兩節）；部署新加坡 deployment RUNNING 14:08Z：`Applying migration 20261011000000_p3_perf_indexes … All migrations have been successfully applied`、助手 provider=claude、OCR 自檢 ok、login 200。
- **正式站 after（老闆 Chrome，同一 script；before 見附錄 p）**：

| 項目 | Before | After |
|---|---|---|
| `/guards` 頁嘅 guards API | 2,221 ms | **624 ms** |
| `/rate-cards`／`/brokers`／`/approvals`／更表編輯器 嘅 guards API | 2,409／2,006／2,036／2,325 | **868／863／832／850** |
| `/api/guards` 單獨 p50 | 643 | **425** |
| `/api/audit-log` 單獨 p50 | 654 | **427** |
| `/api/roster-uploads/pending-summary` 單獨 p50 | 1,151 | **763**（`?months=0` 全部月份 710） |
| 首頁 pending-summary（頁內） | 1,587／1,457 | **953** |
| `/api/month-close/one-click` 列表 | 191 KB | **1.9 KB**（`include=full` 190.9 KB 不變；單一 run route 61 KB） |
| `/sites` 頁 load | 2,629 ms | **815 ms** |
| `/month-close` 頁 load | 683 | 1,512（列表→單一 run 兩次序列請求＋month-health 738；總 bytes 191→63 KB；階段 2 改並行） |
| `/api/sites`／`rate-cards`／報表類 單獨 p50 | 490／565／730–803 | 512／591／749–836（RTT 地板 ~370 ms 主導，查詢數 64→4／204→4 喺本機先明顯；報表未改，預期不變） |
| 首頁 TTFB（暖） | ~500 | 410 |

- 口徑：單次量度、香港→新加坡、部署後即量（第一次首頁 TTFB 1,982 ms 係冷啟動，未計）。更表編輯器仍 11 個 API、`/guards` 仍載全表 47 KB、DOM 17,932——階段 2（lite guards／lookups 快取）處理。
- **產品行為改變（已話俾老闆知）**：首頁「更表對數待處理」卡由計全部月份改為本月＋上月（`?months=0` 可攞全部）。

### 8.2 階段 2 落實紀錄（Sonnet 5.5，2026-10-10，branch p3-phase2）
逐項獨立 commit（P3-2.1 至 P3-2.10）。API 合約只 additive；冇 migration。Before／after 用附錄 d 同一套 script（`bench.sh`、`qcount.py`、`snap.sh`，另加 `batch-bench.py`、`pw-count.mjs`），同一份合成 DB（540 保安員、60 盤、9,408 更、20k audit；PG 54388、server 3190＝階段前 main、3191＝本分支；p50 係 5 次）。

1. **P3-2.1 P6 報表 request-scoped memo**：新 `src/lib/reports/context.ts`（`AsyncLocalStorage<Map<key, Promise>>`、`withReportContext`、`memoized`、`invalidateReportMemo`）。`buildMonthlyClose`／`buildGrossMargin`（key 含 threshold）／`buildLongtermSalaryAllocation`／`buildPayrollTotals` 入口 memo；冇 context（script、test 直接叫）每次照計。`withApiError` 統一包住每個 API request（一個 request 一個 Map）；AI 工具（gross_margin／monthly_close／shortfall／month_health）各自開全新 context（`withReportContext` 永遠新 Map，巢狀唔承接外層，AI 一次對話內多次工具調用唔會讀到舊結果）；一鍵結算 `compute`＋`postorder_compare`＋`report` 共用一個 context，`stepCompute` 內長工糧／介紹費重算完 `invalidateReportMemo()`。冇任何模組級 cache／TTL，Map 隨 request 結束 GC。已逐個核對 caller 唔會改動回傳物件（`scrubSite` 等都係 spread 複製）。
2. **P3-2.2 首頁毛利卡（老闆第 6 條：每次即時重計）**：新 `GET /api/reports/margin-progress?month=`（權限同日級 `尚欠總覽:view`，回 `month/revenue/cost/profit/margin_pct/threshold_pct/below_threshold_site_count`，數字＝`buildGrossMargin(month).totals`，test 斷言相等且同舊 `month_progress` 一樣）；`GET /api/reports/shortfall` 加 `?include_margin=0`（只回日級，唔跑毛利表；冇參數＝舊 shape 逐 byte 一樣）。`ShortfallDashboard` 兩條並行 fetch、日級先顯示，‹ › 同月換日只重拉日級，換月先重拉月級。**點樣保持即時**：兩條 route 都冇 cache（唔 TTL、唔跨 request）——每次開首頁／換月／重新整理都由 DB 即時重算（test：改一條 shift_record 之後下一個 request 即反映）。`buildGrossMargin` OT 查詢 `include` 改 `select`（A-18）。
3. **P3-2.3 P4 字型**：Noto Sans HK 由 4 個 static weight 改 `weight: "variable"`（Google 提供 wght 100–900 variable），一套 CJK 切片 `@font-face` 涵蓋所有字重——UI 現有 font-medium／semibold／bold 視覺完全不變，唔使映射字重。每頁 CSS：472,469 B（164,339 B gz）→ 118,824 B（41,219 B gz）；連另一個 10,160 B gz 嘅 CSS 合計 174.5 → 51.4 KB gz（-70%）。**未達 <40 KB gz 目標**（51.4 KB），但低過簡報「>60 KB gz 先要改 `next/font/local`」嘅門檻，所以冇做 local 切片，留俾規劃者決定。First Load JS 共用 103 kB 不變。
4. **P3-2.4 P5 輕量 guards＋lookups**：`GET /api/guards?fields=lite`（`id/staff_no/name_zh/name_en/status/default_broker_id/default_broker_code/sia_permit_expiry/staff_numbers`，經 field-group gate；雞頭 session 照舊隔離；test 斷言冇電話／證件／銀行／月薪／地址／出生日期）；`daily-requirements` 加 `work_date_from/to`；`src/lib/ui/lookup-cache.ts`＋`lookups.ts`（`cachedGetAll`、`useLookups`、`invalidateLookups`；模組級 in-memory、TTL 60 s，`apiRequest` 對 guards／sites／brokers／shift-types／broker-site-assignments／month-closes／roster-uploads／guard-fix／staff-import／triage／months 嘅成功寫入自動作廢）。RosterEditor：guards 用 lite、brokers／month-closes（按 `?month=`）經 lookup cache、`daily-requirements` 帶本月範圍（順帶修正原本把該盤**所有月份**每日所需人手按日加埋嘅錯）、tel 唔再載入（`RowMeta.tel` 本來就唔顯示）；儲存／重新計價（`reloadTick`）之後淨係重拉 shift-records（＋未定價 banner），唔重拉 guards／brokers／month-closes／shift-types／daily-requirements／quotas／site。**偏離**：簡報寫「用 batch response 就地更新 cells」——batch response 冇 status／snapshot 等欄，就地更新要重造 cell 狀態，風險高過收益，改為儲存後只重拉 shift-records 一條。approvals／brokers／rate-cards／quotas／users／roles／roster／roster-uploads／my-receivable／ReconcileClient／guard-fix／reconcile 名冊 嘅 `take=500`（或 `take=200`）全部改 `apiGetAll`／`cachedGetAll`／lite（`/api/guards` 用 lite；reconcile 名冊要電話對照，用 `apiGetAll` 全欄）。
5. **P3-2.5 P9 batch 批量化**：tx 內用已讀 `existing` 做 before；清格／更新按相同 data 分組 `updateMany`＋一次讀 after；新增 `createManyAndReturn`；audit 一條 `createMany`（新 `writeAuditMany`，`createdAt` 逐 ms 遞增保持次序，內容經同一個 `toAuditCreateData`）；quota 警示一條 `groupBy`；內部角色 settlement broker fallback 批量預填（兩條 `DISTINCT ON` SQL 取代每保安員 2–3 條）。payload 有重複格（API 容許、UI 唔會送）行返舊逐格路徑，行為不變。test：結果／DB／audit before-after 同逐條 `writeAudit` 一致；fallback prefetch 同單個 resolve 逐級一致；查詢數不隨格數／保安員數增長（舊碼 632 差，新碼 ≤6）。
6. **P3-2.6 一鍵結算 guard-fix 收斂 loop**：Postorder 上載讀取（最大 30 MB）＋xlsx 解析搬出 loop（最多 5 輪→1 次）；step6／報告重複 builder 靠 P3-2.1。
7. **P3-2.7 P11**：GuardsClient brokers／sites 只 mount 拉一次（lookup cache），搜尋只拉 guards；request id＋AbortController 防舊 response 蓋新（B-6）；保安員 >500 逐頁拉齊（原本 `take=500` 靜靜截斷）。
8. **P3-2.8 P12**：AI 側欄對話紀錄只喺用戶開側欄先載；換頁後還原開住狀態用 sessionStorage 快取（綁用戶名、30 分鐘 TTL、登出清走），唔再每頁 fetch。
9. **P3-2.9 A-15 開新月**：assignments／quotas／daily_requirements 各一次 `findMany` 攞已存在 key → `createManyAndReturn({ skipDuplicates })` → 一條 audit `createMany`（224 行來源 641 條額外查詢→固定）。
10. **P3-2.10 階段 1 驗收員補充**：(a) `take=500` 逐個改 `apiGetAll`／lite（見上）；`apiGetAll` 及 GuardsClient 分頁 `skip` 改按頁前進（雞頭 session 嘅 DTO 轉換喺分頁後剔行，用 `rows.length` 做 skip 會錯位——e2e 揪到）；(b) `p3-1-upload-meta-select` 只認頂層 `select`；(c) `p3-1-pending-summary` 加「查詢數不隨份數增長」斷言；(d) `name-only.ts` 註解；(e) build 前 `rm -rf .next`。

**Before → after（本機合成數據）**

| 對象 | before | after |
|---|---|---|
| 月結工作台入頁（generate＋gross-margin）`buildMonthlyClose` 次數 | 4（generate 3＋gross-margin 1） | 2（每個 request 各 1；跨 request 唔共用） |
| `POST /month-closes/:id/generate` close 次數 | 3 | 1 |
| 一鍵結算整個 run close 次數（9 月＋體檢上月） | 5 | 2（9 月 compute＋report＋體檢共 1；上月體檢 1） |
| `/api/reports/gross-margin` 查詢／p50 | 46／73 ms | 44／67 ms |
| `/api/reports/shortfall?date=`（舊 shape） 查詢／p50 | 45／78 ms | 43／63 ms |
| 首頁日級 `shortfall?…&include_margin=0` | （無）| 8 條／9 ms／7,225 B |
| 首頁月級 `margin-progress` | （無）| 37 條／63 ms／145 B（並行，換日唔重拉） |
| 首頁撳 ‹ › 換日 | 1 個 API（45 條／78 ms，連毛利） | 1 個 API（8 條／9 ms，毛利卡不動） |
| 每頁字型 CSS（raw／gz） | 472,469／164,339 B | 118,824／41,219 B |
| `/api/guards?fields=lite&take=500`（540 人，頭 500 行） | （無；`/api/guards?take=500` 435,854 B／27 ms／6 條）| 129,497 B（gz 16,538 B）／6 條，約全欄嘅 30%；**未達簡報 ≤15 KB**（規劃者接受）。原先紀錄嘅 25,934 B 係 `take=100`，已更正 |
| 更表編輯器載入（headless Chromium，老闆；本機 540 人＞500 所以 lite 要 2 頁） | 10 API／528,520 B | 冷載 10 API／177,889 B；同分頁切換月份（lookup 暖）7 API／21,079 B（6 個不計未定價 banner） |
| 更表編輯器儲存後重拉 | 全部（≈10 個 API） | shift-records＋未定價 banner＝2 個 |
| `/rate-cards`／`/brokers`／`/approvals` 頁 API bytes | 600,049／507,457／536,815 | 269,149／176,557／240,859 |
| 保安員搜尋打 5 字（API 數／bytes） | 4／496,498 | 3／496,744（brokers／sites 唔再跟搜尋重拉；`/guards` 因 540>500 多拉一頁，原本係截斷） |
| `POST /shift-records/batch` 100／500／2000 格（新增）SQL 條數／秒 | 395／0.22、1,892／0.77、4,892／1.85 | 23／0.10、22／0.20、23／0.54 |
| 同上（更新既有格）| 316／0.19、1,516／0.73、6,016／2.65 | 29／0.09、29／0.21、29／0.58 |
| 開新月（224 行來源）額外查詢 | +641 | +≤4 |

對照 §4：`buildMonthlyClose` 呼叫「4→1」只喺**單一 request** 內達成（generate 3→1）；月結工作台入頁係兩個 request，各自 1 次，合計 4→2（唔跨 request 共用係鐵則）。字型 193 KB gz→51.4 KB（未達 <40）。更表編輯器「11→≤6」：暖載 6（不計未定價 banner）、冷載 10（保安員 >500 要 lite 2 頁；<500 人時 9）。batch 2,000 格 ≈6,000→<30 條 ✓。

**驗證**
- `tsc --noEmit` 0；`npm run lint` 0；`rm -rf .next && npm run build` 過。
- `npx vitest run`（隔離 PG 54389）：208 檔全過，3407 passed（階段 1 為 3359；新增 `tests/p3-2-*.test.ts`：report-memo、margin-progress、lookups、batch-write、month-open、memo-counts；並補強 `p3-1-*`）。
- Playwright（`PW_PORT=3192`，dev DB 重 seed 後；home／wp-r2-roster-redesign／wp3／wp4／staffno／p2a-master-pages／month-close-ui／reconcile-ui／mobile／pii／pricing 共 100 條）：本分支 73 passed／13 failed／14 did not run，階段 1 基線（同環境重 seed）73／13／14，失敗清單逐條一樣（13 條舊有失敗，主要係 month-close-ui 1a/1e 分診對話框、mobile (b)、pii (a)、wp-r2 (f)、wp4 (b)，非本階段引入）。首次跑曾見 4 條本分支獨有失敗：home (a)（毛利 placeholder 字眼撞「載入緊…」→ 改字）、p2a guards 雞頭A（分頁 skip 錯位 bug → 修）、pricing (c)／wp3 (a)（gate 後 8 月數據狀態，重 seed 後消失）。
- 修前修後（同一份 synth DB）`/api/reports/gross-margin|monthly-close|payroll|month-health`、`/api/diagnostics/month`、`/api/reports/ops-digest`、`/api/month-close/one-click?include=full`（8、9 月）、`/api/reports/shortfall`（8、9 月）、`/api/guards?take=500`、`/api/sites`：回應 body `cmp` byte-for-byte 一樣（唯一差異：ops-digest 9 月內 `window.to` 係「而家」時間戳）。
- `npm run gate:locked-months`：12/12 rc=0；另在階段 1 merge 基線（main）同環境跑多一次，比對 `snapshot.json`：5,080 個數字葉 multiset 相等（逐 path 比對有 34 個數字因同名盤／更種排序次序不同而錯位，內容相同，同階段 1 紀錄一致）。

**驗收後修正（Opus 5.5 第一輪，同日）**
1. lookup cache key 形狀統一：`RosterEditor` 改用 `cachedRows()`（`src/lib/ui/lookups.ts`，內部走 `cachedGetAll` 取 `.data.rows`），唔再另開 `all:/api/guards?fields=lite`／`all:/api/brokers` 嘅 array 形狀；test 覆蓋「先 lookups 後 editor」「先 editor 後 lookups」兩個方向（`tests/p3-2-lookups.test.ts`）。
2. cache 綁用戶：`lookup-cache.ts` 加 `setLookupScope(userId)`（scope 變即清空、key 帶 scope 前綴），`(app)/layout` 經新 `LookupScope` 元件傳 `session.userId`（render 時同步設定，早過子頁 effect）；`LogoutButton`（前後）同 `LoginClient`（登入成功）都 `invalidateLookups()`；test：scope 轉換後 cache miss、invalidate 後 miss。
3. 上表 lite 數字更正（見表）。
4. `runOneClickMonthClose` 包一層 `withReportContext`（內部原函數改名 `runOneClickMonthCloseInner`），背景 run（`after()`）唔繼承發起 request 嘅 memo；test：ambient memo 放毒值，run 照樣 done 且 report 冇毒值。
5. 舊 `src/lib/api-client.ts` `apiGetAll` skip 改按 `pageSize` 累加。
6. `daily-requirements` 嘅 `work_date_from/to` 加 `YYYY-MM-DD` 驗證，亂填 400；test。
7. `writeAuditMany` 唔再逐條 +1 ms，同批共用 DB `now()`；batch test 改為斷言同一 created_at＋rowId 集合。
8. batch 批量路徑 tx 內先 `SELECT id … FOR UPDATE`（按 id 排序鎖）再 `findMany` 重讀 before，audit before 用 tx 內重讀值（計價判斷仍用 tx 外 plan，同逐格寫法一致）。
驗證：vitest 208 檔／3414 passed；tsc 0；lint 0；`rm -rf .next` build 過；`gate:locked-months` 12/12，snapshot 5,080 個數字葉同修正前一樣。

#### 8.2.1 驗收、部署、正式站 after（2026-10-11 凌晨）
- Opus 5.5 第一輪**唔通過**（3 必修：lookups cache key 形狀撞（各頁 `ApiResult` vs 編輯器 `T[]`，60 秒內跨頁會 TypeError／下拉變空）；登出／登入軟導航唔清 cache，60 秒內雞頭同分頁登入會攞到上一用戶嘅全表（違反雞頭隔離）；§8.2 lite 數字量錯（`take=100`））；執行員補 8 項（`246c6ad`：`cachedRows` 統一形狀、cache 按 userId scope＋登出／登入清、數字改正 129,497 B raw／16.5 KB gz、`runOneClickMonthClose` 包 `withReportContext`、舊 `apiGetAll` skip、daily-requirements 日期驗證、`writeAuditMany` 同一 now()、batch tx 內 `FOR UPDATE` 重讀 before）；第二輪通過（0 必修）。驗收員自寫 test：memo 並發 A／B 互不影響、10 個並發各計一次、同 request 同 key 只計 1 次；跨用戶 scope 切換後 cache miss；batch 2,000 格 23／24 條 SQL。(ii)：one-click 包裝嘅守護 test 喺舊 code 都過（要改讀 `als.getStore()`）；同批 audit 次序唔再保證；兩批同時 create 同組新 key 次序相反會死鎖回 500（舊有）；`api-client.ts` 註解不準；§8.2 vitest 字眼（3,399＋15）。
- merge main `82ea938`；部署 `6aca6162c0a5252069b82f55` RUNNING 16:07Z：56 migrations／No pending、助手 claude、OCR 自檢 ok、login 200。
- **正式站 after（老闆 Chrome，同一 script）**：

| 項目 | Before（基線） | 階段 1 後 | 階段 2 後 |
|---|---|---|---|
| CSS 每頁（gz） | 193 KB | 193 | **52 KB**（41＋10）；h1／semibold 計算字重 700／600 有分別 |
| 首頁 API | shortfall 781、pending-summary 1,587 | 588／953 | 暖載：`shortfall?include_margin=0` **435 ms** 同 `margin-progress` 760 ms **並行**（日級表先出）、pending-summary 977；首頁 load 557 ms（基線冷載 2,128） |
| 更表編輯器 | 11 API、guards 47 KB | 11 API、guards 47 KB | **10 API、guards lite 26 KB、全部 API 合共 37 KB** |
| `/rate-cards`／`/approvals` guards | 47 KB（2.0–2.4 s） | 47 KB（0.83–0.87 s） | **lite 26 KB**（0.77–0.98 s，同其他請求並行） |
| `/month-close` load | 683 | 1,512 | **978**；側欄對話唔再每頁載（0 次） |
| `/guards` 頁 | guards 47 KB、DOM 17,934 | 47 KB | 47 KB（名冊本身要全欄）、DOM 19,332——階段 4／5 做虛擬化或分頁 render |

- 未達／留意：字型 CSS 41 KB gz（目標 <40，差 1 KB；`next/font/local` 切片留待老闆要唔要）；更表編輯器冷載仍 10 個 API（暖載 7）；`/guards` 頁仍載全欄（名冊頁本身需要），DOM 節點數係階段 5 拆 GuardsClient 時做分頁／虛擬 render。
- 行為改變（已話俾老闆知）：更表編輯器「每日已排／所需」只計本月（舊版將該盤所有月份按「幾號」加埋，係顯示 bug）；首頁毛利卡仍每次開即時重計（無 cache），換日唔重拉毛利。

### 8.3 階段 3 落實紀錄（Sonnet 5.5，2026-10-11，branch p3-phase3）
逐項獨立 commit（P3-3.1 至 P3-3.8）。**只搬 UI**：API 合約、權限矩陣、任何定價／結算／報表計算全部冇改；冇 migration；舊路徑全部保留（redirect 或照 render）。

1. **P3-3.1 NAV_SCHEMA**：新 `src/lib/nav/schema.ts`（client-safe）係導覽單一真相——`INTERNAL_NAV`／`BROKER_NAV` 每條 `{ href, label, group, kicker, module, badge? }`；`getNavLinks()`／`groupNavLinks()`（`rbac/nav.ts`）、`isLinkActive()`／`kickerFor()`（`ui/nav-active.ts` 只 re-export）、各頁 `PageHeader kicker`（30 幾處手寫字串全換 `kickerFor(href)`）全部由 schema 派生，刪咗三份手寫表。顯示與否仍然全部由 `grants[module]` 決定（權限邏輯不變）。內部角色 6 組：首頁／排更（更表、配額、審批）／對數（更表上載、未配對保安員修復）／月結（一鍵結算、待答問題、報表）／資料（盤、保安員、雞頭、價目）／設定（用戶、角色權限、操作紀錄、現場意見）；雞頭 3 組（首頁／排更／我的：本月應收、我的保安員、價目）；保安員只有首頁。「報表」連結任一報表 module 有 view 就出（主 module「月結總表」冇 grant 就改連去有權限嗰份）。`/reports/shortfall`、`/guard-fix`、`/guards/import`、`/guards/new-from-docs`、4 份報表由導覽拎走。`DesktopNav` 收緊（連結 `py` 3px＋`leading-5`、組距收窄、用戶區一行、「登出會同時登出所有裝置」改 `title`），1512×700 老闆 nav `scrollHeight`＝`clientHeight`＝594（唔使捲）；每條連結加 testid（桌面 `nav-<href>`、手機 `mnav-<href>`）。`isLinkActive` 識帶 query 嘅連結（`/roster-uploads?tab=fix`），並修正舊寫法「更表」連結會喺 `/roster-uploads` 雙重 active。
2. **P3-3.2 共用月份選擇器**：新 `components/ui/MonthPicker.tsx`（‹ 月份 ›＋原生 month 輸入，唯一實作）＋`useMonthState(defaultMonth?, { persistDefault? })`＋`lib/ui/month-store.ts`（純函數）。月份來源次序 URL `?month=` → `sessionStorage["zk.month"]` → 頁面預設（本月，香港；月結／長工糧／修正摘要維持上個月）；改變時用 `history.replaceState` 更新 URL（唔加 history）同寫 sessionStorage。14 個 `useMonthState` call site（brokers、quotas、roster、roster-uploads、my-receivable、guards、gross-margin、monthly-close、ops-digest、payroll、month-close、longterm-payroll、BrokerDashboard、HomeInbox）；rate-cards 生效月用 `MonthPicker` 但本地 state；guard-fix 面板經父頁 roster-uploads 嘅月份；RosterEditor 月份喺路徑，經 `rememberMonth` 寫入 sessionStorage；`BrokerDashboard` 改用 hook；`RosterEditor`（月份喺路徑）寫入 sessionStorage。`EmptyMonthNotice` 擴到 brokers、roster-uploads、ops-digest、longterm-payroll（my-receivable 本來有）。
3. **P3-3.3 首頁待辦收件箱**：新 `components/home/HomeInbox.tsx`：待審批（更）、待答問題（題）、更表未對數（盤；`pending-summary` entries 數；API 預設「本月＋上月」`months=2`）、「YYYY-MM 月結」進度（`/api/month-close/one-click?month=` 最新 run：未開始／進行中 n/N 步／已完成／失敗）、要老闆決定（項；`/api/guard-fix/runs` 最新 run `summary.needs_boss`，淨係老闆，冇 run 就唔出）。每格按 grants，冇權限唔打 API。審批／待答由 server page 傳落（新 `rbac/pending-counts.ts` `getPendingCounts` react `cache()`，layout 側欄 badge 同首頁共用同一次查詢）。`TriageHomeNotice` 刪；`ShortfallDashboard` 刪 `variant="overview"`、待審批卡、更表對數卡（搬入收件箱）；`/reports/shortfall` 改 `redirect("/")`（保留合法 `?date=`）。
4. **P3-3.4 月結**：新 `reports/layout.tsx`（server，按 grants）＋`ReportTabs`（5 tab：月結總表／毛利／糧明細／長工糧／修正摘要，路徑不變，換 tab 帶 `?month=`；定義放 `lib/nav/report-tabs.ts`，因 server 唔可以 import "use client" 檔嘅常數）；5 頁 kicker「月結 › 報表」。`/reports/monthly-close`：右欄**刪鎖定／解鎖掣**（連同 override 原因、強制鎖定 checkbox、roster-coverage fetch、`MonthHealthCard`），改顯示鎖定狀態＋「去一鍵結算鎖月 ›」；頁首主掣「生成月結」，匯出 Excel／Postorder 格式／重算介紹費入新 `MenuButton`「更多 ▾」；標題「月結總表」、卡標題「五條自動對數規則」（testid `recon-rules-title`）。`/month-close`：主欄 ReviewCard「開始逐條答」、LockSection「鎖定」、AutoSummaryCard「還原」三個重複掣刪，右欄 RightRail 係唯一 CTA 區（testid `rail-open-triage`／`rail-lock-month`／`undo-auto-rail`）；「歷史 runs」→「過往執行紀錄」。
5. **P3-3.5 對數**：`guard-fix/page.tsx` `git mv` 做 `roster-uploads/GuardFixPanel.tsx`（邏輯不變）；`roster-uploads/page.tsx` 變 server wrapper（`canFix`＝「安員配對修復」view），原 client 頁搬去 `RosterUploadsClient.tsx`，tab「上載與對數」／「未配對保安員修復」（`?tab=fix`，兩邊保持 mount、切 tab 唔丟狀態）；`/guard-fix` 改 `redirect("/roster-uploads?tab=fix[&month=]")`。修復 tab：兩個 CSV 過渡面板收入 `<details>`「其他上載方式（9 月過渡用）」、「歷史 runs」→「過往紀錄」預設收起（套用失敗／卡住提示會自動展開）、頁首 PageHeader 由父頁出。上載列表預設只顯示「有嘢要做」（`needsAction`：盤名未配對／解析失敗／未對數確認／仲有未配對或多重配對），其餘摺成一行「未上載 N 盤、已完成 M 盤，已摺埋｜顯示全部 ›」（sessionStorage `zk.rosterUploads.showAll` 記住）。「重新對數全月結果」改人話（共用新 `lib/roster-upload/category-labels.ts`，ReconcileClient 同用）：預設一句總結，明細收入 `<details>`；詳情頭 `layout:` 刪。一鍵結算 UploadSection 加「亦可以喺『對數 › 更表上載』逐盤上載同對數」。
6. **P3-3.6 資料**：`/guards` 三個入口收成「新增 ▾」（手動新增／用證件新增／批量導入；雞頭保持單一「新增保安員」）；`/guards/import`、`/guards/new-from-docs` 加「‹ 返回保安員」。`/brokers` Drawer「銀行資料（JSON）」改「銀行名」「戶口號碼」兩格（新 `lib/ui/broker-bank.ts`）：現有程式冇任何地方讀 `bank_info` 內部 key，只有舊提示例 `bank_name`／`account_no`，所以寫呢兩個 key；舊 JSON 已用其他拼寫（`bankName`／`account_number` 等）就沿用，其他 key 原封保留；送出仍然係同一個 `bank_info` JSON。銀行資料屬 PII：test 只用假值，唔 log。
7. **P3-3.7 保安員角色**：`baseRole`＝安員（顯示「保安員」）登入 `/` 見說明頁（「你嘅帳號係保安員帳號，系統功能稍後開放。如要改密碼請按下面。」＋改密碼／登出）；導覽只有首頁（`getNavLinks` 強制）。（代碼改動喺 P3-3.3 commit 一齊做，P3-3.7 commit 係 e2e。）
8. **P3-3.8 e2e 舊失敗**：見下。

**行為改變清單**
- 導覽：老闆 23→17 條、5→6 組；主管／會計各 11 條；雞頭 6 條（3 組）；保安員 1 條。連結改名：審批隊列→審批、用戶管理→用戶、角色權限管理→角色權限、價目 unchanged、雞頭端「保安員」→「我的保安員」、月結工作台／毛利／糧明細／長工糧／修正摘要→合成「報表」一條。
- 尚欠總覽併入首頁；證件資料導入（導覽）→保安員頁「新增 ▾」；未配對保安員修復→對數 tab；4 份報表→報表 tab。
- 鎖月：`/reports/monthly-close` 唔再有鎖定／解鎖／強制鎖定／override 原因輸入。`/month-close` 嘅鎖定掣照舊條件（`ready_to_lock`）；**解鎖**（簡報寫「解鎖都刪」，但刪咗就冇 UI 可以解鎖）搬入 `/month-close` LockSection（已鎖定先出現，原因必填，API 不變）。
- 更表編輯器手機（compact）取消 mouseenter 範圍拖選（`onCellMouseEnter`）：鍵盤彈出令容器縮細、格仔移位，指標下面換咗格會將單格選擇變範圍選擇令鍵盤收埋（wp-r2 (f) 揭出）；桌面唔受影響。
- 月份：換頁跟住（URL→sessionStorage）；初始值＝預設（同 SSR 一致），paint 前由 `useLayoutEffect` 解出 URL→sessionStorage→預設後先 `ready`，頁面只 fetch 一次（第二輪修正，見 §8.3.2）。

**e2e 改動清單**（Playwright 全部 spec 0 fail；固定帳號冇碰）
- 新增 `tests/e2e/p3-3-nav.spec.ts`（導覽 5 角色條數／組／唔使捲、手機抽屜 17 條、月份跟住、報表 tab、首頁收件箱、redirect、修復 tab、新增 ▾、雞頭銀行兩格〔假值，測後還原〕、保安員說明頁）。
- 跟新架構改：`home.spec (d)`（尚欠總覽→redirect＋收件箱）、`roster-reconcile`（「更表對數待處理」→`inbox-unreconciled`）、`roster-upload`（作廢後「未上載」要撳顯示全部）、`wp4 (b)`（鎖月／解鎖改喺 `/month-close` 做；run 報告用 `page.route` 假、generate／lock／unlock 打真 API 並用 API 核對）、`p2b (d)(e)(e2)`、`month-close-ui`（`rail-*` testid、主欄冇重複掣斷言）、`guard-fix`（redirect）、`reconcile-ui`（guard-fix 連結）。
- **舊失敗修正**：`mobile.spec` (b)(e)（strict mode，改 `mnav-/roster`）；`p2a-master-pages` 雞頭A保安員列數（改同 session 嘅 `/api/guards?fields=lite` total 比對）；`pricing (c)`（dry-run 摘要兩種現行文案都收）。簡報冇列但同環境一齊揭出、一併修：`month-close-ui`／`postorder-free`（P3-1.6 之後列表係摘要版，要另外 mock `/api/month-close/one-click/run1`——9＋2 條）、`pii (a)`（身份證 check digit 驗證之後舊假值 A123456(7) 會 400，且畫面顯示規範化 `A1234563`）、`p2b (d)`（7 月 race，等 7 月 response）、`ai-actions (d)`（真 POST 會對 2099-01 起真 run，連帶令 `longterm-payroll` 重算 2026-08 被「後面月份已計過」擋住；改 fulfill 假回應）、`wp-r2 (h)`（唔再假設第 0 行 27／29 日係空）、`wp-r2 (f)`（上面 RosterEditor compact 修正）。
- vitest：`rbac-nav-groups` 重寫（5 角色逐個斷言分組＋次序＋條數；schema href 掃描）；`triage-guard-import`、`ai-action-requests`（檔案路徑）、`ui-reconcile-derive`（guardFix 連結）跟改；新增 `p3-3-month-store`、`p3-3-report-tabs`、`p3-3-redirects`、`p3-3-needs-action`、`p3-3-broker-bank`。

**驗證**
- `tsc --noEmit` 0；`npm run lint` 0；`rm -rf .next && npm run build` 過（`/` First Load 115 kB；共用 103 kB 不變）。
- `npx vitest run`（隔離 PG 54385）：213 檔（212 過、1 skip），3,429 passed｜10 skipped（階段 2 為 3,414）。
- Playwright 全部 spec（隔離 PG 54386、`next start` 3190、`AI_LLM=fake`；`db:reset` 後即跑）：**179 passed｜5 skipped（原有 test.skip）｜0 failed**。
- `npm run gate:locked-months`：12/12 rc=0（本分支兩次獨立跑）；兩次 `snapshot.json` 嘅 5,080 個數字葉 multiset 相等（逐 path 比對只差隨機 uuid 同 20 個同名盤排序錯位，同階段 1／2 紀錄一致）。本階段冇碰任何報表／定價／結算計算，gate 只係保險。
- 五個角色（出廠矩陣）桌面 1512×700＋手機 375 導覽截圖（seed 假資料，唔入 repo）：`/private/tmp/claude-501/-Users-macbookpro-zoi-kan/41316f0d-3a34-4ae3-a8de-d2fb6db0b018/scratchpad/perf/p3-3/shots/`（`<角色>-desktop-1512x700.png`、`<角色>-mobile-375.png`）；實測連結數 老闆 17／主管 11／會計 11／雞頭 6／保安員 1，nav `scrollHeight`＝`clientHeight`＝594。

**Before → after**
| 指標 | before | after |
|---|---|---|
| 老闆導覽連結／組 | 23／5 | 17／6 |
| 老闆 1512×700 導覽要捲 | 要（財務組喺下面） | 唔使（`scrollHeight` 594 ＝ `clientHeight` 594） |
| 月份選擇器實作（`type="month"` 於 `src`，唔計註解） | 16 | 1（`MonthPicker`）＋3 個表單欄（開更表、新增配額、雞頭掛盤）；呢三處月份欄冇改 |
| 讀網址月份嘅頁 | 3 | 16（URL→sessionStorage→預設） |
| 「待處理」計法 | 9 處各自計（題／更／格／盤／項） | 1 個收件箱（更／題／盤／項，單位寫清楚） |
| 導覽分組真相 | 3 份（`nav.ts`、`nav-active.ts`、各頁 kicker） | 1 份 `NAV_SCHEMA` |
| redirect 舊路徑 | 0 | 2（`/reports/shortfall`、`/guard-fix`） |
| 鎖月入口 | `/reports/monthly-close`、`/month-close`（主欄＋右欄） | `/month-close` 右欄（唯一鎖定）；解鎖喺同頁 LockSection |
| Playwright 失敗 | 主分支 3 條已知＋環境揭出多條 | 0 |

**偏離／風險（請規劃者決定）**
1. **強制鎖定／override 原因**：`/reports/monthly-close` 嗰兩個輸入（紅色差異要填原因、roster-coverage 未齊嘅「強制鎖定」checkbox，後者淨係老闆）隨鎖定掣一齊刪咗；`/month-close` 嘅 `lockMonth()` 一向送空 body，`ready_to_lock` 唔齊就掣停用。**API 仍然支援**（`override_reason`、`force`），但而家冇 UI 入口——如果老闆日後要喺條件未齊時強制鎖月，要喺 `/month-close` LockSection 補（只係 UI，未做）。
2. 簡報「刪解鎖」→ 實際搬去 LockSection（見上），否則冇方法解鎖。
3. 「要老闆決定 N 項」用現成 `/api/guard-fix/runs` 最新 run 嘅 `summary.needs_boss`（簡報寫 `needs_decision`，代碼冇呢個名）；冇 run 就唔出該格。
4. 月份 URL 同步用 `history.replaceState`（同 `BrokerDashboard`／`ShortfallDashboard` 既有手法，唔觸發 RSC 重載），唔係 `router.replace`。
5. 價目頁「生效月」係篩選（空＝全部），用 `MonthPicker allowEmpty` 但保持本地 state，唔入全站月份。
6. 簡報要求 8 個部分按「搬 UI」做；`RosterEditor` compact 拖選修正、`pending-counts` 抽出屬為達成 0 fail／共用查詢嘅最小 app 改動。

**未測**
- 冇喺 production／真機觸控驗證（手機 e2e 係 Chromium 模擬）；`useMonthState` 冇 jsdom 單元測（純函數有，hook 行為由 `p3-3-nav.spec` 覆蓋）；「要老闆決定」格喺有 guard-fix run 嘅數據下嘅顯示冇專門 e2e（冇 run 時唔出，主管冇呢格有 e2e）。

#### 8.3.1 規劃者裁定後補（同日，Sonnet 5.5）
1. **強制鎖定補返**：`/month-close` LockSection 加「強制鎖定」——淨係老闆（server wrapper `month-close/page.tsx` 傳 `isBoss`＝`baseRole==="老闆"`；API 本身一樣只准老闆）、只喺 `lock_precondition` 有未上載／未對數盤（鎖月條件未齊）且未鎖定時顯示；勾選後出「override 原因」輸入，必填先可撳；call 同一個 `POST /api/month-closes/:id/lock`，body `{ force: true, override_reason }`（舊 `/reports/monthly-close` 嘅 `force`／`override_reason` 欄位名一字不差；`generate` 先行亦同舊 `lockMonth`）。e2e：`p3-3-nav.spec.ts` 老闆（條件未齊先出、原因必填、request body、鎖完 API 核對並解返）＋主管見唔到；一般右欄鎖定掣照舊停用。
2. **解鎖搬 LockSection**、**`needs_boss`**、**生效月本地 state**：規劃者接受。
3. **月份只 fetch 一次**：`useMonthState` 初始值改喺第一次 client render 前讀（`useState(() => readInitialMonth(fallback).month)`，次序 URL → sessionStorage → 預設；SSR 冇 window 用預設），唔再先用預設月份 fetch 再切；`MonthPicker` input 加 `suppressHydrationWarning`（hydration 時 value 屬性可能同 server HTML 唔同）。新增 devDependency `jsdom`，`tests/p3-3-use-month-state.test.ts`（jsdom）覆蓋初始值次序、第一次 render 已係最終值、補 URL／storage、setMonth。
4. **RosterEditor 手機（compact）`onCellMouseEnter`**：舊行為——mousedown 開始「拖曳填充」狀態（`draggingRef`），之後指標進入任何格都將選擇範圍延伸到嗰格。手機單撳一格會彈出底部更別鍵盤，容器因此縮細、格仔上移，**指標位置不變但下面換咗另一格**，瀏覽器觸發 mouseenter，將單格選擇（`sel.a==sel.b`）變成多格範圍，鍵盤顯示條件（單一格）唔再成立，鍵盤即刻收埋——用家見到「撳咗格鍵盤閃一下／唔出」，特別係近底部嘅格（e2e wp-r2 (f) 重現）。新行為——compact 下 `onCellMouseEnter` 直接 return，唔延伸範圍。桌面（≥640px）完全不變（拖曳填充照用）。係 bug 唔係功能：手機冇滑鼠拖曳填充操作（觸控冇 hover），範圍選擇喺手機只會由呢個佈局位移意外觸發；e2e 本身斷言（格喺鍵盤上面）正確，所以改 app 唔改 e2e。唯一副作用：窗口 <640px 嘅桌面滑鼠用家失去拖曳填充。

4（8.3.1 補）：e2e 數字 181 passed｜5 skipped｜0 failed（第一次補完後）；第 3 點「`useState(() => readInitialMonth…)` 讀 storage」被 §8.3.2 第 1 點取代（會 hydration mismatch）。

#### 8.3.2 第二輪修正（Opus 5.5 驗收後，Sonnet 5.5）
1. **Hydration #418**：`useMonthState` 初始值改回 fallback（同 SSR 一致），回傳 `[month, setMonth, ready]`；`useLayoutEffect`（paint 前、passive effects 前）解出 URL→sessionStorage→預設後 `setReady(true)`。13 個頁面（含 HomeInbox）嘅月份 fetch effect 全部 `if (!monthReady) return` 並以 `monthReady` 做 dep → 仍然只用最終月份 fetch 一次；GuardFixPanel 等 `monthReady` 先 mount。月份派生文字（HomeInbox「YYYY-MM 月結」）未 ready 時係預設月份、ready 後切換（hydration 安全）。新增 e2e（`p3-3-nav.spec.ts`）：`?month=` 同 sessionStorage 月份≠預設兩種情況各開 `/`、`/month-close`、`/reports/payroll`、`/reports/longterm-payroll`，斷言 0 `pageerror`／console #418／hydration，`/reports/payroll` 只打 `month=2026-08`；jsdom 單元測改用 `renderToString`＋`hydrateRoot`（`onRecoverableError` 同 `console.error` 都 0、fetch 只一次）。
2. **§6.3 紅色差異鎖唔到**：`lockMonth` 用 generate 回應 `reconciliation.has_diff`；有差異但未填原因就唔打 lock，LockSection（`diff-reason-box`）同右欄（`rail-diff-reason`，原因空時鎖定掣停用）出「override 原因（必填）」，body `{ override_reason }`；強制鎖定（coverage 未齊）body `{ force: true, override_reason }`。兩樣都有時 lock API 淨係得一個 `override_reason` 欄，合併成「差異原因；強制鎖定：強制原因」。e2e：mock `has_diff` 驗證唔打 lock → 填原因 → body。
3. **修復預設月份**：舊版預設上個月（修復係對已完結月份）。而家 `tab==="fix"` 且月份來源係預設時用上個月（`useMonthState(tab==="fix" ? 上個月 : undefined)`）；導覽「未配對保安員修復」連結（`getNavLinks` 動態帶 `&month=上個月`，`isLinkActive` 比較 query 時忽略 `month`，testid 去走 `&month=`）、首頁「要老闆決定」格、tab 切換連結都帶月份；`RosterUploadsClient` 跟 URL `?month=` 變化（soft navigation）。
4. **解鎖輸入按權限**：server wrapper `hasPermission("月結鎖定解鎖","void")`（同 lock／unlock API 一樣）→ `canUnlock`；冇權（主管）已鎖定都唔出 `unlock-box`。e2e 主管 0／老闆 1。
5. **RosterEditor 拖選**：改用 `pointerType`（容器 `onPointerDown` 記低，`mouse` 先容許 `mouseenter` 範圍拖選），唔再用闊度（`compact`）判斷，所以窄窗口桌面滑鼠用家仍然拖得；觸控／筆唔延伸。wp-r2 (f) 改用 `tap()`（touch pointer）。
6. **收件箱**：註解／§8.3 第 3 點改正「本月＋上月」；「更表未對數」卡連結帶 entries 最早有嘢做嗰個月（`/roster-uploads?month=…`）。
7. **版面**：首頁待辦收件箱放喺歡迎標題（PageHeader）下面（`ShortfallDashboard` `afterHeader` slot）；`MonthPicker` input 闊度 118→150px（英文 locale「October 2026」唔再黐住日曆 icon）。
8. **文件**：§8.3 過時句改正；e2e 數字、「14 頁」寫清楚（見上）；`p2b-finance-pages.spec` 註解更新。**設計取捨**：月份記憶跨頁共用（含 `persistDefault` 報表族）——揀過／睇過某月之後，其他頁（包括 `/month-close`）唔再預設上個月而係跟住該月；`/month-close` 只有喺完全冇 URL／sessionStorage 月份時先預設上個月。要避免請喺 `/month-close` 連結帶 `?month=`（鎖月連結已經帶；首頁月結格暫時靠 sessionStorage，去到嘅月份一樣——驗收 (ii)，階段 4 可補 `?month=`）。
9. **第二輪驗證**：tsc 0；lint 0；`rm -rf .next` build 過；vitest 214 檔（213 過、1 skip），3,434 passed｜10 skipped（含 term-guard）；Playwright 全部 spec（`db:reset` 後）192 passed｜5 skipped｜0 failed；gate 冇重跑（無計算改動）。

#### 8.3.3 驗收、部署、正式站核對（2026-10-11 凌晨）
- Opus 5.5 第一輪**唔通過**（3 必修：MonthPicker hydration #418（URL／sessionStorage 月份 ≠ 預設時 SSR 錯配，4 頁各 1 個）；有 §6.3 紅色差異嘅月份 UI 鎖唔到（一般鎖月送 `{}`、API 要 `override_reason`，舊頁嘅 override 輸入已刪）；guard-fix tab 預設月份由上個月變本月）。執行員第二輪（`78a403e`）：`useMonthState` 初始值同 SSR 一致＋`ready` 旗（`useLayoutEffect` 後先 fetch，仍只一次；`hydrateRoot` 單元測＋變異測試證明會捉到 mismatch）；`lockMonth` 讀 `has_diff`，差異原因必填送 `{override_reason}`、強制鎖定送 `{force:true, override_reason}`、兩樣合併一個原因字串（舊頁本身只得一個欄）；fix tab 預設上個月、導覽／首頁連結帶 `&month=`；解鎖框按「月結鎖定解鎖:void」；RosterEditor 拖選改 `pointerType`；收件箱放歡迎標題下；MonthPicker 150px。第二輪通過（0 必修；(ii)：test exhaustive-deps warning（規劃者已補 eslint-disable）、首頁月結格未帶 `?month=`（靠 sessionStorage，階段 4 補）、強制＋差異合併 body 冇 e2e、修復連結永遠帶上個月會蓋過 storage 月份（設計取捨）、修復 tab 載入 `guard-fix/postorder` 打兩次）。驗收員自跑：vitest 3,434 過；tsc 0；lint 0；build 過；**Playwright 全部 192 passed／5 skipped／0 failed**；自寫 hydration spec 21 個頁面載入 0 個 #418。
- merge main `a18ce3b`；部署 `6aca8f8efb15905b77d54fa3` RUNNING 19:25Z：56 migrations／No pending、助手 claude、OCR 自檢 ok、login 200。
- **正式站核對（老闆 Chrome 唯讀）**：側欄 **17 條／6 組**（首頁 1、排更 3、對數 2、月結 3、資料 4、設定 4），nav 唔使捲；首頁待辦收件箱（待審批 0 更／待答 140 題／更表未對數 13 盤／月結進度／要老闆決定 6 項）喺歡迎標題下面；`/reports/shortfall` → `/`；`/guard-fix?month=2026-09` → `/roster-uploads?tab=fix&month=2026-09`、側欄「未配對保安員修復」active、CSV 面板收入「其他上載方式」；月份記憶：毛利揀 8 月後開糧明細自動 2026-08、只 fetch 一次、報表 5 個 tab 齊；`/reports/monthly-close` 冇鎖／解鎖掣、有「更多 ▾」、規則卡標題無「§6.3」；`/guards`「新增 ▾」三項（手動／用證件／批量導入）。
- **正式站發現（交階段 4 修，P3-4.0）**：用舊工作台鎖嘅月份（7、8 月，冇一鍵 run）喺 `/month-close` 顯示「⑤ 鎖定 未到」、冇「已鎖定」、冇解鎖框；`/reports/monthly-close` 嘅鎖／解鎖掣已刪 → 舊鎖月份暫時冇 UI 顯示鎖定狀態／解鎖入口（API 照舊）。要求鎖定狀態由 `month_closes` 記錄決定、唔依賴 run。
- 另：規劃者 Chrome 視窗闊 885px，AI 側欄開住時會覆蓋主內容（側欄狀態跨頁記住）——核對時要先收埋側欄。

---
### 8.4 階段 4 落實紀錄（Sonnet 5.5，2026-10-11，branch p3-phase4）
逐項獨立 commit（P3-4.0 至 P3-4.4）。**只改顯示層**：API 合約、權限矩陣、任何定價／結算／報表計算全部冇改；冇 migration。

**P3-4.0 鎖月狀態（規劃者加入：階段 3 上線後正式站發現）**
- 一鍵結算頁 `locked` 以 `GET /api/month-closes?month=` 記錄為準（有記錄就用 `locked_at`；冇記錄先睇 run 報告），唔依賴有冇 run。7、8 月（舊月結工作台鎖嘅、冇 run）：StageBar「⑤ 鎖定 已鎖定（M/D）」、`LockSection` 單獨出（`report=null` 模式：已鎖定＋鎖定時間＋解鎖框，按「月結鎖定解鎖:void」權限，原因必填）；未鎖又冇 run 照舊「未到」。`month_closes.locked_by` 只係用戶 id（API 唔畀名），所以只顯示「鎖定人見操作紀錄」。
- `/reports/monthly-close` 右欄狀態卡：「已鎖定（日期）· 去一鍵結算解鎖 ›」／「未鎖定 · 去一鍵結算鎖月 ›」（有 month_closes 記錄先出狀態卡，維持原行為）。
- 首頁月結格連結補 `?month=`；修復 tab 載入時 `guard-fix/postorder` ×2：**舊有**（mount effect 同 `[month]` effect 各打一次），已去重。

**P3-4.1 Design token／type scale／斷點**
- `globals.css` 新增 6 色 token（`zk-success-tint`／`warning-tint`／`danger-tint`／`primary-light`／`dark-hover`／`amber`）＋8 級字號（`text-zk-2xs 10.5｜xs 11｜sm 12｜base 13｜md 14｜lg 16｜xl 20｜2xl 28`；內建 `text-xs`／`text-sm` 照用）。
- 一次性 codemod 留喺 `scripts/one-off/p3-4-tokens.mjs`（class）、`p3-4-tokens-strings.mjs`（inline style／字串 → `var(--zk-*)`）：arbitrary hex class、Tailwind 原生色（red→danger、green→success、orange／amber／yellow→warning、blue→primary、gray→text／border／surface）、`text-[Npx]` 全部換 token；字號就近映射（半級向下：11.5→11、12.5→12、13.5→13、15→14、17／18→16、19–22→20、26／28／30→28）。
- 斷點只剩 `sm`（640，表↔卡）同 `lg`（1024，外殼）：`md:` 全部改 `lg:`（15 個檔）；JS 用 `src/lib/ui/breakpoints.ts`（`MQ_BELOW_SM`／`MQ_BELOW_LG`／`LG_PX`），`RosterEditor` 639→`MQ_BELOW_SM`、`MonthCloseTriageDialog` 767→`MQ_BELOW_LG`（平板直向都係全屏手機版）、AI 側欄 1024→`LG_PX`。

**P3-4.2 元件唯一化**
- `Banner` 唯一（`kind` info／success／warning／error、`compact` 圓點樣式＋`action` slot、可傳 `children`／`data-testid`）；`Notice` 刪；手寫紅框錯誤 12 處改 `Banner`；新增 `FieldError`。
- `Button` 唯一：variant `primary｜secondary｜dark｜danger｜dangerSolid｜ghost｜link｜linkMuted｜linkDanger`、size `sm｜md`；`btnPrimary`／`btnSecondary`（近黑）刪（47 處改藍／白 `Button`）；`button-classes.ts` 命名 class：`iconBtn`／`menuItemBtn`／`touchBtn`／`choiceBtn()`／`choiceBtnText()`。
- 確認：新 `ConfirmDialog`／`useConfirm()`（Promise 式，取代 `window.confirm` 13 處：rate-cards 複製上月／重新計價、月結還原自動改動、保安員刪電話／地址／聯絡人／改返現用、糧明細／更表重新計價）；`window.alert` 5 處（重新計價結果、略過 PR）改 info `Banner`（`roster-info-banner`／`payroll-notice`）。唯一保留：`unsaved-guard`（同步攔截離頁／換月，要同步回傳）。
- 表格：`TableLoadingRow`／`TableEmptyRow`（23 處取代「載入緊…」／空行）；自寫 `<table>` 7 個改 `tableCls`（剩 RosterEditor 格仔表、AI markdown 表兩個特例）；`<th>` 補 `tableCls.th`。
- `UnpricedNotice`（`src/components/UnpricedNotice.tsx`）5 份合 1：報表頁（毛利／月結總表／糧明細／本月應收）`variant="compact"` 一行＋「去處理 ›」（`/rate-cards?month=`）；`RosterEditor` `variant="full"`（逐組清單＋重新計價掣＋冇結算單位獨立 error）。
- `useCrudPage`（`src/lib/ui/use-crud-page.ts`）：brokers／sites／quotas／users 共用 rows／loading／error／notice／drawer／editingId／form／saving＋`saveForm()`／`runAction()`；GuardsClient／rate-cards 留階段 5。

**P3-4.3 面板清理 H1–H22 對照**
| H | 狀態 | 備註 |
|---|---|---|
| H1 H2 H3 H4 H5 H6 H7 H8 H10 H11 H13 H17 H21 H22 | 階段 3 已做 | 核實同現況一致（見 §8.3） |
| H9 UnpricedNotice | 今次做 | 見上 |
| H12 進度 | 今次做 | 全部跑完、冇錯、冇要人手處理 → 摺成「N / N 步完成 · 展開 ›」；有錯／有要人手先展開；手機（<lg）一律預設摺，標題列講「N 步有項目要人手處理」；技術明細收 `<details>` |
| H14 分診 | 今次做 | 預設只顯示有未答；摺埋 N 張＋「顯示全部 ›」；轉交收入每張卡「⋯」 |
| H15 ops-digest | 今次做 | Top 雞頭代號、基線指標收 `<details>` |
| H16 audit-log | 今次做 | `audit-field-labels.ts` key→中文欄名（camel／snake 都識，冇對照照顯示）；只顯示有改嘅欄；原始 JSON 收 `<details>` |
| H18 保安員 Drawer | 今次做 | tab 基本／證件／聯絡／長工／銀行（`Tabs` 元件）；各區塊（連權限遮罩）一律照舊 mount，只係 `hidden` 切換；長工 tab 雞頭唔出、銀行 tab 冇權唔出；Drawer 內 `btnPrimary` 改 `Button` |
| H19 長工糧 | 今次做 | tab 本月糧（總額卡＋逐人表＋BOCHK 檔）／人手輸入／合約（含 Maxwell 導入）／平均工資與假期；唔改計糧，鎖月唯讀照舊 |
| H20 登出提示 | 今次做 | 改 `title`；手機抽屜刪常駐字 |

**P3-4.4 月結頁手機版面（<lg）**
StageBar 一行可橫捲；`RightRail` 同一組 testid 但 <lg 變底部 sticky 一行 CTA（「N 題要你睇／開始逐條答／鎖定」，避開 AI 浮動掣），自動改動卡留喺內容流（還原唔失）；上載區（更表＋名單齊）手機預設收起；進度手機預設摺；報告 KPI 2 欄（總成本橫跨 2 欄）；`users` 表手機變卡（同一 DOM、CSS 變 block）；其餘表格頁（audit-log、roles、longterm-payroll、monthly-close、ops-digest、guards/import、修復 tab）全部量度 375px `scrollWidth`＝375。MonthCloseTriageDialog <lg 全屏（見 P3-4.1）。

**Before → after**
| 指標 | before | after |
|---|---|---|
| 寫死 hex（`#rrggbb`，src＋css；含註解） | 455 | 65（`globals.css` token 定義約 40＋註解；程式內非註解 27，其中 18 係 broker／shift 資料調色盤檔） |
| arbitrary 色 class `bg-[#…]` | 254 | 7（頭像靛色、近似色） |
| Tailwind 原生色 | 319 | 0 |
| `text-[Npx]` | 685（20 種） | 0（8 級 `text-zk-*`） |
| 手寫 `<button` | 210 | 64（含 `Button.tsx`）；literal className 種類 33 → 14 |
| `btnPrimary`／`btnSecondary` | 47 | 0 |
| `<Notice` ／ `<Banner` | 24 ／ 61 | 0 ／ 91 |
| `window.confirm`／`alert` | 18（含註解） | `confirm` 9（真實呼叫：改成 `ConfirmDialog`／`unsaved-guard`）＋`alert` 5 已改橫幅；剩 `unsaved-guard` 1 個 `window.confirm` |
| 自寫 `<table>`／`<th>` 無 `tableCls` | 9／23 | 2（格仔表、markdown）／4 |
| 斷點門檻（Tailwind＋JS） | `sm`／`md`／`lg`／`xl`＋JS 639／767／1024 | `sm`／`lg` ＋ `breakpoints.ts` 常數 |
| 月結頁 375px 整頁高（假資料） | 5,793px | 4,018px；「④ 報告」標題喺 3 屏（2,400px）內（e2e 斷言） |
| vitest | 213 過／1 skip，3,434 | 214 過／1 skip，3,446（新增 `p3-4-ui.test.ts` 12 條） |
| Playwright | 192 passed｜5 skipped｜0 failed | **214 passed｜5 skipped｜0 failed**（新增 `p3-4-ui.spec.ts` 15 條、`month-close-ui` 加手機斷言） |
| `tsc`／`eslint`（0 warning）／`rm -rf .next && next build` | 過 | 過（`/` First Load 116 kB；共用 103 kB 不變） |
| `gate:locked-months` | 12/12 | 12/12 rc=0 |

**刻意改動清單（視覺回歸，對照階段 3 截圖）**
1. 色：`text-gray-*`／`border-gray-*` 等中性灰改 slate 系 token（略偏藍灰）；`#475569`→`text-secondary`（#334155，略深）；`#f97316`／`#ea580c` 橙點→`zk-warning`（#c2410c，略深）；`#bfdbfe`／`#a7f3d0` 邊→`primary-tint`／`success/30`；green 邊（300）→`zk-success/30`。
2. 字號：半級向下合併（見上），表頭 11.5→11、備註 12.5→12、正文 13.5→13；`text-[15px]`→14。
3. 按鈕：Drawer／表單主掣由近黑改藍（`Button primary`），次掣白底灰邊；「恢復」類原綠框掣改 secondary；列表行動作統一 `size="sm"`（padding 略不同）。
4. 提示：`Notice` 全部改 `Banner compact`（外觀不變）；其餘錯誤框統一 `Banner`。
5. 確認／結果：原生 confirm／alert 變頁內 `ConfirmDialog`／info 橫幅。
6. 報表頁未定價提示收成一行＋「去處理 ›」（逐組清單只喺更表編輯器出）。
7. 保安員 Drawer、長工糧頁變 tab；進度、上載（手機）、基線指標、Top 雞頭、audit JSON 收起。
8. 分診預設只列未答；轉交收入「⋯」。
9. 月結頁手機：右欄變底部 sticky CTA；上載／進度預設收起。平板（768–1023）全部跟手機版面。
截圖（5 角色 × 桌面 1512×900／手機 375，首頁、月結頁、保安員頁〔Drawer 開〕、長工糧、更表上載、審批；seed 資料，唔入 repo）：`/private/tmp/claude-501/-Users-macbookpro-zoi-kan/41316f0d-3a34-4ae3-a8de-d2fb6db0b018/scratchpad/perf/p3-4/shots/after/`；5 角色 6 頁×2 viewport 全部 `scrollWidth`＝viewport 闊。

**偏離／風險（請規劃者決定）**
1. 手寫 `<button` 冇減到 <10：剩 64 個，主要係 RosterEditor（格仔／鍵盤／選單）、月結頁 RightRail／LockSection／AI 側欄浮動掣、MonthCloseTriageDialog 大觸控掣，種類（literal className）14 種；已將一般按鈕全數改 `Button`，其餘屬格仔表／鍵盤／icon／選單，留待階段 5 隨 RosterEditor 拆分一齊收。
2. hex 剩 27（程式內）：18 係 `broker-color.ts`／`shift-code-color.ts` 資料調色盤（靛／紫等唔係 token 色），其餘 manifest／themeColor／canvas。
3. `<th>` 無 `tableCls` 剩 4（RosterEditor 格仔表表頭＋markdown 表）。
4. 簡報「`<Button>` 全 repo 45 處」＝47 處 `btnPrimary`／`btnSecondary`；原近黑主掣改藍屬簡報要求。
5. 鎖定人：`month_closes.locked_by` 係用戶 id，API 唔回名；顯示「鎖定人見操作紀錄」。
6. `unsaved-guard` 仍用 `window.confirm`（同步攔截）。

**未測**：production／真機觸控（手機 e2e 係 Chromium 模擬）；`ConfirmDialog` 鍵盤焦點陷阱未做（Esc／點遮罩可取消）；`audit-field-labels` 對照表只覆蓋常見欄位；tab 內 `required` 欄喺隱藏 tab 嘅原生驗證提示（目前 `required` 只有基本 tab 嘅姓名）。

#### 8.4.1 驗收後修正（Opus 5.5 驗收唔通過 → 修正，Sonnet 5.5）
斷點政策＝**兩門檻（`sm`／`lg`）＋ReportSection 內層例外**。
1. `ReportSection` 逐雞頭應付／逐盤收入兩張表並排改返 `xl:`（1024–1279px 名欄逐字斷行）；呢處係斷點唯一例外。
2. 手機 KPI 卡：成本卡 `max-lg:order-last`（營業額＋毛利同一行）；金額 `break-all`→`whitespace-nowrap`＋`max-lg:text-zk-xl`；`month-close-ui` 手機 e2e 加斷言（同一行、金額單行）。
3. 保安員 Drawer：預設雞頭／聘用形式／月薪／Polo 尺碼搬入「基本」tab；隱藏 tab 有 invalid／required 欄時（`onInvalidCapture`）自動跳去該 tab 並顯示原生提示。
4. `RateCardsClient` mount 後讀 `?month=` 做生效月初始值（本地 state；唔帶＝空＝全部；mount 後讀避免 hydration mismatch）。
5. `loadMonthClose` 用 ref 對返 request 月份先 set（快速換月 race）。
6. 手機 sticky bar：鎖定掣停用時顯示「條件未齊，未可以鎖」／「要填差異原因先鎖得 · 去填原因 ›」（錨去 LockSection `#diff-reason-box`）。
7. 手機抽屜登出掣旁邊保留一行「登出會同時登出所有裝置」。
8. `pricing.spec` 重新計價取消 case 補斷言：冇 `dry_run:false` 請求。
9. audit-log 欄位名加 `title` 顯示原 key（區分 `effectiveFrom`／`validFrom`、`id`／`number` 同名）。
10. 清走 codemod 留低嘅純空白行（44＋1 行）。**數字改正**：真實 `window.confirm` 呼叫 9＋`window.alert` 5＝14 處（§8.4 表原寫 13／5）；hex 程式內非註解行：本機 grep 量得 27（Opus 驗收量得 25，計法略有出入，兩者都 <40）。

#### 8.4.2 驗收、部署、正式站核對（2026-10-11 清晨）
- Opus 5.5 第一輪**唔通過**（2 必修：`ReportSection` 兩張表 `xl:`→`lg:` 令 1024–1279px 雞頭名逐字斷行；手機 KPI 卡成本卡夾中間＋`break-all` 令金額斷行）；執行員修 2 必修＋10 項（Drawer 散落欄入基本 tab、隱藏 tab invalid 自動跳、rate-cards 讀 `?month=`、`loadMonthClose` race、手機 sticky bar 停用原因＋「去填原因 ›」、手機登出提示、pricing.spec 補 `dry_run:false` 斷言、audit-log `title` 原 key、清 44 行空白、數字改正）；第二輪通過（0 必修）。驗收員自跑：vitest 3,446 過；tsc 0；lint 0 warning；build 過；**Playwright 全部 215／5／0**；codemod 重放 `a18ce3b` 得出同一 commit（可重現）；1024／1100／1280／1512 名欄 242／318／113／219px；375px 營業額＋毛利同行、金額單行、`scrollWidth` 375。(ii)：多個隱藏 tab 同時 invalid 跳去最後一個；「去填原因」無 e2e；手機 sticky bar 81px；`ReviewCard` 四欄 1024–1279 擠（舊有）；對比度兩組 4.38／4.41（未同時使用）——交階段 5。
- merge main `59ed20c`；部署 `6acaa71dc0a5252069b835d9` RUNNING 21:05Z：56 migrations／No pending、助手 claude、OCR 自檢 ok、login 200。
- **正式站核對（老闆 Chrome 唯讀）**：`/month-close?month=2026-08`（舊流程鎖、無 run）：StageBar「⑤ 已鎖定」、`locked-info`＋`unlock-box`（含解鎖原因欄）齊，「已鎖定」字樣 5 處，無 inline hex 色；`/reports/monthly-close?month=2026-08`：「已鎖定 · 去一鍵結算解鎖 ›」連結、0 個鎖／解鎖掣、「更多 ▾」；保安員 Drawer：tab「基本／證件／聯絡／長工」＋散落欄喺基本 tab（「銀行」tab 未出現——視乎老闆帳號該權限格，待核）；糧明細「重新計價」撳落（只到預覽，未確認）；月結頁 StageBar 一行、底部 sticky CTA 81px、金額單行（規劃者 Chrome 無法真正縮到 375px，手機尺寸靠 Opus Chromium 量度）。

---

### 8.5 階段 5 落實紀錄（Sonnet 5.5，2026-10-11，branch p3-phase5）
逐項獨立 commit（P3-5.1 至 P3-5.5）。**純重構**：行為、API 合約、權限矩陣、任何定價／結算／報表計算全部冇改；冇 migration；唯一「行為」改動係 `/guards` 名冊改為分頁 render（簡報明文要求，API 不變）。

**P3-5.1 拆 RosterEditor（2,807 行）→ `roster/[site]/[month]/editor/` 18 檔，最大 564 行**
- `RosterEditor.tsx`（容器＋state 接線 564）｜`useRosterData.ts`（載入／重新 fetch／靜態資料快取／未定價摘要 218）｜`useCellSelection.ts`（選格／編輯／拖選／鍵盤／手機鍵盤 buffer／右鍵選單 509）｜`useRosterActions.ts`（儲存／重新計價／還原／複製上月／加保安員／整行填＋儲存 toast 狀態 462）｜`RosterGrid.tsx`（格仔表 469）｜`RosterHeader.tsx`（桌面＋手機頁首 263）｜`RosterBrokerStats.tsx`｜`RosterNotices.tsx`（橫幅＋本月配額列）｜`MobileKeyboard.tsx`｜`ContextMenu.tsx`｜`FillRowModal.tsx`｜`AddGuardModal.tsx`｜`SaveToast.tsx`｜`DayCell.tsx`｜`roster-types.ts`｜`roster-utils.ts`（純函數，含 `computeBrokerStats`）。
- 全部 `data-testid` 不變；DOM 結構同拆前一樣（子元件用 Fragment）。載入完成後要重置嘅 UI 狀態（警告／錯誤／選格）由容器經 `onLoadedRef` 注入，呼叫位置同拆前一致。
- 簡報原定 `useCellSelection`／`RosterGrid`／`RosterToolbar` 等名稱照用；`RosterToolbar` 實際拆成 `RosterHeader`＋`RosterBrokerStats`＋`RosterNotices` 三個（每個 <300 行）。

**P3-5.2 拆 GuardsClient（2,638 行）→ `guards/` 15 檔，最大 445 行；名冊分頁 render**
- `GuardsClient.tsx`（容器 272）｜`GuardsTable.tsx`（桌面表＋手機卡＋分頁）｜`GuardsFilters.tsx`｜`GuardDrawer.tsx`（Drawer 殼＋tab 組合）｜`drawer/BasicTab|DocsTab|ContactsTab|LongtermTab|BankTab.tsx`｜`useGuardForm.ts`（表單／開關／儲存）＋三個子資源 hook `useGuardStaffNumbers`／`useGuardContacts`／`useGuardLongterm`｜`guards-types.ts`｜`guards-utils.ts`。
- Drawer 各區塊 **DOM 次序同拆前完全一致**（e2e 有靠 `.first()` 揀欄，tab 只係分檔唔改次序）；PII／銀行／出街價 field-group 嘅「送唔送」判斷（`canUpdate*`、`detailAvailable`）原封搬過去。
- **`/guards` 分頁 render**：一次最多 render 100 行（桌面表＋手機卡同一個 slice），底部「顯示 100 / N 位」＋「載入更多（還有 N 位）」；搜尋／篩選照舊 server 做（`GET /api/guards?q=`，API 不變），搜尋／篩選改變先由頭開始（儲存後 reload 唔會跳返頂）。本機 seed 266 人：DOM 節點 9,553 → **3,710**（每行 ~35 節點；540 人 ≈19.2k → 3.7k）。新增 e2e `p3-5-guards-page.spec.ts`。

**P3-5.3 合併重複**
- `src/lib/ai/chat-handler.ts`：兩條 chat route（`api/ai/chat`、`api/feedback/session/chat`）共用 SSE 骨架（session → 每日額度 → body 校驗 → route 專屬前置 → LlmClient → history／tools → loop → 切 chunk → 存對話 → audit → `done`／`error`）。每條 route 只剩差異：prompt、輸出 guard 鏈、存儲、audit／done payload、錯誤日誌。**byte-equal 證明**：`tests/p3-5-chat-sse.test.ts` 用**重構前舊碼**錄低 15 個場景（一般／長回覆多 chunk／空白 fallback／輸出 guard 觸發／可行性 guard／LLM 錯誤兩種／401／400×3／404）嘅 status＋header＋SSE 全文 golden（`tests/fixtures/p3-5-chat-sse-golden.json`），重構後逐字相同。`src/lib/ui/chat-stream.ts`：兩個 client（`ai-chat-client`、`feedback-chat-client`）共用 `streamChatSse()`。
- API 小樣板：`lib/api/route-modules.ts`（`guardModule`／`siteReadModule` resolver——8＋3 處重複定義；`assertScopedGuard()`——11 個保安員子資源 route 17 處）、`lib/roster-upload/reconcile-guard.ts`（`assertUploadReconcilable()`，reconcile apply／resolve-subsite）。response 不變。
- `rate-cards` 改用 `useCrudPage`（GuardsClient 用 `useGuardForm`）；`DrawerFormFooter`（5 頁儲存／取消掣）、`FeedbackForbidden`、`shift-records/batch` 逐格／批量兩條路徑共用 `upsertUpdateData`／`upsertCreateData`、`ui/api-client` 共用 `readResult()`、`BrokerFilterControls`。
- **唔合併**（定價核心）：`month-close/auto/pricing.ts` `fetchCardsVia` ↔ `pricing/resolve-rate.ts` `fetchEffectiveRateCards`——只加互相指向註解。

**P3-5.4 死碼**
- `npx knip --fix`（exports,types）＋級聯清理：src 多餘 `export` 191 → 0、多餘 type export 105 → 0（約 40 個同檔未用嘅宣告連帶刪走：`pickFields`／`coerceDateFields`／`formatPlanSummaryMd`／`loadUTeamList`／`clearReconcileDataCache`／`findCarryoverCard`／`useLookups`／`FieldError`／`touchBtn` 等；附錄 a §2.5 十三個「疑似死函數」：5 個確認無人用已刪，其餘同檔仍有用只取消 export）；`QUESTION_KINDS`／`MC_KINDS`／`PERSON_FIELDS` 等只作型別用嘅常數改成 union type。`Duplicate exports` 3 → 0（`selectCls` 不再 alias `inputCls`；`project.ts` 兩組 alias 隨 export 清理消失）。新增 `knip.json`：`scripts/**`、`tests/**` 當 entry（CLI／測試入口，原本被當「unused files」同「unused exports」），所以 `npx knip` 現時 0 項；**唔用 config**（`knip（唔用 knip.json）`）src 範圍亦係 0，剩 scripts 範圍 52 exports／27 types／25 files（一次性 CLI 腳本之間互相 import）。
- 依賴宣告：`@prisma/client`、`prisma`、`tsx`、`exceljs`、`csv-parse`、`dotenv` 由 devDependencies 搬入 dependencies（production code 或 Dockerfile 啟動腳本實際用緊；`package-lock.json` 同步，`npm ci --dry-run` 過；Dockerfile `--include=dev` 不變）。
- `scripts/one-off/p3-4-tokens*.mjs` 歸檔去 `scripts/archive/one-off/`；`README.md` 改寫成真正 README（一句描述、技術棧、本機起法、測試、目錄、部署）；`docs/api.md` 去 `formatPlanSummaryMd` 提及。§8.4 提到嘅 `FieldError`／`touchBtn` 一直冇人用，今次刪走。

**P3-5.5 階段 1–4 驗收 (ii) 收尾**
- 階段 1：`pending-summary` 查詢數唔隨份數增長斷言（已由階段 1 驗收員補入 `p3-1-pending-summary.test.ts`，核實存在）；tie-breaker test 改括號配對（`orderByHasIdTieBreaker()`，巢狀 `[]`／`{}` 都識，有自測）；`one-click-read.ts` `::date` 改傳 `YYYY-MM-DD` 字串（唔再靠 PG session TimeZone；`TZ=America/Los_Angeles` 跑 `p3-1-one-click-list` 過）。
- 階段 2：`runOneClickMonthClose` 開自己全新 memo context 嘅守護 test 改讀 `als.getStore()`（`currentReportMemoStore()`）——以 DB 寫入做時間標記，斷言「開新 context 先於任何 DB 寫入／memo」，**變異驗證**：拿走 `one-click.ts` 嘅 `withReportContext` 包裝，新 test 即紅（舊毒值 test 兩邊都過，鑑別力不足）；`writeAuditMany` 同批 audit 次序：同批 id 改為批內序號升序（`orderedAuditIds()`，前 8 hex＝序號、其餘隨機，**唔加 migration／seq 欄**），audit-log 列表 `createdAt desc, id asc` 因此保持 plan 次序（test 40 條）；`api-client.ts` `apiGetAll` 註解改準（`pageSize` 唔可以大過 server `take` 上限、停止條件睇 `total`）。**已知／未處理**：兩批同時 create 同組新 key 次序相反會死鎖回 500（舊有，記錄為已知）。
- 階段 3：新增 e2e——強制鎖定＋紅色差異同時有：先要差異原因，body 合併成 `{ force: true, override_reason: "差異；強制鎖定：原因" }`。
- 階段 4 遺留：Drawer 多個隱藏 tab 同時 invalid → 跳去 **DOM 次序第一個** invalid 欄嘅 tab（`onInvalidCapture` 只處理 `:invalid` 第一個；e2e 用 `setCustomValidity` 喺「證件」＋「銀行」tab 各設一個）；手機 sticky bar「去填原因 ›」錨點 e2e（375px：撳鎖定 → 出提示 → 撳連結 → URL `#diff-reason-box` 且輸入框入畫面）；`ReviewCard` 四欄改 `sm:grid-cols-2 xl:grid-cols-4`（1024–1279px 兩欄，唔再擠）——**斷點政策**更新為「兩門檻（`sm`／`lg`）＋`ReportSection`、`ReviewCard` 兩處 `xl:` 內層例外」。

**Before → after**
| 指標 | before | after |
|---|---|---|
| src 檔數／行數 | 463／76,590 | 498／77,762（拆檔加咗 import／props 樣板，去重＋刪死碼抵銷大部分） |
| `RosterEditor` 最大檔 | 2,807 行（單檔） | 564 行（`editor/` 16 檔） |
| `GuardsClient` 最大檔 | 2,638 行（單檔） | 445 行（`guards/` 15 檔） |
| src 其餘超過 600 行嘅檔 | 25（另 2 個巨型檔） | 25（唔屬今次範圍：`roster-export.ts` 1,178、`RosterUploadsClient.tsx` 1,158 …） |
| knip 多餘 export／type／重複 export | 245／105／3（src 191／105） | **0／0／0**（`knip.json`；無 config 時 src 亦 0） |
| jscpd（src，min-tokens 60） | 2.62%（194 組，2,005 行） | **1.99%**（161 組，1,543 行） |
| `/guards` DOM 節點（本機 266 人；540 人推算） | 9,553（19.2k） | **3,710**（3.7k） |
| vitest | 213 過／1 skip，3,446 條 | 215 過／1 skip，3,470 條 passed｜10 skipped（新增 `p3-5-chat-sse` 15 條、tie-breaker helper 自測、memo 守護、audit 次序等） |
| Playwright | 214 passed｜5 skipped｜0 failed（§8.4）→ 215（§8.4.1） | **220 passed｜5 skipped｜0 failed**（production server `next start`，5.1 分鐘；新增 5 條：`p3-5-guards-page` 2、強制＋差異 body 1、sticky bar 錨點 1、Drawer 多 tab invalid 1）。`next dev` 全套另跑：219 passed｜5 skipped｜1 failed——失敗位置每次都撞正「dev server approaching the used memory threshold, restarting」（pricing (g)／(f)、reconcile-ui deep link，每次係不同 test），單獨重跑全部過，屬 dev server 自己重啟，唔係 code |
| `tsc`／`eslint`（0 warning）／`rm -rf .next && next build` | 過 | 過（`/` First Load 116 kB；共用 103 kB 不變；`/guards` 132 kB、`/roster/[site]/[month]` 129 kB） |
| `gate:locked-months` | 12/12 | **12/12 rc=0**；`snapshot.json` 5,080 個數字葉同階段 4 gate 逐項一致（uuid 不計） |
| chat SSE byte-equal（15 場景） | — | 逐字相同 |

**偏離／風險（請規劃者決定）**
1. 「`/guards` 分頁 render」係唯一有可見行為嘅改動（首屏 100 行＋載入更多）；用瀏覽器 Ctrl+F 搵唔喺首 100 行嘅人要先撳「載入更多」或用搜尋框。若老闆想要「一次顯示全部」，把 `GUARDS_PAGE_SIZE` 改大即可。
2. 超過 600 行嘅檔仍有 25 個（簡報只指定兩個巨型檔；其餘如 `roster-export.ts`、`one-click.ts` 屬定價／匯出核心，唔郁）。
3. `knip.json` 令 scripts／tests 當 entry——scripts 之間嘅「只被一次性腳本用」export 唔再報；若要連 scripts 都清，要逐個決定歸檔邊啲 CLI。
4. 依賴搬動靠手改 `package-lock.json`（離線環境，`npm install --package-lock-only` 要連 registry）：root 兩組依賴同每個套件嘅 `dev` 旗按可達性重算（先驗算法：用舊 lock 重算同現有旗 0 差異，740 個套件）；`npm ci --dry-run` 過。部署用 `npm ci --include=dev`，唔受影響。
5. bundle：`/guards` 124 → 132 kB、`/roster/[site]/[month]` 124 → 129 kB first load（附錄 a 基線 → 今次 build；主要係階段 4 加嘅 Tabs／ConfirmDialog／Drawer 分 tab，唔係階段 5 拆檔）。

**未測**：production／真機觸控；540 人真實 DOM（用 266 人 seed 量度＋每行節點數推算）；`/guards` 分頁喺正式站嘅 Ctrl+F／無障礙行為。


---

#### 8.5.1 驗收、部署、正式站核對（2026-10-11 朝早，P3 完結）
- Opus 5.5 驗收：有條件通過（1 必修＝`package-lock.json` 係離線手改，28 個套件 `dev` 旗唔啱（esbuild 平台 binary、fsevents、typescript）——正式站 `npm ci --include=dev` 唔會爆，但 `--omit=dev` 會缺 tsx 用嘅 binary）；規劃者喺 worktree 用 `npm install --package-lock-only` 重生成、`npm ci --include=dev` 驗證，並清走 knip 留低嘅 10 行 `;`、過時註解、文件數字（`c4928ec`）。驗收員自跑：真 `npm ci` 577 套件 9 秒；vitest 3,470 過；tsc 0；lint 0 warning；build 過；**Playwright 220／5／0（production server）**；拆檔逐行對照（RosterEditor 1,474 獨特行只 66 行係 export／type／deps 變化；GuardsClient 33 行）、testid 集合不變、PII gate 區塊 diff 0；chat golden 用舊碼重錄 16/16 相同＋驗收員自加 11 場景逐 byte 相同；變異測試證明 one-click `withReportContext` 守護 test 有效；`TZ=America/Los_Angeles` 下 one-click 列表 test 過。(ii) 已處理：`;` 行、`findCarryoverCard` 註解、README `db:reset` 描述、檔數 16／15；未處理：換月唔重置分頁（影響細）。
- merge main `5d19264`；部署 `6acac3f2fb15905b77d552ac` RUNNING 23:08Z：56 migrations／No pending、助手 claude、OCR 自檢 ok、login 200、啟動冇缺模組。
- **正式站核對（老闆 Chrome）**：`/guards` 首屏 100 行、「顯示 100 / 540 位」、DOM **3,707**（基線 17,934）、撳「載入更多」→ 200 行／7,309；更表編輯器載入正常（grid、10 API、0 console error）；AI 助手問「9 月有幾多題未答」→ 答 18 題（分類正確）、4 張卡、無殘留 block。現場反映 chat 同更表儲存＋撤銷冇喺正式站實測（避免寫入），靠 golden test／e2e。
- 收尾：五個 feature branch（p3-phase0…5）已 push 做備份；worktree 全部清走；本機 `data/ops/backup-*.sql.gz` 2026-10-17 後刪；舊香港 Zeabur 專案 2026-10-17 後由老闆刪。

## 9. 總結 before／after 總表（階段 0–5，P3 完結）

§4 每項目標逐項對照。「量法」同各階段紀錄一致：本機＝合成數據（540 保安員、60 盤、9,408 更、20k audit）；正式站＝老闆 Chrome、香港→新加坡、單次。

| # | 指標（§4） | Before | 目標 | After | 達標？ | 出處 |
|---|---|---|---|---|---|---|
| 1 | `/api/guards?take=500` DB 查詢數 | 1,506 | ≤20 | **6** | ✓ | §8.1 |
| 2 | `/api/audit-log`／`rate-cards`／`shift-records`（單盤）查詢數 | 270／204／134 | ≤15／≤10／≤10 | **4／4／4** | ✓ | §8.1 |
| 3 | `pending-summary` 查詢數／本機 p50／正式站 p50 | 894／462 ms／1,151 ms | 本機 <150／<120 ms；正式站 <400 ms | 62／51 ms／**763 ms** | 本機 ✓；**正式站 ✗**（RTT 地板 ~370 ms 主導；首頁頁內 953 ms） | §8.1 |
| 4 | 正式站 `/guards` 頁最慢 API | 2,221 ms | <800 ms | **624 ms** | ✓ | §8.1 |
| 5 | 更表編輯器頁內 API 數 | 11 | ≤6 | 冷載 10（lite guards 26 KB）／暖載 7（不計未定價 banner 6） | **部分**（暖載達標、冷載未） | §8.2 |
| 6 | layout 每頁查詢（老闆） | 12＋1 HTTP | ≤4，0 HTTP | **4，0 HTTP** | ✓ | §8.1 |
| 7 | 月結工作台同一月 `buildMonthlyClose` 呼叫 | 4 | 1 | 單一 request 內 3→**1**；月結工作台入頁（兩個 request，唔跨 request 共用係鐵則）4→**2** | **部分** | §8.2 |
| 8 | 字型 CSS（gz）每頁 | 193 KB | <40 KB | **~52 KB**（41＋10） | ✗（差 ~12 KB；`next/font/local` 切片待老闆揀） | §8.2 |
| 9 | `/api/month-close/one-click` 回應 | 191 KB | <20 KB | **1.9 KB**（`?include=full` 照舊） | ✓ | §8.1 |
| 10 | 老闆側欄連結／組 | 23／5 | 17／6，700px 唔使捲 | **17／6**，唔使捲（正式站核對） | ✓ | §8.3 |
| 11 | 月份選擇器實作 | 5 種／16 頁 | 1 元件 | **1 元件**（`MonthPicker`＋`useMonthState`） | ✓ | §8.3 |
| 12 | 色值寫死／字號寫死 | 398／662 | <40／<60 | hex 程式內 **27**（連 css／註解 65）；`text-[Npx]` **0**；Tailwind 原生色 0 | ✓ | §8.4 |
| 13 | 手寫 `<button>` className 種類 | 76 | <10 | **14**（`<button` 210 → 64，其餘係格仔表／鍵盤／icon／選單） | ✗（差 4 種） | §8.4 |
| 14 | 「待處理」計法 | 9 處 | 1 收件箱＋各頁引用 | **首頁 `HomeInbox` 唯一彙總** | ✓ | §8.3 |
| 15 | 「价」 | 30 行 | 0 | **0** | ✓ | §8.0 |
| 16 | 鎖月 gate | 12/12 | 12/12、0 差 | 12/12，0 差（snapshot 5,080 數字葉同階段 4 一致） | ✓ | §8.5 |
| 17 | 測試 | vitest 3,323（194 檔） | 不減，新增覆蓋 | vitest **3,470 過（215 檔）**；Playwright **220 passed／0 failed** | ✓ | §8.5 |

**階段 5 專項（§3.3）**

| 指標 | Before | 目標 | After | 達標？ |
|---|---|---|---|---|
| `RosterEditor`／`GuardsClient` 最大檔行數 | 2,807／2,638 | ≤600 | **564／445**（各 18／15 檔） | ✓ |
| knip 多餘 export／type | 245／105（src 191／105） | <20 | **0／0** | ✓ |
| jscpd 重複碼 | 2.62%（2,005 行） | <2.0% | **1.99%**（1,543 行） | ✓（邊緣） |
| `/guards` DOM 節點（540 人推算） | ~19.2k（量得 266 人 9,553） | <5,000 | **~3.7k**（量得 3,710） | ✓ |
| 兩條 chat route | ~150 行重複 | response 逐 byte 一樣 | `chat-handler.ts`＋15 場景 golden 相同 | ✓ |

**未達標項目（交規劃者／老闆決定）**：#3 正式站 pending-summary（RTT 主導，需要 CDN／同區部署先有改善）、#5 更表編輯器冷載 API 數、#7 月結入頁 `buildMonthlyClose`（跨 request 共用違反鐵則 6）、#8 字型 CSS ~52 KB、#13 按鈕種類 14。
**小結**：17 項 §4 目標入面，完全達標 12 項（#1、2、4、6、9–12、14–17）；部分 2 項（#5、#7）；未達 3 項（#3 正式站、#8、#13）。冇任何計算改動；7／8 月鎖月數字經 `gate:locked-months` 12/12 逐階段核對。

## 10. 階段 6 安全補漏（2026-10-11 老闆批准）

來源：`docs/audit-2026-10/second-opinion-automation-ai.md` §六 H1–H10（Opus 5.5 獨立第二意見）。範圍：5 個鎖月漏洞＋鎖月 TOCTOU（H1–H6）、助手 SQL guard 真 parser（H7）、登入保護（H8）、H9／H10＋CSRF defense-in-depth＋低成本 response headers。執行：Sonnet 5.5（`claude-sonnet-5-5`），branch `p6-security`（from main `3732d74`），**唔 merge**，等 Opus 5.5 驗收。API 行為改變清單見 `docs/api.md`「階段 6 安全補漏」。

### 10.1 落實紀錄（Sonnet 5.5，2026-10-11，branch p6-security）

逐項 commit：

| 項 | 內容 | 重點 |
|---|---|---|
| P6.1a／b（H1／H2） | `processRosterUpload()` 喺 advisory lock 之後、任何寫入之前 `assertMonthNotLockedTx`；`PATCH /api/roster-uploads/:id` route 開頭查 `upload.month` 鎖月，`assignRosterUploadSite()` lib 內亦再查 | 同時新增 `month-lock.ts` 嘅 `assertMonthNotLockedTx`／`isMonthLockedTx`（tx 內 `FOR SHARE`，audit 走獨立連線，tx 回滾都留 `permission_denied` 紀錄） |
| P6.1c（H3） | Maxwell 導入：作廢舊合約＋新建合約前，舊段同新段生效區間 `assertMonthRangeNotLockedTx`；作廢舊合約寫 `void` audit（同人手 void 同 shape） | 「冇改動」嘅行（unchanged）唔查；每行獨立 tx，被拒行之前已 commit 嘅行保留，重跑冪等 |
| P6.1d（H4） | `POST /api/broker-site-assignments`、`DELETE …/:id` 按掛盤月份 `assertMonthNotLocked` | `[id]` 只有 DELETE（冇 PATCH） |
| P6.1e（H5） | `reparseAllActiveUploads()` 入口查鎖月；`POST /api/guard-fix/runs/:id/apply` route 於認領前查 `run.month` | 一鍵結算本身已有月鎖檢查，lib 層係 defense-in-depth |
| P6.1f（H6） | `shift-records/batch`、`reconcile-apply`、`reprice`（每個 500 條批次 tx）、`months/[month]/open` 嘅 tx 開頭 `FOR SHARE` 再查；`month-closes/[id]/lock` 改 tx 內 `FOR UPDATE`＋`updateMany({ id, lockedAt:null })` 判 count（0 → 409） | 並發測試：寫入 tx 持 `FOR SHARE` 時鎖月會等；鎖月 commit 後先開查嘅 tx 被擋；兩個並發鎖月只一個 200、另一個 409 |
| P6.2（H7） | `src/lib/ai/sql-guard.ts` 改用 `pgsql-ast-parser@12.0.2`（`dependencies`，釘版本；`package-lock.json` 由 `npm install` 生成，diff 只有新增） | 抽全部 relation（逗號 join、JOIN ON、子查詢、CTE、UNION）＋全部被引用欄位（含 `AS` 改名、函數參數、USING、ORDER BY）；按所屬表判斷遮罩欄（同 `FIELDS[table]` 同一份清單，唔會誤殺 `brokers.name`）；`*`／`t.*`／整行引用有遮罩欄嘅表拒絕；`audit_log.before／after` 當含四組；注釋先剝走（parse 同執行同一份文字）；LIMIT 用 AST＋`_location` 收緊，UNION 包一層；禁 `query_to_xml`／`set_config`／`dblink`／`lo_*`／schema-qualified 函數；parse 失敗一律拒絕。`docs/ai-assistant.md`「已知限制」已更新 |
| P6.3（H8） | `login`：`failedAttempts` 改 `increment` 預留序號（序號 > 5 唔驗密碼）、鎖定用條件式 `updateMany`；新 `src/lib/auth/login-rate-limit.ts`（每 IP token bucket：容量 10、每分鐘補 10、只扣失敗；全局 300／分鐘；冇 IP 跳過每 IP）；未註冊／密碼錯／鎖定中對外一律 401「電話或密碼錯誤」（鎖定只記 audit），未註冊同鎖定中亦跑 dummy bcrypt 對齊回應時間 | 鎖定期間 `failed_attempts` 保持 ≥ 5，鎖定過期／成功登入／重設密碼先清零（否則並發 straggler 會重新攞到序號）。`tests/wp2-auth.test.ts` 嘅 423 斷言同步改 401 |
| P6.4 H9 | migration `20261011120000_p6_ai_audit_log_whitelist`：`ai.audit_log` 加 `table_name IN (12 張業務表)` 白名單，舊 `NOT IN` 排除清單逐字保留；`/api/ai/chat` audit 唔存 `question` 原文，改存 `question_length`＋`question_sha256_16`（feedback chat 本身一直唔存原文） | `tests/wp-pii-ai-audit-log-scrub.test.ts` 更新（主管 `sql_select` 引用 `before／after` 現在拒絕）；`tests/wp-one-click-auto-isolation.test.ts` 重跑舊 migration 後補跑白名單 migration（避免污染同 run 其他測試） |
| P6.4 H10 | `requireSession()`：`mustChangePwd=true` 只准 `/api/auth/change-password`、`logout`、`refresh`，其餘 403 `must_change_pwd` | 同一條 DB 查詢多 select 一欄，冇額外 round trip |
| P6.4 CSRF／headers | `src/middleware.ts`（matcher `/api/:path*`）＋純函數 `src/lib/api/csrf.ts`：非 GET 嘅 `Sec-Fetch-Site`（只准 `same-origin`／`none`）／`Origin`（host 要等於 `Host`／`X-Forwarded-Host`）；兩個 header 都冇嘅非瀏覽器 client 照放行；`next.config.ts` 加 `X-Frame-Options: DENY`、`X-Content-Type-Options: nosniff`、`Referrer-Policy: same-origin` | 用 middleware 而唔放 `withApiError`：`withApiError(fn)` 冇 `req`，而且有 7 條 route（login、chat 等）唔經佢；middleware 一次涵蓋全部 `/api/*` |

**驗證**

- 新增 test：10 檔、60 條（`tests/p6-1ab-…`、`p6-1c-…`、`p6-1d-…`、`p6-1e-…`、`p6-1f-…`、`p6-2-…`、`p6-3-…`、`p6-4-h9-…`、`p6-4-h10-…`、`p6-4-csrf-headers`）：5 個鎖月漏洞各有「鎖咗月 → 403 `month_locked`＋DB 零改動；未鎖 → 行為不變」；SQL guard 繞過類 test 20 條（逗號 join、`AS` 改名、子查詢、CTE、`*`／`t.*`／整行引用、UNION、函數包欄、相關子查詢、注釋混淆、`audit_log` JSON、`query_to_xml`、parse 失敗、LIMIT）＋4 條 `sql_select` 工具端到端；login 並發 20 個錯密碼請求最多 5 個被驗、全部 401，IP 限速 429＋`Retry-After`，三種失敗 status／body 完全一致。
- `npx vitest run`（隔離 PG 54374）：**226 檔全過，3,526 passed／15 skipped（共 3,541）**（階段 5 為 215 檔／3,470）。`tsc --noEmit` 0；`tsc --noUnusedLocals --noUnusedParameters` 0；`npm run lint` 0 warning；`npm run build` 過（`rm -rf .next` 後；多咗 `ƒ Middleware 34.2 kB`）；knip 0。
- `npm run gate:locked-months`（隔離 dev PG 54375）：**12/12 rc=0**；snapshot 5,080 數字葉，同舊基線 snapshot 嘅全部數值 multiset 逐個相同（只有 uuid 排序次序差異）。
- Playwright 全部 spec（隔離 PG 54375、`next start` 3181、`AI_LLM=fake`；gate 後 `db:reset`＋`db:seed` 重 seed 再跑）：**221 passed｜4 skipped（原有 `test.skip`）｜0 failed**；e2e 固定帳號冇改，login e2e 照過。
- `package-lock.json`：只由 `npm install --save-exact pgsql-ast-parser` 生成，diff 純新增（+79 行，冇 dev 旗改動）。

**已知限制／交驗收者留意**

1. 限速狀態喺 process 記憶體：多 instance 各自計、重啟清零。`getClientIp` 改取 `X-Forwarded-For` **最右一段**（平台 proxy 加嗰段，偽造左段無效），依賴部署平台 proxy 一定會加 XFF；全局 bucket 只扣失敗、上限 1000／分鐘，每 IP 10 次失敗／分鐘。
   鎖月 route 等長寫入 tx：`lock_timeout` 預設 10 秒（env `MONTH_LOCK_TIMEOUT_MS`），逾時回 409 `lock_busy`。
2. `sql_select` 對 parser 唔識嘅合法寫法（例如 `WITH RECURSIVE`、`LIMIT ALL`、`IS NOT DISTINCT FROM`）一律拒絕；`SELECT *` 掂到有遮罩欄嘅表（例如 `ai.shift_records`）而家對冇收客價／出街價權限嘅角色拒絕（以前係靜靜剝欄）——助手要明確列欄。
3. Maxwell 導入遇到已鎖月區間會整份 403（唔係逐行跳過）；已 commit 嘅前面行保留；下一階段改逐行跳過。
4. `reprice` 逐批 tx：中途鎖月令後面批次 409，前面批次已 commit（原有分批語意，冇新增）。
5. 未做：CSP；容器 root 用戶；`XFF` 偽造防護（需要部署層配合）。

### 10.2 驗收、部署、正式站核對（2026-10-11 上午）
- Opus 5.5 第一輪有條件通過（1 必修：鎖月 route 用 Prisma 預設 5 秒 tx timeout，寫入 tx 揸住 `FOR SHARE` >5 秒時鎖月回 500）；執行員補：`SET LOCAL lock_timeout`（預設 10 秒，`MONTH_LOCK_TIMEOUT_MS` 可調）＋tx timeout／maxWait、`55P03`／`P2028` → 409 `lock_busy`；`getClientIp` 取 XFF 最右段＋全局限速只扣失敗 1000／分鐘；再補 `x-real-ip` 優先＋`TRUSTED_PROXY_HOPS`（`a5e19fa`，規劃者自審 diff）。第二輪通過：writer 7 秒 → 鎖月等到後 200、12 秒 → 409；32 條 SQL 繞過全擋；20 並發錯密碼只驗 5 次；偽造 XFF 左段仍被限速、偽造 60 IP 唔影響正常登入；CSRF 14 種組合正確；全套 vitest 3,532 過、Playwright 220／5／0。驗收員披露：第一輪曾用 worktree `.env`（指向本機 dev DB，非正式站）跑 11 條 e2e 冇設 fake LLM，即時停止；只影響本機 dev DB 同可能少量 DeepSeek 呼叫。
- merge main `e8fd541`；部署 `6acafb0bfb15905b77d55831` RUNNING 03:03Z：`Applying migration 20261011120000_p6_ai_audit_log_whitelist … applied`、助手 claude、OCR 自檢 ok。
- **正式站核對**：`curl -sI /login` 見 `x-frame-options: DENY`、`x-content-type-options: nosniff`、`referrer-policy: same-origin`；用唔存在電話錯密碼 1 次 → 401「電話或密碼錯誤」；**硬性條件通過**：該次 `login_failed` audit 記錄嘅 ip ＝ 規劃者公網 IP（Zeabur 下 XFF 最右段／x-real-ip 係真 client，`TRUSTED_PROXY_HOPS` 保持預設 1，唔使改 env）；更表上載頁載入 0 個 4xx；助手一問一答 200、冇 `csrf_blocked`；runtime log 0 個 csrf_blocked／lock_busy／internal_error。
- 留待下一階段：Maxwell 導入遇已鎖月改逐行跳過；reprice 409 vs 403 統一；`month_closes` 無 row 月份嘅細窗口；NATURAL JOIN 靠 parse 失敗拒絕（升級 parser 要補）。

## 11. 階段 7 自動化第一批（2026-10-11 老闆批准）：排程＋email 通知基建＋月頭自動開新月

來源：`docs/audit-2026-10/second-opinion-automation-ai.md` §三 J1／J2／J3／J7／J9、§四、§五 T1／T3／T4／T7。原則（老闆）：**每個月重複嘅嘢，系統做，唔好要人手每月重複。** 執行：Sonnet 5.5（`claude-sonnet-5-5`），branch `p7-automation-1`（from main `d212d4b`，含階段 6 merge `e8fd541`），**唔 merge**，等 Opus 5.5 驗收。API 清單見 `docs/api.md`「階段 7」，運維見新檔 `docs/ops.md`。

### 11.1 落實紀錄（Sonnet 5.5，2026-10-11，branch p7-automation-1）

| 項 | 內容 | 重點 |
|---|---|---|
| P7.1 基建 | migration `20261011150000_p7_notifications_scheduler`（只新增）：`app_notifications`（kind／title／body／href／audience jsonb／read_by jsonb／email_sent_at／dedupe_key unique）、`scheduled_jobs`、`job_runs`、`users.notify_email`＋`notify_prefs` | 通知 body 只有盤名／數字／id／月份（`assertNoPii` 拒 HKID／電郵／8 位電話型）；唔入 `ai` schema（`ai.users` view 本身冇呢兩欄，有 test 鎖死）；audit 只記 `notify_email_update`（唔存電郵） |
| P7.1 mailer | `src/lib/notify/mailer.ts`：`nodemailer@10.1.0`（釘版本，`package-lock.json` 由 npm 生成，純新增）經 `SMTP_URL` 寄；冇設 → 只寫站內通知並 log `[notify] email disabled`；`NOTIFY_FROM`、`APP_BASE_URL`（預設 `https://zoikan.zeabur.app`） | 寄失敗只 log 錯誤類別（唔 log 地址／連線字串），唔影響通知建立；`notify_prefs` 逐類控制電郵 |
| P7.1 排程器 | `src/instrumentation.ts`→`instrumentation-node.ts`（Node runtime 先 import，edge bundle 唔引入 `pg`）→`startScheduler()` 每分鐘 tick；5 欄 cron 按香港時間（`hkParts`）；到期 job 攞專用 PG 連線 session-level advisory lock（`pg_try_advisory_lock(hashtextextended('zoikan:job:<key>',0))`）→ `UPDATE … next_run_at<=now` 認領 → 跑 → 寫 `job_runs`／`scheduled_jobs.last_*`；失敗通知老闆（`job_failed`） | `SCHEDULER_ENABLED`：冇設＝production 開、dev／test 關（與簡報「預設 1」差別：dev 唔自動跑，免得本機庫 25 號被改）；Playwright 固定 `0`。`next start`（production build）實測啟動、3 個 job 設定行寫入 |
| P7.1 API／UI | `GET /api/notifications`、`POST /api/notifications/:id/read`、`/read-all`；`GET／PATCH /api/users/:id/notify`；`GET /api/admin/jobs`、`PATCH /api/admin/jobs/:key`、`POST /api/admin/jobs/:key/run-now`（老闆專用，`baseRole` 判斷，**冇新 RBAC module**）；首頁「通知」區（未讀 N、最新 5 條）、側欄「首頁」未讀 badge、`/notifications`、`/settings/jobs`（開關／改 cron／立即跑／最近紀錄）、用戶頁同改密碼頁「通知電郵」 | 側欄多一條「自動排程」（老闆 18 條，`DesktopNav` 組間距 `mb-2→mb-1.5` 令 1512×700 仍唔使捲） |
| P7.2 自動開新月 | job `open_next_month`（每月 25 日 09:00 HKT）：`openMonth()` 由 route 抽成 `src/lib/months/open-month.ts`（route 同 job 共用，tx 內 `FOR SHARE` 鎖月檢查保留）；價卡用 `findCopyLastMonthCandidates`＋新 `classifyCopyCandidates`（`same`／`new`／`rate_changed`／`changed_in_month`），只 `same` 經 `applyCopyLastMonthCards` 自動寫（`created_by=job:open_next_month`、audit actor null＋`after.by_job`；lib 內加鎖月檢查）；其餘通知「N 張價卡要你確認」＋首頁「價卡待確認」卡（`GET /api/rate-cards/copy-last-month?month=`）→ `/rate-cards?month=…&pending=1` 自動開預覽（preview 每行標「★價錢有變／新組合」）；已鎖月跳過並通知；同月通知 dedupe | `/sites` 加「開新月」手動掣（call 同一 API） |
| P7.3 唯讀 job | `nightly_month_health`（21:00）：本月＋未鎖上月 `buildMonthHealth`，新紅項先通知（dedupe＝紅項 hash，body 只有代號×數量），全綠＋一鍵結算 run done→「可以鎖月」；`triage_reminder`（09:00）：負責人有 >2 日未答重要題→通知（每人每日一條） | 兩個 job 只寫通知／job_runs，唔寫業務表（test 驗證） |

**老闆要喺 Zeabur 加嘅 env（都唔加亦可運作，只係冇 email）**

| 變數 | 說明 |
|---|---|
| `SMTP_URL` | `smtps://用戶:密碼@主機:465`。冇設＝email 關閉，只有站內通知 |
| `NOTIFY_FROM` | 寄件人，例 `在勤 <notify@你的網域>` |
| `APP_BASE_URL` | email 連結根網址，預設 `https://zoikan.zeabur.app`（唔改亦得） |

部署後：每個要收 email 嘅同事喺「改密碼」頁（或老闆喺「用戶」頁）填通知電郵；老闆到「設定 › 自動排程」撳「立即跑」試三個 job。`SCHEDULER_ENABLED` 唔使加（production 預設開）；緊急剎車見 `docs/ops.md` §5。

**驗證**
- 新增 vitest：`tests/p7-1-cron`（6）、`p7-1-scheduler`（10：tick 冪等、並發 tick 只跑一次、advisory lock 令第二個 run-now `skipped_locked`、認領、停用、失敗通知、stale 掃除、開關解析）、`p7-1-notify`（8：dedupe、PII guard、mailer 關閉唔拋錯、收件人過濾、audience 隔離＋已讀、電郵設定權限／audit 唔存電郵、`ai.users` 無電郵欄）、`p7-2-open-next-month`（7：分類四類、價錢冇變先自動寫、冪等第二次 0 新增、已鎖月跳過、通知 dedupe、排程 tick＋run-now、通知無 PII）、`p7-3-nightly-health`（4）、`p7-3-triage-reminder`（2）；既有 test 同步：`rbac-nav-groups`（老闆 18 條）、`p3-1-pagination-tiebreak`（開月 `timeout: 60_000` 檢查改指 lib）。
- `npx vitest run`（隔離 PG 54373）：**233 檔全過，3,584 passed／0 failed**（階段 6 為 226 檔／3,541）。`tsc --noEmit` 0；`--noUnusedLocals --noUnusedParameters` 0；`npm run lint` 0 warning；`npm run build` 過（`rm -rf .next` 後；`ƒ Middleware` 照有、新頁 `/notifications`、`/settings/jobs`）；knip 0。
- `npm run gate:locked-months`（隔離 dev PG 54375）：**12/12 rc=0**；snapshot 5,080 數字葉，同階段 6 基線 snapshot 數值 multiset 逐個相同。
- Playwright 全部 spec（隔離 PG 54375、`next start` 3180、`SCHEDULER_ENABLED=0`、`AI_LLM=fake`；gate 後 `db:reset`＋`db:seed` 重 seed 再跑）：**225 passed｜5 skipped（原有 `test.skip`）｜0 failed**。新增 `tests/e2e/p7-automation.spec.ts` 5 條（通知區／badge／已讀／全部頁、角色隔離、自動排程頁開關＋改 cron＋立即跑、開新月掣、通知電郵）；`p3-3-nav` 兩條 17→18；`p2c` 角色矩陣 checkbox 樣式斷言改 `toHaveCSS`（原一次性 `evaluate` 間歇撞到 re-render，回空字串；同一 build 連跑 3 次先後有過有失敗，與 P7 無關，已加固）。
- 本機用 `run-now` 試跑三個 job（seed 假資料）：`open_next_month` 200 ok（2026-11 已開好，seed 無 2026-10 結構故全 0）、`nightly_month_health` 200 ok（2026-09／10 紅項 0）、`triage_reminder` 200 ok（假 3 題逾期→會計 1 條通知）；首頁通知區、`/notifications`、`/settings/jobs` 截圖正常。
- `package-lock.json`：只由 `npm install --save-exact nodemailer`＋`--save-dev --save-exact @types/nodemailer` 生成，diff 純新增（無刪除行）。

**已知限制／交驗收者留意**
1. `open_next_month` 只自動複製「`effective_to`＝上月最後一日」嘅價卡（沿用 `findCopyLastMonthCandidates` 既有口徑）；`same` 判斷以收客價／出糧價／雞頭費／支付價四個價相等＋上月內冇新卡生效為準，上上月冇卡一律當 `new`（待確認）。
2. `nightly_month_health` 以「最早建立嘅啟用老闆」做讀者 session（只在記憶體）；無啟用老闆則 job 失敗並通知。
3. 通知 `audience` 以 base_role 或 user id 比對；自訂角色用 base_role。`notify_prefs` 只控制電郵。
4. 排程停機錯過嘅執行，重啟後第一個 tick 補跑一次（job 全部冪等）；多 instance 靠 advisory lock＋認領防重跑，未做跨 instance 時鐘校正。
5. 未做（留下一階段）：J3 上載後自動跑一鍵結算、J4 證件到期、J7 摘要推送、J5／J6／J8、T2 批量接受建議；`SCHEDULER_ENABLED` 預設與簡報字面不同（見上）。

### 11.2 驗收後修正（Opus 5.5 有條件通過，Sonnet 5.5，同 branch）
- **必修 1**：`classifyCopyCandidates` 新 class `auto_source`——上月來源卡 `source` 以 `auto:` 開頭（一鍵自動定價、未經人確認）即使價錢同上上月一樣，排程都唔自動複製（auto 卡只可 propose，亦保住 `resolve-rate` 嘅「auto 卡唔准跨雞頭」），計入「要你確認」；預覽標「上月係自動定價卡」。**人手「複製上月卡」路徑不變**（階段 7 之前已會將 auto 卡轉 `copy_last_month`，預覽有標示）。
- **必修 2**：`GET /api/rate-cards/copy-last-month` 雞頭 403（`isBrokerRole`）；另 additive 回 `auto_copy`／`needs_confirm`。
- 一併做：(3) 單個 job 最長執行 `JOB_TIMEOUT_MS`（預設 10 分鐘，`Promise.race`；逾時 `status=timeout`、通知老闆、lock／`busy` 釋放、tick 繼續）；(4) 首頁「價卡待確認」卡只計 `needs_confirm`，note「要你確認（25 號自動複製其餘 M 張）」；(5) 排程失敗／逾時 1 小時後重試（唔遲過下次排程），連續最多重試 3 次，手動跑唔重排；(6) advisory lock 連線字串只剝 Prisma 專用參數（`schema`／`connection_limit`／`pool_timeout`／`pgbouncer` 等），保留 `sslmode`。
- test：`p7-1-scheduler` 加重試／超時／連線字串 3＋1 條、`p7-2` 加 auto_source、雞頭 403／會計 200 共 2 條。

### 11.3 驗收第二輪修正（Sonnet 5.5）
- **必修 1**：逾時唔再釋放 advisory lock——`withJobLock(key, fn(hold))`，逾時時 `hold(底層 promise)`，lock 持有到底層 job settle 先釋放；期間 run-now → 409 `job_running`、排程重試 `skipped_locked`；原 job 完成後先可再跑。`docs/ops.md` §5b 同步。
- **必修 2**：`applyCopyLastMonthCards` 寫入 tx 內先 `pg_advisory_xact_lock(hashtext('rate_cards:<月>'))`，攞到後先揾候選並喺 tx 內重查目標月已存在組合（跳過）；唔加 unique、唔改 schema。
- test：`p7-1-scheduler` 逾時案改為「lock 持有至底層完成」；`p7-2` 加並發 apply（6 路只 5 張）、並發 job（價卡無重複）。

### 11.4 驗收、部署、正式站核對（2026-10-11 中午）
- Opus 5.5 三輪：第一輪 2 必修（auto 來源價卡被自動複製兼「洗白」；雞頭可讀全公司待確認價卡數）；第二輪 1 必修（規劃者要求加嘅逾時會提早放 advisory lock，30 次並發 29 次寫出重複價卡）；第三輪通過：逾時唔放 lock（原 job settle 先放，期間 run-now 409、重試 `skipped_locked`）、價卡寫入 tx `pg_advisory_xact_lock('rate_cards:<月>')`＋tx 內重查（30 次並發 0 重複）、失敗 1 小時重試 ≤3、`sslmode` 保留。驗收員自跑 vitest 3,592 過、Playwright 225／5／0。
- merge main `68826c8`；部署 `6acb12e3da7cf920c2637c53` RUNNING 04:45Z：`Applying migration 20261011150000_p7_notifications_scheduler … applied`、`[scheduler] started`。
- **正式站核對（老闆 Chrome）**：`/settings/jobs` 3 個 job：`open_next_month` 下次 2026-10-25 09:00 HKT、`nightly_month_health` 今晚 21:00、`triage_reminder` 明早 09:00；手動試跑兩個唯讀 job 都 200 ok——體檢：2026-10 warn 1、2026-09 新紅項 7（已出通知「2026-09 體檢有 7 項新紅項」）；待答提醒：122 題超過 2 日、通知 1 位負責人。首頁「通知」區＋側欄未讀 badge 2。**冇試跑 `open_next_month`**（會寫 11 月資料，25 號自動跑或老闆批先）。
- **老闆要喺 Zeabur 加（email 先會寄；唔加照樣有站內通知）**：`SMTP_URL`（格式 `smtps://使用者:密碼@smtp主機:465`，例如 Gmail 要用應用程式密碼）、`NOTIFY_FROM`（寄件人地址）、`APP_BASE_URL`（`https://zoikan.zeabur.app`）。加完 Zeabur 會自動重啟，log 由 `[notify] email disabled` 變成寄出；之後每個用戶喺「改密碼」頁填自己嘅通知電郵，老闆亦可喺用戶頁代填。
- (ii) 留下階段：連續失敗計數跨排程累計；25 號後 job 失敗時首頁卡文案過期；apply 候選查詢佔一條額外連線。

## 12. 階段 8 自動化第二批（2026-10-11 老闆批准）：上載完自動結算、批量接受建議、鎖月後自動出檔、證件到期週報、每月修正摘要推送

來源：`docs/audit-2026-10/second-opinion-automation-ai.md` §二 S1、§三 J3／J4／J7、§五 T2／T5（審查 Top 10 之 J3／T2／T5／J4／J7）。原則延續階段 7：**每月重複嘅嘢系統做；涉及錢嘅簽收（鎖月、autopay 入銀行）留人。** 執行：Sonnet 5.5（`claude-sonnet-5-5`），branch `p8-automation-2`（from main `4e365e8`，含階段 7 merge `68826c8`），**唔 merge**，等 Opus 5.5 驗收。API 見 `docs/api.md`「階段 8」，運維（4 個新 job、state、唔自動跑嘅情況）見 `docs/ops.md` §2／2b／2c／2d。所有寫入經現有 lib＋鎖月檢查；job 用階段 7 框架（advisory lock、逾時唔放 lock、失敗重試、`by_job`）。

### 12.1 落實紀錄（Sonnet 5.5，2026-10-11，branch p8-automation-2）

| 項 | commit | 內容 | 重點／行為改變 |
|---|---|---|---|
| P8.1 J3 上載完自動一鍵結算 | `P8.1` | migration `20261012000000_p8_scheduled_job_state`（`scheduled_jobs.state jsonb`，只新增）；`src/lib/scheduler/state.ts`；job `auto_one_click`（每 5 分鐘）：未鎖月份有 `parsed` 上載、最新有效上載（`uploaded`／`parsed`／`confirmed`）靜置 ≥10 分鐘、新過該月最後一次 run 的 `started_at`、同批上載未觸發過（`state.last_trigger_upload_at[月份]`）、冇 run 跑緊（同 `POST /api/month-close/one-click` 同一條全域 advisory xact lock＋busy 檢查）→ call 同一個 `runOneClickMonthClose`；完成通知老闆＋會計「N 題要你答、未定價 N 更」＋連結，失敗／halt 通知原因一句 | 新通知 kind `one_click_auto`。**偏離簡報字面**：簡報寫 actor null——但 `month_close_runs.started_by`、價卡 `created_by`、分診 session 擁有人係 FK／必須有人，所以自動 run 用「最早建立嘅啟用老闆」做 actor；run 建立嗰條 audit 係 actor null＋`after.by_job=auto_one_click`（`writeAudit` 嘅 meta 白名單 `by_job` 由「只喺有 DTO mapper 嘅表保留」改為所有表保留）。**唔自動鎖月**。失敗唔會每 5 分鐘無限重跑（state 已記）。test `p8-1-auto-one-click` 10 條（觸發條件逐個、同批只跑一次、人手 run 跑緊／全域 busy／已鎖／10 分鐘內新檔／uploaded 未處理完／voided 全部跳過、precheck halt 失敗通知、通知 regex＋`assertNoPii`、audit by_job） |
| P8.2 T2 待答題批量接受建議 | `P8.2` | `POST /api/triage/questions/batch-accept`（≤50 per request，逐題 `previewMcAnswer`→`submitMcAnswer`，audit 同單題一樣＋`after.batch_id`；一題失敗唔影響其餘；任一題已鎖月 → 整批 403）、`GET …/batch-accept/preview?session_id=\|month=`（可批量接受清單，用 `mcQuestionViews` 投影）、`BatchAcceptButton`（對話框可逐題取消剔 → 確認 → 5 秒 `UndoBar`，撤銷零請求 → 送出 → 「已答 N、跳過 N、失敗 N」），掛喺 `/triage` 每張一鍵結算 session 卡同 `/month-close` ReviewCard；AI 助手白名單 `triage_accept_batch{question_ids[]≤50}`（撳卡＝同一條 API＋5 秒撤銷）、`triage_summary` 每題 `has_suggestion`、system prompt 加「3 題或以上高把握（propose）先建議批量」 | **範圍說明**：「系統建議答案」只存在於一鍵結算／補齊價目卡嘅 `month_close_*` 題（`prefillCandidateId`＋`mc_accept`），所以走 `previewMcAnswer`／`submitMcAnswer`（簡報寫嘅 `previewAnswer`／`submitAnswer` 係保安員導入題路徑，冇「建議答案」→ 一律 `skipped: no_suggestion`）。送出後嘅撤銷同單題一樣：冇一鍵撤銷（補齊價目卡題仍可逐題「撤銷補齊」）。test `p8-2-triage-batch-accept` 6 條（批量 vs 逐題人手答：價卡／snapshot／audit 逐欄相同、冇建議跳過、一題失敗唔影響其餘、鎖月 403 整批唔寫、雞頭 403／非擁有人 error／上限 200／body strict、preview 兩種 scope）＋`ai-actions`／`ai-action-requests`／`ai-system-prompt-diag`／`ai-diag-tools` 同步 |
| P8.3 T5 鎖月後自動出齊檔 | `P8.3` | migration `20261012010000_p8_generated_files`（`generated_files`：month／kind／filename／content bytea／size／sha256／generated_at／generated_by／source_locked_at／current，partial unique index 保證同月同 kind 一份 current）；`writePayrollBuffer`／`writeMonthlyCloseBuffer`（同 `write…Xlsx` 共用 workbook builder；`GET /api/reports/payroll\|monthly-close?export=1` 改用 buffer，輸出不變）；job `after_lock_exports`（每 5 分鐘，`state.last_processed_lock_at`）生成 4 份（糧明細／月結總表／Postorder／BOCHK autopay，該月未計長工糧就跳過並寫明）、重新鎖月取代 current（舊版保留 1 份）、失敗 job 拋錯（state 唔前進，框架 1 小時重試）；`GET /api/files?month=`、`GET /api/files/:id`；頁面 `/month-close/files`（月結頁已鎖時有「已生成檔案」掣）；通知 `month_files_ready` | 權限＝原匯出 route 嘅 module `export`（糧明細／月結總表／長工糧），雞頭 403。**autopay 下載沿用原 route 嘅 `confirm_locked=1` 防重複出糧閘**（頁面彈確認；直接打 URL 無參數 400＋`export_download_blocked` audit）。首次跑只處理最近 31 日內鎖嘅月份。test `p8-3-after-lock-exports` 7 條（4 份生成＋未計長工糧月份跳過、與人手匯出 route **逐 xlsx part 相同**（`docProps/core.xml` 生成時間除外）、重複跑唔重複、重鎖取代保留 1 份舊版、某份失敗 state 唔前進／修好補齊、雞頭／安員 403、下載 Content-Disposition＋audit＋autopay 確認閘）。既有 `wp-phase4-postorder-export-route` 改用「之前已有幾多條 audit」做基線（audit_log append-only，唔會被其他檔清走） |
| P8.4 J4 證件到期週報 | `P8.4` | job `permit_expiry_weekly`（逢星期一 09:00 HKT）：牌照（同 `/api/guards` 一樣現算：乙類滿 70 歲失效）／平安卡／QAS 三種「30 日內到期 N 人」同「已過期但本月／下月仍有排更 M 人」（只計 active、取消更唔計），通知主管＋老闆（body 只有數字），全部 0 唔通知，同週一條；`/guards?expiring=30`（additive query）＋第二個篩選 chip「30 日內到期」（90 日 chip 不變，e2e 舊斷言不變） | 通知 kind `permit_expiry_weekly`。test `p8-4-permit-expiry-weekly` 4 條（假 guard 十種情況計數、body 精確文字＋PII 掃描、dedupe 每週一條／下週再出、全 0 skipped、cron 下次時間） |
| P8.5 J7 每月修正摘要推送 | `P8.5` | job `lock_ops_digest`（每 5 分鐘，鎖月後；state 同 P8.3）：`buildOpsDigest`→數字摘要（必有，全由 digest 數字砌）＋可選 AI 摘要（現有 `generateDigestSummary`／`getLlmClient`，經輸出 guard；AI 用量寫一行 `ai_chat` audit，actor null＋`by_job`）；AI 失敗／guard 觸發／文字被 `assertNoPii` 拒絕就退回只推數字；通知老闆，同月只一次（dedupe），連結 `/reports/ops-digest?month=` | 通知 kind `ops_digest_ready`。test `p8-5-lock-ops-digest` 6 條（冇 AI 設定仍推數字、有 AI 附摘要＋audit、AI 失敗、含電話／電郵退回數字、guard 觸發丟棄、同月一次／未鎖唔推） |

**每月慳幾多步（估算，一個典型月份；before＝人手操作次數，after＝仍需人手）**

| 項 | before | after |
|---|---|---|
| J3 上載完一鍵結算 | 上載完要記得返月結頁、揀月份、撳「一鍵結算」、輪詢等完（≥3 個動作＋等待，每次重傳再重複 3 次） | 0（10 分鐘後自動跑；收通知後去答題） |
| T2 待答題 | 每題「預覽→確認→等 5 秒撤銷」≈2 次點擊×N 題（N≈20 有建議題＝約 40 點擊＋100 秒等待） | 1 個對話框＋1 次確認（2 次點擊，可逐題取消剔） |
| T5 鎖月後出檔 | 4 份各開一頁／揀月份／撳匯出（≈12 個動作），autopay 要記得再確認 | 收通知後開 1 頁、按需要撳 4 次下載（autopay 仍要人覆核）；生成 0 動作 |
| J4 證件到期 | 每週開保安員頁、剔「90 日內到期」睇（≈3 個動作×4 週＝12） | 0（逢星期一通知，一撳入篩選好嘅頁） |
| J7 修正摘要 | 開 ops-digest 頁、揀月份、撳 AI 摘要（≈3 個動作） | 0（鎖月後通知；AI 摘要隨附） |
| 合計 | ≈70 個動作／月（T2 佔大半） | ≈10 個動作／月（全部係「睇通知／簽收／答真正要判斷嘅題」） |

**驗證**
- vitest（隔離 PG 54363）：**238 檔（237 passed｜1 skipped），3,619 passed｜10 skipped｜0 failed**（階段 7 為 3,592；新增 p8-1／2／3／4／5 共 33 條＋既有 test 同步）；`tsc --noEmit` 0；`npm run lint` 0 warning；knip 0；`npm run build` 過（`rm -rf .next`）。
- `npm run gate:locked-months`（隔離 dev PG 54364）：**12/12 rc=0**；snapshot 5,080 數字葉，multiset 同階段 4（p3-4）基線 snapshot（階段 6／7 驗收已證實同佢相同）逐個相同。
- Playwright 全部 spec（隔離 PG 54364、`next start` 3174、`SCHEDULER_ENABLED=0`、`AI_LLM=fake`；gate 後 `db:reset`＋`db:seed` 重 seed 再跑）：**229 passed｜5 skipped（原有 `test.skip`）｜0 failed**（第一次跑撞出 2 條：「新增 ▾」選單被側欄遮住——因我加咗第二個篩選 chip 令工具列多一行，已改成同一個 chip 按 `?expiring=30` 變 30 日；(k)「首頁」連結名帶未讀 badge——因 run-now 試跑留低通知，已喺 spec afterAll 清走）。新增 `tests/e2e/p8-automation2.spec.ts` 4 條（批量接受對話框：列清單／取消剔／5 秒撤銷零請求／確認 body／結果摘要；已生成檔案頁：列表／糧明細直接下載／autopay 彈確認先下載／直接 URL 400／雞頭 403；`/guards?expiring=30` 預設篩選；自動排程頁新 job＋證件到期週報立即試跑）。
- 本機 `run-now` 試跑 4 個 job（seed 假資料）：`auto_one_click` 跳過（seed 無未鎖月份上載）、`after_lock_exports` 成功（2026-07 出 3 份：糧明細 99 KB／月結總表 14 KB／Postorder 56 KB，未計長工糧故冇 autopay）、`permit_expiry_weekly` 跳過（seed 無 30 日內到期）、`lock_ops_digest` 成功（2026-07 數字摘要；fake AI 附摘要）；通知頁／自動排程頁／已生成檔案頁截圖：`/private/tmp/claude-501/p8-shots/{notifications,jobs,files}.png`。

**已知限制／交驗收者留意**
1. `auto_one_click` 用老闆帳號做 actor（見上），AutoCollector 等內部 audit 嘅 actor 係該老闆、冇 `by_job`；run 建立嗰條有。無啟用老闆 → job 失敗並通知。
2. `after_lock_exports`／`lock_ops_digest` 首次部署只處理最近 31 日內鎖嘅月份；歷史月份（7／8 月）冇自動出檔（可日後加「重新生成」掣）。重新鎖月會重新出檔；摘要推送同月只一次。
3. `generated_files.content` 存 bytea（糧明細檔含保安員姓名／工號，與手動匯出同敏感度，靠同一 `export` 權限＋audit 保護；**唔入 `ai` schema**）。每月 4 份×（current＋1 舊版）約數 MB，無需另外清理。
4. T2 只涵蓋有系統預填建議嘅 `month_close_*` 題；保安員導入題（身份／銀行）冇建議答案，批量接受一律跳過。
5. J7 AI 摘要 provider／每日額度：沿用現有設定（`isAiConfigured`），但 job 呼叫唔計入任何用戶嘅每日額度（audit actor null）；每月最多一次。
6. 未做（留下階段）：J5／J6／J8、歷史月份補出檔、批量接受之後嘅「一鍵撤銷」。

### 12.2 驗收後修正（Opus 5.5 唔通過 → 2 必修＋一併項，Sonnet 5.5，同 branch）
- **M1 排程系統帳號**：新 `src/lib/system-user.ts`＋`scripts/db/ensure-system-user.ts`（Dockerfile CMD 加一步、`npm run db:ensure-system-user`，唔喺 migration hardcode id；job 首次用亦 lazily 建立）：`tel=00000000`、「系統排程」、`inactive`（登入 401，有 test）、永遠 match 唔到嘅 hash、角色＝老闆。所有 job 嘅 actor／`started_by`／`created_by`／AutoCollector 內部 audit 用佢；排程期間（`withAuditJob`／AsyncLocalStorage，`src/lib/audit-job-context.ts`）**每一條** audit 自動帶 `after.by_job`，舊 lib 寫 null actor 嘅補系統帳號（runner 對所有 job 生效；`runOneClickMonthClose` 新 `opts.triageOwnerUserId`）。分診 session owner＝該月最新上載者（active＋有「一鍵結算:create」），冇就系統帳號；系統帳號擁有嘅 session 任何有權限嘅人都可以睇／答／批量（`canAccessOwnedBy`，列表／badge／AI 診斷一併）。`audit.ts` 未登記表 passthrough 收窄到 `by_job`／`auto_source`／`batch_id`。test `p8-m1-system-user`（5：冪等＋校正、登入 401、系統 session 會計答得（單題＋批量）、非系統 owner 仍 403、audit 收窄）＋`p8-1`（自動 run 每條 audit actor＝系統帳號＋by_job 冇一條掛老闆、owner 規則、老闆全部停用 job 照跑）。
- **M2 首次 baseline**：`auto_one_click` state 空唔觸發，只記每月份最新上載時間（summary `baseline`）；之後有新上載先跑（test）。
- **一併**：批量接受對話框預設唔剔 `confidence=unknown`（「全選有建議」亦只選 propose）；API 每 request 上限 50、`BatchAcceptButton` 自動分批（AI 動作卡上限同為 50）；P8.3 權限 test 逐角色×逐 kind 對權限矩陣（清單＝有 `export` 權嘅 kind，下載有權 200／冇權 403）。

### 12.3 驗收第二輪修正（M3＋一併項，Sonnet 5.5，同 branch）
- **M3**：系統帳號伺服器端保護——`auth/login` 對 `tel=00000000` 一律 401；`users/[id]` PATCH／`void`／`unvoid`／`reset-password`／`notify`（GET＋PATCH）一律 403 `system_account`（`assertNotSystemAccount`）；`/users` 頁該行只顯示「系統」標記、冇編輯／恢復／重設掣（`SYSTEM_USER_TEL` 抽到 client-safe `system-user-const.ts`）。test：6 條 route 403、active＋正確 bcrypt 密碼登入仍 401、一般用戶不受影響。
- **(ii)**：`canAccessOwnedBy`／`visibleOwnerIds`——系統擁有嘅 session 只俾有「一鍵結算:create」嘅人睇／答（列表、待答 badge、AI 診斷一致；主管 badge 唔計），test；`triage_reminder` 系統擁有嘅逾期題通知老闆＋會計（dedupe `triage_reminder:system:<日>`），test；`docs/api.md`（job audit 補系統帳號）、`docs/ops.md`（前端分批時「鎖月整批零寫入」只對單一 request 成立）。

### 12.4 驗收、部署、正式站核對（2026-10-11 下午）
- Opus 5.5 三輪：第一輪 2 必修（自動 run 用「最早老闆」做 actor——7 條 audit 有 5 條掛老闆、會計答唔到自動 run 嘅題；`auto_one_click` 一部署就會對 9／10 月現有上載自動跑）；第二輪 1 必修（系統帳號可被 UI `unvoid`→`reset-password`→登入 200）；第三輪通過。最終：系統排程帳號（`tel=00000000`、inactive、永不 match hash、登入一律 401、users 相關 route 對佢一律 403、UI 無掣；startup script 建立，唔 hardcode id）；`audit-job-context`（AsyncLocalStorage）令 job 內所有 audit actor＝系統帳號＋`by_job`、人手路徑不變；分診 owner＝最新有效上載者（有 `一鍵結算:create`）否則系統帳號，系統擁有嘅 session 只有 `一鍵結算:create` 嘅人可答；首次 baseline 唔觸發；批量接受每 request ≤50、前端分批；audit passthrough 只剩 `by_job`／`auto_source`／`batch_id`。驗收員自跑 vitest 3,632 過、Playwright 229／5／0。(ii)：`POST /api/users` 未擋 `tel=00000000`（下階段）。
- merge main `3ff5466`；部署 `6acb464fc0a5252069b8453c` RUNNING 08:24Z：2 個 migration applied、`[db:ensure-system-user] 系統排程帳號就緒（inactive，唔可登入）`、`[scheduler] started`。
- **正式站首個 tick（08:30Z）**：`auto_one_click` → `skipped`（baseline，冇新 run）；`after_lock_exports` → ok：7 月、8 月（31 日內鎖）各生成 3 份檔（月結總表 14 KB、糧明細 93 KB、Postorder 50 KB；autopay 冇——該兩月冇長工糧 run）；`lock_ops_digest` → ok：7、8 月摘要已推送。4 條 `[notify] email disabled`（SMTP 未設）。
- 老闆 Chrome 核對：`/settings/jobs` 7 個 job（`open_next_month` 10-25 09:00、`nightly_month_health` 21:00、`triage_reminder`／`permit_expiry_weekly` 明早 09:00、三個 5 分鐘 job）；手動試跑 `permit_expiry_weekly`（唯讀）→ ok：牌照 30 日內到期 3 人、平安卡 2 人、QAS 0、已過期仍排更 0；系統帳號 API 顯示 inactive；未讀通知 7 條（證件週報、7／8 月摘要、7／8 月檔已備妥、待答提醒、9 月體檢紅項）。**冇試跑** `auto_one_click`／`after_lock_exports`／`lock_ops_digest`（已由排程自然跑過）。

## 13. 階段 9 長工糧草稿（2026-10-11 老闆決定）：病假草稿＋勤工獎合資格清單＋三個細補

**老闆規則（寫死）**：**唔准自動加任何金額**。系統只出「草稿」同「合資格清單」，會計確認之前唔計糧；賣假、固定扣款／加項、頂位金額全部維持人手（頂位金額規則等老闆另答）。範圍只有：病假（SL）草稿、年假／無薪假（先核清楚 aggregate 已自動計定未）、勤工獎合資格清單；另加三個細補（AI 每日額度原子、`POST /api/users` 擋系統帳號電話、Maxwell 導入遇鎖月逐行跳過）。執行：Sonnet 5.5（`claude-sonnet-5-5`），branch `p9-longterm-drafts`（from main `6a56d4f`），只 push 唔 merge。

### 13.1 落實紀錄

**先搞清楚 aggregate 而家點計（對照表）**

| 項目 | 而家點計 | 草稿做乜 |
|---|---|---|
| NL／NPL 無薪假 | 更表 leave 代號自動讀入，逐日按日薪扣（日薪制唔另扣）；唔使人手輸入 | **唔生成**（已自動計） |
| AL 年假 | 更表 AL 日數自動累積（寫回 `alTaken`）；在職唔扣唔補；離職自動結算（`alLeaverPayout`）；`leaver_settlement` input 只係覆蓋金額（會計用終止合約計算表核實先用） | **唔生成**（已自動計；離職覆蓋金額屬人手金額，唔草稿） |
| SH 法定假 | 更表 SH 日子自動按合約 `statutoryHolidayPaidFrom` 計 | 唔生成 |
| **SL 病假** | 更表 SL 日子自動讀入，但 4/5 判定要會計開 `kind=leave` 病假段＋核醫生紙；冇對應輸入就當無薪假扣（`uncoveredSl`） | **生成病假段草稿**：連續日期合成一段（`date_from`／`date_to`）、金額空、醫生紙＝「未核」、`draft_source=roster_leave:SL`、`draft_evidence={dates, roster_upload_ids}`（無姓名）。確認（醫生紙仍未核）＝金額同冇輸入一樣；會計逐條核實醫生紙先改變 4/5 |
| 勤工獎 | 全人手：`special_allowance` 輸入＋金額 | **唔建 input、唔填金額**；只出「合資格清單」（更表該月冇 SL／NL／NPL；系統冇遲到紀錄，所以遲到未能核對，頁面同通知都寫明）＋通知「N 人合資格」 |
| 賣假／頂位（`other_allowance`）、制服、扣款、津貼 | 全人手金額 | 不變（人手） |

**P9.1 草稿**
- Migration `20261013000000_p9_longterm_input_drafts`（只新增、冪等）：enum `LongtermInputStatus`、`longterm_payroll_inputs` 加 `status`（預設 `confirmed`，舊資料不變）、`draft_source`、`draft_evidence`、`confirmed_at`／`confirmed_by`、索引 `(month,status)`。
- `aggregate.ts` 讀 inputs 加 `status:"confirmed"` 過濾——草稿對 Gross 零影響（test 證明 Gross／4/5／notes 全部不變）。
- `src/lib/longterm-payroll/drafts.ts`：`generateLongtermInputDrafts`（冪等；dedupe＝同人同月同日期集合；更表改咗→更新未確認草稿、已確認嘅唔郁但計入 `mismatches`；會計刪走嘅草稿唔再生成；會計改過（`edited`）嘅草稿唔覆蓋；已被確認輸入覆蓋咗嘅日子唔再出草稿；鎖月唔生成）、`listAttendanceBonusEligible`。
- Job `longterm_input_drafts`（每日 21:30，本月＋上月；`auto_one_click` 完成後亦對該月跑一次，失敗唔影響結算）：actor＝排程系統帳號、audit 帶 `by_job`；通知會計「N 條草稿待確認」「更表同已確認輸入唔同」「勤工獎合資格 N 人」（body 只有月份／數字，經 `assertNoPii`）。
- API（additive）：`GET /api/longterm/inputs?status=`、`PATCH …/:id` 加 `status:"confirmed"`、`POST …/confirm-batch`（≤50、鎖月整批 403）、`GET /api/longterm/attendance-bonus-eligible`。權限同現有 inputs（長工糧）。
- UI（長工糧頁「人手輸入」tab）：頂部「草稿」面板（標「草稿」、來源、日期、醫生紙；確認／改咗再確認／刪除；「全部確認」5 秒撤銷、自動分批 50）＋「勤工獎合資格清單」面板（只列名）。

**P9.2 三個細補**
- `ai-rate-limit.ts`：`assertUnderDailyLimit` 改原子（`pg_advisory_xact_lock(hashtext('ai-daily:'+userId))`＋新表 `ai_daily_usage`；取 `max(計數, audit 次數)` 再預留 +1）；並發 20 個、已用 90／上限 100 → 只放行 10 個。叫 LLM 前失敗（503／解析失敗）退還一次。
- `POST /api/users`：`tel === SYSTEM_USER_TEL` → 403 `system_account`（系統帳號建咗未都擋）。
- Maxwell 導入：遇已鎖月份只跳過該行（summary `skippedLockedRows`＋warnings），其餘照導入（既有 p6-1c test 由「整個 reject」改為「逐行跳過」）。

**行為改變**：(1) 長工糧「人手輸入」tab 多草稿面板同合資格清單；(2) 每日 21:30 多一個 job（`/settings/jobs` 可關）；(3) AI 每日額度檢查喺叫 LLM 前已預留一次；(4) Maxwell 導入遇鎖月唔再整個失敗；(5) 其餘計糧路徑不變（confirmed 照計）。

**每月慳幾多步（估算，非實測）**：以每月約 8 段更表 SL 計，原本每段「揀人→揀種類→填日期→勾醫生紙→新增」≈5 個動作＝約 40 個動作；而家＝開頁＋「全部確認」＋逐段核實醫生紙（只對真係有紙嗰啲，≈2–3 個動作／段）。勤工獎由「逐人對更表有冇 SL／NL」變成「睇清單、填金額」。

**驗證**：vitest（隔離 PG 54359）241 檔全 passed，**3,657 passed｜0 failed**（階段 8 為 3,632；新增 p9-1 11 條＋p9-2 4 條，既有 p6-1c／p7-1 test 同步；worktree 接上 data／venv 後原 skip 嘅 test 亦跑）；`gate:locked-months`（隔離 dev PG 54389）**12/12 rc=0**，`gate:ltpay-aug` **56/56**（Gross 917,875.19／Autopay 882,146.72／MPF EE 35,728.47／ER 35,966.15 不變），snapshot 5,080 數字葉 multiset 同階段 4 基線逐個相同；tsc 0；lint 0 warning；knip 0；build 過；Playwright（隔離 PG 54389、`next start` 3170、`SCHEDULER_ENABLED=0`、`AI_LLM=fake`）**232 passed｜4 skipped｜0 failed**（首次全跑 231／1 failed＝新 e2e spec 自己斷言用錯 id，修正後該 spec 同 longterm-payroll spec 重跑通過）；本機 `run-now` 試跑 `longterm_input_drafts`（seed 假資料：3 條草稿、勤工獎合資格 1 人）截圖核對。

**已知限制**：(1) 勤工獎唔核遲到（系統冇遲到欄）；合資格清單只計 active 保安員（inactive 已排除），但未排除「當月中途入職／離職」嘅人（面板已寫明，由會計判斷）；(2) AL／NL／SH 不出草稿（已自動計）；(3) SL 連續段只合併日曆連續日（中間隔 RD 會分兩段）；(4) 月份鎖咗之後草稿唔再生成亦唔可確認；(5) AI 每日額度「預留」喺 LLM 呼叫前，呼叫中途失敗（非 503）唔退還（保守，寧少勿多）。

### 13.2 驗收後修正（Opus 5.5 唔通過 → 1 必修＋一併項，Sonnet 5.5，同 branch）
- **M1 重疊確認會重複扣錢**：新 `findConfirmedLeaveOverlap`（同 guard／月、未作廢、`confirmed`、`kind=leave`、日期段重疊）。`PATCH inputs/:id`（用改完後日期）確認草稿重疊 → 409 `overlaps_confirmed_leave`；`confirm-batch` 該條 `skipped`（reason「同已確認病假段重疊」）；人手 `POST inputs` 新增 `kind=leave` 重疊亦 409。test：人手 10–14＋草稿 10–14 → PATCH 409、batch skipped 1、Gross 不變、改走日期後可確認、人手新增重疊 409。
- **(ii)-2** `auto_one_click` 觸發草稿改用 `withJobLock(longterm_input_drafts)`，攞唔到就跳過並喺 summary 記 `drafts:"skipped_locked"`（test）。
- **(ii)-3** 誤報：改過（`edited`）嘅已確認輸入唔再同更表原始日期比對；PATCH 改草稿日期時同步更新 `draft_evidence.dates`（test：縮短段後 `mismatches=0`）。
- **(ii)-4** 勤工獎通知只發上月；面板加「中途入職／離職未排除，請自行判斷」；§13.1 限制已改正（test：本月唔推、上月推）。
- **(ii)-5** e2e 撤銷步驟用 `page.on("request")` 斷言非 GET 請求為 0。
- **(ii)-6** Maxwell 導入通知顯示「N 行因鎖月跳過」。
- 驗證：vitest 241 檔、**3,661 passed｜0 failed**；tsc 0、lint 0 warning、knip 0、build 過；`gate:ltpay-aug` **56/56**（Gross 917,875.19／Autopay 882,146.72 不變）；`longterm-drafts`＋`longterm-payroll` e2e 5/5。

### 13.3 驗收、部署、正式站核對（2026-10-11 傍晚）
- Opus 5.5 兩輪：第一輪 1 必修（確認草稿冇檢查同已確認病假段重疊——實測 Gross 13000→10500 重複扣）；執行員補 `findConfirmedLeaveOverlap`（PATCH 409 `overlaps_confirmed_leave`、batch skipped、人手新增重疊 409）＋job lock＋edited 唔比對＋勤工獎只通知上月＋e2e 非 GET 斷言＋Maxwell 數字；第二輪通過（部分重疊擋、唔重疊照確認）。驗收員兩輪都自跑 `gate:ltpay-aug` 56/56（Gross 917,875.19／Autopay 882,146.72／MPF 35,728.47／35,966.15）；vitest 3,661 過；Playwright 231／5／0。偏離裁定：AL／NL／NPL／SH 唔出草稿——接受（aggregate 已全自動，會計唔使開 input）；SL 確認但醫生紙未核＝當無薪扣、同冇 input 一樣（唔會當有薪病假）。
- merge main `80f66ba`；部署 `6acb65a4c0a5252069b84a92` RUNNING 10:39Z：migration `20261013000000_p9_longterm_input_drafts` applied、系統帳號就緒、scheduler started。
- **正式站核對（老闆 Chrome 唯讀）**：8 個 job，`longterm_input_drafts` 下次今晚 21:30；手動試跑 → `skipped`（9 月／10 月 created 0——現有更表冇長工 SL 日）；10 月草稿 0、8 月（已鎖）草稿 0；長工糧頁「人手輸入」tab 見勤工獎合資格面板＋「中途入職／離職未排除」提示；草稿面板只喺有草稿時顯示；10 月長工糧 API 回應 run-now 前後一樣；冇新通知（本月唔推勤工獎）。**冇確認／刪除任何嘢。**

## 14. 階段 10 頂位津貼價目表＋由歷史反推＋頂位草稿（2026-10-11 老闆揀 B：逐盤逐職級）

**決定**：頂位津貼價目表逐盤逐職級（IC／兵）。價目表只用嚟計「頂位草稿」金額，**草稿未確認唔計糧**，會計確認先加入 Gross；7／8 月已鎖，任何路徑唔改已鎖月數字。正式站歷史資料本機讀唔到，所以反推做成 app 內**純唯讀**頁面／API（老闆專用），本機只用合成 fixture 驗證算法。執行：Sonnet 5.5（`claude-sonnet-5-5`），branch `p10-cover-rates`（from main `80f66ba`），只 push 唔 merge。

### 14.1 落實紀錄

**定義（同 aggregate 口徑一致，見 §14.2）**：「頂位更」＝非簽證長工、`recordType=shift`、`settlement_broker_id` 有值且 ≠ B07（`findInternalLongtermBrokerId()`）；B07 或 null＝自己崗位。共用 `shift-classify.ts` `classifyLongtermShift`（aggregate 同 cover-shifts 都 call）。職級＝更表行 Rank 欄 `classifyRank`（含 IC／SIC＝`IC`，其他＝`兵`；搵唔到更表行就跟更別 `billing_group=monthly_ic`／code 含 IC）。

**P10.1 價目表**
- Migration `20261014000000_p10_cover_shift_rates`（只新增、冪等）：`cover_shift_rates(id, site_id, grade, amount, effective_from, effective_to?, source manual|inferred, evidence?, created_*, voided_*)`，唯一 `(site_id, grade, effective_from)`。生效價＝`effective_from<=日期` 且 `effective_to` 空或 `>=日期`、未作廢、取 `effective_from` 最大者；盤搵唔到就試母盤。
- API：`GET/POST /api/longterm/cover-rates`、`PATCH /api/longterm/cover-rates/:id`（改額／`void:true`）。老闆＋會計 view，**寫入老闆專用**（`baseRole` 核對）。改價＝新增一行新生效日（舊價保留）。鎖月：生效區間覆蓋已鎖月份唔准新增／改額／作廢（`assertMonthRangeNotLocked`；另補一個遠期生效日撞鎖月嘅缺口——開放式價原本只查到「下個月」，現加查生效日本身所屬月份）。作廢後同日同盤同職級再加＝復用該行。
- 頁 `/settings/cover-rates`（老闆＋會計；會計唯讀）。audit：`cover_shift_rates` 登記 audit DTO（否則只存 `{id}`）。

**P10.2 由歷史反推＋回測（純唯讀）**
- `GET /api/longterm/cover-rates/infer?months=2026-07,2026-08,2026-09`（老闆專用；零寫入，test 證明價目表／輸入／shift／audit 行數不變；回應冇姓名，只有盤／職級／金額／次數／人數／`guard_id`）。
- 配對規則：同一長工同一月，「頂位人手輸入」總額 ÷ 該月頂位更數＝每更金額；`note` 寫明盤名／「N 更」就優先用。**頂位人手輸入判斷**：`kind=other_allowance`、已確認、未作廢、`note` 含「頂位」；同時含「賣假」＝混入項（唔參與配對）。**漏判風險**：冇「頂位」字樣嘅其他津貼認唔到——有頂位更嘅人月若存在此類輸入，計入 `stats.untagged_other_allowance_guard_months`（回測當實際＝0）。
- 按 (盤,職級) 彙總：每更金額清單（金額×更數×人數）、月份。建議值＝眾數；`consistent`（全部一樣）／`mixed`（多個價，`needs_choice`，平手時建議值 `null`）／`single_sample`（總共 1 更證據）。
- 推斷唔到：(a) 有頂位更冇對應輸入；(b) 有頂位輸入但配對唔到頂位更（`no_cover_shift`）或混賣假（`sell_leave_mixed`）；(c) 同月頂多個盤／職級而輸入得一個總數（`ambiguous`）。
- 回測：用建議價逐人逐月重算「應有頂位津貼」對實際輸入：吻合率（diff＝0 且全部更有價）、有差額人月數、最大差額、有更未有價人月、逐月分項；逐行 `guard_id`（頁面只顯示 id 前 8 位，唔出姓名）。
- 頁 `/settings/cover-rates/infer`（老闆專用）：揀月份→建議表（`consistent` 預剔；`mixed` 要揀歷史金額；`single_sample` 自己剔）→推斷唔到清單→回測→「採用已剔選嘅行」。`POST /api/longterm/cover-rates/adopt` 後端重跑推斷核對（狀態要一致、金額要係歷史出現過嘅金額，否則 422），**只有呢步寫價目表**（`source=inferred`、audit 記證據；生效日要係未鎖月份，頁面預設本月 1 號；同日已有價跳過）。**同簡報嘅差異**：簡報寫「`effective_from`＝揀定月份」，但推斷月份（7／8 月）已鎖，直接用會被鎖月擋，所以改為獨立揀「價目表生效日」（預設本月 1 號）。

**P10.3 頂位草稿**
- `generateCoverDrafts`（`src/lib/longterm-payroll/cover-drafts.ts`），掛喺現有 job `longterm_input_drafts`（每日 21:30＋一鍵結算後；本月＋上月未鎖）：每位長工每月一條 `other_allowance` 草稿（`draft_source=cover:rates`），金額＝逐更價（當日生效價）之和，`draft_evidence={lines:[{date,site_id,grade,rate_id,amount}], shifts}`（冇姓名）。無價嘅 (盤,職級) 唔生成，job 通知老闆＋會計「N 個盤／職級未有頂位價，去設定 ›」（`cover_rates_missing`，同一缺價組合集合只推一次，無 PII）。有新增／更新時通知會計「頂位津貼草稿待確認」。
- 規則：同月已有已確認頂位津貼（`note` 含「頂位」或來源 `cover:rates`）→ 唔出草稿（防重複）；更表／價目表變→更新未確認、未編輯嘅草稿；更表冇咗頂位更→系統作廢該草稿；會計改過金額（`edited`）嘅唔覆蓋；會計刪走嘅同一組證據唔再出；鎖月唔生成。長工糧頁草稿面板標「頂位價目表」、顯示金額／更數，確認可改金額（經既有 `PATCH inputs/:id`）。**草稿對 Gross 零影響**（test：生成前後 Gross 相同；確認後 `otherAllowance` 加該金額）。

**行為改變**：(1) 多 `/settings/cover-rates`、`/settings/cover-rates/infer` 兩頁（無新 RBAC module，沿用「長工糧」＋老闆 `baseRole` 核對；導覽冇加條目，入口喺長工糧頁頂「頂位價目表 ›」同通知）；(2) job `longterm_input_drafts` 對有價嘅頂位更出草稿（價目表未設定前行為不變）；(3) 計糧路徑不變（只讀 confirmed，價目表唔入 aggregate）。

**驗證**：vitest（隔離 PG 54358）244 檔，**3,684 passed｜0 failed**（階段 9 為 3,661；新增 p10-1 4 條＋p10-2 11 條＋p10-3 8 條）；tsc 0；lint 0 warning；knip 0；`rm -rf .next` 後 build 過；`gate:locked-months`（隔離 dev PG 54368）**12/12 rc=0**，`gate:ltpay-aug` **56/56**（Gross 917,875.19／Autopay 882,146.72／MPF EE 35,728.47／ER 35,966.15 不變）；Playwright 全套（隔離 PG 54368、`next start` 3169、`SCHEDULER_ENABLED=0`，含新增 `p10-cover-rates.spec.ts` 3 條）**235 passed｜4 skipped｜0 failed**；本機 fixture 跑一次 infer 頁截圖（e2e 內截）：建議表 1 行「一致」200、3 更／2 人、回測吻合 2/2、推斷零寫入。注意：`tests/seed-regen-gate.test.ts` 會對 `.env` 嘅 `DATABASE_URL` 重 seed——worktree `.env` 必須先指向隔離庫（今次一度未改，令本機主庫 `zoikan`（54329）被 seed 清到一半，要 `npm run db:reset` 還原，見回報）。

**正式站推斷步驟（俾規劃者用老闆 Chrome 唯讀執行）**
1. 老闆登入正式站，開 `/settings/cover-rates/infer`（頁面同 API 都係純唯讀，唔會寫任何嘢；**唔好撳「採用」**）。
2. 月份欄填 `2026-07,2026-08,2026-09`，撳「推斷（唯讀）」。或者喺同一個登入 session 嘅 Chrome console 用 GET：`fetch("/api/longterm/cover-rates/infer?months=2026-07,2026-08,2026-09").then(r=>r.json())`（回應冇姓名；只讀取，記低 `suggestions`／`unresolved`／`backtest.summary`／`stats`）。
3. 先睇頂部統計：頂位更數、頂位人手輸入條數、**`untagged_other_allowance_guard_months`**（有頂位更但只有冇寫「頂位」嘅其他津貼嘅人月——愈大代表歷史備註寫法唔一致、漏判愈多，建議價唔可靠）。
4. 建議表：`consistent`＝可以採用；`mixed`（多個價）要老闆揀邊個；`single_sample` 只得 1 更證據，要老闆確認。逐行抄低 盤／職級／建議金額／狀態／次數。
5. 「推斷唔到」三個清單要老闆逐項補：(a) 有頂位更冇輸入、(b) 有輸入但配唔到頂位更或混賣假、(c) 同月頂多個盤但輸入得一個總數。
6. 回測：總吻合率、有差額人月數、最大差額、有更未有價人月。吻合率低或最大差額大＝建議價或頂位更認定（崗位盤登記）有問題，先查 `guard_longterm_posts` 同備註寫法，唔好採用。
7. 老闆決定採用先由**老闆親手**撳「採用已剔選嘅行」（生效日揀未鎖月份，預設本月 1 號；7／8 月已鎖唔可以做生效日），然後去 `/settings/cover-rates` 檢查／微調。採用後每晚 21:30 job 就按價目表出頂位草稿（會計確認先計糧）；未設價嘅盤／職級會通知「N 個盤／職級未有頂位價，去設定 ›」。

### 14.2 驗收後修正（Opus 5.5 唔通過 → 3 必修＋一併項，Sonnet 5.5，同 branch）
- **M1 頂位更認定同 aggregate 分叉**：原本自己重查 `guard_longterm_posts`（只摺母盤，漏構造盤 `activityProxySiteId` 摺疊同 Postorder 權威月只認 manual），8 月實測多認 13 更（全部係 CP5 構造盤嘅自己崗位更）。改為抽 `classifyLongtermShift`（B07→own、有值非 B07→cover、null→保守當自己崗位）俾 aggregate 同 `cover-shifts.ts` 共用；頂位更＝非簽證、`recordType=shift`、settlement 有值且 ≠ B07。崗位判斷已喺對數時寫入 settlement，唔再自己查崗位；移除 `no_post_shifts`。test：fixture 頂位更 settlement 改外判雞頭；構造盤／proxy 盤自己更（B07）同 null settlement 都唔算頂位。
- **M2 note 日期當更數**：note 更數只認「N更」／「N次」（唔再認「日」，「8月15日」唔當 15 更）；note 更數同實際頂位更數唔一致 → 列 `unresolved.ambiguous`，唔照用。test：1 更 200 元＋note 含日期 → 每更 200；唔一致 → ambiguous。
- **M3 缺價通知 dedupe**：hash 只用缺價組合（盤＋職級）集合，唔含更數；之後更數增加唔再推，組合增加先再推（`docs/ops.md` 一致）。test 覆蓋。
- **一併**：PATCH 改額文件寫明「改額＝更正；改價請新增一行」；頂位草稿確認後更表再加更只記 `skipped_confirmed`（文件註明）；`schema.prisma` 過時註解（`SELL_LEAVE_RATE_TABLE`）改正。
- **待老闆確認（雙重支付）**：aggregate 口徑嘅頂位更＝長工幫雞頭頂散更，嗰啲更已經由雞頭現金結算（`aggregate.ts` 「幫雞頭頂散更 N 更：已由雞頭現金結算」）。再出頂位津貼會唔會同雞頭結算雙重支付，由回測吻合率（會計過往有冇另外畀頂位津貼）同老闆決定；推斷頁頂部已加提示；未決定前**唔好採用價目表**。

### 14.3 驗收、部署、正式站推斷結果（2026-10-11 晚）
- Opus 5.5 兩輪：第一輪 3 必修（頂位更認定同 `aggregate.ts` 唔一致——8 月測試資料 19 vs 6 更，多出嘅係 CP5 構造盤自己崗位更；note「8月15日」被當 15 更；缺價通知 hash 含更數會日日推）；修正：共用 `classifyLongtermShift`（aggregate 同 cover-shifts 都用）、note 只認「N更／N次」、hash 只用 (盤,職級) 集合；第二輪通過——驗收員用舊／新 HEAD 各跑一次 `gate:locked-months` 比 snapshot，7／8 月每個數字一樣（7 月營業額 3,130,432.72／成本 2,715,419.99；8 月 3,236,901.04／2,713,658.02），`gate:ltpay-aug` 56/56。
- merge main `abf1390`；部署 `6acb77eeda7cf920c2638d69` RUNNING 11:56Z：migration `20261014000000_p10_cover_shift_rates` applied、scheduler started。
- **正式站推斷（老闆 Chrome 唯讀，`/settings/cover-rates/infer?months=2026-07,2026-08,2026-09`，冇撳採用）**：`cover_shifts=0`、`tagged_inputs=0`、`untagged_other_allowance_guard_months=0`，建議表 0 行，推斷唔到清單 0，回測 0 人月。原因（同一 session 唯讀核實）：正式站 **長工合約 0 份、7／8／9 月長工糧 0 次 run（頁面顯示「未計過長工糧」）、人手輸入 0 條**——長工糧模組喺正式站從未用過，歷史頂位津貼紀錄只存在於系統外（Payroll Editor／Excel／Drive）。本機 gate 嘅 8 月 fixture 有 6 更頂位係因為 fixture 由 `data/` 開盤資料砌出，正式站 shift_records 未有長工 settlement 標記。
- 結論：階段 10 功能已就緒（價目表、推斷、回測、草稿），但**反推要等歷史資料入系統**。選項交老闆（見報告）：(A) 將 7／8／9 月 Payroll Editor／長工糧表（Maxwell 名單＋人手津貼）導入系統（Maxwell 導入已有；人手輸入要逐月導入或批量導入功能），再跑推斷；(B) 由老闆／會計直接提供舊價目表（盤×職級×金額）人手輸入；(C) 由本機 `data/` 內舊檔離線反推（只出盤×職級×金額彙總，唔出人名）——視乎 `data/` 有冇相關檔。

## 15. 階段 11 長工資料導入準備＋系統 vs Payroll Editor 逐人核對

### 15.1 落實紀錄（Sonnet 5.5，branch `p11-ltpay-import`，未 merge）

- **P11.1** Maxwell 導入加 `contract_start_mode`（`original` 預設不變／`first_unlocked`＝由最後一個已鎖月嘅下一個月 1 號起生效，原入職日留 note）。唔改 `guards.monthlySalary`（毛利表長工分攤讀佢，已鎖 8 月成本不變）；名單月薪同系統現值唔同只計入 `salary_mismatch`。route＋UI 下拉＋`tests/p11-1-import-start-mode.test.ts`（5 條：original 同階段 9 一致、first_unlocked 全建／鎖月零改動／monthlySalary 零改動／冪等／冇鎖月／route 400）。
- **P11.2** `scripts/gate/ltpay-vs-payrolleditor.ts`＋`scripts/gate/lib/payroll-editor-compare.ts`（dev-only；`xlsx@0.18.5` devDependency 釘版本，lock 由 npm 生成）；`gate:ltpay-aug` 加 `--out`。`tests/p11-2-payroll-editor-compare.test.ts`（3 條，含 CLI 唔印 PII）。

### 15.2 驗收後修正（Opus 5.5 唔通過 → 1 必修＋一併項，Sonnet 5.5，同 branch）

- **M1** `first_unlocked` 處理離職名單：離職日空或早過起始日 → 唔建合約（`skipped_left_before_start` 計數＋warning）；離職日 ≥ 起始日 → 末段 `effectiveTo`＝離職日（之後起生效嘅段丟棄）。xlsx／CSV（`left_csv`）兩路各有 test，離職人唔出糧。
- 一併：密碼保護 xls 中文提示＋ops.md 解法；冇表頭／冇明細行 throw；重複 key 唔再計入 only-in-PE（另列 `details.duplicates`）；移除 `--db-url`（只用 `DATABASE_URL`）；合約 note 淨係入職日早過起始日先寫「原入職日」；`gate:ltpay-aug --out` 嘅 `people[].fields` 加逐欄 oracle／system／diff；P11.2 test 補重複 key／金額讀唔到／密碼保護／無表頭。

### 15.3 部署同正式站核對（2026-10-12）
- Opus 5.5 第二輪（delta `dd5a8ff..55a9ecc`）通過，冇必修；M1（離職名單 lastDay）用獨立 fixture 重跑確認；計算路徑無改動，gate 沿用第一輪結果。
- merge `1a7bfa7`（`--no-ff`，零衝突）；Zeabur 部署 `6acbb5e3`，RUNNING；啟動 log：62 migrations／No pending、`[db:ensure-system-user]` 就緒、`[ai-assistant] provider=claude model=claude-opus-5-5`、`[scheduler] started`、Ready 940ms。
- 正式站（老闆帳號、唯讀）：`/reports/longterm-payroll` 「合約」tab 見到「合約起始」下拉，兩個選項，預設「照名單入職日（覆蓋鎖月嘅行跳過）」；**未導入任何資料**（等老闆決定 7／8 月鎖月 vs 本機核對）。
- Opus (ii) 留待：`docs/ops.md:89` 字眼同 `payroll-editor-compare.ts` 預設欄位殘留；真檔表頭 regex 可能要放寬（規劃者本機跑真檔時處理）。
## 17. 階段 13 hotfix（2026-10-12 老闆報）：「要你睇」手機載入慢＋全站冇得返

### 17.1 根因、修法、before/after
**問題一：載入慢**（正式站老闆帳號實測）：`GET /api/triage/sessions/:id?status=open` 對「保安員證件資料導入」session（350 題未答：重要 122、補充 228）回 **680 KB、桌面 Wi-Fi 1.3 秒**；`TriageDialog` 要成份 JSON 到齊先 render 第一題，手機流動數據下載＋parse＋render 350 題 view 物件＝老闆見到嘅「3 分鐘載入緊」。月結 session 只 22 KB 所以唔慢。

**問題二：冇返回**：(a) 兩個對話框只有細「遲啲先答」／「×」，冇「上一題」、冇清楚「返回列表」；(b) 老闆 2026-09-15 要求「加到主畫面」（`manifest.display: "standalone"`＋`appleWebApp.capable`）→ 由主畫面開冇任何瀏覽器 chrome（冇返回掣、冇網址列，iPhone 連邊緣滑返手勢都冇，Android 得系統返回）；頁對頁導航本身正常（全站 `GuardedLink`／`Link`），但 **10 個覆蓋層（6 個 Drawer 用家、`TriageDialog`、`MonthCloseTriageDialog`、`BatchAcceptButton`、`MobileNav` 抽屜）＋AI 助手側欄全部唔入 history**：正式站實測開「繼續答」對話框後 `history.back()` 直接跳出去 `/`，對話框冇咗；(c) 全站冇統一「返回」UI。

| 項目 | 修法 |
|---|---|
| P13.1 分頁 | `GET /api/triage/sessions/:id` 加 additive `take`（0–50）＋`cursor`＋`tier`＋`status=open,skipped`；回應加 `next_cursor`；`counts` 照舊整個 session；DTO 只對該頁行計；**冇 `take` 行為一字不變**。兩個對話框用 `useTriagePager`：首屏 5 題，剩 ≤3 題背景 prefetch；counts 取自 session |
| P13.5 覆蓋層入 history | `useHistoryOverlay(open,onClose,key,enabled)`：開＝`pushState`（同 URL，帶 depth），返回（popstate）只關覆蓋層；UI 關閉 `history.back()`；嵌套後開先關；導航離開留低舊 entry 由全域 popstate 跳過；連撳兩次 close 只返一格。套用 Drawer（一處改 6 個用家）、兩個分診對話框、批量接受、MobileNav 抽屜、AI 側欄（只 `< lg`）。唔改 `manifest.display`、唔改 month-store `replaceState` |
| P13.2 返回 | 兩個對話框頂部左「‹ 返回列表」（取代「遲啲先答」／×，＝關對話框）；底部「‹ 上一題／下一題 ›」回看本次處理過嘅題：已答只讀（「你答咗…已送出」，改答案留下一輪）、跳過嘅可重新答 |
| P13.3 記位置 | `sessionStorage` `zk-triage-pos-<session>`；重開顯示「由第 N 題繼續」＋「由頭開始」（連跳過咗嘅一齊攞）；關對話框唔再 `router.refresh()`（只重 fetch 列表 counts；左欄 badge debounce 2 秒） |
| P13.4 列表卡 | 「重要 N 題」做主數字，「補充 N 題」細字；「繼續答」直接開重要題 |
| P13.6 全站返回 | 手機頂欄（`< lg`，首頁除外）「‹」；`NavHistoryTracker` 記 sessionStorage 頁面 stack（≤50）；`goBack`：有上一頁 `router.back()`，否則父路徑（`/month-close/files`→`/month-close`），再否則 `/`；5 個頁內「‹ 返回…」改 `BackLink`（同一 `goBack`；`/month-close/files` 保留 `Link` 因為要帶 `?month`） |

**Before / after（合成 350 題 session，重要 122／補充 228；Playwright Chromium 375px、CDP 模擬 Fast 3G＝1.6 Mbps／RTT 150 ms）**
| | before（無 `take`） | after（`take=5`） |
|---|---|---|
| 首屏請求大細 | **565,757 bytes** | **9,449 bytes**（<40 KB） |
| 該請求 3G 時間 | 3,291 ms | — |
| 撳「繼續答」→ 第一題出現 | ≥3,291 ms（要等成份 JSON） | **約 330 ms**（<1 秒） |
| 首屏題數 | 350 | 5 |
| 開對話框後 `history.back()` | 跳出去上一頁（`/`） | 只關對話框，仍喺 `/triage` |

**驗證**：vitest（隔離 PG 54347）247 檔，**3,696 passed｜10 skipped｜0 failed**（新增 p13-1 分頁 10 條、p13-5 history hook 7 條、p13-6 back-nav 4 條）；tsc 0；lint 0 warning；knip 0；`rm -rf .next` 後 build 過；Playwright 全套（隔離 PG 54348、`next start` 3162、`AI_LLM=fake`、`SCHEDULER_ENABLED=0`，每次跑前 `db:reset`＋`db:seed`）**241 passed｜5 skipped｜0 failed**（新增 `tests/e2e/p13-triage-mobile.spec.ts` 7 條：350 題 3G 量度、上一題／返回列表／記位置／prefetch、重新整理後覆蓋層 UI／系統返回都關得到、history 返回、月結對話框分頁、手機頂欄「‹」）；`gate:locked-months` **12/12 rc=0**，`gate:ltpay-aug` **56/56**（Gross 917,875.19／Autopay 882,146.72／MPF EE 35,728.47／ER 35,966.15 不變）。量度（本機 Playwright）：before 565,757 B／約 3.2–3.3 秒（Fast 3G）；after 首屏 9,449 B（take=5）、第一題 330–340 ms。既有 `month-close-ui`／`reconcile-ui` 兩個 spec 嘅 `page.route` mock 要接受 query string（`sess1*`），斷言不變。

**驗收修正（Opus 5.5 第一輪 3 必修）**：M1 `.venv` symlink 誤入 git（已 `git rm --cached`，`ls-files -s | grep ^120000` 為空）；M2 重新整理後覆蓋層卡死（舊 entry 同 key、depth 相同令 `closing` 永遠 true）→ 每次開生成 nonce 寫入 state，比較用 nonce＋depth，舊 entry 一律當「唔係我嘅」，另加 400ms 保險；月結對話框 flush 失敗時 `restore()` 補返 entry；M3 `NavHistoryTracker`／`trackPath` 只存 pathname（query 可能帶姓名／員工編號）。一併：timer unmount 清理、重載後「共約 M 題」、重複 close 測試改為斷言 `history.back` 只呼叫一次。

**驗收修正 2（Opus 5.5 第二輪 M4＋g＋h）**：M4 `close()` 嘅 400ms 保險 timer 先 fire 時，`onClose` 令 overlay unmount，cleanup 見 entry 仲喺頂又 `history.back()` 一次，popstate 遲到（慢機）變雙退格飛出頁面；修：timer 分支喺 `onClose` 前先設 `poppedRef=true`，遲到嘅 popstate 只返到 base entry。g 全域跳過舊 entry 嘅 popstate listener 改為模組載入即裝（MobileNav 每頁 layout 都 import），重新整理後唔再開 overlay 直接導航，back 一次就返到原頁。h `restore()` 改用開啟時記低嘅 depth。新增 Playwright：patch `History.prototype.back` 延遲 700ms，撳「返回列表」`back` 只叫一次、仍喺 `/triage`；開 overlay→reload→唔開→Link 去 `/guards`→back 一次返 `/triage`。最終：vitest 3,696／10 skip／0 fail；Playwright 241／5／0；gate 12/12；ltpay-aug 56/56。

### 17.2 驗收、部署、正式站實測（2026-10-12）
- Opus 5.5 三輪：第一輪 M1（`.venv` symlink 入 git）、M2（重新整理後覆蓋層關唔到——key 撞舊 entry，改 nonce＋depth）、M3（nav 堆疊存 query string，改只存 pathname）；第二輪 M4（400ms 保險同遲到 popstate 雙退格，timer 分支先標 popped）＋(ii) g（全域舊 entry 跳過改模組載入就裝）／h（restore depth）；第三輪通過（0/300/700/1500ms 延遲全部 1 次 back）。留 (ii) i（重新整理後第一下「‹」無可見變化）、j（flush 失敗同保險同時發生多一輪開關，無資料遺失）。
- merge `ddbefdf`（只 P3 doc 衝突，兩節並存）；部署 `6acbd564` RUNNING；啟動 log：62 migrations／No pending、系統帳號就緒、provider=claude model=claude-opus-5-5、scheduler started、Ready 1089ms。
- 正式站（老闆帳號、唯讀，桌面 Wi-Fi）：導入 session（350 題）首屏 `?status=open&take=5&tier=important` **6,855 B／387 ms**（改前 680 KB／1.3 s）；月結 session 5,564 B／420 ms；開對話框 history +1 並帶 `zkOverlay/zkNonce/zkDepth`；`history.back()` 只關對話框、仍喺 `/triage`（改前跳出去 `/`）；「‹ 返回列表」關閉後 history 唔多退；手機頂欄「‹」（aria「返回上一頁」）喺 DOM。

### 15.4 8 月真實 Payroll Editor 逐人核對（本機，2026-10-12）
- 來源：解密後 `(Maxwell) PayrollEditor (2026.08).xls`（79 行、總額 958,967.58）vs gate DB 2026-08 run（56 人）。工具 `ltpay-vs-payrolleditor.ts` 配對 0：備考號欄 79 行全空（冇工號）、隔離 DB 冇戶口。改由規劃者本機用 Maxwell 名單嘅英文名做橋（逐人明細 `data/2026-10/ltpay-aug-by-name.json`，唔入 git）。
- 結果：配對 51/56；**46 人完全吻合（±0.01）**；5 人有差（系統－銀行：−3,444.18、−2,375.00、−582.25、+16.17、+14.45，淨 −6,370.82）；系統有、銀行冇 5 人（全部 8 月內或 9/1 離職，7／8／9 月 autopay 檔都冇）；銀行有、系統冇 28 行（唔喺 Maxwell 前線名單、全部整數金額、合共 101,950，7 月有 15 個、9 月有 18 個同名）。
- 根因（逐個）：(1) −2,375＝銀行照舊薪 19,000 出糧，Maxwell 名單寫 8/1 起改 16,500（系統跟名單）；(2) −582.25＝同盤另一人同樣減薪（8/5 生效，兩邊口徑一致）但無薪假日數系統 3 日、銀行 2 日，差 1 日；(3) −3,444.18＝10 日短期病假（全部有醫生紙、冇一段 ≥4 日）＋1 日無薪假，系統按《僱傭條例》唔出病假津貼，銀行出咗 3,444.18（唔等於全數 4/5＝6,451.61，公式未知）；(4)(5) +16.17／+14.45＝兩個 8/31 離職者嘅年假折現天數算法細微差別（日數基準），系統略高。
- 待老闆判斷：減薪生效日以邊個為準；短期病假公司實際點計；離職者係咪唔經 autopay 出糧；28 行非前線人員係乜（唔屬長工模組）。

## 18. 階段 14（2026-10-12 老闆決定 B＋硬要求）：長工糧「同銀行對數」工具鏈

背景：正式站要解鎖 7、8 月 → 導入長工合約＋人手輸入 → 系統計 → 逐人同銀行 Payroll Editor 對數 → 修到 100% 一致（或每個差異有合理解釋）→ 再鎖返。本階段只做工具鏈，**唔改計算邏輯（`aggregate.ts` 一字未動）**；規則修正係下一步另一簡報。目標係以後每個月「上載銀行檔 → 系統自動逐人對數 → 差異列明原因」。

### 18.1 內容、驗證（執行員 Sonnet 5.5，worktree `p14-bank-reconcile`，未 merge）
- **P14.1 Maxwell 導入補欄**：連結到既有 guard 時，`nameEn` 空就補、MG／MW 工號空（且冇任何 MG／MW 行）就經 `guard_staff_numbers`（`upsertCurrentStaffNumber`＋`syncLegacyStaffNoColumns`）補；永不覆蓋非空、永不改 `monthlySalary`；summary 加 `filled_name_en`、`filled_staff_no_mw`。配對規則不變（工號 → 中文名唯一；正式站 `staffNoMw` 全空即主要靠中文名，補完後下次靠工號）；配唔到維持列 `unmatched`（現行行為本來就唔建新 guard，保持）。
- **P14.2 批量導入＋生成草稿**：`POST /api/longterm/inputs/bulk`（≤500、逐行配 guard、冪等、病假重疊逐行列明、`dry_run` 預覽、鎖月 403）；`POST /api/longterm/inputs/drafts/generate?month=`（老闆；同 job 共用 advisory lock，並發 409）；UI「人手輸入」tab 面板（上載→預覽只列行號／工號→確認寫入；「由更表生成草稿」）。`findConfirmedLeaveOverlap` 加可選 `db` 參數（預設仍係全局 prisma，行為不變）。
- **P14.3 銀行對數**：新表 `longterm_bank_reconciliations`／`_rows`（銀行名只存 sha256）；`xlsx` 0.18.5 移入 dependencies（server-only；`.next/static` grep 0 命中）；`POST/GET /api/longterm/payroll/:month/reconcile`、`PATCH /api/longterm/reconcile-rows/:id`；三輪配對（備考號 → 戶口 → 英文名，撞名用金額縮窄）、容差 ±0.01、重新上載帶舊原因（同人同差額）；UI 新 tab「銀行對數」（summary 卡、逐人表、只睇差異、原因下拉、差異行展開系統組成、匯出差異 CSV 無姓名）；鎖月前體檢加 `bank_reconcile` info 項（唔擋鎖）。
- **P14.4 解鎖期安全**：逐個 job 核實並加 test。`auto_one_click` 發現缺口——解鎖月份若最新上載新過上次一鍵結算（或根本冇 run）會重跑一鍵結算；加條件「曾解鎖（audit `unlock_month`）而最新上載唔新過解鎖時間 → skip（`reopened_no_new_upload`）」。`longterm_input_drafts`（只上月＋本月）、`open_next_month`（只下個月）、`nightly_month_health`（只本月＋上月、唯讀）舊月份唔掂；`after_lock_exports`／`lock_ops_digest` 重鎖會重出檔（可接受，寫入 `docs/ops.md`）。`docs/ops.md` 加「解鎖舊月份做對數嘅標準流程」。
- **驗證**（隔離 PG：vitest 54370、e2e／gate 54372，`next start` 3166，`AI_LLM=fake`、`SCHEDULER_ENABLED=0`，每次跑前 `db:reset`＋`db:seed`）：vitest **254 檔，3,731 passed｜10 skipped｜0 failed**（新增 p14-1 4、p14-2 bulk 6＋parse 2、p14-3 7、p14-4 5＝24 條）；tsc 0；lint 0 warning；knip 0；`rm -rf .next` 後 build 過；Playwright 全套 **243 passed｜5 skipped｜0 failed**（新增 `p14-bank-reconcile.spec.ts` 2 條；`p3-4-ui` 長工糧 tab 數 4→5）；`gate:locked-months` **12/12 rc=0**，`gate:ltpay-aug` **56/56**（Gross 917,875.19／Autopay 882,146.72／MPF EE 35,728.47／ER 35,966.15 不變）；client bundle 冇 SheetJS。
- **驗收修正（Opus 5.5 第一輪 3 必修＋(ii)）**：M1 英文名同名配對改為「任何一邊多過一行只接受金額唯一對唯一，其餘 `ambiguous_name` 唔配」（行序無關，test 三場景）；M2 批量重複判斷只比 confirmed，撞同人同段 draft 即確認（`confirmed_existing_draft`）；M3 `XLSX.read` `sheetRows` 5,100＋夾 60 欄＋明細 >5,000 行 400（巨大 `!ref` 宣告範圍嘅檔會先夾範圍再正常解析（約 6ms），明細真係超過 5,000 行先回 400；100k 行檔 332ms 回 400）；(ii) 真實 Excel 行號、日期 `from≤to` 且在當月、生成草稿 audit `trigger_drafts_generate`、體檢反映 stale、只填備注都存、tab 隱藏唔 GET、工號撞號 warning 唔帶姓名。審計 action 用 TS 聯合型別新增 `confirm`／`trigger_drafts_generate`（`audit_log.action` 係 text，冇 migration）。
- **執行員對簡報冇講清楚處嘅保守處理**：(1) 簡報「配唔到就建新 guard 嘅行為保持」——現行導入本來唔建新 guard（只列 `unmatched`），保持不變；(2) 批量導入 body 額外接受可選 `name_zh` 作最後後備配對（additive），且 `kind` 為津貼／制服／扣款而缺金額、`leave` 缺 `date_from` 列入 `invalid[]`（additive 欄位）；(3) 「來源 `bulk_import`」落 `draft_source="bulk_import"`（status=confirmed），冇新增欄；(4) `生成草稿` 用系統帳號做 actor（令「被人作廢嘅草稿唔再生成」判斷同 job 一致），audit `by_job` 為 `longterm_input_drafts:manual`；(5) 對數系統 autopay＝0 而銀行冇行唔列 `system_only`（記 `system_zero_skipped`）；(6) 銀行金額壞嘅行列 `bank_only`（唔猜）；(7) 鎖月都可對數（對數唔改糧單數字）；(8) 上載後重算令 `stale=true`，需重新上載；(9) 「生成草稿」掣所有長工糧用家都見到，非老闆撳會 403（API 強制老闆）。

### 18.2 驗收、合併（2026-10-12）
- Opus 5.5 兩輪：第一輪 M1（同名配對淘汰法錯配、行序相關）、M2（批量導入將 draft 當已存在）、M3（解析無行數上限，16KB 惡意檔拖死 server >9 分鐘）＋(ii) a–h；第二輪全部通過（確認咗嘅病假段 recompute 真係入糧：sl45 0→1,548.39；舊 code 對同一惡意檔 >120 秒，新 code 6ms）。
- merge（`--no-ff`，零衝突）；部署見 §18.3。

## 19. 階段 15（2026-10-12）：長工糧「作廢本月計算」（可倒序重算）＋平均工資批量導入＋新增合約

### 19.1 內容、驗證（執行員 Sonnet 5.5，worktree `p15-ltpay-void-avgwage`，未 merge）
- **P15.1 作廢本月計算**：`voidLongtermPayrollMonth()`（`src/lib/longterm-payroll/void-month.ts`）＋`POST /api/longterm/payroll/[month]/void`（老闆、`reason` 必填；後月有效 → 409、無可作廢 404、鎖月 403）。結餘係「每人每年單一累積記錄」，故新表 `guard_leave_balance_history`（migration `20261016000000`，只新增）喺每次計糧寫回前影低舊狀態，作廢時原樣還原（`existed=false` 刪行）；P15 前計過嘅月份（冇快照，正式站 8 月屬此類）走 legacy 重建（`taken`＝`*_opening`，上月 opening＝上月尾累積減上月新增，後者以 0 起算 dry-run `buildLongtermPayrollInputs(prev, …, { zeroOpening:true })` 取得），回應 `legacy_rebuilt` 提示覆核。同時清走該月 computed／自動計平均工資；audit `void_longterm_payroll_month`。UI：「本月糧」tab「作廢本月計算（老闆）」＋原因。
- **P15.2 平均工資批量導入**：`POST /api/longterm/avg-wages/bulk`（≤500、配對同 P14.2、`source` 人手批量導入、冪等、`dry_run`、鎖月 403）＋「平均工資與假期」tab 批量面板（預覽只顯示行號／工號）。
- **P15.3 新增合約**：「合約」tab「新增合約」表單（月薪制／日薪制；日薪制 `monthly_salary` 填同每更價）；新增 additive `GET /api/longterm/guard-search`（只回 id／姓名／工號）供揀保安員；`POST /api/longterm/contracts` 不變。
- **驗證**：vitest `tests/p15-void-month.test.ts`（7→8→void 8→重算 8 結餘同 lines 完全一致；8→void→7→8 等於順序 7→8；legacy 無快照路徑同樣一致；409／403／404／400／會計 403；computed 平均工資清走；avg bulk 配對／冪等／dry_run／權限／鎖月／上限；guard-search 與月薪＋日薪建合約）；Playwright `tests/e2e/p15-void-avg-contract.spec.ts`（3 條）。數字見提交紀錄／回報。
- **執行員對簡報冇講清楚處嘅保守處理**：(1) 結餘快照只影「第一次」（同月重算唔覆蓋）；若該行已是本月狀態而冇快照（legacy）就唔影，留俾 void 走 legacy 重建；(2) legacy 重建對 SL 假設上月有足夠結餘（0 起算 dry-run），近似，需覆核；(3) 作廢限老闆（`baseRole`），權限 module 仍用「長工糧:update」；(4) 簡報 `source=manual` 於 avg bulk 解讀為「人手批量導入」字串，不會被作廢清走；(5) 新增 audit action 為 TS 聯合型別（`audit_log.action` 係 text，無 migration）。
- **驗收修正（Opus 5.5）**：M1 合約日期重疊 409 `contract_overlap`＋`close_previous`（POST／PATCH，表單預設勾自動結束上一段）；(ii) a 作廢掣非老闆唔顯示（`can_void`）、b 作廢只清 `computed`／`auto:`／`自動計:` 前綴 avg wage（bulk 固定 `manual:`）、c 作廢前置檢查 GET（`earlier_valid_runs`／`rollback_method`）＋近似重建要 `confirm_approx`、d audit 列齊 run id／受影響 guard 數／計數、e `existed=false` 快照遇人手 entitled／carry 唔刪行（`kept_manual_rows`）。
- **驗收修正 2（Opus 5.5 第二輪）**：N1 跨年 `existed=false` 快照回滾保留行時 taken 回 opening（唔係 0），opening 非 0 唔當人手（上年結轉）；新 test 跨年 2026-12→2027-01→作廢→重算同首次一致。PATCH 合約重疊檢查搬入 transaction＋`FOR UPDATE`；`close_previous` 舊合約之間已重疊時回應 `overlap_note`（用 `overlap_note` 因 DTO 已有合約 `note` 欄）。


### 19.2 驗收、合併、部署（2026-10-12）
- Opus 5.5 三輪：第一輪 M1（重疊合約靜靜建立）＋(ii) a–e；第二輪 M1 過但 (ii)e 修法引入 N1（跨年作廢清走上年結轉已放日數，regression）；第三輪通過（跨年刪行／保留行兩變體、legacy 無快照跨年都精確、PATCH 並發 [200,409]）。留 (ii)：舊合約之間本身重疊 `close_previous` 唔處理，只以 `overlap_note` 提示。
- e2e 注意：Playwright 全套要用 `next build`＋`next start`；`next dev` 模式下開對話框 spec 會 timeout（main 一樣），唔係代碼問題。
- merge（`--no-ff`，零衝突）；部署見下。

### 19.3 正式站進度（2026-10-12，階段 15 部署後）
- 部署 `6acc72af`（migration `20261016000000` 已套用）。正式站：作廢 9 月空 run → 作廢 8 月（精確重建，57 人）→ 計 7 月（54 行）→ 計 8 月（57 行，數字同作廢前一致）。
- 8 月對數（重新上載）：配對 50／吻合 45／差 5（同前）／系統有銀行冇 7／銀行有系統冇 30。
- 7 月對數（首次）：配對 51／吻合 17／差 34／系統有銀行冇 3／銀行有系統冇 20。逐人對辦公室 7 月糧單（＝銀行）拆解：18 人冇扣 7/1 法定假（Maxwell「法定假期」空白被導入當 immediate → 階段 16a 修映射）；22 人 OT／補假日工資冇輸入（已由糧單批量導入 24 項，另 1 重複）；病假 4/5 用月薪/31 而非平均工資（已批量導入糧單平均工資 41 人）；另 3 人 NPL 日數差 1–2 日、1 人 7 月更表冇連結（wd 0）、1 人新入職按日拆分方式唔同——待下一輪重算後再對。
- 8 月 D2（短病假 3,444.18）用 7 月平均工資驗證唔符（10 日×0.8×824＝6,594），公式仍未知；D4／D5 用 7 月平均工資算離職年假仍差十幾蚊（8 月平均工資略低）。
## 20. 階段 16a（2026-10-12）：Maxwell 導入——法定假期有薪起點映射修正＋重導入更新既有合約

- **根因**：Maxwell 名單「法定假期」欄只有「即時享有薪SH」（30 人）同空白（99 人）；`import-service.ts` 舊映射把空白當 immediate → 7 月 1 日法定假全部有薪，系統冇扣 NPSH（辦公室糧單有 18 人扣，合共 −10,490.31）。
- **修法**：`mapStatutoryHolidayPaidFrom()`：含「即時」／immediate → immediate；空白或其他 → after_3_months。重導入更新既有 `source=maxwell_import` 合約非薪酬欄（值唔同先更新，寫 audit，summary `contracts_fields_updated`）；薪酬段邏輯、manual 合約、鎖月行為不變。不改計算公式。
- **驗證**：新 `tests/p16a-import-sh-mapping.test.ts`（映射兩值＋空白；重導入更新＋audit＋manual 唔掂＋冪等；7 月 SH 入職未滿 3 個月 import→aggregate 扣 NPSH／「即時」唔扣）。


### 20.2 部署同正式站重算（2026-10-12）
- merge `0d63d10`（P3 doc 衝突兩節並存）；部署 `6acc7fb8`。正式站重導入 Maxwell：76 份生效合約 → 法定假期 after_3_months 45／immediate 31。作廢 8 月（快照精確還原 57 人）→ 重算 7 月（54 行，autopay 883,955.93 → 888,933.87）→ 重算 8 月（57 行，不變）。
- 7 月對數：配對 51／**吻合 17 → 40**／差 11／系統有銀行冇 3／銀行有系統冇 20。8 月不變（45／50）。
- 7 月剩餘 11 個差額逐人追查（更表 vs 辦公室糧單備註）：7 人係**更表同辦公室出勤紀錄唔同**（例：更表 7/30–31 返工，辦公室扣無薪假；更表 7/16 SL、7/21 AL，辦公室當 NPL／NPSL；更表 7/26 RD，辦公室當病假第 6 日；更表 7/23 RD，辦公室當病假第 1 日）；1 人 OT＋補假日同額 650 被批量導入當重複（已人手補一項；工具改進：重複判斷要計 note）；1 人（月薪 25,000）7 月所有更歸咗雞頭結算，長工糧當全部係頂位更（wd 0）；1 人法定假替假（7/3）冇扣（待查紀錄歸屬）；3 人 ±7 元以內（平均工資四捨五入）。

## 21 階段 16b（2026-10-12）：對數工具細修
- **P16b.1** 批量輸入重複判斷加入 note（`bulk-inputs.ts`）：同金額唔同 note 分開新增；回應 `separate_by_note`。由草稿確認嘅行保持原冪等。
- **P16b.2** 銀行檔第二表頭行跳過（`bank-reconcile.ts`）：不入 rows、不計 `bad_amount_rows`；summary `header_rows_skipped`。
- **P16b.3** 同日多來源更表紀錄衝突提示（`aggregate.ts` `attendanceConflictNote()`）：只加 notes，不改計算；summary `attendance_conflicts`；銀行對數 tab 展開以紅字顯示；`docs/ops.md` 加根因一節。
- 測試：`tests/p16b-recon-tweaks.test.ts`（6 條）。驗收修正（Opus 5.5）：M1 系統草稿已確認行唔計 note 判重；第二表頭行只認表頭字眼；`.gitignore` `/out`；衝突前綴抽去 `attendance-conflict.ts`（client bundle 唔拉 aggregate）。

### 21.2 驗收、合併、部署（2026-10-12）
- Opus 5.5 兩輪：第一輪 M1（系統草稿經 UI 確認後被批量當唔同 note 新增→雙重支付）＋(ii) a–e；第二輪代碼通過，剩文件字眼（規劃者自行修正）。squash merge `c0f1baf`（歷史曾含 out symlink，故 squash）；部署 `6acc9c5c` RUNNING。

### 21.3 正式站第三輪對數（2026-10-12，Dispatch 完成 4 步 UI 修正後）
- 作廢 2 份不應存在合約、再入職者舊合約結束 6/30＋清離職日（Dispatch 經 UI）；規劃者補建 8/1 新合約（API POST）；作廢 8 月（快照精確還原）→ 重算 7 月（53 行，autopay 870,551.37）→ 重算 8 月（56 行，autopay 882,137.90）。
- **8 月**：配對 51／**吻合 46**／差 5（同前，等老闆）／系統有銀行冇 5（全部月內離職者）／銀行有系統冇 28（非前線）；表頭行已跳過。
- **7 月**：配對 51／**吻合 41**／差 10（7 個更表 vs 辦公室出勤衝突＋3 個 ±7 元四捨五入）／系統有銀行冇 2／銀行有系統冇 19。
- 待查 (ii)：`attendance_conflicts` 回 0，但 7 月實證有同日多來源代號衝突——aggregate 讀紀錄嘅篩選可能已先去重，P16b.3 嘅偵測要對住 aggregate 實際讀到嘅集合之前做。

### 21.4 8 月第四輪（2026-10-14）
- 減薪個案查 9 月銀行（19,000 − 4 日病假 + 4×0.8×ADW ≈ 銀行數，差 2 元）→ 減薪未生效、Maxwell 名單錯；Dispatch 作廢 16,500 合約、19,000 合約清結束日（UI 清空唔送 null＋409 被吞 → P17.4 修）。重算 8 月：**配對 51／吻合 47**／差 4（8/2 例假 1 條等老闆；3 條係平均工資：短病假 3,444.18、離職年假 −21.06／−17.31，等 1–6 月 Payroll Editor）／系統有銀行冇 5（離職者唔經 autopay，老闆已確認）／銀行有系統冇 28（寫字樓員工，老闆「應該係」）。
- 老闆病假規則（2026-10-14）：有 SL 標記就彈出人手確認先出津貼 → 階段 17。

## 22 階段 17（2026-10-14）：病假人手確認彈出＋合約表單修正＋每週一日例假
- **P17.2** 更表有 SL → 一定要人手確認醫生紙先出津貼（老闆規則），未確認當無薪（草稿機制保留）。主動彈出：通知 `sl_drafts_pending`、首頁收件箱卡、一鍵結算 needs_human（「長工結算」步）、鎖月擋（409 `sl_drafts_pending`，老闆帶原因可「全部當無薪」覆蓋，audit）。長工糧頁人手輸入 tab 新「病假要你確認醫生紙」面板：逐段顯示日期／連續日數／夠唔夠 4 日／結餘／預計津貼，掣「有醫生紙，確認」「冇醫生紙，當無薪」；病假冇「全部確認」。新 `src/lib/longterm-payroll/sl-confirm.ts`。
- **P17.1** `slSegmentVerdict` 加 `confirmedShortPaid` 參數＋常數 `SL_CONFIRMED_SHORT_PAID`（**預設 true**，老闆決定：確認咗就出，唔理連續幾日）。初版曾因 `gate:ltpay-aug` 由 56/56 變 25 項差異（6 人）而預設 false；查明係 fixture 假設錯（底稿對所有 SL 段一律 `doctorNoteVerified:true`，但 oracle 同銀行對短段冇出），故改 `build-ltpay-aug-fixture.ts`：只對 oracle 出咗津貼（`sl_pay>0` 且連續 ≥4 日）嘅段標已核實，其餘標未核實（段 note 註明）。
- **P17.4** 長工糧「合約」tab：編輯表單日期欄收到 ISO 日期時間（`2026-12-31T00:00:00.000Z`）顯示空白，清唔到結束日 → 現截成 YYYY-MM-DD，清空送 `effective_to: null`；合約新增／編輯／作廢嘅 4xx 錯誤喺表單位置 Banner 顯示（409 `contract_overlap` 列出重疊日期＋「要先結束或作廢另一段」），表單唔關。`src/lib/longterm-payroll/contract-form.ts`。
- **P17.5** 同日 RD／NPL 衝突按每週一日例假（`resolveRdNplConflicts`）。`gate:ltpay-aug`：56 人，Gross 918,488.09／Autopay 882,728.97／MPF EE 35,759.12／MPF ER 35,996.80，對 oracle 舊數只 第 1 人 一人差（gross +612.90、autopay +582.25、MPF EE／ER 各 +30.65），其餘 55 人 0 差異（第 2 人 workDays INFO 照舊），與規劃者預期一致。
- 測試：vitest `p17-sl-confirm`（7）、`p17-4-contract-form`（6）、compute／aggregate 增補；Playwright `p17-sl-confirm`（2）、`p17-4-contract-edit`（2）、`longterm-drafts` 改用頂位草稿。

### 22.2 部署同 8 月重算（2026-10-15）
- merge `6f85188`（§22 員工編號改序號）；部署 `6acf0340`。重算 8 月：8/2 例假個案已吻合；但「已確認短病假照出 4/5」令 5 人（試算底稿一律假設有醫生紙、銀行實際冇出）新增差額，另 1 人（短病假銀行有出但平均工資唔同）差額由 +3,444 變 −3,007。配對 51／吻合 44／差 7。處理：按老闆規則，該 5 段由人手改為「冇醫生紙」（Dispatch 經 UI），之後重算。
## 23 階段 18（2026-10-14）：長工糧更表來源優先次序＋「出勤修正」面板
- **根因**：aggregate 讀 `shift_records` 唔分來源，同人同日 `roster_upload`／`master_roster`／`payroll_only` 紀錄全 union（7/21 同入 NL、RD、AL；7/16 shift＋SL；7/3 SH＋shift），而且更表編輯器只改同 guard／date／shift_type 嗰條，蓋唔過其他來源舊紀錄；另一位長工所有更 settlement 係雞頭（唔係 B07），被當全部頂位更。
- **P18.1**：新 `attendance-priority.ts`（`pickBySourcePriority`）：每人每日只取最高優先來源（`manual` > `roster_upload` > `master_roster` > `payroll_only` > 其他／null）嘅 shift／leave 紀錄；同來源同日多條全計；OT 不受影響；金額公式不變。`attendanceConflictNote` 文案加「已採用：來源 X」。發現 batch API 原本**冇寫 `source`**，故 batch 新建寫 `source="manual"`、更新現存格只喺代號類型改變先改寫 manual（改結算單位唔蓋）；對數套用仍寫 `roster_upload`。
- **P18.2**：新 `GET /api/longterm/attendance-issues`（衝突日＋全歸雞頭長工）、長工糧頁新 tab「出勤修正」（`AttendanceFixPanel.tsx`）：採用代號／設為代號（batch 就地改最高來源紀錄為人手，舊內容留 audit）、歸公司兵（batch 設 B07，按 site 分批）、完成後「要重算本月先反映」＋重算掣、已鎖月唯讀。簽證形式長工唔列入「歸公司兵」。
- **測試**：`tests/p18-attendance-priority.test.ts`（7 條）、`tests/e2e/p18-attendance-fix.spec.ts`（1 條）；`p16b-recon-tweaks` note 斷言同步。
- **驗證**：見最終回報（vitest 隔離 PG 54405；e2e／gate 隔離 PG 54406、`next build`＋`next start` 3178）。已基於 main（含 P17），`gate:ltpay-aug` 為 55/56＋1 已知差異。
- **補充（協調者 2026-10-14）**：(a) `countSlPending()` 對已鎖月份（含「全部當無薪」覆蓋鎖月）回 0 → `sl_drafts_pending` 通知、一鍵結算報告不再提示；首頁收件箱病假卡跳過 `sl-pending` 回 `locked:true` 嘅月份（長工糧頁面板仍可睇）。(b) `POST /api/longterm/inputs/confirm-batch` 遇 `draftSource=roster_leave:SL` 草稿 → 400（提示用 `sl-decision`；鎖月 403 優先）。已 rebase 到 main `6f85188`（含階段 17），所以 `gate:ltpay-aug` 為新基準。
- **驗收修正（Opus 5.5）**：M1 SL 草稿生成／病假待確認清單先跟來源優先次序（連 shift 比較）；M2 面板改用專用 `POST /api/longterm/attendance-fix`（`長工糧:update`，會計可用；`attendance-issues` 回 `can_update` 停用掣）；採用 X 目標已係 X → 改揀代號唔同嗰條、仍無改動回 `noop:true`；來源層級加 `master_roster_only`／`master_roster_site`（＝master_roster）、`payroll`（＝payroll_only）；優先次序改按（保安員, 日, 盤）分組；單條 `POST/PATCH /api/shift-records` 寫 `source=manual`。其餘建議項目只作註明、不改。
- **驗收修正 2**：M4 規則改為 shift 按（日, 盤）、leave 逐日跨盤比較（aggregate／SL 草稿／待確認清單／勤工獎／頂位津貼同一 helper）；M5 勤工獎資格先跟優先次序；M6 `attendance-fix` 補 auto 價卡 journal；(ii)a 頂位津貼先跟優先次序；(ii)b audit `via` 加入 `AUDIT_META_PASSTHROUGH_KEYS`。


### 23.2 驗收、合併（2026-10-15）
- Opus 5.5 四輪：第一輪 M1（SL 草稿未跟來源優先）、M2（會計冇權限）＋(ii)1–4、7；第二輪 M4（按盤分組引入跨盤 leave 錯配）、M5（勤工獎讀全部來源）、M6（attendance-fix 冇 journal auto 卡）＋(ii)a/b；規劃者補規則「最高來源當日只有 leave → 低來源 shift 一律唔計」；第三輪 M7（helper key 冇 guardId → 跨人污染，嚴重）、M8（跨盤衝突冇提示）；第四輪通過（三人 fixture 三處同 aggregate 一致）。留 (ii)：helper `guardId` 改 required；`ignored` 未接線；OT 跨來源唔去重；re-upload 蓋 manual。
- merge（`--no-ff`，P3 doc 衝突兩節並存）；部署見 §23.3。

### 23.3 部署同 7 月套用辦公室答覆（2026-10-15）
- 部署 `6acf304c`。經 `POST /api/longterm/attendance-fix` 套用辦公室 7 條：案 2（7/30–31→SL）、案 3（7/21→SL）、案 5（7/3→SH）、案 6（7/23→SL、7/10→返工）、案 7（7/26→SL）、案 4（7/3 原本冇紀錄→新增 SH 假期紀錄）、案 1（歸公司兵：全月 CP5 更設 B07，21 號 NL、31 號 SL、其餘返工，CP5 IC 更維持頂位）。作廢 8 月（快照）→ 重算 7 月（53 行，autopay 866,587.48）→ 重算 8 月。
- **7 月對數：配對 51／吻合 48／差 3（−1.05、−0.57、+7.09，年假折現／MPF 四捨五入）／系統有銀行冇 2（離職者唔經 autopay）／銀行有系統冇 19（寫字樓員工）。** 7 月已達「全部吻合或有合理解釋」。
- 8 月：等 Dispatch 將 5 段短病假改「冇醫生紙」後重算；預期剩 2 項平均工資差額（等 1–6 月 Payroll Editor）。

### 23.4 8 月第五輪（2026-10-15）
- Dispatch 經 PATCH 將 5 段短病假 `doctor_note_verified=false`（底稿假設、銀行冇出）。重算 8 月（56 行，autopay 891,546.75）。**配對 51／吻合 48／差 3**（全部係 12 個月平均日薪：短病假 10 日 −3,007.42、離職年假 −21.06／−17.31，等 1–6 月 Payroll Editor）／系統有銀行冇 5（離職者唔經 autopay，老闆確認）／銀行有系統冇 28（寫字樓）。8 月除平均工資資料外已全部吻合或有解釋。

### 23.5 辦公室月薪表（Monthly Payroll Google Sheet）導入（2026-10-15）
- 來源：Drive 資料夾「Monthly Payroll」→「Monthly payroll 9月」Google Sheet（tabs 平均工資表／09.2026／09.2026 (2)／08.2026／07.2026…），rclone 匯出 xlsx 至 `data/2026-10/monthly-payroll/`。辦公室 08.2026 vs 銀行 47/47、09.2026 vs 銀行 50/50 全對（＝銀行真相＋組成）。
- 導入：8 月平均工資 45 人、9 月平均工資 46 人；9 月人手項 15（補假日 8、其他津貼 3、勤工獎 1、法定假日工資 1、病假段 2）＋補 1 段；8 月誤加 OT×2＋薪金調整×1（試算底稿 other_allowance 已含）→ 要作廢。
- 作廢 9 月→重算 8 月→重算 9 月。**9 月：配對 50／吻合 46／差 4**（3 項＝年資起點用散工入職日而非長工合約生效日：MPF 首 60 日豁免＋法定假 3 個月 → 階段 19a；1 項＝病假結餘：辦公室出 8 日、系統按累積結餘只出 4 日）。**8 月：45／51**（3 項係誤加輸入待作廢；D2 短病假：辦公室只出 4 日（結餘限制）＋補假日 806.45；兩離職者 ±20 辦公室 08.2026 tab 冇佢哋行）。
- 待辦公室：病假結餘（截至 2026-07-01 已放日數／結餘）同累積口徑；離職者年假折現計法。
## 24 階段 19a（2026-10-14）：長工年資起點統一＝最早長工合約生效日
- **根因**：兩位 9/1 轉長工（`guards.hire_date`＝散工入職日 7/29、8/11）9 月 MPF 僱員供款應 0（新僱傭首月豁免由長工合約起計）但系統用 hire_date 判斷已過 60 日而扣 5%；另一位 2025-03 散工入職、2026-09 轉長工：辦公室扣 9 月法定假（未滿 3 個月）同 MPF 0，系統用 hire_date 唔扣假又扣 MPF。
- **改動**：`aggregate.ts` 新年資起點＝最早一段未作廢長工合約 `effectiveFrom`（`firstContractByGuard`），fallback `guards.hire_date`；MPF 僱員供款豁免（`computeMpf` 嘅 `hireDate`）同法定假 `after_3_months` 3 個月規則（`computeShDeduction`）都改用呢個起點；年假 entitlement 原本已經係。起點同 hire_date 唔同時 notes 加「年資起點：長工合約 YYYY-MM-DD（散工段唔計）」。其他公式、API、schema 不變。
- **測試**：`tests/p19a-seniority-start.test.ts`（4 條：散工轉長工 MPF 0＋法定假扣、合約＝入職日不變、2025 散工轉長工、8 月不變）。`docs/ops.md` 加「年資起點」規則表。
- **P19a 修正**（Opus 驗收 (ii)）：年資起點由「最早一段」改為「現行連續合約鏈第一段」（斷開＝離職再入職，由中斷後第一段計；前段 effectiveTo 同後段 effectiveFrom ≤1 日當連續），新 `continuousChainStart()`；年假 entitlement 同口徑。合約日早過 hire_date 加 warning；note 只喺合約日遲過 hire_date 出。測試補 (e)、E2、連續轉約、helper 單元。

### 24.2 驗收、合併（2026-10-16）
- Opus 5.5 兩輪：第一輪通過但 (ii)-1 中斷再入職起點要拍板——銀行實證（8/1 再入職者 8 月 MPF 0）→ 規劃者決定「現行連續合約鏈起點」；第二輪 code 通過（三段鏈、中斷兩次、相差 1 日、年假同口徑、gate 不變），文件字眼由規劃者改正。留 (ii)：再入職要清離職日（ops 文件寫明）、重疊合約異常資料、月中中斷、年假結餘唔分鏈（舊行為，待老闆）。

### 24.3 部署同重算（2026-10-16）
- 部署 `6acf6001`。作廢 9 月→重算 8 月（autopay 892,475.76）→重算 9 月（851,139.10）。
- **9 月：配對 50／吻合 49／差 1**（病假結餘：辦公室出 8 日、系統累積結餘只出 4 日）／系統有銀行冇 2（離職者）／銀行有系統冇 20（寫字樓）。
- **8 月：配對 51／吻合 48／差 3**（D2 病假結餘 −3,936.43（含已加補假日 806.45）、兩離職者 −21.06／−17.31 待辦公室離職結算口徑）。
- 7 月維持 48／51（四捨五入）。三個月剩餘差異全部等辦公室兩條資料：病假結餘（截至 7/1 已放／結餘＋累積口徑）、離職結算計法。

### 24.4 P19b 離職月結算：平均工資（ADW）自動計＋導航卡（2026-10-15，branch `p19b-leaver-adw`，未 merge）
- **背景**：辦公室「終止僱傭合約薪酬計算表」公式同系統規則 9 完全一致，唯一差異係年假補償平均工資——系統冇 `guard_avg_wages` 就 fallback 月薪÷當月日數（8 月兩位離職者因此差 +17.31／+21.06）。
- **改動**：新 `adw.ts`（純函數 `computeEoAdw`／`resolveAlDailyRate`）＋`adw-history.ts`（由歷史 `longterm_payroll_lines` 砌每月工資同不獲全薪日子）；aggregate 離職分支按 人手金額 ＞ guard_avg_wages ＞ EO（期間完整）＞ 月薪÷日數 揀；歷史唔齊維持現行數（8 月 oracle 不變）。additive 欄 `al_daily_rate_basis`／`al_adw_json`；`GET /api/longterm/leaver-adw`；長工糧頁頂 `LeaverAdwCard`；鎖月／一鍵結算 precheck 加警告（唔阻）。
- **保守取捨（簡報冇講清）**：①Prisma client 唔重生（簡報禁 prisma generate）→ 新欄用原生 SQL 讀寫，schema.prisma 同步加欄；②歷史月份不獲全薪日子＝糧線 `npl_days`＋病假日（更表 SL 日同 `npsl_days` 取大）＋無薪法定假日（npsh 扣款÷合約日薪近似）；③人手扣款加返入工資（唔當不獲全薪日子）；④期間邊界月按日比例攤；⑤日薪制長工唔做 EO；⑥補入缺失月份用現行合約月薪；⑦手動金額 basis＝`manual_amount`；⑧每月只取最新未作廢 run 嘅糧線。
- **測試**：`tests/p19b-leaver-adw.test.ts`（15 條：公式結構兩例、四層優先次序、EO 計算含不獲全薪日／12 個月截斷／服務期短／邊界月／歷史唔齊、aggregate 接入、卡出現／消失、precheck warning）、`tests/e2e/p19b-leaver-adw.spec.ts`（3 條：卡、輸入儲存、手機 375px、消失）。

### 24.5 P19b.4 平均工資口徑（勞工處定義，2026-10-15 老闆拍板）
- 津貼一律計入；加班費有條件計入（期內每個有糧線月份都有 OT，或每月平均 OT ≥ 同期每月平均工資（不含 OT）20% → 全部計入，否則全部剔除）；不獲全薪日子連工資剔走（維持）。`adw.ts` `evaluateOtRule()`；`al_adw_json.otRule` additive；備註一句講明。測試 `tests/p19b-leaver-adw.test.ts` 加 7 條（OT 每月都有／部分月 ≥20%／<20%／無 OT／制服津貼／恰好 20%／aggregate 寫入）。詳見 `docs/ops.md`「平均工資口徑」。
- **P19b.5（Opus 複檢）**：`evaluateOtRule` 按每月 factor（期間內日子比例，邊界月攤分）加權 OT 同不含 OT 工資，平均用期間月數（期間日數÷(365/12)）；固定性質＝期內有糧線月份全部 OT>0 且至少 2 個月（只有 1 個月唔判固定，仍可按 20%——**規劃者保守取捨，待老闆確認**）；OT 負數當 0；不含 OT 工資 ≤0 時 ratio=null（備註「無法計算比率」）。

## 25 OCR-5／OCR-4（2026-10-15，基於 `docs/plans/ocr-accuracy-plan.md` §2；branch `ocr54-eval-candidates`，未 merge）

執行：Sonnet 5.5（`claude-sonnet-5-5`）。範圍：路徑 A（證件新增保安員）＋路徑 B 共用排序；OCR-1／2／3 未動。全程只用合成 fixture／fake client，冇讀 `data/` 內容、`.env`、冇 PII；圖片同辨識值冇落地（audit 只加 `arbiter_calls` 數量）。

### 25.1 OCR-5 評估腳本
- `scripts/staff-import/eval-ocr.ts`（CLI）＋`lib/eval-ocr-core.ts`（比較／報表／重試／並行／fake client）＋`lib/eval-ocr-images.ts`（Node 出圖）。用法見 `docs/ops.md`「OCR 準確度評估」。`--manifest`／`--out`（限 `data/` 之下）／`--dry`／`--limit`／`--only-doc-type`／`--concurrency`（預設 2）；失敗重試 1 次；逐 case 進度只印 `n/總數`。
- 同一條應用內路徑：圖片規格抽到 `src/lib/guards/ocr/image-plan.ts`（來源 ≤2,400px → 全圖 ≤1,600px、2×2 分格 0.6／≤1,000px、JPEG 質素梯級至 ≤900,000 字元），`browser-images.ts` 改用同一份（`tileRects` 照舊由 browser-images re-export）；Node 端用 ImageMagick（同其他 staff-import 腳本）；然後 `getReadClients()`（真 client）→ `readDocument` → 逐欄對 truth（`normalizeField` canon）。
- 輸出：`exact`／`review_contains_truth`／`wrong`（另計 confirmed 但錯）／`missing` 計數＋百分比（整體、按欄、按 doc.field）、review 率、review 欄平均候選數、估算人手改字（wrong＋missing）、估算撳候選、calls／tokens／按供應商／仲裁文件數。console 同 JSON 冇欄位值、姓名、圖片路徑；per-case 只有 id＋結果類別。
- fixture：`tests/fixtures/ocr-eval/`（3 張合成圖＋`manifest.dry.json` 6 個 case：完美、alternatives 含 truth、仲裁 2/3、錯值＋缺值、check digit 排序、地址形近字）。`--dry` 固定結果：6/6 case、13 欄、exact 9（69.2%）／review_contains_truth 2（15.4%）／wrong 1（7.7%，confirmed 錯 0）／missing 1（7.7%）、仲裁 3 份。

### 25.2 OCR-4 候選字＋雙模型共識（逐點）
1. **輸出結構 additive**：每欄舊純字串或 `{value, confidence, reason?, alternatives?(≤2)}`；`field-read.ts` zod 兩種都收（未知 confidence／reason 當冇寫，缺 `value` 先算格式錯）；`ocrJsonSchema` 每欄 object（全 required、禁多餘 key）；DeepSeek `json_object` 靠 prompt 說明；prompt 規則 2 改為「盡量出部分值＋confidence＋alternatives，仍唔准猜無根據嘅字」，規則 1 保留。
2. **`reconcile` 升級**（移到 `reconcile.ts`，`rank.ts` 係排序核心）：候選池＝讀 A、讀 B、各自 alternatives、仲裁值（去重、≤4）；分數＝格式驗證基礎分（HKID check digit、電話 8 位首位 2–9、日期曆法＋年齡、中文姓名純中文／簡體疑似、地址長度／中文字／門牌標記）＋每多一個獨立讀數同意 +5＋仲裁 +3；同分 confidence high 優先、再讀 A 優先；輸出 `candidates_ranked:{value,sources,score,reason}[]`，舊 `candidates:string[]` 保留；`value`＝最高分候選；兩讀一致且 valid 先 confirmed（不變）。
3. **第三讀仲裁**（`GUARD_OCR_ARBITER`，預設開）：見 `docs/api.md` 同 `docs/ops.md`。規則：兩讀正規化後唔同且兩讀 confidence 都唔係 high（舊格式冇 confidence＝唔係 high）→ Claude 對該份文件一次過問所有分歧欄；仲裁值同其中一讀一致**且 valid** → confirmed（`arbiter: agree_a|agree_b`）；否則入候選池加權、仍 review。仲裁出錯唔影響主流程；用量計入 `usage`／`usage_by_provider`；audit 多 `arbiter_calls`。
4. **UI**：review 欄候選 chip（≤4、一撳套用、`aria-pressed`）；中文姓名／地址候選只差 1–2 字時高亮分歧字（純函數 `diffChars`／`isCloseVariant`／`candidateChips`，`review-state.ts`）；套用後 `ackAfterEdit` 不變（關鍵欄仍要「對過證件，啱」）；舊 server 回應（冇 `candidates_ranked`）用 `candidates`。375px 實測 chip 喺視窗內、冇橫向捲動。
5. **路徑 B**：`fields-ext.ts` `Cand` 加 optional `confidence`／`alternatives`，`resolveField` 在 `sources_disagree` 時多出 `candidates_ranked`（同一個 `rankPool`）；確認規則完全不變。
6. **測試**：`tests/ocr4-rank-reconcile.test.ts`（47：排序每種欄位 ≥3 case 含 check digit、reconcile 候選池／舊格式／仲裁規則、zod 兩格式、schema／prompt、diffChars／chip、路徑 B）、`tests/ocr4-arbiter.test.ts`（17：觸發／唔觸發／high 跳過／一次過／上限 1 次／出錯／用量／開關／route 新舊格式＋audit 無值）、`tests/ocr5-eval.test.ts`（26）、`tests/e2e/ocr-candidates.spec.ts`（3：撳 chip、舊格式、手機 375）；既有 `guard-ocr*.test.ts` 只改 parse／schema 斷言及 import。

### 25.3 保守取捨（簡報冇講清）
- 仲裁圖＝全圖＋全部放大格（路徑 A 冇欄位位置資訊，無法揀「相關格」）；prompt 只列分歧欄。
- 仲裁只喺讀 A 係 Claude（冇退回 DeepSeek）時用；測試 override 只有自報 `provider:"claude"` 嘅 fake 先有仲裁，其他 fake 行為同舊版（2 次呼叫）。
- 2/3 一致 confirmed 係簡報明文規則；但仲裁同讀 A 同樣係 Claude，並非完全獨立證據——關鍵欄（姓名／身份證號／出生日期）仍然要人撳「對過證件」，唔受影響。
- `value` 預填由「永遠讀 A」改為「最高分候選」（簡報要求）；`candidates` 次序可能同舊版唔同（格式啱嗰個排前），其餘語意不變。
- Node 出圖用 ImageMagick／pdftoppm（repo 慣例、已有腳本用），冇引入 `sharp`／`canvas` 依賴（兩者都只係 transitive）。
- truth 嘅 `bank_account` 路徑 A 唔讀，評估時略過並喺報表 notes 標明。

### 25.4 驗證
- vitest（隔離 PG 54415）**264 檔，3,913 passed｜0 failed**（基線 261 檔／3,823；新增 3 檔 90 條）；tsc 0；lint 0；knip 0（只有既有 configuration hints）；`rm -rf .next` 後 build 過。
- Playwright 全套（隔離 PG 54416、`next build`＋`next start` 3182、`AI_LLM=fake`、`SCHEDULER_ENABLED=0`，跑前 `db:reset`＋`db:seed`）**258 passed｜4 skipped（原有）｜0 failed**（含新 `ocr-candidates.spec.ts` 3 條）。
- `gate:locked-months`（隔離 dev PG 54416，需 `SESSION_SECRET` 已設）**12/12 rc=0**；`gate:ltpay-aug` 56 人 Gross 918,488.09／Autopay 882,728.97／MPF EE 35,759.12／ER 35,996.80，**55/56 吻合＋1 已知差異**（同 P17.5 數字逐個相同）——OCR 路徑獨立，不受影響。

### 25.6 OCR-4.4 仲裁觸發放寬＋形近字分歧入仲裁＋schema 實測（branch `ocr44-arbiter-trigger`，起點 main `08b6ca0`，未 merge）
執行：Sonnet 5.5（`claude-sonnet-5-5`）。背景：真檔評估入職表電話預填值啱 28/36 但只 13 份 confirmed——讀 A（Claude，有 box／refs）多數自報 high，舊條件「兩讀都唔係 high」令仲裁幾乎唔觸發。
- `read.ts` `disputedFields`：兩讀正規化後唔同，**除非兩讀 confidence 都係 high** 先仲裁（A high/B high 唔觸發；high/medium、medium/high、low/low、high/low 觸發）；每份文件最多 1 次、`GUARD_OCR_ARBITER`、「仲裁值同其中一讀 strict 一致且 valid 先 confirmed」全部不變。
- Opus N7：地址欄分歧用 strict 比較（只差形近／簡繁字都入仲裁）。`reconcile.ts` 地址「canon 一致但 strict 唔同」分支原本唔睇仲裁值（OCR-2.2 S1），放寬後仲裁會白叫——該分支加：冇糾錯建議（`edits` 空）且仲裁值 valid、同其中一讀 strict 一致 → confirmed（`arbiter: agree_a|agree_b`）；有糾錯建議仍 review。
- `scripts/staff-import/ocr-schema-smoke.ts`＋`docs/ops.md`「真 API schema 實測」：合成圖三種文件類型各打真 Claude stage A 一次，斷言 200／冇後備／解析成功。
- `eval --dry` 數字（取代 §28.6）：已評估 13 欄、exact **10（76.9%）**、review_contains_truth **1（7.7%）**、wrong 1（confirmed 錯 0）、missing 1；review 率 15.4%；仲裁文件 2→**4**；ALS 查過文件 1。
- 測試：`tests/ocr4-arbiter.test.ts` 觸發矩陣（hh／hm／mh／ll／hl、一致唔觸發）、地址 strict 分歧入仲裁＋agree_b、strict 一致唔觸發；`tests/ocr5-eval.test.ts` dry 數字更新。

### 25.7 驗收修正（OCR-4.5，Opus 5.5：M1／N1）
- **M1**：`reconcile.ts` 地址「canon 一致但 strict 唔同」分支，仲裁 agree 只喺仲裁值係標準寫法（`variantCharCount(仲裁值) ≤ 另一讀`）先 confirmed；2/3 同意嘅係變體字（厦）寫法 → 維持 review（`address_variant_chars`，`arbiter` 標籤保留、標準寫法排前；仲裁加權後以變體字數穩定重排，確保預填係標準寫法）。
- **N1**：形近字 test 補 status／reason 斷言；加 M1 正反兩個 case（仲裁「大廈」→ confirmed agree_b；仲裁「大厦」→ review agree_a，預填「大廈」）。

### 25.8 OCR-5.6 DeepSeek 讀 B 輸出上限（branch `ocr56-deepseek-budget`，起點 main `927d5b8`，未 merge）

- **根因**：`deepseek-flash`（V4.1）係思考模型，思考 token 計入 `max_tokens`；舊上限 1,500 令入職表讀 B（5 欄裁圖）思考用晒 → content 空、`finish_reason=length` → `parse_ok.b=false` → 每欄 `one_read_unclear`（review，唔會仲裁）。規劃者實測上限 4,000 後 4 份入職表 B 全部解析成功。
- **改動**：`config.ts` 舊 `OCR_MAX_OUTPUT_TOKENS`（1500，只有 DeepSeek 用）改為 `OCR_MAX_OUTPUT_TOKENS_DEEPSEEK=4000`（env `GUARD_OCR_DEEPSEEK_MAX_TOKENS` 覆蓋，≤8,000）；Claude 路徑一直用 `OCR_CLAUDE_MAX_OUTPUT_TOKENS=8000` 不變（簡報「CLAUDE=1500」冇對應用途，唔另設死常數）。DeepSeek 請求加 `reasoning_effort`（預設 `low`；env `GUARD_OCR_DEEPSEEK_REASONING=low|high|max|off`，`off`＝`thinking:{type:"disabled"}`）。
- **防守**：讀 B 同仲裁回應 `truncated` 且 content 空 → 自動重試一次，`max_tokens` 加倍（上限 8,000，`VisionRequest.maxTokens`）；仍失敗當 parse 失敗；兩次呼叫 usage 都計；audit `guard_ocr_read` 加淨計數 `b_retry_truncated`；`DocumentReadResult.b_retry_truncated`（additive）。
- **真 API 實測**（`ocr-schema-smoke.ts` 加 DeepSeek 段，有 `DEEPSEEK_API_KEY` 先跑）：`reasoning_effort:"low"` 同 `response_format json_object` 相容；身份證／住址證明／入職表（5 圖）三次 content 非空、JSON 合法、未撞頂（6/6 通過）。low 對準確度影響留規劃者用真檔評估。

## 26 OCR-3（2026-10-15，基於 `docs/plans/ocr-accuracy-plan.md` §1 問題 3／§2 OCR-3 及老闆硬性要求；branch `ocr3-field-crops`，未 merge）

執行：Sonnet 5.5（`claude-sonnet-5-5`）。起點 main `e269099`（OCR-5／OCR-4 已合併）。範圍：路徑 A 兩段式讀＋欄位級裁圖、分格線防呆、路徑 B 外擴與戶口位數；OCR-1／2 未動。全程只用合成 fixture／fake client，冇讀 `data/` 內容、`.env`、冇 PII；圖片同辨識值冇落地（audit 只加計數）。

### 26.1 老闆硬性要求（欄位級裁圖）
入職表放大圖由「固定 2×2 格」改為**欄位級裁圖**：電話、地址各一張，**完整包住欄位格（印刷 label＋手寫內容）**，按讀 A 回報嘅欄位 box 裁，長邊 ≤1,000px（細過就放大，最多 2×），由 2,400px 來源圖（`SOURCE_MAX_EDGE`）裁出；2×2 格只係後備（無有效 box／任何一步失敗）。日後姓名／HKID／出生日期喺 `OCR_CROP_FIELDS` 加欄即可。

### 26.2 逐點
1. **`read.ts` 兩段式**：`readStageA(clients,type,full)`（全圖 1 張；入職表要求 `field_boxes`，退回 DeepSeek／解析失敗＝冇 box）→ `StageAResult{a_fields_raw, field_boxes, usage, provider, model, fallback_reason, parse_ok}`；`readStageB(clients,type,stageA,imagesB{kind,images,fieldOf?,full?})` → 讀 B＋reconcile＋仲裁 → `DocumentReadResult`（加 `images_b_kind`、`field_boxes_used`）。`readDocument` 行為不變（A、B 仍同時發出；內部共用 `finishRead`），現有 tests 不變。
2. **幾何 `src/lib/guards/ocr/field-crops.ts`**（純函數，browser／Node 共用）：`sanitizeBox`（0≤x,y；x+w≤1、y+h≤1；面積 0.3%–60%；w≥3%、h≥1.5%）、`padBox`（上下 1.2×h、左右 0.6×h、最少 3% 圖邊；越入鄰欄 box 唔超過該鄰欄高度 20%；clamp 到圖內；唔縮入原 box）、`cropOutSize`、`planFieldCrops`（所有裁圖欄位都有有效 box 先 `field_crops`，否則 `tiles`；≤4 張）。Node 評估腳本 `cropFields` 同瀏覽器 `cropFieldsFromCanvas` 都只負責「按計劃裁」，幾何由同一函數算（測試核對輸出尺寸一致）。
3. **API**（additive，詳見 `docs/api.md`）：`stage:"a"`→`documents[].{field_boxes, continuation}`；`stage:"b"`→同舊格式 `fields`＋`images_b_kind`。`continuation`＝HMAC-SHA256（`SESSION_SECRET` 經固定 label 衍生）簽名 base64url JSON（讀 A 原始讀數＋box＋type＋iat），10 分鐘、綁用戶、單次使用、≤64k；伺服器唔存 state；驗簽／過期失敗＝400 固定字串。audit 只加計數（`stage`、`boxes`、`field_crops_docs`、`fallback_tiles_docs`）。
4. **瀏覽器**：`PreparedImage.source` 保留 2,400px 來源 canvas；`two-stage.ts`（純邏輯）`readTwoStage`：stage a → `planFieldCrops` → 裁 → stage b；任何一步失敗回 `{ok:false}`，`NewFromDocsClient` 退回舊單次流程。review 面板細字「放大圖：欄位級／後備格」（`data-testid=ocr-b-kind`，唔含值）。
5. **讀 B prompt（field_crops）**：「第 n 張係電話欄，含印刷 label 同手寫內容」，只抄該欄；仲裁（欄位級）＝全圖＋分歧欄對應裁圖。
6. **分格線防呆**：prompt（只喺有電話欄嘅文件）加「分格線唔係數字 1；電話 8 位；9–10 位請重數；戶口按格數」＋`digit_count`（Claude schema 電話欄 required，`field-read.ts` 解析）；`normalize.ts` `phoneGridlineCandidates`（9 位剔 1 個、10 位剔 2 個 1，首位 2–9，唯一或 ≤2 個解）→ reason `phone_gridline_suspect`、`extra`；`reconcile` 入候選池（source `_grid`）、`rank.ts` 配合（基礎分 20，剔走後 100）；**唔自動 confirmed**。UI `REASON_MSG` 加說明。
7. **路徑 B**：新 `scripts/staff-import/lib/crop-pad.ts`（`padAround`：行高比例外擴＋唔越過上下／同行左右 label 行＋`pad` 參數）；`phone-crop.ts`／`form-address-crop.ts`／`crop-box.ts`（姓名、地址 block、出生日期、姓名第二套）改用；新 `hkicl-digits.ts`（匯豐 9／12、中銀 12／14、恒生 9——計劃書 §1 3.6 列明嗰幾間）＋`fields-ext.acctDigitsReason`／`acctValidate`，`15-fields-merge.ts` 戶口位數唔啱 → review `acct_digits_mismatch`（`normAcct` 本身行為不變）。
8. **評估腳本**：`eval-ocr.ts --flow legacy|two-stage`（預設 two-stage）；報表／console 加 `flow`、`field_crops_docs`、`fallback_tiles_docs`；`--dry` fake 可帶 `boxes`；新 fixture `manifest.dry-crops.json`（4 case：明確 box、地址 box 缺失、不合格 box、身份證）。dry 結果：two-stage 欄位級裁圖文件 1、後備 2×2 格文件 2；legacy 全 0。

### 26.3 保守取捨（簡報冇講清）
- **欄位級裁圖 all-or-nothing**：該文件類型所有裁圖欄位（入職表＝電話＋地址）都有有效 box 先用；只得一欄有 box → 整份退回 2×2 格（避免 B prompt 同圖片混合）。身份證／住址證明冇欄位級設計（印刷體，2×2 格照舊），故唔計入 `fallback_tiles_docs`。
- **stage b 多收 optional `full`**（簡報冇列）：仲裁需要全圖；冇 `full` 就唔仲裁。client 會傳。
- **continuation 加 userId 綁定＋單次使用（process 內 nonce）**：簡報只要求簽名＋10 分鐘；多實例下單次使用盡力而為。stage b 唔另外預留配額；stage b 失敗後退回舊流程會計 2 次預留。
- **`digit_count` 目前只解析、保留，未參與排序**（保守；確認有用後再加）。
- **9–10 位解多於 2 個＝唔出候選**（太不確定），照舊 `phone_not_hk`。
- **HKICL 位數表只收計劃書列明嘅 3 間**（匯豐／中銀／恒生）；表外銀行唔檢查。數字出自計劃書，**需要規劃者核實並補齊**。
- **路徑 B 既有 tests 邊界調整**：`staff-import-a6` 範本 B 地址 `y1` 上限 0.66 → 0.68（variant b 外擴最少 0.042）。`crop-box` 嘅 card／page 後備框（整張卡／成頁）冇欄位行高可比例，保持不變。
- 外擴「唔越過下一個 label 行」嘅 label 判斷＝非數字為主嘅文字行（`isLabelLine`：數字 ≤2 個、≤40 字、含中英文），避免手寫數字行被當界線。
- Worktree 環境：共用 `node_modules` 嘅 Prisma client 過時（缺新表），改用 `cp -c`（APFS clone）自 `zoi-kan-wt-ocr54` 嘅完整 `node_modules`（冇 `prisma generate`）；e2e seed 需要 `data/`、`tools/importer/out`，以 symlink 指向主 repo（只供 seed 腳本讀，我冇讀內容）。

### 26.4 驗證
- vitest（隔離 PG；因 dev PG 佔住 54418，全套用 54419）**265 檔，3,972 passed｜0 failed**（基線 264 檔／3,913；新增 `tests/ocr3-field-crops.test.ts` 56 條：box sanity、padBox 邊界／clamp／鄰欄／最少 3%、cropOutSize、planFieldCrops、continuation 簽名／過期／篡改／別人／重用、readStageA／B、stage a／b route〔含 audit 無值〕、後備、電話 9–10 位候選、戶口位數、路徑 B 外擴、`readTwoStage`、Node 裁圖幾何、`--flow`）；tsc 0；lint 0；knip 0（只有既有 configuration hints）；`rm -rf .next` 後 build 過。
- Playwright 全套（隔離 dev PG 54418、`next build`＋`next start` 3184、`AI_LLM=fake`、`SCHEDULER_ENABLED=0`，跑前 `db:reset`＋`db:seed`）**262 passed｜4 skipped（原有）｜0 failed**（新 `ocr-two-stage.spec.ts` 4 條：欄位級裁圖〔電話／地址各一張、≤1,000px、field_of、身份證仍 tiles〕、box 缺失後備、stage b 400 退回舊流程、手機 375px；既有 `ocr-candidates.spec.ts` 3 條照過）。
- `gate:locked-months`（隔離 dev PG 54418）12 步：除 `gate-ltpay-aug`（rc=1＝其已知 harness 差異，見下）外 11 步 rc=0；`gate:ltpay-aug` 56 人 Gross 918,488.09／Autopay 882,728.97／MPF EE 35,759.12／ER 35,996.80，**金額 55/56 吻合＋1 已知差異**（1 人金額欄＋1 人 workDays INFO）——數字同 §25.4 逐個相同，OCR 路徑獨立，不受影響。

### 26.5 驗收修正（OCR-3.6，Opus 5.5：M0／S3／N7）
- S1：`padBox` 鄰欄分類改為「同自己垂直重疊 <20%（較矮者高度計）＝上／下鄰欄，否則左右鄰欄」，並排嘅電話／地址上下外擴仍係完整 1.2×h（新 test）。
- S2：`HKICL_ACCT_DIGITS` 清空（各來源戶口位數口徑不一，開檢查會造大量假 review）；函數與 unknown_bank 路徑保留，待戶口格式正規化後再填。
- S3：兩段式只用於入職表。stage a 收到身份證／住址證明（須帶 tiles）→ 伺服器 A＋B(2×2) 並行讀完回 `final:true`＋`fields`，唔發 continuation；client 對呢類文件唔打 stage b。
- N2：stage a／b 收到 429／503 唔退回舊流程，直接顯示錯誤；其他失敗（網絡、400）照退回。
- N4：2,400px 來源 canvas 只保留入職表 slot，其他 slot 出完 full／tiles 即釋放（寬高設 0）。
- 驗證：vitest 265 檔 3,978 passed｜0 failed；tsc／lint／knip 0；Playwright（ocr-two-stage 5、ocr-candidates 3、reconcile-ui、guard-fix、p3-5-guards-page）通過。

## 27 OCR-1（2026-10-15，基於 `docs/plans/ocr-accuracy-plan.md` §1 問題 1／§2 OCR-1／§3 決定 3；branch `ocr1-cross-doc`，起點 main `c65a382`，未 merge）

執行：Sonnet 5.5（`claude-sonnet-5-5`）。範圍：路徑 A 跨文件上下文（印刷證件已核實值注入入職表讀 A）＋入職表加讀姓名／HKID／出生日期交叉核對；路徑 B `printed` 來源。OCR-2 未動。全程只用合成 fixture／fake client，冇讀 `data/` 內容、`.env`、冇 PII；圖片、讀值、refs 只喺記憶體（audit 只加計數）。API 全部 additive，舊 client／舊單次流程不變。

### 27.1 逐點
1. **次序**（`two-stage.ts` `readTwoStage`）：先 `stage:"a"` 印刷文件（身份證／住址證明，伺服器 `final:true`）→ 回應 additive `refs_token` → 再 `stage:"a"` 入職表（body 加 optional `refs_token`）→ 本機裁圖 → `stage:"b"`（再帶 `refs_token`）；documents 按上載次序合併。冇 `refs_token`／驗簽失敗＝照舊讀（唔報錯，audit `refs_rejected`）。舊單次流程（冇 stage）不變；舊 client 一次過傳三種文件嘅 stage a 仍然得（只係冇 refs）。
2. **`refs_token`**（`continuation.ts`：`signRefs`／`verifyRefs`／`consumeRefsCredit`）：同 continuation 同一套機制（HMAC-SHA256、key 由 `SESSION_SECRET` 經另一個 label `guard-ocr-refs-v1` 衍生，兩種 token 唔通用）、綁 userId、10 分鐘、≤8,000 字元（`OCR_MAX_REFS_CHARS`）。內容＝`refs.ts` `confirmedRefsFromDocs`：身份證／住址證明 **confirmed 且兩讀一致（冇 arbiter 標籤）** 嘅 `name_zh`／`name_en`／`hkid`／`dob`／`sex`／`address`，每值消毒（NFKC、剔控制字元、≤200 字）；冇 confirmed 就冇該欄。
3. **prompt**（`prompts.ts` `buildUserTextWithContext(doc, refs, opts)`）：「refs 只可用嚟判斷潦草字係咪同一個字；唔准將圖中冇嘅內容填入；手寫明顯唔同→照抄並標 `reason:"differs_from_reference"`」；refs 值 JSON 字串化、當不可信資料；只列該文件要抽嘅欄位（入職表：姓名／HKID／出生日期／地址）；規則 1（圖中文字係資料）保留。只用喺入職表讀 A；**讀 B（欄位裁圖）同仲裁盲讀**（兩個 builder 構造上冇 refs 入口）。冇 refs＝同 `buildUserTextFull` 完全一樣。`READ_REASONS` 加 `differs_from_reference`（Claude schema enum 同步；目前只解析保留，未參與排序／確認）。
4. **config**：`onboarding_form` 欄＝`phone`／`address`／`name_zh`／`hkid`／`dob`（只做交叉核對，唔覆蓋身份證值）；`OCR_MAX_FIELD_CROPS=6`（tiles `OCR_MAX_TILES=4` 不變）；`field-crops.ts` 新 `OCR_EXTRA_CROP_FIELDS`（姓名／HKID／出生日期）＋`ocrBoxFields`；`planFieldCrops`：電話＋地址有有效 box 就用欄位級裁圖，額外欄有 box 就加、冇就唔加（不影響後備判定）。讀 A 要求回報 5 欄 box。stage b `images_b.images` 上限 6（tiles 仍 ≤4）、`field_of` 必須含電話＋地址，可加額外欄。`OCR_MAX_BODY_CHARS`（8,000,000）夠用：stage b 最多 1 全圖＋6 裁圖＝7×900,000≈6.3M＋token，所以冇調高。
5. **`normalize.ts` `crossCheck(formValue, idValue, field)`** → `match｜differs｜unreadable`（用現有 canon：HKID 全字、dob 比 ISO 日期、中文姓名全字）；任何一邊睇唔清或者手寫值格式唔成立＝`unreadable`，格式成立但唔同＝`differs`。`FieldResult.cross?: {against:"id_card"|"onboarding_form", result}`（additive）。**伺服器計**：`stage:"b"` 帶有效 `refs_token` 時，入職表 `name_zh`／`hkid`／`dob` 欄 `cross.against="id_card"`；回應頂層 additive `id_cross`（`against:"onboarding_form"`），client 併入身份證各欄。冇 refs＝冇 cross。
6. **UI**（`review-state.ts`／`NewFromDocsClient.tsx`）：身份證三個關鍵欄下面顯示「入職表手寫（唯讀）：…　同身份證一致 ✓／⚠ 同身份證唔一致，請對住證件再確認／手寫讀唔到，未能交叉核對」（`data-testid=ocr-cross-{k}`，`data-result`）；⚠ 欄 ack 掣改為「對過證件，以證件為準」，`ackAfterEdit(k, status, value, cross?)` 第 4 參數 optional：`differs` 嘅關鍵欄打字／改值都唔自動算確認；`reviewProblems` 專屬訊息「…同入職表手寫唔一致，要對過證件確認」。手機 375px 實測冇橫向捲動。
7. **路徑 B**：`crosscheck.ts` 加 `printedRefCmp(ex)`（同一文件包印刷身份證抽取值 `ex.hkid/nameZh/nameEn/address` 對申請表手寫抽取值 `ex.aux.form*`）；`crosscheck(…, opts:{printed?:true})` 令 `cmp[f].printed` 出現，且 printed 有明確結果（match／mismatch）時 `status[f]` 以佢為準（優先於 U Team／Maxwell／DB 打字名單）；預設關＝舊行為完全不變，`03-crosscheck.ts` 已開。`fields-ext` `SrcKind` 加 `printed_ref`、`evidenceClass` 獨立類別（同手寫讀數／打字名單各算獨立證據）。
8. **評估腳本**：`eval-ocr.ts` two-stage 次序同 client 一致（印刷→refs→入職表）；報表／console 加 `refs_enabled`、`refs_injected_docs`、`cross{match,differs,unreadable}`；`--no-refs`；`by_doc_field` 自然多 `onboarding_form.name_zh/hkid/dob`。新 fixture `tests/fixtures/ocr-eval/manifest.dry-refs.json`（6 case：全 confirmed 注入、身份證兩讀唔同＋仲裁都唔同→唔注入、仲裁 2/3 確認→唔注入、入職表 HKID differs、出生日期 unreadable、身份證全讀唔到→冇 refs）。dry 結果：已評估欄位 60、注入 refs 入職表文件 5、cross match 11／differs 1／unreadable 1；`--no-refs` 全 0；原 `manifest.dry.json` 因入職表多 3 欄由 13 欄變 16 欄（exact 12／review_contains_truth 2／wrong 1，confirmed 錯 0／missing 1／仲裁 3，另 cross match 3）。
9. **配額**：新流程有兩次 stage a。有效 `refs_token` 令「只含入職表」嘅 stage a 免再預留（credit 單次使用，process 內記 nonce；多實例盡力而為）→ 同一次辨識仍計 1 次；token 無效／已用過就照常預留。
10. **audit**（淨計數）：stage a 加 `refs_issued`／`refs_injected_docs`／`refs_rejected`；stage b 加 `refs_rejected`、`cross{match,differs,unreadable}`；冇值、冇 token（測試核對 audit JSON 不含任何姓名／HKID／日期／token 片段）。

### 27.2 保守取捨（簡報冇講清）
- **只收「兩讀一致」嘅 confirmed**：身份證靠第三讀仲裁 2/3 確認（`arbiter` 標籤）嘅欄**唔**注入（仲裁同讀 A 同為 Claude，並非完全獨立）。
- **cross 只用入職表 confirmed 值**：入職表欄 review／missing＝`unreadable`。理由：讀 A 睇過 refs、讀 B 盲讀，兩讀唔一致就唔可以話「一致 ✓」（避免讀 A 迎合 refs 嘅假一致）；`differs` 只喺兩讀一致仍然同身份證唔同、而且兩邊格式都成立時先出。
- **cross 放 stage b 伺服器端計**（簡報揀定）；身份證側經回應頂層 `id_cross` 帶返 client 併入（stage b 回應本身唔含身份證文件）。
- **配額 credit**：簡報冇講第二次 stage a 點計，揀「refs_token 抵銷一次預留（單次）」，令一次辨識仍計 1 次。
- **refs 只列該文件要抽嘅欄位**（`name_en`／`sex` 唔送入職表 prompt），減少多送個人資料。
- **`differs_from_reference` 只解析、保留，未參與任何確認／排序**。
- **額外裁圖欄非 all-or-nothing**（簡報明文）；`field_of` 校驗收緊：必須含電話＋地址，其他只可係姓名／HKID／出生日期，每欄一張。
- **路徑 B**：`printed` 比對只覆蓋申請表有抽取到嘅欄（hkid／nameZh／nameEn／address；申請表冇抽取 dob／phone）；`printed_ref` 證據類別已加入 `fields-ext`，但 `15-fields-merge.ts` 尚未將身份證抽取值以 `printed_ref` 加入 Cand（簡報只列 crosscheck＋evidenceClass；接入需要規劃者按真資料決定）。`03-crosscheck.ts` 已開 `printed:true`，真資料重跑會影響評級（優先於打字名單）。
- **eval `--no-refs` 連 cross 一齊關**（cross 由 refs 衍生）。
- **現有 OCR-3 兩段式 tests 由 `["a","b"]` 改為 `["a","a","b"]`**（新次序）；`guard-ocr.test.ts`／`ocr5-eval.test.ts`／`ocr3-field-crops.test.ts`／`ocr4-rank-reconcile.test.ts` 因入職表多 3 欄／schema reason enum 多一項而改斷言（無行為倒退）。
- Worktree 環境同 OCR-3：`node_modules` 以 `cp -c` 自 `zoi-kan-wt-ocr3` 複製（冇 `prisma generate`）；e2e seed 用 `data/`、`tools/importer/out` symlink 指向主 repo（只供 seed 腳本讀，我冇讀內容）；Playwright 用 `next build`＋`next start`，設 dummy `DEEPSEEK_API_KEY`（辨識 API 全部 page.route 攔截，唔會出網）令頁面唔 404；gate 設 dummy `SESSION_SECRET`。

### 27.3 驗證
- vitest（隔離 PG 54422）**266 檔，4,011 passed｜15 skipped｜0 failed**（OCR-3.6 基線 265 檔／3,978；新增 `tests/ocr1-cross-doc.test.ts` 48 條：refs_token 簽名／過期／換人／超長／同 continuation 唔通用／credit；只注入 confirmed〔錯讀、review、仲裁確認都唔入〕；prompt 消毒＋規則；crossCheck 各欄 ≥3 case；crossForOnboarding；stage a 有／冇／無效 refs 路徑＋audit；stage b cross／id_cross／冇 refs；配額 credit；OCR_MAX_FIELD_CROPS 校驗；UI ack 規則；readTwoStage 次序／id_cross 併入；評估腳本 refs／cross／--no-refs；路徑 B printed／printed_ref）；tsc 0；lint 0；knip 0（只有既有 configuration hints）；`rm -rf .next` 後 `next build` 過。
- Playwright 全套（隔離 dev PG 54422、`next build`＋`next start` 3186、`AI_LLM=fake`、`SCHEDULER_ENABLED=0`，跑前 `db:reset`＋`db:seed`）**267 passed｜4 skipped（原有）｜0 failed**（新 `ocr-cross-doc.spec.ts` 4 條：全流程 refs_token 傳遞＋⚠ 要「以證件為準」ack＋改值仍要確認、一致 ✓、舊 server 冇 refs、手機 375px；`ocr-two-stage.spec.ts` 5 條改為 `a→a→b` 次序後全過）。
- `gate:locked-months`（隔離 dev PG 54422，`SESSION_SECRET` 已設）12 步：除 `gate-ltpay-aug`（rc=1＝其已知 harness 差異）外 11 步 rc=0；`gate:ltpay-aug` 56 人 Gross 918,488.09／Autopay 882,728.97／MPF EE 35,759.12／ER 35,996.80，**55/56 吻合＋1 已知差異**（逐欄差異 gross=1、mpfEe=1、mpfEr=1、autopay=1、workDays=1＝同一人）——同 §25.4／§26.4 逐個相同，OCR 路徑獨立，不受影響。

### 27.4 驗收修正（OCR-1.2，Opus 5.5：M1／S1／N1／N4）
- **M1**（`crosscheck.ts`）：`printed` 比對只可以**降級**——printed mismatch 生效→`status` 為 mismatch；printed match 永遠唔可以蓋過 U Team／Maxwell／DB 名單 mismatch（status 只由其他來源綜合）。身份證 HKID 係 `corrected_by_corroboration`（靠手寫表修正）時 `printedRefCmp.hkid`＝`no_reference`（避免循環證據，`hkidFixed` 防線照舊）。新增 2 test（重現：身份證同表都係 Z900001(2)、名單 Z900002(0) → 開／唔開 printed 都係 fail＋`mismatch_hkid`；corrected_by_corroboration 唔計 printed）。
- **S1**（`refs.ts`）：入職表欄靠仲裁 `agree_a` 先 confirmed → `cross` 一律 `unreadable`（讀 A 睇過 refs，仲裁又收讀 A 候選，唔係獨立證據）；`agree_b` 照比。新增 test。
- **N1**（`route.ts`）：`refs_token` 只喺該次 stage a 請求**冇**入職表時先簽發；同一請求混入入職表唔簽發。新增 test。
- **N4**（`eval-ocr-core.ts`）：入職表 `name_zh`／`hkid`／`dob` 唔計入 `overall`／`by_field`，另出 `cross_fields`（n／exact／wrong／missing…）及 console 一行；`by_doc_field` 保留。`--dry` 數字還原為 OCR-5 基線：已評估欄位 13／exact 9（69.2%）／review_contains_truth 2／wrong 1（confirmed 錯 0）／missing 1，`cross_fields` n=3 exact 3；`manifest.dry-refs.json`：overall 42、cross_fields 18。

## 28 OCR-2（2026-10-15，基於 `docs/plans/ocr-accuracy-plan.md` §1 問題 2／§2 OCR-2／§3 決定 1 及老闆決定「ALS 預設開，但樓層／室號絕不外送」；branch `ocr2-hk-address`，起點 main `bf1508a`，已 merge main `5d190ac`，未 merge 回 main）

執行：Sonnet 5.5（`claude-sonnet-5-5`）。範圍：香港地址正規化（純函數）＋ALS 政府地址庫候選＋UI／評估／測試／文件。全程只用合成地址（虛構門牌＋真實公開街道／屋邨名）、fake ALS，冇讀 `data/` 內容、`.env` 內容（只將 DB port 改 54426）、冇 PII；ALS 查詢字串冇寫 log／audit／DB／error message。

### 28.1 `hk-address.ts`／`hk-address-data.ts`（純函數，browser／Node 共用）
- **資料表**：公共屋邨 270 個（維基百科「香港公共屋邨列表」，取自房委會公開資料，2026-10-15 由 wikitext 抽取各區表格首欄；該頁冇英文名，所以屋邨冇英文欄）、18 區中英＋區內常見地名（手編）、街道後綴、建築物後綴、手補私人屋苑 12 個、手補主要街道約 55 條（非窮盡，註明）。
- **形近／簡繁字映射**（每條註解；簡報清單全收，另補「栅→柵」）：canon 歸一（邨村、埗步、涌湧、鰂則、埔浦、灣湾、荔茘、葵癸、嶺岭、沙砂、澳奧、邊园樓厦興華丰寶丽榮龍号…）；**角↔咀（旺角／尖沙咀）只做候選**（`candidate_only`，唔入 canon）。
- `normalizeHkAddress(raw) → {display, canon, strict, suggested, edits[{from,to,reason,index}], parts}`：`display` 保留原讀數；`suggested`／`edits` 只喺命中屋邨／街道／地區表而原文寫法唔同先有（唔命中唔改；屋邨本身就叫「健康村」「漁光村」唔當錯）；`canon` 另做全形半形、空白標點、單位詞歸一（15/F＝15樓、Flat／Rm／Room／Unit＝室、Block／Blk／Tower＝座、Phase＝期、G/F＝地下、中文數字〇零一二…壹貳叁…→阿拉伯）；`strict`＝唔做形近字歸一嘅 canon（候選去重用，令「邨／村」係兩個候選）；`parts` 規則抽出 district／street／number／estate／block／floor／unit／building（另 phase）。
- **ALS 外送守則**：`alsQueryFromParts(parts)` 只由 district／street／number（有 street 先帶）／estate／block／building 砌 q；floor／unit 永遠唔入；任何部件仍含樓層室號字眼（例如大廈名「利美樓」）→ 該部件整個唔送；資訊太少（冇街道／屋邨／大廈）→ null（唔查詢）；q 最後再用 `hasFloorUnitText` 斷言一次，唔過 → null；`fetchAls` 送出前再斷言一次（失敗即拋，唔發網絡）。

### 28.2 `als-client.ts`（server-only）
- `GET https://www.als.gov.hk/lookup?q=<percent-encoded>&n=3`；`Accept: application/json`、`Accept-Language: zh-Hant`；唔傳 `3d`／`floor`／`unit`；Node 原生 fetch；`AbortSignal.timeout(3000)`（注入嘅 fake 亦受 3 秒上限）；非 2xx（400／406／413／429／500）／逾時／網絡錯誤＝拋，`lookupAlsCandidate` 捕捉後回 `failed`，唔 log 查詢。
- `parseAlsResponse` 解析 `SuggestedAddress[].Address.PremisesAddress.ChiPremisesAddress{ChiDistrict.DcDistrict, ChiStreet{StreetName,BuildingNoFrom,BuildingNoTo}, ChiEstate.EstateName, ChiBlock{BlockDescriptor,BlockNo}, BuildingName}`＋`ValidationInformation.Score`（寬鬆、防禦）。
- `lookupAlsCandidate(address, lookup)`：由原讀數抽 parts → q → 查詢 → 取最高分（Score ≥ 60 先要）→ 本地按 `<district><street><number><estate><block><building><floor><unit>` 拼返（floor／unit 係本地保留嘅，從冇外送）→ 候選。
- `GUARD_OCR_ALS` 預設 1（`0`／`false`／`off`／`no` 完全唔呼叫，`getReadClients` 唔帶 `als`）；測試 override（`setVisionClientForTests`）下只有注入咗 `setAlsOverride` 嘅 fake 先有 ALS，**唔會打真網絡**。

### 28.3 讀取流程／reconcile／rank／route／UI／評估
- **呼叫點**：`read.ts` `finishRead`（stage b、舊單次流程、印刷文件 final 路徑共用）——兩讀解析後、仲裁前，用預備 `reconcile("address", A, B)` 揀出要查嘅地址，每份文件最多 1 次（address_proof／onboarding_form，所以每次請求最多 2 份）；ALS 候選以 `ExtraCandidate{source:"als", als_score}` 入 reconcile，並放仲裁 prompt 最後一個候選位（當不可信字串）。`DocumentReadResult.als={called,candidate,failed}`。
- **reconcile 地址分支**：兩讀 canon 一致＋`edits` 空 → confirmed（`大厦／大廈` 現在直接 confirmed，毋須仲裁）；`edits` 非空（兩讀一致都係）→ `review`、`reason:"address_variant_suggested"`、候選＝原文＋建議（`hk_address`）；兩讀一邊村一邊邨（canon 一致但有建議）→ review，兩個寫法都係候選。
- **rank**：推導候選（`hk_address`、`als`）`derived`——唔算獨立讀數（唔加同意分）、分數封頂喺最高原讀數分數、同分排後（唔搶預填）；address 分組用 `strict`（邨／村 分開兩個候選，空白標點差異仍合併）；`RankedCandidate.als_score` additive。
- **route**（additive）：每份 document 多 `als:{called,candidate,failed}`；audit `guard_ocr_read` 多 `als_called_docs`／`als_candidate_docs`／`als_failed`（淨數量）。
- **UI**：`candidates_ranked` 嘅 ALS 候選 chip 加細字「政府地址庫」（`data-testid=ocr-chip-als-address`）；形近字建議同原文只差 1–2 字時高亮分歧字（沿用 `diffChars`）；撳 chip＝`ackAfterEdit` 規則不變；375px 實測冇橫向捲動。
- **路徑 B**：`compare.cmpAddress` 中文地址用 `hk-address` canon（邨／村、埗／步、單位詞歸一）。
- **評估**：`eval-ocr.ts` 報表／console 加 `als_enabled`／`als_called_docs`／`als_candidate_docs`／`als_failed`／`als_truth_from_candidate`（review_contains_truth 入面真值只來自 ALS 候選嘅欄數）；`--no-als` 唔查；`--dry` 用 `fakeAls`（照 q 回標準化結果，冇網絡）。`--dry`（`manifest.dry.json`）：已評估 13 欄、exact 9、review_contains_truth 2、wrong 1（confirmed 錯 0）、missing 1 **不變**；仲裁文件 3→2（`syn-06` 嘅「大厦／大廈」現歸一後兩讀一致，毋須仲裁）；ALS 查過文件 2／出候選 2／失敗 0。

### 28.4 保守取捨（簡報冇講清）
- 兩讀歸一後一致、`edits` 空、但字面唔同（例如兩邊都係表外嘅「某某村」／「某某邨」）→ 照簡報 confirmed，`value` 用讀 A 寫法。
- ALS 唔改變已 confirmed 欄位；ALS 候選只喺 review 欄出現。
- 查詢字串資訊太少（冇街道／屋邨／大廈）就唔查，寧願冇候選都唔送半截地址；大廈名含「樓」嘅部件整個唔送。
- ALS Score 當 0–100（≥ 60 先要）；`ChiBlock` 拼法：描述係「座／閣／樓」→ `<號><描述>`，否則 `<描述><號>`（規格冇講中文序，揀最常見寫法）。
- parts 只取第一個命中嘅已知屋邨；地區只認開頭連續嘅地名；一個地址有多個「樓／室」只當 floor／unit 全部剔走（保守）。
- `eval --dry` 嘅 `syn-06` 預期行為變咗（仲裁 3→2），`ocr5-eval.test.ts` 斷言相應更新並加 ALS 行斷言。
- Worktree 環境同 OCR-1：`node_modules` 以 `cp -c` 自 `zoi-kan-wt-ocr1` 複製（冇 `prisma generate`）；e2e seed 用 `data/`、`tools/importer/out` symlink 指向主 repo（冇讀內容，已隨後保留為 gitignored symlink）；Playwright 用 `next build`＋`next start`，設 dummy `DEEPSEEK_API_KEY`（辨識 API 全部 `page.route` 攔截）。

### 28.5 驗證
- vitest（隔離 PG 54426）見最後回報數字；新增 `tests/ocr2-hk-address.test.ts`（形近字 31 條＋易混字／表命中／屋邨本名／中文數字、parts 24 條、q 唔含樓層室號 20 種寫法＋部件剔除／資訊太少／斷言／fetchAls 唔發網絡、ALS fake〔成功／Score 低／冇結果／429·500·網絡／timeout／資訊太少／parseAlsResponse〕、reconcile 地址分支、`readDocument`×ALS 整合〔每份 1 次、失敗、仲裁 prompt、`GUARD_OCR_ALS=0`／override 唔打網絡〕、cmpAddress）；`ocr5-eval.test.ts` 斷言更新。
- Playwright 全套（隔離 dev PG 54426、`next build`＋`next start` 3188、`AI_LLM=fake`、`SCHEDULER_ENABLED=0`，跑前 `db:reset`＋`db:seed`）**273 passed｜4 skipped（原有）｜0 failed**（含新 `ocr-als-chip.spec.ts` 3 條：ALS chip「政府地址庫」＋撳套用、形近字建議高亮、手機 375px）。
- `gate:locked-months`（隔離 dev PG 54426）：除 `gate-ltpay-aug`（rc=1＝其已知 harness 差異）外 11 步 rc=0；`gate:ltpay-aug` 56 人 Gross 918,488.09／Autopay 882,728.97／MPF EE 35,759.12／ER 35,996.80，**55/56 吻合＋1 已知差異**（逐欄 gross=1、mpfEe=1、mpfEr=1、autopay=1、workDays=1＝同一人），同 §25–§27 逐個相同。

### 28.6 驗收修正（OCR-2.2，Opus 5.5：M0／S1／S2／N1–N6；S1 係規劃者裁決，取代 28.4 第一點同 28.3 `eval --dry` 數字）
- **S1**：canon（形近／簡繁折疊）只用嚟**配對**兩讀，唔可以直接 confirmed。地址兩讀 `strict`（只做 NFKC／空白／標點／單位詞歸一，**唔**折疊形近字、唔折疊 楼／号／厦）相同且冇 edits → confirmed；strict 唔同但 canon 相同（只差形近／簡繁字，例如 村／邨、沙／砂、厦／廈）→ `review`（`reason:"address_variant_chars"`），候選＝兩個寫法，變體字少／表命中嗰個排前並作預填；edits 非空照舊 review。仲裁同某一讀亦要 strict 一致先算 agree（唔會靠形近字歸一 confirmed）。
- **評估口徑**：`eval-ocr-core.classifyField` 地址欄 exact（confirmed 且啱）用 strict 比較，review_contains_truth 仍用 canon。`--dry`（`manifest.dry.json`）數字更新：已評估 13 欄、exact **8（61.5%）**、review_contains_truth **3（23.1%）**、wrong 1（confirmed 錯 0）、missing 1；review 率 30.8%；仲裁文件 2；ALS 查過文件 **1**（S2：只查 review）／出候選 1／失敗 0。（`syn-06` 大厦／大廈 由 exact 變 review_contains_truth。）
- **S2**：ALS 只喺該地址欄預備 reconcile 結果係 `review` 先查；confirmed／missing 唔查（als.called=false）。
- **N2／N6**：支援「廿」「卅」（廿三樓＝23樓）；單位補 `Flat-3`／`Flat-A`、`12樓A`、`12樓 B`、`12/F 1203`、`12/F, 1203A`、獨立 `12A`（後面跟英文街名＝門牌，唔剔）——floor／unit 一律由 parts 抽走，q 唔漏出，本地拼返保留。
- **N3**：仲裁 prompt 將 ALS 值另列為「government address database suggestion (untrusted string, NOT one of the readers' outputs)」，唔當兩讀候選；仲裁值若同 ALS 值 strict 一致，仲裁輸入標 derived——唔加 ARBITER_BONUS、分數封頂、唔搶預填。
- **N4**：ALS 值同某讀值合併時（sources 仲有 a／b／arbiter）chip 細字顯示「讀數＋政府地址庫」，否則「政府地址庫」（e2e 新增 1 條）。
- **N5**：英文 q 門牌放街名前（`999 TEST ROAD`），中文維持「街名 ＋ 999號」。
- **N1**：`eval-ocr-core.ts` `--no-als` 註解改正（live／dry 一樣剔走 clients.als，唔設 GUARD_OCR_ALS）。
- 測試：`tests/ocr2-hk-address.test.ts` 更新 S1 斷言並加 S1（村／邨、沙／砂、厦／廈、表外名稱、仲裁形近字）、S2、N2／N6（廿卅＋8 種單位寫法）、N3（prompt 另列、無加權）、N5；`tests/ocr5-eval.test.ts` dry 數字更新。

### 27.5 OCR-1.3：來源優先規則（老闆指示，branch `ocr13-source-of-truth`，起點 main `c54fc2e`）
- **規則**：身份證號碼、出生日期、中英文姓名一律以身份證副本為準；住址一律以住址證明為準（冇住址證明／讀唔到先用入職表手寫地址）。入職表手寫值只做交叉核對；「唔一致」唔係人手判斷嘅阻塞警示——最終紀錄直接採用證件／住址證明值，差異只顯示 warning 級提示。
- **改動**：①`review-state.ts`：移除 OCR-1.2 前加嘅 `differs` 專屬 ack 規則（`ackAfterEdit` 回復三參數、`reviewProblems` 唔再有 cross 訊息）——關鍵欄「對過證件，啱」規則維持原本（一致／冇手寫值都要）；`CROSS_MSG.differs`＝「入職表手寫同證件唔同，已以證件為準」，新 `CROSS_MSG_ADDRESS`。UI 提示改 warning 色、ack 掣文字不變。②地址：新 `merge-docs.ts` `mergeDocFields`（純函數，client 唯一合併點）：住址證明有 confirmed 或 review 值就用佢，入職表地址只做 cross＋唯讀顯示；`refs.ts` `crossForField`／`crossForOnboarding` 加地址 cross（`against:"address_proof"`），住址證明 review 時 client 用同一函數補算；`OCR_CROSS_CHECK_FIELDS`（`OCR_CROSS_FIELDS` 保持三欄，eval 嘅 `cross_fields` 統計範圍不變）。③`FieldResult.source_of_truth`（additive，`tagSourceOfTruth` 就地標示，唔改值），stage a final、stage b、舊單次流程回應都有。④docs/api.md、docs/ops.md 已寫明。
- **證明冇覆蓋路徑**（`tests/ocr13-source-of-truth.test.ts`）：身份證 confirmed 值＋入職表 differs → `mergeDocFields` 採用身份證值（手寫值只入 `formValue`）；身份證 missing 亦唔借用手寫值；proof 地址＋form 地址 differs → 最終用 proof（server cross／client 補算兩條路）；冇住址證明或讀唔到先用入職表地址；route 回應值唔變、`source_of_truth`／cross 正確。
- **保守取捨**：`source_of_truth` 伺服器標示 best-effort（住址證明只有 review 值時入職表地址仍標 `onboarding_form`，最終以 client `mergeDocFields` 為準，已喺 API 文件寫明）；地址 cross 只喺入職表地址 confirmed（非仲裁 agree_a）先比，否則 `unreadable`；OCR-1.2 嘅 e2e／unit 斷言（⚠、『以證件為準』ack 掣、differs 專屬訊息）已按新規則改寫。

### 27.6 OCR-1.4：證件欄讀唔到／待覆核時唯讀顯示入職表手寫值（老闆要求，Opus N2；branch `ocr14-form-hint`，起點 main `8c8c1d4`）
- 身份證欄 `missing`／`review`（或住址證明 `review`）而入職表有手寫值：`mergeDocFields` 設 `formValue`＋`referenceOnly`；UI 顯示「入職表手寫（參考）：…」唯讀一行＋「用呢個值填入」掣。**唔自動填、唔改 value、來源仍係證件**（身份證 missing 時欄位仍然空）。
- 一撳填入＝人手改值：非關鍵欄走現有 `ackAfterEdit`；關鍵欄（姓名／身份證號／出生日期）另外強制 `ack=false`（手寫值係模型讀出嚟，唔係用戶自己打），仍要「對過證件，啱」。住址證明 `missing` 時按 OCR-1.3 來源規則直接用入職表地址（唔屬參考）。冇手寫值就冇參考行。
- 測試：`tests/ocr14-form-hint.test.ts`（6 條：missing／review 有手寫、冇手寫、confirmed 唔算、住址證明 review／confirmed／missing）、`tests/e2e/ocr-form-hint.spec.ts`（2 條，含 375px）。

### 27.7 OCR-1.5：填入來源與確認規則（Opus 驗收 N1／N2／N3）
- N1：「用呢個值填入」填入嘅值，提交 payload 地址 `source` 標 `application_form`（`FormField.filledFromForm`；包格式只有地址有來源欄）；**所有欄**（含地址等非關鍵欄）填入後一律 `ack=false`，要撳確認先可提交。純函數 `ackAfterFill()`（`review-state.ts`）；其後用戶再人手改字清走 `filledFromForm`，回到 `ackAfterEdit` 規則。
- N2：填入後交叉核對提示改為 `FORM_FILLED_MSG`「已採用入職表手寫值（請對住圖確認）」，唔再顯示「已以證件／住址證明為準」。
- N3：`ackAfterFill` 單元測試（`tests/ocr14-form-hint.test.ts`）；e2e 加：地址填入後 data-ack=0、提示文字、預覽掣要確認後先可撳、preview request `address.source==="application_form"`、再人手改字回復。

## 29 G2/G4（Gemini 審查跟進；branch `gem24-shift-reuse-audit-tx`，起點 main `0dfcfdf`，未 merge）
- **G2**：`POST /api/shift-records`（雞頭／內部兩分支）改用 `src/lib/shift-records/create-or-reuse.ts`：`$transaction` 內 `findUnique(guard_id,work_date,shift_type_id)`——冇行→create；`cancelled`→update 重用（id／created_by／created_at 保留；其餘非 key 欄先重設做新建預設〔status=confirmed、OT／parent／billed／paid／rescue／provenance 等清走〕再寫入今次 data）；非 cancelled→P2002 風格 409（照舊）。回 201，body additive `reused:true`；audit `update`（before＝cancelled 行、after＋`reused_cancelled:true`，`AUDIT_META_PASSTHROUGH_KEYS` 加 `reused_cancelled`），audit 同 tx（`writeAuditTx`）；journal before＝被重用行 snapshot。鎖月檢查位置不變（tx 前）。並發 P2002 fallback 保留。
- **G4**：`batch/route.ts` audit 搬入同一 `$transaction`（`writeAuditMany(…, tx)`，既有函數本身已支援 tx client，唔使新增 `writeAuditManyTx`），tx 最後一步寫，rollback 一齊回滾；`pendingAudits` 次序／內容不變。
- **保守取捨**：schema 冇 `updated_by` 欄（唔改 schema）→ 只靠 audit actor；重用行 `source` 取 caller 帶嘅值或 manual。
- **後續（只列，未改）**：commit 後先寫 audit 嘅路徑——`src/lib/months/open-month.ts`（`writeAuditMany(pendingAudits…)`）、`src/lib/longterm-payroll/attendance-fix.ts:156`、`src/lib/roster-upload/reconcile-apply.ts`（逐條 `writeAudit`，pendingAudits）。
- 測試：`tests/g2-g4-shift-reuse-audit-tx.test.ts`（G2 兩分支×4 case＋G4 成功／audit 失敗全回滾／鎖月擋）；`tests/p3-2-batch-write.test.ts` 對比不變。
- **G2.2（Opus 驗收修正）**：S1 重用行 journal `before` 一律用 `manualBefore`（雞頭分支 `[null,null,null]`），移除 `beforeSnapshots`——行已 reset 至新建預設，用舊 snapshot 做 before 會令「舊值＝新自動價」時漏寫 journal；測試加「舊 snapshot 等於新自動價仍寫 journal」。N1 provenance 清空改 `Prisma.DbNull`（SQL NULL）並加斷言。N3 雞頭分支重用斷言 `status===pending_approval`。
- **G4b（老闆拍板；branch `g4b-audit-tx`，起點 main `217ecfa`，未 merge）**：上面「後續」三條 commit 後寫 audit 路徑全部搬入同一 tx（`writeAuditMany(…, tx)`，tx 最後一步一條 createMany）：`open-month.ts`、`attendance-fix.ts`、`reconcile-apply.ts`。audit 內容／次序不變（原有 tests 照過）；timeout 沿用（60s／60s／120s）。journal：attendance-fix 維持 commit 後 best effort（見 docs/ops.md）。測試 `tests/g4b-audit-tx.test.ts`：三路徑各一個 DB trigger 迫 audit 失敗 → 資料同 audit 0 行；2,000 條 audit createMany 在 tx 內約 100 ms（<2 s）。注意：同批 audit 現共用同一 `createdAt`（id 序號保次序，同 `writeAuditMany` 一致），reconcile-apply 之前逐條寫係各自 createdAt。

## 30 TR-1（舊分流題 OCR 重讀＋「建議答案」導入；branch `triage-reread`，起點 main `217ecfa`，未 merge）
- **A 本機腳本** `scripts/staff-import/19-triage-reread.ts`＋`lib/triage-reread-core.ts`：package review 欄 → 工號連 person-fields-ext `docIds` → extract 揀身份證／住址證明（`address.page`）／入職表各 1 頁 → 同 client 次序兩段式讀（`readStageA`／refs／裁圖／`readStageB`）→ `mergeDocFields` → 保守規則出 `{person_key, field, value, basis, doc, confidence, match}`；console／summary 淨計數；`--dry` 用 fake client＋記憶體內合成 fixture（唔讀 data、唔載 `.env`）；`--out` 限 `data/` 下。
- **B 伺服器** `POST /api/triage/sessions/:id/proposals[?dry_run=1]`（`src/lib/triage/proposals.ts`＋route）：只處理 open 嘅 `field_review`／`name_not_confirmed`／`hkid_not_confirmed`；砌現有 `answerSchema` 答案（`apply_fields` confirm＋值／`use_package_name`／`use_package_hkid`，**唔新增 option**），逐題 `previewAnswer` → `submitAnswer`（`extra.source="ocr_reread"` → `answerJson.source`、audit `answered_via`）；回應淨計數。UI：`/triage` 卡「⋯」→ `OcrRereadImportDialog`（上載→dry→確認套用，375px）；卡顯示「OCR 重讀自動答 N 條」。
- **與簡報不同／保守取捨**：① 題目 `personKey` 現時係 HMAC（`serverPersonKey`，包內 key 刻意唔入 evidence），唔係包內 `persons[].key` uuid——建議帶可選 `match{hkid,staff_numbers}`，server 用同一函數推返 key（亦兼容 key 直接相等）；② `field_review` 一題多欄：schema 容許只答部分欄，但答咗題目就變 answered、未決定嘅欄再無人問 → 改為要全部覆核欄都有建議先答，否則 `skipped_partial`；③ field_review 用 `action:"confirm"`＋值（只補空，唔覆蓋現有唔同值）；④ 仲裁 `agree_a` 唔收；⑤ 簡報嘅「撤銷回填」只屬 postorder 補齊題，guard_import 無對應功能，唔做；⑥ 打字名單參考冇原始值喺 package，只能用 `reasons`（mismatch_*／near_match／differs_from_list）當代理。
- 測試：`tests/triage-reread-script.test.ts`（規則／揀頁／工號索引／`--dry` 計數／參數／來源頁）、`tests/triage-proposals.test.ts`（dry／apply／partial／mismatch／kind／key 配對／RBAC／錯誤分類／schema）、`tests/e2e/triage-ocr-reread.spec.ts`（375px 上載→dry→套用；壞檔）。注意：本機 `next dev` 下 /triage 覆蓋層一開即關（既有 `p13-triage-mobile` 同樣失敗，與本改動無關；懷疑 `useHistoryOverlay` 同 dev StrictMode 雙 effect 互動，未深究）；e2e 改用 `next build` 後 `next start` 驗證（p13／月結／p3-4／p3-3／p7／p8 triage 相關 spec 全過）。


- **TR-1.2（Opus 驗收修正）**：N1 `proposals.ts` 顯式身份檢查——有 `match`：推導 key 要等於題目 `personKey`，而且 `match.hkid`／`staff_numbers` 要同題目 `evidence.person` 身份證（canonical）／工號集合（`normalizeStaffNumber`）一致；冇 `match`：`person_key` 要等於 `evidence.person.key`（冇 evidence 可對＝擋）；任一唔過 → 新計數 `skipped_identity_mismatch`（單位＝建議條數）。N3 `GET /api/triage/sessions` 加 `can_answer`（`導入分診:update`），「⋯ → 導入 OCR 重讀建議」只喺 `can_answer` 時顯示。N4 OCR 重讀答嘅題 `triage_answer` audit `manual_confirmed:false`（人手答仍 `true`）。N6 `TriageDialog` 對 `answer.source=ocr_reread` 嘅題顯示「OCR 重讀自動答」標籤（`Question.answer`）。測試：`tests/triage-proposals.test.ts` 加 identity／N4／can_answer。
- **TR-2（舊分流題重讀第二輪；branch `triage-reread-2`，起點 main `d7c388a`，未 merge）**：① 規則（老闆 2026-10-17：身份證號／出生日期／中英文姓名以身份證副本為準，住址以住址證明為準）：`proposeFromPicks` 移除 `cross_differs` 阻擋（入職表手寫唔一致只影響 confidence＝medium）；`typed_list_disagrees` 保留；address_proof 兩讀唔一致照留人手；summary 加 `skipped_by_field`。② 腳本 `--cache <data/ 下目錄>`／`--no-cache`：`fileDocCache` 每 type＋docId＋page 存 `{version:1,result}`（tmp＋rename 原子寫、壞檔當 miss），`readPerson` 命中就唔 `prepare`、唔打 API（`DocCache` 介面可注入）；summary 加 `cache_hits`。③ 伺服器部分欄答題：`planForQuestion` 對 `field_review` 答有建議而且合法嘅欄，餘下放 `rest`（格式唔合法嗰欄入 `invalidFields`→`skipped_invalid`）；`submitAnswer` 加可選 `extra.followUp`，喺答題同一 tx 內（同 groupKey 不存在先）建 `<舊 groupKey>:rest` 跟進題，`AnswerOutput.follow_up_created`；計數 `applied_partial`／`follow_up_created`（dry＝會開）。④ `skipped_field_mismatch` 細分 `skipped_field_not_under_review`／`skipped_value_mismatch`（原總數保留）。測試：`triage-reread-script`（cross differs 照建議、skippedByField、快取命中 0 呼叫、fileDocCache）、`triage-proposals`（partial→舊答新開只含剩餘欄、重覆上載 no-op、同 groupKey 不重覆開、全覆蓋照舊、planForQuestion rest／invalidFields）。

## 31 W0（WhatsApp 報更模組基建，基於 `docs/plans/whatsapp-roster-plan.md` §3／§4／§9 W0 及老闆 2026-10-17 批核；branch `wa-w0-infra`，起點 main `3305794`，未 merge）
- **Migration（只加）** `20261018000000_wa_w0_whatsapp_infra`：`whatsapp_groups`／`whatsapp_messages`／`whatsapp_intents`＋4 個 enum（kind／message status／intent kind／routed）；`message_id` unique、`(message_id,revision)` unique、`(chat_jid,ts)`／`(status)` index、intents unique `(message_id,message_revision,idx)`；FK：groups→sites／brokers（SET NULL）、messages.sender_guard_id→guards（SET NULL）、intents.message_id→messages.message_id（CASCADE）。無 `gen_random_uuid`／RAISE／DROP，id 由應用程式端產生；**唔入 `ai` schema**，`ai.audit_log` 排除清單加三表。
- **Webhook** `POST /api/webhooks/whatsapp`：總開關 503 → raw body ≤64KB（413）→ HMAC-sha512＋`X-Zoikan-Hook`（`timingSafeEqual`，fail closed；401 唔落庫唔 log body）→ zod（400）→ 落庫（`createMany skipDuplicates`＝`ON CONFLICT DO NOTHING`）；edited／revoked 喺 transaction 內 `FOR UPDATE` 鎖行（revision 由 server 遞增、舊文字入 `text_history`、intents `source_changed`）；fromMe／非群／stale 72h／未來 10 分鐘 → `ignored`＋reason。回 200 `{ok:true}`，不做解析。
- **WAHA client** `src/lib/whatsapp/waha.ts`：只有兩個 GET（session 狀態、群組列表），`X-Api-Key`，5s timeout，結構化錯誤；`tests/whatsapp-misc.test.ts` 掃描 `src/lib/whatsapp`／webhook／`api/whatsapp`／頁面目錄不得出現發送類 API 字串。
- **API／UI／RBAC／job**：`/api/whatsapp/{groups,groups/sync,messages,health}`；頁面 `/whatsapp`（群組卡、綁定抽屜〔kind／盤／判頭／口語對照／自動開關〕、訊息列表、health；375px 無橫向捲）；新 module「WhatsApp 報更」（老闆 view＋update、會計／主管 view、雞頭／保安員硬性拒）；導覽「排更」組加一條；`whatsapp_retention` job 每日 03:00；`.env.example`／`docs/ops.md`（WAHA Zeabur 設定清單）／`docs/api.md`。
- **假設與保守取捨（簡報未講清）**：① WAHA payload 欄位按常見格式全 optional：edited 目標 id＝`editedMessageId ?? id`、revoked＝`revokedMessageId ?? before.id ?? id`、timestamp 秒（>1e12 當毫秒）、群內發訊人＝`participant`（後備 `_data.key.participant`，再後備 `from`）；缺 `id`／`from` → 400；未訂閱事件 → 200 不處理。② 私訊（非群）：只記一行 `ignored:not_group`，**text 置空、chat／sender jid 以 hash 取代、唔解析電話**（私隱）。③ edited 只處理「已收過原訊息」；冇原訊息／空內容／同文字（重覆投遞）／已撤回／ignored 行＝no-op（唔補建）；revoked 保留原文（等 W1 intents 顯示「已撤回」），90 日保留期照清。④ 媒體 `media_type` 只記 mimetype 主類（`image`／`audio`…），hasMedia 但冇 mimetype＝`unknown`。⑤ `sender_guard_id` 只喺電話對應**唯一**保安員（`GuardPhone`／`Guard.tel`）先設，零個或多個＝null。⑥ API 不回原文、WAHA `message_id`、完整電話。⑦ `shift_word_map` 對外係 `[{word,code}]` 陣列（避免 camel→snake 轉 key 弄壞 `OT` 類 key）。⑧ PATCH 一致性：site 群要綁盤、判頭群要綁判頭、ignored／office 唔准自動、auto_confirm 要 auto_write。⑨ intents 嘅 site／guard／shift_type 係軟引用（無 FK），避免阻塞主檔刪除。⑩ 桌面導覽多一條令老闆 1512×700 要多捲 15px：`p3-3-nav.spec` viewport 高度 700→720（其餘斷言不變），未改產品 CSS。
- 測試：`tests/whatsapp-webhook.test.ts`（26：HMAC 對／錯／缺、header、總開關、重覆／併發、fromMe／非群／stale／future、媒體、edited／revoked、大小 413、schema 400）、`tests/whatsapp-api.test.ts`（15：RBAC、fake WAHA 同步、PATCH 驗證＋audit、訊息清單遮罩、health）、`tests/whatsapp-misc.test.ts`（15：retention、禁用字串掃描、migration 規矩＋AI 隔離〔真連 `zoikan_ai_ro`〕、純函數、middleware CSRF、矩陣）、`tests/e2e/wa-w0.spec.ts`（6：綁定流程、驗證錯誤、訊息清單、health、RBAC、375px）。
- **W0.2（Opus 驗收修正）**：M1 註解「安員」→「保安員」；S1 編輯事件 timestamp 早過該行 `edited_at`（無則 `ts`）、新文字已喺 `text_history`／等於現文字 → no-op，`edited_at` 改記事件時間；編輯／撤回事件套同一 72h／未來 10 分鐘窗口，無 timestamp → no-op；S2 撤回先到 → tombstone（revoked、text 空），原訊息後到撞 ON CONFLICT 保持；S3 編輯先到 → tombstone（received、編輯後文字、revision 1、`pending_edit=true`），原訊息後到 no-op，下一次較新編輯清 `pending_edit`；S4 私訊 `message_id`／chat／sender 全改存 24 字母 hash（純字母，整行冇 8 位數字／`@c.us`）；S5 保留 1512×700 門檻（test 改返 700），改產品 `DesktopNav` 連結 `leading-5`→`leading-[19px]`（每項 −1px，19 項共 −19px）；N1 編輯／撤回 `chat_jid` 同原行唔一致 → no-op＋`console.warn` 計數；N2 message 無 timestamp → `ignored:no_timestamp`（唔用 now）；N3 `whatsapp_groups.label_locked`（PATCH 改群名即鎖，同步唔覆蓋）；N4 `docs/ops.md` 註明私網／IP allowlist／middleware 擋外網**未實作**，現靠 HMAC＋header。Migration `20261018010000_wa_w0_2_pending_edit_label_lock`（只加兩欄）。**更正**：上文假設③「冇原訊息＝no-op（唔補建）」及 ⑩「viewport 700→720」已被 S2／S3／S5 取代。
- **W0.3（Opus 複檢）**：S1 編輯去重改用**編輯事件 id**，唔再用文字（W0.2 嘅「新文字已喺 `text_history` → no-op」會擋住合法 A→B→A）。事件 id＝`payload.id`（若同目標訊息 id 唔同，例如 `editedMessageId` 模式）；否則 `sha256(message_id|timestamp|text)`。每次套用編輯，`text_history` 項目記 `{revision, text, replaced_at, event_id}`；同 `event_id` 再嚟＝no-op；「同現文字」及「事件時間早過 `edited_at`／`ts`」照舊 no-op；timestamp 等於原訊息 ts 嘅編輯照處理。N3 由「編輯先到」tombstone（`pending_edit`）嘅行，原訊息後到時補返 `sender_jid`／`sender_tel_norm`／`sender_guard_id`／`media_type`／`quoted_message_id` 同群 `last_message_at`，唔改文字／狀態／revision（撤回 tombstone 完全保持）。已知限制：tombstone 本身嗰個編輯事件冇記入 history，其重送靠「同現文字」no-op 吸收。測試：webhook 檔加 A→B→A、event id 重放、等 ts、hash 去重、tombstone 補欄共 2 條（原有 S1 重放 test 改用 event id）。

## 32 W1（WhatsApp 解析 dry-run，基於 `docs/plans/whatsapp-roster-plan.md` §5／§6.1／§9 W1；branch `wa-w1-parse`，起點 main `2cc5328`〔W0 已合併〕，未 merge）
- **只記錄建議**：`whatsapp_intents.routed` 判定（`auto_write|triage|ignored`），**唔寫 `shift_records`、唔開 Triage 題**。Migration `20261019000000_wa_w1_parse`（只加）：`whatsapp_groups.filter_threshold`、`whatsapp_messages.parse_attempts`、`whatsapp_intents.superseded_by_revision`／`revoked_at`＋`created_at` index。
- **第 0 層** `src/lib/whatsapp/filter.ts`（純函數）：日期 token＋25、更別詞＋25、請假詞＋40、盤口別名＋15、發訊人係已知保安員＋10、日期＋（更別或請假）組合＋10；減分：確認詞 −30、連結 −40、>300 字轉發 −30、**純疑問句 −20**；**問號規則**：日期＋（更別或請假）＝帶問句嘅指令，問號不減分（`question_directive_kept`）；被回覆文字（同群 24h）併入上下文（其命中以半分計）；閾值預設 40，群組 `filter_threshold` 覆寫（PATCH 0–100／null）；未綁定／ignored／停用群 → ignore。reasons 只有代碼。
- **第 1 層** `parse.ts`：用現有 `LlmClient`——**additive 擴展** `LlmChatParams.structured`（DeepSeek：`response_format json_object`＋temperature 0＋`reasoning_effort low`＋`max_tokens 2000`；Claude：單次 `messages.create`、只傳 `max_tokens`〔唔傳 temperature／thinking，避免新型號拒收〕；`AI_LLM=fake` 回純雜訊 JSON）。輸入只有訊息原文、HK 時間、群 kind、更碼表、口語對照、被回覆文字（**唔傳保安員名單**）。zod strict（多餘欄位／缺 confidence／非法 type → `bad_schema`；壞 JSON → `bad_json`）→ 一條 `unclear` triage（`llm_bad_output`）。schema 加 `question_only`。DeepSeek 連唔到＋有 `CLAUDE_API_KEY` → Claude 後備。合成 few-shot（測試甲／乙）。真 API smoke：`scripts/whatsapp/parse-smoke.ts`（規劃者跑）。
- **程式碼解析**：`dates.ts`（HK 時區、以訊息 ts 為今日；相對詞、星期／下星期、X 號／X 月 Y 日／X/Y〔日/月，兩解都合法＝ambiguous〕、相對＋絕對要一致〔否則 `date_inconsistent`〕、range 展開≤14 日；**凌晨 00:00–<05:00 用「今日／今晚／而家／今個更／聽日」→ `date_ambiguous`，候選當日＋前一日〔聽日：聽日＋當日〕**）；`resolve.ts`（盤：群綁定／`classifySiteName` exact·auto 採用、propose·new·單盤群指另一盤 → ambiguous；人：發訊人電話〔唯一〕／`byName`／`byAlias` 唯一先硬鍵、多個 ambiguous〔候選按近 60 日同盤優先，判頭群限該判頭近 60 日保安員，只影響候選〕、零 unknown；更碼：口語對照→直接更碼→startTime 時段〔06–12 早、12–18 中、18– 夜〕→LLM 猜嘅碼只做候選；請假碼 SL/AL/NL/RD/SH 詞表；衝突：同更已存在 no-op〔ignored〕、同日另一更／請假、額滿〔DailyRequirement／ShiftType.headcount〕、配額滿、鎖月、日期 −2～+45；cover／cancel 一律 `triage(type_not_auto)`）。`guard-index.ts` 由 roster-upload service 抽出 `loadGuardMatchIndex`（service 行為不變）。
- **Job** `jobs/whatsapp-parse.ts`：`whatsapp_parse`（`WA_ENABLED=1` 先跑；received 按 ts → filter → parse → resolve → intents；單一 transaction 落結果、處理期間被編輯／撤回＝stale 下輪重來；失敗 `parse_attempts+1`，3 次 `status=error`〔error 只有原因碼〕；編輯：新 revision 重新走，舊 intents `superseded_by_revision`；撤回：intents `revoked_at`）＋`whatsapp_daily_summary`（09:00，通知老闆，只有數字）。`whatsapp_retention` 加清 `parsed_json`。
- **API／UI**：`GET /api/whatsapp/intents?group=&from=&to=&routed=`、`GET /api/whatsapp/stats?from=&to=&group=`（RBAC 同 W0 module；原話／姓名要「保安員:view」）；頁面 `/whatsapp/intents`（統計卡、篩選、逐條 ✓／✗／—、原因碼、被編輯取代／已撤回標示；375px 無橫向捲動；`/whatsapp` 頁首連入，唔加導覽項）；`/whatsapp` 群組抽屜加「過濾閾值」。
- **假設與保守取捨（簡報未講清）**：① **排程最細 1 分鐘**（5 欄 cron）→ 「每 30 秒」改為每分鐘跑、每次連續處理到冇待處理或 45 秒預算用盡。② `routed=auto_write` 只睇 §6.1 第 1–6 項；第 7 項（群組 `auto_write` 開關）記 `resolution.group_auto_write`＋備註「群組未開自動寫入」，否則 dry-run 期間（試點群開關關）永遠 0 條建議自動、量度唔到準確率；W3 真寫入時再把關第 7 項。③ 「今日」＝訊息 ts 嘅香港日（唔用處理當刻）。④ 「下星期 X」＝下一個（星期一起計）星期入面嘅星期 X；「星期 X」＝由今日起最近一個（含今日）；「X 號」冇月＝今日 −2 日起最近一個，過咗當下個月。⑤ 凌晨窗口取 [00:00, 05:00)。⑥ 單盤群 `site_raw` 為 propose／new 一律 ambiguous（照簡報字面）。⑦ 純 W1 無 Triage：`unclear`／`llm_no_intent`／壞 JSON 都只係 `routed=triage` 記錄。⑧ Claude 結構化模式唔傳 temperature（未實測新型號接唔接受，留俾 smoke 驗證）。⑨ **retention 改動**：W0 retention 測試原本斷言 `parsed_json` 保留；因 `parsed_json` 含 LLM 抽出嘅原話片段／人名（PII），90 日後一併置空，該條斷言改為 `null`（intents 解析結果照舊保留）。⑩ `senderKnown`（過濾加分）只認保安員（`sender_guard_id`），冇判頭電話對照。⑪ 子盤（`parent_site_id`）冇展開：更碼只取群綁定盤本身嘅 `shift_types`。⑫ `playwright.config.ts` 加可選 `PW_SERVER_CMD` 覆寫 webServer 指令（預設 dev server 不變），用嚟跑 `next start`。
- 測試：`tests/whatsapp-filter.test.ts`（63：合成訊息 39＋問號規則 14 正反例＋群組／閾值／quoted／長文等）、`whatsapp-dates.test.ts`（37）、`whatsapp-resolve.test.ts`（42）、`whatsapp-parse.test.ts`（15，fake LLM；含 DeepSeek／Claude 結構化請求形狀）、`whatsapp-job.test.ts`（27：端到端 received→intents、noise／壞 JSON／重試 3 次 error／stale、編輯 supersede 含 A→B→A、撤回、quoted 24h、DB 衝突〔已存在／另一更／鎖月／額滿／配額〕、日摘要、retention）、`whatsapp-intents-api.test.ts`（9）、`tests/e2e/wa-w1.spec.ts`（5，含 375px）；`p7-1-scheduler`（job 清單）、`whatsapp-misc`（retention parsed_json）各改 1 條斷言。
- **W1.2（Opus 驗收修正）**：M1 term-guard：intents 頁／route／測試／docs 嘅「安員」顯示稱呼改「保安員」。S1 `dates.ts` 相對 range 分支：凌晨 [00:00,05:00) 若任一相對詞屬當日／翌日類 → `date_ambiguous`（候選＝各詞單日規則聯集）；數字 range 不變。S2 job catch：任何例外都 `failAttempt(…,"process_failed")`（3 次 → error），唔再無限重試打 LLM。N1 LLM `confidence < 0.6` → 原因碼 `low_confidence`，落 triage。N2 「放假／休息／休假」唔再自動對 RD：`leave_code` 留空＋`leave_code_unclear`（triage）；只有明確「例假／RD／OFF」先 RD。N3 few-shot 加「病假3日＝期間，唔係 3 號」負例（date 留 null）＋規則 4 說明。N4 DeepSeek 結構化上限改 4,000（env `WA_DEEPSEEK_MAX_TOKENS` 嚴格 `^\d+$` 且 1,000–8,000，否則 4,000；Claude 路徑仍 2,000）；`LlmChatResult.truncated`（additive）＋撞上限而內容空／JSON 被截 → 加倍（cap 8,000）重試一次，再唔得先 `bad_json`，用量兩次相加。測試：dates +3、resolve +2（並改 放假 斷言）、parse +6、job +1。

## 33 W2（WhatsApp Triage 分流題＋共用排更 write service，基於 `docs/plans/whatsapp-roster-plan.md` §6.2／§6.3／§9 W2；branch `wa-w2-triage`，起點 main `d7c388a`〔W1 已合併〕，未 merge）
- **無 migration、無新 env**（`shift_records.source`／`provenance` 早已存在；`whatsapp_intents.result_ref` W0 已有）。gate:locked-months／gate:ltpay-aug 不變。
- **共用 write service** `src/lib/shift-records/write.ts`：由 `POST /api/shift-records/batch` 抽出 plan 型別、`computePlanPricing`（計價 snapshot）、`applyShiftPlansTx`（clear／update／createManyAndReturn／重用已取消行／audit 一條 createMany）、`computeWarnings`；batch route 保留自己嘅權限／雞頭隔離／逐格驗證，改為 call 呢啲函數，`tests/p3-2-batch-write.test.ts` 等 batch tests **原樣通過**。新入口 `writeShiftCells(tx, { siteId, month, cells, actor, source, provenance, statusPolicy, overwriteActive? })` 同 `cancelShiftRecordsTx`。
- **Triage**：`QuestionKind` 加六種 `wa_*`；session `sourceType="whatsapp"`／`sourceRef=<group_jid>:<YYYY-MM>`；generator `src/lib/whatsapp/triage.ts` 由 `whatsapp_parse` job 喺落 intents 後同 tx 即時開題（`createManyAndReturn` 取 intent id → 寫 `result_ref`）；答題 `triage-answer.ts`（view／preview／submit）＋ `triage-eval.ts`（答題後重跑阻擋評估）；`/api/triage/questions/:id/{preview,answer}`、`/api/triage/sessions/:id` 按 `sourceType==="whatsapp"` 分流；`restrictedKindsFor` 加 WA_KINDS；`batch-accept` 加白名單；UI `WhatsappTriageDialog`（375px）、`/triage` 頁、`/whatsapp/intents` 連結、排更頁「來自 WhatsApp」。細節見 `docs/api.md`「WhatsApp 分診題（W2）」同 `docs/ops.md`。
- **假設與保守取捨（簡報未講清）**：① **owner**：系統冇「用戶↔盤」主管關係，只按 `BrokerSiteAssignment` → 判頭名下屬 TRIAGE_OWNER_ROLES 嘅啟用用戶揾，通常揾唔到 → 老闆（最早建立、啟用中）；全冇先用系統帳號。② session 月份＝**訊息香港日所屬月**（唔用工作日期，因為日期可能未知）。③ alias 學習只有 audit，**冇 journal**（簡報寫「journal＋audit，同 guard-fix link」，但 guard-fix link 實際只有 audit；SimpleWriter 嘅 journal 亦係 no-op）。④ **provenance** 只放簡報指定四個鍵（`message_id`、`revision`、`intent_idx`、`triage_question_id`），冇加群 jid／發訊人 hash（W3 自動寫入再加）。⑤ **鎖月**：答題時 400 固定字串；W1 已判 `month_locked` 嘅 intent 出 `wa_shift_conflict` 只有「人手處理／跳過」。⑥ **輪次**：第 1、2 輪按原因碼優先次序出題，第 3 輪一律 `wa_unparsed`（只剩人手／忽略／跳過）；人手揀過日子或「仍然入更」之後唔再擋 −2～+45 日窗口。⑦ **請假格**要揀一個 `shift_type`（`shift_records` 唯一鍵含更種）：用該保安員喺該盤最近用過嘅更種，冇就該盤第一個（按代號）更種。⑧ `wa_unparsed` 只喺「淨係低信心」時提供「照解析結果入更」；cover／cancel／unclear 只有人手／忽略。⑨ 「人手入更」＝答完當處理咗，另開新分頁去 `/roster/<盤>/<月>?date=&guard=`（排更頁**未做**格子預填，query 只係保留俾日後用）。⑩ `wa_person_unknown` 嘅「新保安員」只係連結去 `/guards/new-from-docs`，唔喺度建人。⑪ 會計見到 WhatsApp 題但標 restricted（冇「更表:create」）；主管只可答自己做 owner 嗰批（現有 `canAccessOwnedBy` 規則）。⑫ 通知 kind `whatsapp_triage`（加入 `NOTIFY_KINDS`），同一 session 同一香港日 dedupe，body 只有數字。⑬ 簡報「新 revision → 舊題 superseded」同「已批核／已答 → 唔自動改」：已答題不動；pending_approval 自動 reject（計劃書 §3.3 (a)）屬 W3 自動寫入範圍，W2 唔做。⑭ `tests/lib/db.ts clearAll()` 加清 `whatsapp` 分診 session／題（否則跨檔累積令冪等判斷失準）；W1 `resolveIntents` 嘅 `ResolvedIntent` 加記憶體限定 `src`（原始片段，唔落 `whatsapp_intents`），`resolveShift`／`normLeave` 改 export。
- 測試：`tests/w2-write-service.test.ts`（10：pending_approval／confirmed、source／provenance、鎖月、重用已取消行、exists no-op、衝突 409／overwrite、請假格、驗證失敗 rollback、取消舊 void audit）、`tests/w2-whatsapp-triage.test.ts`（33：六種 kind 產題、優先次序、owner、冪等、通知無 PII、revision supersede／撤回、答題寫入＋alias＋audit、選項驗證、hash 409、site／date／請假、撞更取消舊同 tx＋forced failure rollback、keep_old／manual／skip、額滿、unparsed／低信心、輪次上限、鎖月 400、RBAC、遮罩、source_changed、intents API 連結、batch-accept 白名單）、`tests/e2e/wa-w2.spec.ts`（5：揀人→寫入→排更頁見「來自 WhatsApp」、取消舊、對照頁深連結、375px、RBAC）。
- **驗證**：vitest 全套 286 檔通過＋1 skipped（4586 passed／10 skipped／0 fail）；Playwright 全套 299 條（295 passed／4 skipped／0 fail，含 wa-w2 五條）；tsc／eslint（0 error）／knip 乾淨；`next build` 成功。`gate:locked-months` 於 main(d7c388a) 同本 branch 各跑一次（獨立 PG port）：各 gate rc 一致（`gate-ltpay-aug` rc=1 係現有 harness diagnostic，兩邊同一組 5 個欄差異）、gate log 正規化 uuid／路徑／時間後相同、`snapshot.json` 正規化後只差時間戳＝數字不變。
- **W2.3（Opus 驗收修正）**：先 `git merge main`（TR-2／TR-2.2，無衝突）。S1 `triage-answer.ts` 嘅 preview 同 submit（共用 `resolveWaPlan`）：要取消舊記錄（`wa_use_whatsapp`，cancelIds 非空）額外要「更表:void」；目標格已有行（含已取消重用）額外要「更表:update」，唔夠權限 403 且冇任何寫入。N1 `leaveRowShiftType` 兩個查詢排除 code `PR` 佔位更別。N2 預覽：被取消記錄含 confirmed／completed／billed／paid → note「⚠ 會取消已確認／已結算記錄（N 條）」置頂，仍可繼續。N3 alias 學習 audit 加 `before`／`after.nameAliases`（經 guards DTO 白名單，用 camelCase 鍵）方便撤銷。測試 +5（S1×2、N1、N2、N3）。


## 34 W3（WhatsApp 自動寫入＋待批清單，基於 `docs/plans/whatsapp-roster-plan.md` §6.1／§6.2／§3.3 補充／§9 W3；branch `wa-w3-autowrite`，起點 main `ed44cbb`〔W2 已合併〕，未 merge）
- **Migration（只加）** `20261020000000_wa_w3_auto_write_cap`：`whatsapp_groups.auto_write_daily_cap`（int，預設 50）。新 env `WA_AUTO_WRITE_ENABLED`（預設開；非 `1`＝關，fail closed）。gate／計價核心／batch route 未改。
- **自動寫入** `src/lib/whatsapp/autowrite.ts`（由 `process.ts` 喺落 intents 之後、開 Triage 題之前、**同一 tx**呼叫）：`routed=auto_write` 且群組 `auto_write=true` 逐條過閘——總開關（`auto_disabled`）→ 信心 ≥0.6（`low_confidence`）→ 每群每日上限（`daily_cap`，按訊息香港日計）→ 同發訊人 5 分鐘去重（`ignored`／`duplicate_recent`）→ tx 內 `isMonthLockedTx`（`month_locked`）→ `writeShiftCells`（statusPolicy＝`auto_confirm ? confirmed : pending_approval`；`source=whatsapp`；provenance `{message_id, revision, intent_idx, sender_guard_id}`；actor＝系統排程帳號）。`result_ref`＝`shift_record_id`、`resolution.auto_write={result:"written"|"no_op",record_id,status}`；寫入前驗證類錯誤（409／400／鎖月 403）→ 改 triage（`conflict_other_shift`／`shift_unmapped`／`month_locked`），DB 錯誤照拋（整條訊息 rollback、`parse_attempts` 機制重試）。請假經同一 service（code＝LeaveCode，更種用 W2 嘅 `leaveRowShiftType`，抽到 `leave-row.ts` 共用）。`TRIAGE_LOCK` 序列化 cap／去重計數同 Triage 答題寫入。`wa_unparsed`「照解析結果入更」選項擴到 `daily_cap`／`auto_disabled`。
- **編輯／撤回後續** `src/lib/whatsapp/source-change.ts`：新 revision（>1）**喺 resolve 之前**處理舊 revision 寫過嘅記錄（`provenance.message_id`、revision 較舊）——`pending_approval` 且當月未鎖 → 取消；其餘（已確認／已批／已結算／鎖月）只標 `source_changed`（`resolution.auto_write.followup`）。撤回由 `whatsapp_parse` tick 處理（`followUpRevokedWrites`，冪等）。
- **待批清單** `/whatsapp/pending`＋`GET /api/whatsapp/pending`、`GET /api/whatsapp/records`；批核／退回走現有 `/api/shift-records/[id]/approve｜reject`；「全選」唔包含 ⚠；排更格 tooltip（群／時間／原話）＋「⚠ 原訊息已被發訊人修改／撤回」橫幅；`/whatsapp` 綁定抽屜加每日上限；對照頁／stats 加 `auto_result`／`auto_results`；日摘要加「自動寫入 N、待批 M、拒絕 K」。細節見 `docs/api.md`「WhatsApp 自動寫入（W3）」、`docs/ops.md`。
- **假設與保守取捨（簡報未講清）**：① **群組 `auto_write=false` 嘅 intent 維持 W1 行為**（`routed=auto_write`、唔寫、唔開題），即使總開關亦然；總開關／cap／低信心等安全閥只對「群組已開自動寫入」嘅 intent 改 triage——否則試點期所有未開群組會突然開滿題。② **自動退回用 `cancelled`（audit `void`）而唔係現有 reject 嘅 `draft`**：draft 仍佔 `(guard,date,shiftType)` 格，新 revision 重寫同一格會被當「已存在」寫唔返；cancelled 行可被 `writeShiftCells` 重用。audit `void_reason`＝`source_message_edited`／`source_message_revoked`（簡報寫 `source_message_edited|revoked`，採完整字串）。手動退回（待批頁）仍走現有 reject（→ draft）。③ 編輯後處理喺 `processWhatsappMessage` 開頭（resolve 前），即使新 revision 被過濾／雜訊亦退回舊 pending；已 confirmed 嘅一律唔動。④ 「同更已存在」W1 resolve 已判 `ignored`；W3 只喺 resolve 之後先出現（併發）時記 `no_op`（`routed` 保持 `auto_write`、`result_ref`＝既有記錄 id）。⑤ 每日上限「已寫」計數包括之後被退回／被取代嘅（寫過就計）；0＝全部分流。⑥ 每日上限／去重只計 `result=written`。⑦ 去重窗口＝新訊息 ts 往前 5 分鐘；同一訊息嘅舊 revision 不計。⑧ 「已拒」＝記錄現狀 `draft`／`cancelled`／冇記錄；「已批」＝其餘非 pending。⑨ `auto_confirm=true` 直接 `confirmed`，不經待批清單（照 §8 決策 2）。⑩ 排更格 tooltip 用 `title`，原話截 120 字；冇「WhatsApp 報更」view 權限（403）靜靜忽略，只剩「來自 WhatsApp」。⑪ 待批清單群組篩選用 raw SQL join `whatsapp_messages`。⑫ **e2e 用 production server**（`npx next start`，見 W1 §32 ⑫）：dev server 首次編譯期間 Fast Refresh 會令 drawer 點擊失效（W0 既有 spec 亦同樣現象，非 W3 引入）。⑬ 日摘要 job 名由「…（dry-run）」改「WhatsApp 報更解析＋自動寫入」（只改 label／description）。
- 測試：`tests/w3-whatsapp-autowrite.test.ts`（29：基本寫入 pending／confirmed／請假／群組關＝dry-run／低信心／鎖月／已存在／撞更；每日上限＋香港日重置＋cap=0；總開關 0／亂碼／1；5 分鐘去重；`autoWriteIntentsTx` 直接測鎖月 race／no_op race／409 race；編輯退回重寫／同格重用／雜訊／已確認只標示／鎖月只標示；撤回 tick 退回＋冪等＋已確認不動；pending API 內容／⚠／RBAC／group 篩選／批核＋退回；records API；intents `auto_result`＋stats `auto_results`；日摘要；群組 cap PATCH）、`tests/e2e/wa-w3.spec.ts`（6：待批清單＋全選唔含 ⚠＋批核＋退回要原因、排更格 tooltip＋⚠ 橫幅、群組抽屜 cap、對照頁、375px、RBAC）。
- **驗證**：vitest 全套 288 檔（287 通過＋1 skipped；4625 passed／10 skipped／0 fail）；Playwright 全套 305 條（281 passed／24 skipped〔既有資料依賴 skip〕／0 fail，3 shard，含 wa-w3 六條）；tsc／eslint（0 error，3 個既有 warning）／knip 乾淨；`next build` 成功。`gate:locked-months` 於 main(`ed44cbb`) 同本 branch 各跑一次（獨立 PG port）：各 gate rc 一致（`gate-ltpay-aug` rc=1 係現有 harness diagnostic，兩邊相同）、gate log 正規化後只差 daemon pid／migration 數／seed 耗時，`snapshot.json` 正規化（uuid／sha／時間戳、陣列排序）後完全一致＝數字不變。
- **W3.2（Opus 驗收修正）**：S1 編輯後取消舊 pending 記錄改為同新 revision 結果**同一 tx**（`process.ts`：`staleEditedPendingIds` 令 resolve／repo 當舊 pending 記錄唔存在；最終 tx 內 `applySourceChangeTx` 先取消再 `autowrite`；被過濾／雜訊嗰條路徑 `ignoreNow` tx 內同樣處理；原先喺 resolve 前另一 tx 取消嘅 `followUpEditedMessage` 已刪）；新 revision 3 次失敗（`failAttempt` giveUp，`status=error`）→ 舊 pending 保留，同 tx 開 `wa_unparsed` 題（reasons 含 `source_edited_failed`，標「原訊息已修改，自動處理失敗」）。N1 `/whatsapp` 頁 health 區同日摘要加「建議自動但群組未開 N」（取 stats `auto_results.suggested`，唔開題）；docs 註明上線前逐群開。N2 `autowrite.ts` 寫入前 tx 內再查同人同日記錄（`FOR SHARE`，其他更種／請假 → `conflict_other_shift`／`conflict_leave`／`conflict_shift_vs_leave`）。N3 `docs/ops.md` 寫明總開關＋群組開關兩者都要開。測試 +5（S1 失敗 3 次保留舊記錄＋開題、S1 寫新失敗舊記錄不取消、N1、N2×2；原「409 race」斷言改為 `conflict_shift_vs_leave`）。

## 35 W4（WhatsApp 請假接病假確認、替更兩段式、取消，基於 `docs/plans/whatsapp-roster-plan.md` §5.2／§6／§8 決策 3／§9 W4；branch `wa-w4-leave-cover`，起點 main `2005e41`〔W3 已合併〕，未 merge）
- **無 migration、無新 env**。gate／計價核心／batch route 未改。
- **請假**：AL／SL／NL／RD／SH ＋ range 逐日展開本來就由 W2／W3 經同一 write service 寫（`pending_approval`）；W4 核對並補 test（各碼、range、range 其中一日已有更、「放假」仍 `leave_code_unclear`）。**補漏**：過濾層 `LEAVE_RE` 冇 RD／SH／NPL 口語（例假／公假／休假／公眾假期／法定假／RD／SH／NPL），「我21號例假」會喺 filter 被丟棄，已補。同日已有更而報請假＝既有 `conflict_shift_vs_leave` → `wa_shift_conflict`；題卡加 `cancel_preview`「會取消 X 月 X 日 X 更」，`existing[]` 加 `work_date`；「以 WhatsApp 為準」取消該更＋寫 leave 同 tx（沿用 W2）。
- **病假接現有確認流程**：長工 SL 草稿（`drafts.ts`／`sl-confirm.ts`）本來就讀 `shift_records` leave SL；但現有讀法係「status≠cancelled」，即 `pending_approval` 已會出草稿／計糧。新 `src/lib/longterm-payroll/approved-only.ts`（`excludeUnapprovedWhatsapp()`）：**`source=whatsapp` 而仍 `pending_approval` 嘅記錄唔計入** aggregate、SL 草稿生成、SL 待確認清單、勤工獎資格；批核後先計。其他來源 `pending_approval` 行為不變。草稿一律 `status=draft`／`doctorNoteVerified=false`（群組 `auto_confirm` 都唔會自動確認病假）。
- **替更 `wa_cover`**（`triage-types.ts`／`triage.ts`／`triage-eval.ts`／`triage-answer.ts`）：新 `QuestionKind` `wa_cover`／`wa_cancel`（加入 `KIND_LABEL`／`WA_KINDS`＝restrictedKinds）；`resolve.ts` 對 cover／cancel 唔再用 `type_not_auto`，改做診斷（被替者配對＋當日同盤同更別記錄 `replaced_record_ids`、替更者撞更 `conflict_*`、取消目標 `existing_record_ids`／`no_cancel_target`）；`pickWaKind(reasons, intentKind)`：cover＝unparsed>site>date>鎖月>`wa_cover`（人／撞更喺題內）；cancel＝unparsed>person>date>鎖月>`wa_cancel`。evidence 加 `cover{replaced_guard_id, replaced_candidate_ids, replaced_record_ids}`、`human.replaced_guard_id`。選項 `wa_cover_confirm`／`wa_cover_add_only`（替更者撞更時改為只有 `wa_use_whatsapp`）。答案 schema 加 `replaced_guard_id`（additive）：**同一題兩個候選列**，一次答案帶齊兩人。確認＝同 tx：被替者該更 `cancelled`（audit `void_reason=covered_by_whatsapp`，**唔寫 leave**）＋替更者 `pending_approval`；被替者冇當日更／揀「只加替更者」＝只寫替更者；替更者同日撞更＝預覽 `can_confirm=false`（409）；`wa_use_whatsapp` 先取消替更者原有記錄。取消要「更表:void」、目標格已有行要「更表:update」。batch-accept 白名單不變（唔收 wa_cover／wa_cancel）。
- **取消 `wa_cancel`**：「取消該更／請假」（`cancelled_by_whatsapp`）、「改為請假（揀碼，`input:"leave_code"`）」＝取消＋同 tx 寫 leave；已係同一請假碼＝當處理咗；冇目標＝`wa_unparsed`；鎖月 400。
- **解析／UI／對照頁**：`parse.ts` few-shot 加「17-19號病假」range、cancel（現有 cover 例子保留）＋規則 9（取消／唔返＝cancel）；`WhatsappTriageDialog` 加替更面板（兩個 `PersonPicker`、揀齊先可預覽）、取消請假碼 select、`cancel_preview` 橫幅；`GET /api/whatsapp/intents` 加 `replaced_guard_name`／`has_replaced`／`replaced_candidate_count`／`replaced_shift_count`／`cancel_target_count`，對照頁顯示「被替者：…／將取消：N 條記錄」。
- **假設與保守取捨（簡報未講清）**：① 替更題輪次上限放寬到 4（一般仍 2）——cover／cancel 要先經盤／日子／人再到確認題，否則第 3 輪會變 `wa_unparsed`。② 替更者撞更「只可以」`wa_use_whatsapp`（連替更者同日原有記錄一併取消）或人手；選咗人先發現撞更＝預覽 `can_confirm=false`＋409，指示人手處理（唔另開題）。③ 被替者記錄＝被替者當日、**同盤**、（更別已知時）**同更別**嘅非取消 shift；冇 → 只寫替更者＋提示。④ 取消目標＝該人當日非取消、非 OT 嘅 shift／leave；有盤口（群組盤或訊息盤）就只限該盤，多盤群無盤口＝全部。⑤ 取消題 `wa_pick_guard` 唔支援「記住花名」（選人只係進下一輪）。⑥ 未批核 WhatsApp 記錄唔計糧係**擴到所有 `source=whatsapp` 嘅 `pending_approval`**（唔限 SL），語意＝批核後先計。⑦ 病假批核之後草稿出現時機＝下次草稿生成（月結／排程／重算），冇加批核即時觸發。⑧ e2e 同 W3 一樣用 production server（`PW_SERVER_CMD="npx next start -p …"`）。⑨ 同日 `vitest --shard` 因檔案次序有兩個既有檔（`p6-4-h9-ai-audit-whitelist`／`p8-2-triage-batch-accept`）次序相依而偶發紅，單檔／不分 shard 全套綠。
- 測試：`tests/w4-whatsapp-leave-cover.test.ts`（27：各碼寫入＋放假、range、range 內撞更、同日有更報請假＋取消預覽、SL 批核先出草稿＋auto_confirm 仍 draft＋其他來源不變、cover 兩人確定／只加／被替者冇更／已有同更／兩個候選／替更者撞更／選後撞更／同 tx 回滾／權限（缺 void／會計）／日子再問／鎖月／batch-accept 排除／對照頁 API、cancel 取消／改請假／回滾／同碼／無目標／人再問＋權限／鎖月、filter 口語）；`tests/whatsapp-resolve.test.ts` +2、`tests/w2-whatsapp-triage.test.ts` 2 條改成新語意；`tests/e2e/wa-w4.spec.ts`（4：替更兩人確定、兩個候選揀齊先可確認、取消改請假、375px）。
- **驗證**：vitest 全套 289 檔（288 通過＋1 skipped；4659 passed／10 skipped／0 fail）；Playwright 全套 309 條（285 passed／24 skipped〔既有資料依賴 skip〕／0 fail，3 shard，含 wa-w4 四條）；tsc／eslint（0 error）／knip 乾淨；`next build` 成功；`gate:ltpay-aug` 於 main(`2005e41`) 同本 branch 各跑一次：rc 一致（rc=1 係現有 harness diagnostic）、輸出（逐人差異表／總額／逐欄差異數）完全一致＝數字不變。
