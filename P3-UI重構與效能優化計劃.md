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
