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
