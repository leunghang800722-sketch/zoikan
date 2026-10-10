# c-ux：UI／UX 同導覽列現況盤點＋問題清單＋重組材料

- 分析 agent：C（代號 `c-ux`），自報 model ID：**claude-opus-5-5**
- 範圍：主 repo `/Users/macbookpro/zoi-kan`（main @ c2b07d0），**只讀**；冇改 code、冇起 server、冇碰 DB、冇讀 `data/`。
- 參考：`~/Desktop/design-MSG/9-10/README.md`＋縮圖 `thumbs/07-roster-uploads.png`（只用嚟理解畫面，冇抄任何人名／盤名／電話）。
- 量度方法：`grep`／`wc -l`／`find` 喺 `src/app/(app)/**`（59 個 .tsx）＋`src/components/**`（28 個 .tsx）共 87 個 .tsx；計數一律係「出現次數」（唔係 unique），除非寫明「distinct」。角色可見性由 `src/lib/rbac/nav.ts` `getNavLinks()`＋`src/lib/rbac/matrix.ts` 出廠矩陣 view 格推算（老闆可以事後改矩陣，以下係**出廠預設**）。
- 角色縮寫：老＝老闆、主＝主管、會＝會計、雞＝雞頭、保＝保安員；✓＝出廠 view grant、○＝出廠 off（老闆可開）、✗＝硬性 deny、*＝唔喺導覽列但可以經網址／其他頁入。
- 鎖月影響：本報告**所有建議都係顯示層／導覽層**，唔改定價、結算、報表口徑；除咗特別標明（§3「鎖月」欄）之外唔使跑 `gate:locked-months`。凡建議「合併頁面」時，只搬 UI、唔改 API，計算邏輯不變。

---

## 0. 五句總結

1. 導覽列老闆見 **23 條連結／5 組**（首頁＋排更 5＋主檔 6＋財務 7＋系統 4），1512×700 視窗要捲先睇到財務組（縮圖 07 側欄有捲軸）；分組按「資料類型」而唔係「做嘢次序」，例如「尚欠總覽」（今日人手）擺咗喺「財務」、「待答問題」（一半係月結題）擺咗喺「主檔」。
2. 「上載／待處理／鎖月」三個概念各自有 **2–5 個入口**：更表 xlsx 可以喺 `/roster-uploads` 同 `/month-close` 上載；U Team 名單／Postorder 可以喺 `/guard-fix` 同 `/month-close` 上載；鎖月可以喺 `/reports/monthly-close` 同 `/month-close`（再加 RightRail）做；「未定價／冇結算單位」警告 Notice 一模一樣複製咗 **5 份**（毛利表、月結工作台、糧明細、本月應收、更表編輯器）。
3. 一致性：月份選擇器 **16 個頁面各自實作**（5 種寫法，只有 3 頁會由網址讀返月份，換頁就跳返本月）；按鈕有 **3 套主色**（`Button primary` 藍、`btnPrimary` 近黑、`Button dark` 近黑）＋198 個手寫 `<button>`（76 種 className）；錯誤提示有 `Banner`／`Notice` 兩套元件；手機斷點有 **5 個**（640/768/1024 CSS＋639/767 JS）。
4. 真 bug（顯示層）：`/month-close` 報告「去長工糧 ›」連去 **`/longterm-payroll`（404）**，正確係 `/reports/longterm-payroll`（`src/app/(app)/month-close/ReportSection.tsx:106`）；雞頭出廠有「雞頭:view」，`getNavLinks()` 會畀佢 `/brokers`，但 `BROKER_GROUP_ORDER` 冇列，結果雞頭導覽列多咗一組「其他 › 雞頭」（unit test fixture 冇包呢條，所以冇捉到）。
5. 「唔需要嘅面板」大多數係 9 月過渡期／緊急 WP 留低嘅：`/guard-fix` 三種 Postorder 上載方式（xlsm＋兩個 CSV＋精簡 CSV，連 CSV 欄名都印出嚟）、`/roster-uploads` 「重新對數全月結果」入面嘅 `roster_only`／`settlement_diff` 英文 key、`layout: …` 技術字、`/reports/monthly-close` 卡標題「§6.3 五條自動對數規則」（因舊 e2e 用字面值揾而保留）、`/brokers` 要用戶手打 JSON 嘅「銀行資料（bank_info，JSON）」欄。

---

## 1. 逐頁盤點（29 頁＋2 個 dashboard 元件）

LOC＝page.tsx＋該頁專屬 client 檔（`wc -l`）；共用對話框另列。S＝server page（再 render client 元件）、C＝`"use client"` page。

| # | 路徑 | 用途（一句） | 老/主/會/雞/保 | S/C | LOC | 面板／區塊／對話框 | 主要動作 | 共用 UI（`components/ui/*`） | 自家寫／重疊 |
|---|---|---|---|---|---|---|---|---|---|
| 1 | `/` | 首頁：內部角色＝尚欠 dashboard；雞頭＝BrokerDashboard；保安員＝快速連結卡 | ✓/✓/✓/✓/✓ | S | 104（＋下兩行） | TriageHomeNotice（待答 N）＋ShortfallDashboard(home)；或 BrokerDashboard；或連結卡 grid | 去答、撳 KPI 跳頁 | PageHeader, Notice | 保安員出廠 0 個 module → 首頁永遠顯示「未開任何模組權限」 |
| 1a | `ShortfallDashboard.tsx` | 今日尚欠＋待審批＋更表對數待處理＋本月毛利進度 | 老主會 | C 元件 | 432 | 頁首（自寫 h1，冇用 PageHeader）、日期 chip、KPI 4 張（桌面）/2×2（手機）、「今日各盤出勤 vs 所需」表（桌面表＋手機卡兩份 markup） | ‹ › 換日、撳行去更表 | KpiCard, Banner, DataTable | **同 `/reports/shortfall` 係同一個元件**，只差 kicker／H1；用 `md:` 斷點（外殼用 `lg:`） |
| 1b | `BrokerDashboard.tsx` | 雞頭首頁 4 KPI＋「我有份嘅盤」 | 雞 | C 元件 | 270 | 頁首（自寫 h1）、KPI 4 張、我有份嘅盤（桌面表＋手機卡） | 換月（網址 `?month=`）、撳卡跳頁 | KpiCard, Banner, DataTable | 用 `md:` 斷點 |
| 2 | `/approvals` | 審批雞頭排嘅更（draft→confirmed／退回） | ✓/✓/○/✗/✗ | C | 398 | 頁首（盤 FilterChip）、Banner×2、待審表（桌面表＋手機卡） | 批、退回、批量 | PageHeader, FilterChip, Button, Pill, DataTable, Banner | 冇月份篩（刻意，同 badge 口徑一致） |
| 3 | `/audit-log` | 操作紀錄唯讀 | ✓/○/○/✗/✗ | C | 288 | 頁首（資料表／操作人／日期／由 4 個 FilterChip）、表、每行 `<details>` 展開 before/after **原始 JSON** | 篩選、載入更多 | PageHeader, FilterChip, Notice, Button, Pill, DataTable | 錯誤用 Notice（大部分頁用 Banner）；冇手機卡 |
| 4 | `/brokers` | 雞頭主檔＋介紹費率子表＋掛邊啲盤 | ✓/✓/✓/✓(*)/✗ | C | 660 | 頁首（月份 FilterChip）、雞頭表（桌面＋手機卡）、「介紹費率」子面板（h2）、Drawer×2（新增／編輯雞頭；新增費率） | 新增、編輯、作廢、加費率 | PageHeader, FilterChip, Drawer, Field, Button, Pill, ConfirmVoidButton, DataTable, Banner | Drawer 內用 `btnPrimary`（近黑）而頁首用 `Button primary`（藍）；**bank_info 要手打 JSON**（:577） |
| 5 | `/change-password` | 改密碼 | 全部 | S | 14＋120 | 單一表單 | 改密碼 | PageHeader, Notice, Button | 唔喺 nav，入口喺側欄底／抽屜底 |
| 6 | `/feedback` | 現場意見清單（開會反映） | 老（助手✓＋baseRole 老闆） | S | 28＋136 | 頁首、表（桌面＋手機卡） | 撳入詳情 | PageHeader, DataTable | — |
| 7 | `/feedback/[id]` | 單一意見詳情 | 老* | S | 30＋143 | 頁首、內容、狀態按鈕 | 改狀態 | PageHeader, Button | 只可以由 #6 入 |
| 8 | `/guard-fix` | 未配對保安員修復（U Team／Postorder → 計劃 → 套用） | ✓/✗/✗/✗/✗ | C | 1026 | ① U Team 名單、①b Postorder（xlsm 拖放＋「兩個 CSV」子面板＋「精簡 CSV」子面板）、② 計算修復計劃（摘要 tile＋要老闆決定清單＋雞頭稱呼對應）、③ 確認套用（inline 確認框）、④ 歷史 runs | 上載、計算、套用、重新套用 | PageHeader, Banner, Button, Field, Pill, EmptyState | 冇用 DataTable（0 個 table）；text-[Npx] 38 個；**上載同 `/month-close` ① 重疊（同一 API `/api/guard-fix/staff-list`、`/api/guard-fix/postorder`）** |
| 9 | `/guards` | 保安員名冊 | ✓/✓/✓/✓(自己)/✗ | S | 39＋2558 | 頁首（搜尋／本月更數月份／90 日到期／識別狀態 4 FilterChip＋「證件資料導入」「用證件新增」「新增保安員」3 掣）、名冊表（桌面＋手機卡）、Drawer（基本欄＋**9 個子區**：所有電話、長工、牌照與證件、員工編號、個人資料、地址、緊急聯絡人、Blacklist、銀行） | 搜尋、新增、編輯、子資源 CRUD | PageHeader, FilterChip, Drawer, Field, Button, Pill, DataTable, Banner(13) | 全系統最大 client 檔；Drawer 用 `btnPrimary/Secondary` 19 次；`window.confirm` 4 個；去導入頁用 `<a>`（整頁 reload） |
| 10 | `/guards/import` | 保安員證件資料批量導入（本機產生嘅導入包） | ✓/✓/✓/✗/✗ | C | 451 | 頁首、上載、預覽表×2（自寫 table class）、套用自動項 inline 確認、覆核清單（h2）、TriageDialog | 上載、套用、逐欄決定 | PageHeader, Banner, Button, Pill, EmptyState | **同 #11、#9 Drawer、#8 套用 四條路都可以建／補保安員**；答題框同 MonthCloseTriageDialog 兩套外觀（README 痛點 06） |
| 11 | `/guards/new-from-docs` | 單人證件 OCR 新增保安員 | 老主會（要 OCR 已配置＋批量導入 c/u/v） | S | 19＋589 | 三步：上載三格→逐欄核對（sticky 證件圖）→預覽寫入；TriageDialog | 辨識、逐欄確認、寫入 | PageHeader, Banner, Button | 唔喺 nav，只可由 #9 掣入 |
| 12 | `/month-close` | 一鍵全月結算（上載→一鍵→進度→報告→鎖定） | ✓/✓(只睇)/✓/✗/✗ | C | 318＋1164（11 個子元件）＋879（`components/month-close`）＋567（MonthCloseTriageDialog） | StageBar、① UploadSection（更表／U Team／Postorder 三格＋details）、② RunSection、③ ProgressSection（10 步）、④ ReportSection（大數卡、長工糧行、AutoSummaryCard、ReviewCard、逐雞頭應付、逐盤收入）、⑤ LockSection（含 MonthHealthCard）、RightRail（sticky：要你睇／鎖月／還原，**同主欄重複三個掣**）、HistorySection（歷史 runs，預設收起）、MonthCloseTriageDialog | 上載、一鍵、重跑、還原、答題、鎖月、下載 Postorder 格式 Excel | PageHeader, Banner, Button | README 痛點：8400px 長；逐雞頭應付≈`/reports/payroll`、逐盤收入≈`/reports/gross-margin`、鎖月≈`/reports/monthly-close`；**:106 死連結 `/longterm-payroll`** |
| 13 | `/my-receivable` | 雞頭本月應收（自己更數×出街價） | 雞（內部角色*：可預覽） | S | 16＋301 | 頁首（月份）、未定價 Notice、冇結算 Notice、P2BStatCard×3、明細表（桌面＋手機卡） | 換月 | PageHeader, FilterChip, Notice, P2BStatCard, DataTable, Banner | 內部角色唔喺 nav 但可以入 |
| 14 | `/quotas` | 雞頭每月每盤每更別配額 | ✓/✓/✓/✓/✗ | C | 425 | 頁首（盤／月份 FilterChip）、EmptyMonthNotice、表（桌面＋手機卡）、Drawer（新增／編輯配額，內有第二個 month input） | 新增、編輯、作廢 | PageHeader, FilterChip, Drawer, Field, Button, Pill, EmptyMonthNotice, ConfirmVoidButton, DataTable, Banner | Drawer 用 `btnPrimary` |
| 15 | `/rate-cards` | 價目（收客／出街價卡） | ✓/✓/✓/✓/✗ | S | 24＋746 | 頁首（盤／生效月 FilterChip＋複製上月＋重新計价）、表（桌面＋手機卡）、Drawer（新增價目） | 新增、複製上月、重新計价、作廢 | PageHeader, FilterChip, Drawer, Field, Button, Pill, ConfirmVoidButton, DataTable, Banner | `window.confirm` 2 個；「計价」用簡體「价」 |
| 16 | `/reports/gross-margin` | 毛利即時表 | ✓/○/✓/✗/✗ | C | 340 | 頁首（只睇／月份）、未定價 Notice、冇結算 Notice、EmptyMonthNotice、P2BStatCard×3、表（桌面＋手機卡） | 換月、篩選、撳行去更表 | PageHeader, FilterChip, Notice, P2BStatCard, EmptyMonthNotice, DataTable, Banner, Button | Notice 塊同 #18/#20/#13/#25 複製 |
| 17 | `/reports/longterm-payroll` | 長工糧（合約、計糧、人手輸入、平均工資、假期餘額、autopay 檔） | ✓/✗/✓/✗/✗ | C | 938 | 頁首（‹ 月份 › ＋重算本月）、鎖定 Banner、① 總額卡×5（**自寫**，冇用 KpiCard/P2BStatCard）、② 逐人結算表、BOCHK autopay 檔、人手輸入項、合約管理（含 Maxwell CSV 上載）、平均工資、假期餘額 → **7 個區塊直排** | 重算、匯出 autopay、人手輸入、合約 CRUD、上載 CSV | PageHeader, Banner, Button, Field, Pill, DataTable(5 表) | 月份選擇器第 4 種寫法（Button ‹ ›＋inputCls） |
| 18 | `/reports/monthly-close` | 月結工作台（生成月結總表＋5 條對數規則＋鎖定／解鎖） | ✓/○/✓/✗/✗ | C | 680＋173（MonthHealthCard，同 #12 共用） | 頁首（月份＋**4 個掣**：匯出 Excel／下載 Postorder 格式／重算介紹費／重新 Generate）、未定價 Notice、冇結算 Notice、EmptyMonthNotice、「§6.3 五條自動對數規則」卡、月結總表（h2）＋額外盤 details、右邊 sticky 狀態卡（鎖定／解鎖＋未上載盤清單＋MonthHealthCard） | Generate、鎖、解鎖、匯出、重算介紹費 | PageHeader, FilterChip, Notice, Pill, EmptyMonthNotice, DataTable, Banner, Button | **鎖月同 #12 重複**；MonthHealthCard 兩頁都出 |
| 19 | `/reports/ops-digest` | 每月修正摘要（類別趨勢） | ✓/○/✓/✗/✗ | C | 252 | 頁首（月份）、9 類別數字卡、AI 解讀掣、連續出現嘅問題、類別明細、修正量 Top 5 盤、Top 雞頭代號、基線指標 | 換月、問 AI | PageHeader, FilterChip, Button, Pill, DataTable(1/2 表), Banner | 一張表自寫 class（:216） |
| 20 | `/reports/payroll` | 糧明細（按雞頭／結算單位） | ✓/○/✓/✗/✗ | S | 15＋299 | 頁首（月份＋重新計价）、未定價 Notice、冇結算 Notice、EmptyMonthNotice、表（桌面＋手機卡） | 換月、重新計价（`window.alert/confirm`×3） | PageHeader, FilterChip, Notice, EmptyMonthNotice, DataTable, Banner, Button | — |
| 21 | `/reports/shortfall` | 尚欠總覽 | ✓/✓/✓/✗/✗ | S | 11（＋432 共用） | 同 1a | 同 1a | 同 1a | **同首頁內容 100% 相同**（只差標題） |
| 22 | `/roles` | 角色權限矩陣 | ✓/✗/✗/✗/✗ | C | 337 | 頁首、角色揀選＋複製角色、105 格矩陣（自寫 grid，冇 table） | 開關格、儲存、複製角色 | PageHeader, Notice, Button, ConfirmVoidButton, Field | 錯誤用 Notice |
| 23 | `/roster-uploads/[id]/reconcile` | 更表 vs 系統對數 | 老主會* | S | 11＋889＋193 | 頁首、Banner×3、7 分類 tab 計數、子盤未定批量、差異表（桌面）＋卡（手機）、UnresolvedCells、確認套用 modal | 逐行決定、全部以更表為準、套用 | PageHeader, Banner, Button, DataTable | 只可由 #24「對數」掣入；text-[Npx] 40 個 |
| 24 | `/roster-uploads` | 逐盤上載更表 xlsx | ✓/✓/✓/✗/✗ | C | 1046 | 頁首（月份／顯示已作廢／重新對數全月）、執行緊提示、**重新對數全月結果**面板、上載區（盤下拉＋拖放＋隊列）、逐盤狀態表（桌面＋手機卡，60 幾行大半「未上載」）、已作廢記錄表、逐上載詳情（篩選＋警告＋逐格表） | 上載、指定盤、睇詳情、對數、作廢、重新解析、重新對數全月 | PageHeader, FilterChip, Button, Pill, Field, ConfirmVoidButton, DataTable, Banner | **同 #12 ① 重疊（同一 API `/api/roster-uploads`）** |
| 25 | `/roster/[site]/[month]` | 更表編輯器（格仔表） | 老主會雞* | S | 20＋2792 | 手機專屬頁首、雞頭統計卡（桌面）／雞頭 chips（手機）、鎖定提示、未定價 Notice、冇結算 Notice、格仔表、手機底部更別鍵盤、右鍵選單、儲存 Toast | 填更、整行填、加保安員、複製上月、匯出、重新計价、儲存 | Notice | **冇用 PageHeader／Button／DataTable**；hex 色值 56 個（全系統最多）；`window.alert/confirm`×4 |
| 26 | `/roster` | 更表索引：揀盤揀月 | ✓/✓/✓/✓/✗ | C | 184 | 頁首、EmptyMonthNotice、「開啟更表」表單（盤＋月份）、「最近開過」、月份總覽 | 開啟編輯器 | PageHeader, Banner, Button, Pill, EmptyState, EmptyMonthNotice, Field | 月份用 inputCls（唔係 FilterChip） |
| 27 | `/sites` | 盤主檔＋更別子表 | ✓/✓/✓/✗/✗ | C | 782 | 頁首、盤表（桌面＋手機卡）、Drawer「新增／編輯盤」、Drawer「更別——盤名」（內有自寫 table :725） | 新增、編輯、作廢、改更別 | PageHeader, Drawer, Field, Button, Pill, ConfirmVoidButton, DataTable, Banner | Drawer 用 `btnPrimary` |
| 28 | `/triage` | 待答問題（導入分診＋一鍵結算題 session 列表） | ✓/✓/✓/✗/✗ | C | 151（＋TriageDialog 699＋MonthCloseTriageDialog 567） | 頁首、「只睇我自己」勾、session 卡列表（含已處理晒／已被取代嘅舊卡）、轉交下拉＋掣、兩種答題 dialog | 繼續答、轉交 | PageHeader, Banner, Button, Pill, EmptyState | 同一頁開兩套外觀唔同嘅答題框 |
| 29 | `/users` | 用戶帳號 | ✓/✗/✗/✗/✗ | S | 13＋444 | 頁首（角色 FilterChip）、Notice×3、表、Drawer（新增／編輯） | 新增、編輯、重設密碼、停用 | PageHeader, FilterChip, Notice, Drawer, Field, Button, DataTable | 錯誤用 Notice；Drawer 用 `btnPrimary`；冇手機卡 |

全域常駐（每頁都有）：DesktopNav（216px 左欄）／MobileNav（漢堡）、AiAssistantSidebar（老主會右邊 tab，767 行）、ChunkErrorReload、SessionRefresh、MustChangePwdGate。

### 1.1 重疊功能矩陣

| 概念 | 出現位置（檔:行） | 觀察 |
|---|---|---|
| 「待處理」 | 側欄 badge `/triage`、`/approvals`、`/feedback`（`layout.tsx:40-52`）；首頁 TriageHomeNotice＋KPI「待審批」「更表對數待處理」（`ShortfallDashboard.tsx:292,318`）；`/month-close` StageBar「N 題要你睇」＋ReviewCard＋RightRail＋LockSection「仲差 N 樣」＋MonthHealthCard；`/reports/monthly-close` 規則差異＋未上載盤清單＋MonthHealthCard；`/guard-fix`「要老闆決定」；`/roster-uploads` 未配對欄；`/roster-uploads/[id]/reconcile` 未配對 tab | **9 個地方各自計「待處理」**，口徑唔同（題／更／格／盤／項），冇一個總收件箱；「更表對數待處理」KPI 連去 `/roster-uploads`（列表），唔係直接去要處理嗰個 reconcile |
| 上載更表 xlsx | `/roster-uploads`（:592 拖放）、`/month-close` UploadSection | 同一 API，兩個 UI；後者冇「指定盤」「睇詳情」 |
| 上載 U Team 名單 | `/guard-fix` ①（:586）、`/month-close` UploadSection | 同一 API `/api/guard-fix/staff-list`（`month-close/page.tsx:110`） |
| 上載 Postorder | `/guard-fix` ①b（:629，三種方式）、`/month-close` UploadSection（只 xlsm） | 同一 API `/api/guard-fix/postorder`（`month-close/page.tsx:136`） |
| 鎖月 | `/reports/monthly-close` 右欄狀態卡、`/month-close` LockSection＋RightRail（:58） | 同一 API `/api/month-closes/{id}/lock`；MonthHealthCard 兩頁都 render |
| 下載 Postorder 格式 Excel | `/reports/monthly-close` 頁首、`/month-close` 頁首 | 兩個掣同一 URL |
| 重算／重新計价 | `/rate-cards`、`/reports/payroll`、`RosterEditor`、`/reports/monthly-close`（重算介紹費）、`/reports/longterm-payroll`（重算本月）、`/roster-uploads`（重新對數全月）、`/month-close`（重跑） | 7 個「重算」掣散落；老闆難分邊個先邊個後 |
| 新增／補保安員 | `/guards` Drawer、`/guards/new-from-docs`（單人 OCR）、`/guards/import`（批量導入包）、`/guard-fix` 套用（批量建人）、`/month-close` 一鍵（保安員修復步） | 5 條路 |
| 逐盤收入／毛利 | `/reports/gross-margin`、`/month-close` ReportSection「逐盤收入」、首頁毛利進度卡 | — |
| 逐雞頭應付 | `/reports/payroll`、`/month-close` ReportSection「逐雞頭應付」 | — |
| 尚欠 | `/`、`/reports/shortfall` | 同一元件 |
| 答題框 | `TriageDialog`（699 行）、`MonthCloseTriageDialog`（567 行） | 兩套外觀（README 痛點 06） |
| 報表篩選器 | 7 個 reports 頁各自 `useState(currentMonthStr())`＋各自 FilterChip／input | 見 §3 月份選擇器 |

---

## 2. 「可能唔需要／可以隱藏」面板候選

| # | 位置（檔:行） | 顯示乜 | 點解懷疑冇用／重複 | 建議 | 風險 |
|---|---|---|---|---|---|
| H1 | `guard-fix/page.tsx:711-767` | Postorder「或者上載兩個 CSV」子面板（含 Google Sheets 匯出教學） | WP-POSTORDER-CSV 9 月緊急 workaround（正式站讀唔到 xlsm）；README 講明 Postorder 係「8、9 月過渡期」 | 收入「其他上載方式」`<details>`，或者 10 月後刪 | 低；10 月如仲要靠 CSV 先要保留（問老闆） |
| H2 | `guard-fix/page.tsx:767-818` | 「或上載精簡長工組合 CSV（longterm-pairs.csv）」，連 `site_label,site_short,guard_name,cell_count` 欄名都印出 | 產生佢嘅 script 已刪（:765 註解）；同 H1 一樣係過渡 | 刪或收起 | 低 |
| H3 | `guard-fix/page.tsx:975-1010` | 「歷史 runs」卡列表（英文 runs） | README 痛點「一堆相同卡」 | 預設收起（同 `/month-close` HistorySection 一樣）、改「過往紀錄」 | 低 |
| H4 | `roster-uploads/page.tsx:560-600` | 「重新對數全月結果」面板：`roster_only`／`settlement_diff` 英文 key、補價格數、per-upload 清單 | 技術 debug 性質，老闆睇唔明 key | 改人話＋預設只顯示一句總結，明細收起 | 低（純文字） |
| H5 | `roster-uploads/page.tsx:927` | 詳情頭 `layout: {layout_key}` | 解析器內部 key，debug | 刪或搬入「技術明細」 | 無 |
| H6 | `roster-uploads/page.tsx` 逐盤狀態表 | 60 幾行，大半「未上載」灰行 | README 痛點 07：要處理嘅淹冇咗 | 預設篩「有嘢要做」（未配對>0／未對數），「未上載」摺埋做一行計數 | 低；要保留「顯示全部」 |
| H7 | `reports/monthly-close/page.tsx:470` | 卡標題「§6.3 五條自動對數規則」 | 設計文件章節號外露，只為 `tests/e2e/wp4.spec.ts` 字面值揾而保留 | 改 e2e selector（testid）後改標題 | 低；要同步改 e2e |
| H8 | `reports/monthly-close/page.tsx:355-372` | 頁首 4 個掣（匯出／Postorder 格式／重算介紹費／重新 Generate） | 「重算介紹費」「Postorder 格式」係過渡期工具；Generate 英文 | 主掣留「生成月結」，其餘入「更多 ▾」 | 低；**按掣行為不變**，唔觸及口徑 |
| H9 | `gross-margin/page.tsx:162-196`、`monthly-close/page.tsx:408-440`、`payroll/PayrollReportClient.tsx:162-197`、`MyReceivableClient.tsx:185-200`、`RosterEditor.tsx:2178-2230` | 「N 更未定价」＋「N 格冇結算單位」兩塊 Notice，**5 份複製** | 同一警告逐頁重講，冇「去處理」連結 | 抽成共用 `<UnpricedNotice>`，報表頁收成一行＋「去處理 ›」（連去價目／更表）；完整清單只喺月結頁出 | 低；**唔改數字口徑**，只改顯示 |
| H10 | `ShortfallDashboard.tsx` 經 `reports/shortfall/page.tsx` | 「尚欠總覽」頁 | 同首頁內容一樣 | 從 nav 拎走（首頁已經係佢），路徑保留做 KPI 連結目標或 redirect `/` | 低；e2e 可能有用到路徑 |
| H11 | `month-close/RightRail.tsx:35,58,74` | sticky 右欄：答題／鎖月／還原三個掣 | 同主欄 ReviewCard／LockSection／AutoSummaryCard 掣重複 | 桌面保留 RightRail 做唯一 CTA 區，主欄內同樣掣刪；或者反過來 | 中：要確認 e2e testid（`rail-*`、`undo-auto-rail`） |
| H12 | `month-close/ProgressSection.tsx` | 10 步進度＋技術明細（key=value） | README 痛點：③ 進度紅字同 ④「要人決定」講兩次 | 跑完後摺成一行「10/10 步完成」，有錯先展開 | 低 |
| H13 | `month-close/HistorySection.tsx:26` | 「歷史 runs」 | 英文；已預設收起 | 改字「過往執行紀錄」 | 無 |
| H14 | `triage/page.tsx:83-125` | 已處理晒／已被取代嘅 session 卡＋每張卡嘅轉交下拉 | README 痛點 04/20：舊卡佔位，轉交好少用 | 預設只顯示「有未答」；轉交收入「⋯」選單 | 低 |
| H15 | `reports/ops-digest/page.tsx:203-250` | Top 雞頭代號、基線指標表 | 基線指標係 ops 量度用，老闆／會計日常唔睇 | 收起成 `<details>` | 無 |
| H16 | `audit-log/page.tsx:259-263` | 展開 before/after 原始 `JSON.stringify` | 技術資料 | 保留（審計需要），但改 key→中文欄名 diff 表；低優先 | 無 |
| H17 | `brokers/page.tsx:577` | 「銀行資料（bank_info，JSON）」文字框要人手打 JSON | 唔係一般用戶做得到 | 改成「銀行名／戶口號」兩格 | 中：涉及銀行資料欄（PII），要守 `staff-data-sources` 規則 |
| H18 | `guards/GuardsClient.tsx:1862-2500` | 保安員 Drawer 9 個子區直排 | Drawer 太長，主管／會計大部分子區無權改 | Drawer 改 tab（基本／證件／聯絡／長工／銀行），無權嘅 tab 隱藏 | 中：權限遮罩邏輯要保持 |
| H19 | `reports/longterm-payroll/page.tsx` | 7 區塊直排 | 一頁做晒合約管理＋計糧＋設定 | 拆 tab：本月糧／人手輸入／合約／平均工資與假期 | 低；**唔改計糧**，鎖月唯讀邏輯照用 |
| H20 | `DesktopNav.tsx:85`、`MobileNav.tsx:150` | 「登出會同時登出所有裝置」常駐細字 | 每頁都出 | 搬入登出確認 tooltip | 無 |
| H21 | `(app)/page.tsx:73-100` | 保安員角色首頁「未開任何模組權限」 | 保安員出廠 0 module（P4 先做），登入只見空白 | 保安員登入改顯示說明頁或者唔畀登入（產品決定） | 低 |
| H22 | `guards/import/page.tsx` 成頁 | 「上載本機產生嘅導入包」 | 要本機 script 產生導入包，屬一次性資料遷移工具 | nav 降級：搬去 `/guards` 頁內「更多 ▾」或「系統 › 資料導入」 | 低；主管／會計 §28.4 開咗權，搬位唔改權限 |

---

## 3. 一致性審計（數字）

| 項目 | 量度 | 結果 | 備註 |
|---|---|---|---|
| PageHeader 用法 | `grep '<PageHeader'` | 29 個檔用（含 feedback 嘅 server＋client 兩層重複出）；**冇用**：`ShortfallDashboard`、`BrokerDashboard`（自寫 h1，為手機/桌面兩版 heading）、`RosterEditor`（自寫手機頁首） | kicker：`/month-close`「財務」但 nav 叫「一鍵結算」、頁標題「一鍵全月結算」；nav「糧明細」vs 標題「糧明細（按雞頭）」；nav「證件資料導入」vs 標題「保安員證件資料導入」 |
| 分組真相來源 | 檔數 | **3 份**：`nav.ts` `INTERNAL_GROUP_ORDER`、`nav-active.ts` `INTERNAL_KICKER_BY_HREF`、各頁寫死 kicker 字串 | 改導覽要同步 3 處，易走樣 |
| 月份選擇器 | `grep 'type="month"'` | 19 處（16 個頁面級篩選＋3 個表單欄）；**5 種寫法**：①FilterChip 包原生 input（10 頁：brokers, quotas, roster-uploads, my-receivable, guards, gross-margin, monthly-close, ops-digest, payroll, rate-cards）②inputCls/selectCls 表單式（roster, guard-fix）③自寫 ‹ input › 框（month-close）④Button ‹ ›＋inputCls（longterm-payroll）⑤網址 `?month=`／`?year&month`（BrokerDashboard、RosterEditor） | 只有 3 頁（BrokerDashboard、guard-fix、roster-uploads）會讀網址月份；**換頁月份冇保留**，會計做 9 月月結要喺每頁再揀一次 |
| 表格樣式 | `grep '<table'` | 38 個真 table；29 個用 `tableCls`；9 個自寫（約 7 種 className，例：`w-full text-[12.5px]`、`w-full text-xs`、`min-w-full text-[11.5px]`）；23 個 `<th>` 唔用 tableCls | 自寫表集中喺 guards/import、new-from-docs、ops-digest、sites 更別 Drawer、month-close 子卡、RosterEditor |
| 按鈕變體 | `grep` | `<Button>` 121 次（primary 43／secondary 36＋無 variant 30／dark 5／danger 5）；`btnPrimary` 16＋`btnSecondary` 29（`Field.tsx:22-23`，**`bg-gray-900` 近黑**，唔同 `Button primary` 嘅藍 `#2563eb`）；手寫 `<button>` **198 個、76 種 className**；`<a>`/`Link` 扮掣 5 個 | 「主要動作」喺頁首係藍、喺 Drawer 係黑 → 兩套主色 |
| 確認方式 | `grep` | `window.confirm/alert` 14 處（guards 4、payroll 3、rate-cards 2、month-close 1、RosterEditor 4）；`ConfirmVoidButton` 17；inline 自寫確認框 ≥3（guard-fix、guards/import、reconcile modal）；UndoBar 1、UndoToast 1 | 4 套確認 UX |
| 錯誤／成功提示 | `grep` | `<Banner kind="error">` 44、`<Notice variant="error">` 8（audit-log、roles、users、change-password 用 Notice）、`text-red-[67]00` 手寫 37 | 兩套元件，外觀唔同（Banner `rounded text-sm`；Notice 圓點 12.5px） |
| 載入狀態 | `grep` | 「載入緊…」純文字 26 檔／`載入中…` 1 檔；skeleton／spinner **0** | 一致（全部純文字），但冇 skeleton，表格閃動 |
| 空狀態 | `grep '<EmptyState'` | 28 次；自寫空字 2 處；`EmptyMonthNotice`（跳去最近有資料月）只用喺 5 頁（quotas, roster, gross-margin, monthly-close, payroll） | 其餘月份頁（brokers, roster-uploads, ops-digest, longterm-payroll, my-receivable）冇「跳去有資料月」 |
| 硬編碼色值 | `grep -iE '#[0-9a-f]{6}'` | **398 次、50 個 distinct**；其中 331 次嘅值同 `--zk-*` token 一模一樣（即可以直接換 token），67 次唔喺 token 表；16 次喺註解 | 最多：RosterEditor 56、MonthCloseTriageDialog 12、ReportSection 10、monthly-close 9、ShortfallDashboard 9；`#334155`（=`zk-text-secondary`）49 次、`#2563eb`（=`zk-primary`）31 次 |
| arbitrary 色 class | `grep '(bg|text|border|…)-\[#'` | 232；`bg-[…]` 69；inline `style={{…}}` 115 | — |
| Tailwind 原生色板 | `grep '(bg|text|border)-(red|green|blue|amber|orange|gray|…)-NNN'` | **321** 次 | 第三套色系（`zk-*` token 用 1156 次） |
| 字號硬編碼 | `grep 'text-\[Npx\]'` | **662 次、20 個 distinct 值**（13px 153、12.5px 111、11.5px 108、12px 104、11px 84、13.5px 32、14px 20、15px 14、10.5px 9 …以及 9.5/16/18/19/20/21/22/26/28/30px）；另 `text-xs` 137、`text-sm` 83 | 12 / 12.5 / 11.5 / 11 四個細字號混用，冇 type scale |
| 「安員」殘留 | `grep -E '(^|[^保])安員'` 非註解 | 畫面字面值 **0**（剩低全部係 permission key／regex）✓ | 動態：`(app)/page.tsx:76` 同 `ShortfallDashboard` 嘅 `roleLabel` 用 `session.roleName` 原值冇經 `uiLabel()`（layout 有經）；自訂角色名含「安員」時會漏網——低風險 |
| 繁簡混用 | `grep '价'` 非註解 | **30 行**用簡體「价」（「未定价」「重新計价」「計价緊…」），散喺 gross-margin、monthly-close、payroll、rate-cards、RosterEditor、my-receivable | 應該係「價」；純文字修正 |
| 手機斷點 | `grep '(sm|md|lg|xl):'`＋JS `matchMedia` | **5 個門檻**：外殼 `lg`(1024)／AI 側欄 JS 1024、dashboard `md`(768)／MonthCloseTriageDialog JS 767、大部分頁 `sm`(640) 表↔卡切換、RosterEditor JS 639 | 768–1023px（平板）：外殼係手機漢堡，但 dashboard 出桌面 KPI、報表出桌面表 |
| 手機版逐頁 | 有冇 `sm:hidden`/`md:hidden` 卡片版 | **有卡片版（13）**：首頁兩個 dashboard、approvals、brokers、feedback、guards、my-receivable、quotas、rate-cards、gross-margin、payroll、reconcile、roster-uploads、sites；**冇（淨係橫捲表／直排）**：audit-log、users、roles、longterm-payroll、monthly-close、ops-digest、triage、guards/import、guard-fix、month-close（靠 grid 摺）、roster（無表）；RosterEditor 有專屬手機模式（底部鍵盤） | 老闆手機最常用嘅 `/month-close` 冇專門手機版面（README 痛點 14-19） |

---

## 4. 導覽列現況

### 4.1 逐角色（出廠矩陣推算；`layout.tsx`→`getNavLinks()`→`groupNavLinks()`）

| 組 | 老闆（23） | 主管（13） | 會計（17） | 雞頭（7） | 保安員（1） |
|---|---|---|---|---|---|
| （冇標題） | 首頁 | 首頁 | 首頁 | — | 首頁 |
| 排更 | 更表、更表上載、未配對保安員修復、配額、審批隊列〔badge〕 | 更表、更表上載、配額、審批隊列〔badge〕 | 更表、更表上載、配額 | 首頁、更表、配額 | — |
| 主檔 | 盤、保安員、證件資料導入、待答問題〔badge〕、雞頭、價目 | 盤、保安員、證件資料導入、待答問題〔badge〕、雞頭、價目 | 同主管 | — | — |
| 財務 | 毛利即時表、月結工作台、每月修正摘要、糧明細、尚欠總覽、一鍵結算、長工糧 | 尚欠總覽、一鍵結算（只睇） | 毛利即時表、月結工作台、每月修正摘要、糧明細、尚欠總覽、一鍵結算、長工糧 | — | — |
| 系統 | 用戶管理、角色權限管理、操作紀錄、現場意見〔badge〕 | （整組冇） | （整組冇） | — | — |
| 我的 | — | — | — | 本月應收、保安員、價目 | — |
| 其他 | — | — | — | **雞頭**（`/brokers`；見下） | — |

- 任務簡報講「內部角色 5 組 24 條」——實測老闆係 5 組 **23 條**（含首頁；現場意見要「助手:view」＋老闆）。
- **雞頭多咗「其他 › 雞頭」**：`matrix.ts` BROKER `雞頭: row(G,…)`，`nav.ts:113` `push("/brokers","雞頭","雞頭")` 冇排除雞頭，而 `BROKER_GROUP_ORDER`（`nav.ts:150-153`）冇列 `/brokers` → 落「其他」組。`tests/rbac-nav-groups.test.ts:30-37` 嘅 `BROKER_LINKS` fixture 冇呢條，所以測試冇捉到。（推斷自出廠矩陣，建議 runtime 用雞頭帳號核一次。）
- 次序問題：「財務」組次序係 毛利→月結工作台→修正摘要→糧明細→尚欠→一鍵結算→長工糧，同實際流程（一鍵結算→月結工作台→糧明細／長工糧）倒轉；「尚欠總覽」係今日人手，唔係財務。
- 高度：老闆 23 條＋4 個組標題，每條約 32px（`py-[7px]`＋13.5px 字）≈ 1000px 連 logo／用戶區；1512×700 截圖（`thumbs/07`）側欄有捲軸，財務／系統組要捲先見。

### 4.2 Badge 來源（`layout.tsx:33-52`，server 每次 render 查一次 DB）

| 連結 | 計數 | 條件 |
|---|---|---|
| `/approvals` | `shiftRecord.count(status=pending_approval)`（唔篩月） | 有「審批:view」 |
| `/triage` | `countOpenFor(session)`（老闆全部、其他人自己上載嗰批） | 有「導入分診:view」 |
| `/feedback` | `feedbackReport.count(status=new)` | 老闆＋助手 |

冇 badge 但有「待處理」嘅：一鍵結算（要你睇 N）、更表上載（未配對／未對數）、未配對保安員修復（要老闆決定）、月結工作台（規則差異）。

### 4.3 同首頁重複嘅入口

| 首頁元素 | 對應 nav 連結 | 問題 |
|---|---|---|
| 尚欠 KPI＋表 | 財務 › 尚欠總覽 | 同一元件 |
| 待審批 KPI | 排更 › 審批隊列（有 badge） | 重複，但 OK；**會計出廠「審批:view」係 ○，首頁 KPI 照出、撳落去 API 403**（`ShortfallDashboard.tsx:292`） |
| 毛利進度卡 | 財務 › 毛利即時表 | **主管出廠「毛利即時表」○，卡照出、連結照撳**（`ShortfallDashboard.tsx:304,320`） |
| 更表對數待處理 KPI | 排更 › 更表上載 | 連去列表唔係去對數頁 |
| TriageHomeNotice | 主檔 › 待答問題（有 badge） | 重複提示（OK） |
| 冇 | 一鍵結算 | 首頁冇月結進度入口——但月結係老闆每月最重要流程 |

### 4.4 連結深度：唔喺 nav、只可以由其他頁入

| 頁 | 入口 | 層數 |
|---|---|---|
| `/roster/[site]/[month]` | `/roster` 表單／最近開過、首頁尚欠表撳行、毛利表撳行、BrokerDashboard | 2 |
| `/roster-uploads/[id]/reconcile` | `/roster-uploads` 每行「對數」 | 2 |
| `/guards/new-from-docs` | `/guards` 頁首掣 | 2 |
| `/feedback/[id]` | `/feedback` 撳行 | 2 |
| `/change-password` | 側欄底／抽屜底、MustChangePwdGate | 1（非 nav） |
| `/my-receivable`（內部角色） | 冇任何入口（只可以打網址） | — |
| `/reports/longterm-payroll` | nav＋`GuardsClient` 連結＋**`/month-close` 連錯去 `/longterm-payroll`（404）** | — |

即 29 頁入面 **6 頁唔喺 nav**；其中 reconcile 同 roster editor 係日常高頻頁，但都要兩層先到。

---

## 5. 重組建議材料（唔定案，畀規劃者整合）

### 5.0 兩個方案共用嘅 quick wins（同導覽架構無關，純顯示層，唔觸及鎖月口徑）

1. 修死連結 `ReportSection.tsx:106` → `/reports/longterm-payroll`。
2. `BROKER_GROUP_ORDER` 決定雞頭見唔見 `/brokers`（加入「我的」或者喺 `getNavLinks` 排除），並補 test fixture。
3. 首頁 KPI 卡按 grants 顯示（會計無審批 view 就唔出「待審批」卡；主管無毛利 view 就唔出毛利卡／唔加 href）。
4. 「价」→「價」（30 行）；「Generate」「runs」「layout:」「§6.3」改人話（§6.3 要同步改 e2e selector）。
5. 共用 `<MonthPicker>`（‹ 月份 ›）＋網址 `?month=` 同步＋sessionStorage 記住上次揀嘅月，16 個頁面換用。
6. 未定價／冇結算 Notice 抽成一個共用元件（H9）。
7. `btnPrimary/btnSecondary` 改成 `Button`；Banner/Notice 合一；hex→token（331 次可以機械替換）。
8. 一份 `NAV_SCHEMA`（href→組→kicker→label）取代 3 份分組真相（nav.ts／nav-active.ts／頁內 kicker）。

### 5.1 方案 A：按工作流（每月做嘢次序）

第一層（內部角色 ≤6）：**首頁 · 排更 · 對數 · 月結 · 資料 · 設定**

| 第一層 | 第二層（tab／子頁） | 合併／降級 | 老 | 主 | 會 |
|---|---|---|---|---|---|
| 首頁（待辦中心） | 今日尚欠、待辦收件箱（審批 N／待答題 N／未對數 N／要老闆決定 N／月結進度） | `/reports/shortfall` 併入首頁 tab；TriageHomeNotice 變收件箱一格 | ✓ | ✓ | ✓ |
| 排更 | 更表（索引→編輯器）、配額、審批（badge） | — | ✓ | ✓ | ✓（審批○） |
| 對數 | 更表上載（列表預設只顯示有嘢做）、對數（reconcile 作為上載行展開）、未配對保安員修復（老闆） | `/guard-fix` 降級為「對數」入面一個 tab；Postorder CSV 收「其他上載方式」 | ✓ | ✓ | ✓ |
| 月結 | 一鍵結算（主流程）、待答問題、月結工作台（規則＋總表）、報表：毛利／糧明細／長工糧／修正摘要 | 鎖月只留喺一鍵結算（月結工作台改唯讀總表＋解鎖）；`/triage` 變月結 tab（導入題留喺「資料 › 保安員」）；報表 4 頁做同一頁 4 tab，共用月份 | ✓ | 一鍵結算（只睇） | ✓ |
| 資料 | 盤（含更別）、保安員（含證件導入／用證件新增做頁內掣）、雞頭（含介紹費率）、價目 | `/guards/import`、`/guards/new-from-docs` 由 nav 降級做 `/guards` 頁內「新增 ▾」 | ✓ | ✓ | ✓ |
| 設定 | 用戶、角色權限、操作紀錄、現場意見 | — | ✓ | ✗ | ○（操作紀錄） |

雞頭（≤3）：**首頁 · 排更（更表／配額）· 我的（本月應收／自己保安員／價目／我的資料）**

- 優點：跟老闆每月實際次序（排更→上載對數→一鍵月結→出糧→鎖）；一個月份選擇貫穿「對數＋月結」；待處理集中首頁；第一層 6 項唔使捲。
- 缺點：「對數」同「月結」界線要定（reconcile 套用 vs 一鍵結算內嘅全月對數有重疊）；`/reports/*` 合 tab 要改 URL 結構（建議保留舊路徑 redirect，e2e 影響要點算）；主管喺「月結」只見一個唯讀頁，一層只得一項。

### 5.2 方案 B：按對象（嘢屬於邊個）

第一層（內部 ≤6）：**首頁 · 盤 · 保安員 · 雞頭 · 錢 · 系統**

| 第一層 | 第二層 | 合併／降級 |
|---|---|---|
| 首頁 | 今日尚欠＋待辦收件箱 | 同 A |
| 盤 | 盤主檔、更表（索引／編輯器）、更表上載＋對數、配額、審批 | 更表／上載／對數全部歸「盤」，因為每份更表係「一個盤一個月」 |
| 保安員 | 名冊、新增（手動／證件 OCR／批量導入）、未配對修復、待答（導入題） | 4 條建人路徑集中一頁「新增 ▾」 |
| 雞頭 | 雞頭主檔＋介紹費率、價目（出街價）、本月應收預覽 | `/my-receivable` 內部預覽有正式入口 |
| 錢 | 一鍵結算、月結工作台、毛利、糧明細、長工糧、修正摘要 | 同 A 嘅「月結」，但冇「對數」層 |
| 系統 | 用戶、角色、操作紀錄、現場意見 | — |

雞頭：**首頁 · 我的盤（更表／配額）· 我的保安員 · 我的錢（應收／價目）**

- 優點：新人易搵（「關於保安員嘅嘢都喺保安員」）；同 matrix.ts 嘅 module 粒度較接近，權限隱藏邏輯簡單；雞頭端自然對應。
- 缺點：老闆每月流程要跨 3 個第一層（盤→保安員修復→錢），月份選擇唔自然貫穿；「未配對修復」可以歸盤亦可以歸保安員，界線模糊；「待答問題」要拆兩處（導入題 vs 月結題）。

### 5.3 取捨對照

| 維度 | 方案 A 工作流 | 方案 B 對象 |
|---|---|---|
| 老闆每月流程撳幾多層 | 少（對數→月結兩組相鄰） | 多（盤→保安員→錢） |
| 新人／主管找資料 | 中 | 易 |
| 月份貫穿 | 易（對數＋月結共用月份） | 難（主檔頁冇月份概念） |
| 改動量 | 大（報表合 tab、鎖月單一化） | 中（大部分只係搬 nav） |
| 鎖月 gate | 唔改 API、唔改計算；若刪 `/reports/monthly-close` 鎖掣要確認 e2e，**唔使**跑 `gate:locked-months`（口徑不變），但建議跑一次做保險 | 同左 |
| e2e 影響 | 高（路徑、按鈕、§6.3 字面值） | 中 |

建議規劃者考慮：第一層用 A（老闆係主要用戶、手機為主），第二層「資料」區借 B 嘅「按對象收集新增路徑」做法。
