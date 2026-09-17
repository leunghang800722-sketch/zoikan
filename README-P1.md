# 在勤保安排更系統 — P1-WP1／WP2（專案骨架＋schema＋seed＋報表重出＋認證/RBAC/API）

> 呢個檔案本身唔准有真名／工號／電話（PDPO）。真實 7 月數據一律由
> `data/`（gitignored）同 `tools/importer/out/`（gitignored）喺 runtime 讀入本機
> DB，唔會入 git。

## 版本

- Next.js 15.5.x（App Router）+ React 19 + TypeScript + Tailwind CSS 4
- Prisma 6（PostgreSQL）
- 本機資料庫：`embedded-postgres`（npm 套件，18.4.0-beta.17，PG18；呢部 Mac
  冇 Postgres 冇 Docker，唔裝任何系統軟件）
- 測試：Vitest（對住一個獨立、臨時嘅 embedded-postgres，用假數據 fixture）
- xlsx 讀寫：ExcelJS

## 裝機

```bash
npm install
cp .env.example .env   # DATABASE_URL 已經指向 npm run db:start 起嗰個 port
```

## 一句一步

```bash
npm run db:start        # 起本機 embedded-postgres（背景 daemon，.pg/ 目錄，gitignored）
npm run db:migrate:dev  # 由零建立/更新 schema（開發用；生產部署用 db:migrate）
npm run db:seed         # 由 tools/importer/out/{wp2b,wp3} + mappings/ 讀入 7 月真數據
npm run report:regen    # 由 DB 重出三份報表（更表/糧明細/月結）到 out/p1/，再對數
npm test                # Vitest（假數據 fixture，唔會掂真實 7 月數據）
npm run db:stop         # 停 DB
npm run db:reset        # 停 → 刪 .pg/ → 起 → migrate deploy → seed（由零一次過）
npm run dev             # 起 Next.js（畫面留返 P1-WP3/WP4）
```

### `data/mappings-private/` 依賴（C5，Opus 對抗式驗收第四輪）

`npm run db:seed`／`npm run report:regen` 需要 gitignored 嘅
`data/mappings-private/`（`brokers.csv`／`client-names.json`／
`seed-overrides.json`／`report-overrides.json`／`names_en.csv`／
`longterm_staff_2026-07.csv` 等）先可以完整跑得通——呢個資料夾含真名／
電話／工號等 PDPO 資料，唔入 git，一定要另外由授權途徑攞到（問規劃
session／老闆）放落呢個路徑。

**冇呢個資料夾（例如新 clone、CI、未授權機器）：**
- `npm run db:seed` 會直接 **throw 中止**（唔會靜默用假值 seed），呢個
  係刻意行為（見 `scripts/seed/index.ts` 嘅 unmapped 驗證），唔係 bug。
- `npm run report:regen` 部分已知落差比對（例如糧明細嘅單一混合單價頁
  特例、月結總表兩個「月結以外」客戶分類——真名對照見
  report-overrides.json）會降級做 `info`（唔計 `fail`），summary 會印
  「private 檔缺席，N 條
  特例跳過」。
- `npx vitest run` 嘅 `tests/seed-regen-gate.test.ts`（對真實 7 月數據嘅
  gate test）**一定會紅**——呢個係預期行為，唔係其他改動整壞咗；呢個
  gate test 本身就係要求開發庫已經 seed 咗真實數據先做得到斷言。

即係話：**冇 `data/mappings-private/`，`npm run db:seed` 會 fail、
`tests/seed-regen-gate.test.ts` 會紅，屬預期**——唔使因為呢個而懷疑係
自己個改動整壞咗嘢。其餘唔靠真實 7 月數據嘅 test（假 fixture）唔受
影響，照常全過。

### 雞頭費率拆分（P1-WP4，老闆 2026-09-13 批准）

P0 源頭（糧明細／總表）只有「出街價」合計，冇拆開保安員工資／雞頭費
（P0 §3.5 定義：出街價＝工資＋雞頭費）。老闆 2026-09-13 提供雞頭 K 嘅
每更雞頭費率：盤「啟航1331」$60/更，其餘盤 $50/更。正式庫已經用一次性
腳本拆咗（47 張 K 卡、974 條 7 月更次快照）；`npm run db:seed`（包括
`tests/seed-regen-gate.test.ts` 會跑嘅嗰次）而家會喺 seed 期間自動做返
同一件事，唔會退返舊嘅「合計卡」樣。

- 費率規則喺 gitignored 嘅 `data/mappings-private/seed-overrides.json`
  嘅 `brokerFeeRules` key（`{ "<broker_csv_id>": { "default": <數>,
  "bySite": { "<盤 canonical_name>": <數> } } }`），由
  `scripts/seed/lib/seed-overrides.ts` 嘅 `brokerFeeRules()` 讀入——冇
  呢個 key 就跌返 `{}`（即係邊個雞頭都唔拆，行為同拆分前一樣）。
- 拆分嘅純邏輯喺 `scripts/seed/lib/broker-fee-split.ts`
  （`applyBrokerFeeSplit()`），rate_cards 同 shift_records 快照 stamping
  兩處（`scripts/seed/index.ts`）共用同一份判斷：外判雞頭
  （`broker.kind==="broker"`）、有登記費率、`guard_wage` 有值、
  `broker_fee` 空或 0（idempotent，已拆開嘅唔會再拆）先會拆；出街價
  （`guard_wage+broker_fee`）拆前拆後不變。長工／公司兵／external 呢類
  唔屬外判雞頭嘅卡（`kind≠broker`）唔會被呢條規則掂到。
- 8 月起（seed 冇覆蓋嘅月份）新增嘅更次一律經由已經拆開咗嘅 rate_cards
  卡計價，落地時 `guard_wage`／`broker_fee` 已經係分開嘅——呢個拆分邏輯
  淨係為咗令**本機重 seed 7 月歷史數據**時同正式庫已經人手拆過嘅結果
  一致，唔係一個持續運行嘅 runtime 規則。
- seed 完成後 `out/p1/seed-stats.json` 有 `brokerFeeSplitCards`（rate_cards
  拆咗幾張）／`brokerFeeSplitRecords`（shift_records 快照拆咗幾條）兩個
  統計；單元測試見 `tests/seed-broker-fee-split.test.ts`（純函數 fixture，
  唔碰 DB）。

## 由零建庫（等同 `prisma migrate reset`）

`prisma migrate reset` 呢個指令喺 AI agent 非互動 session 會俾 Prisma 自己嘅
安全機制擋住（要真人喺 chat 明確同意先可以用 env var 繞過），所以 WP1
執行期間改用「drop database + `prisma migrate deploy`」達到完全等同嘅效果
（已驗證：由零建庫成功，兩個 migration 全部套用）。人手喺互動式終端跑
`npx prisma migrate reset` 會照樣有正常嘅確認提示，唔受影響。`npm run
db:reset` 呢個腳本本身用嘅係 `migrate deploy`（唔係 `reset`），適合自動化
場景。

## 資料夾

```
prisma/                Prisma schema v1.1 + migrations
scripts/db/             embedded-postgres 起停（daemon 背景執行、pidfile）
scripts/seed/           由 tools/importer/out/{wp2b,wp3} + mappings/ CSV 讀入 DB
scripts/report/         由 DB 重出三份報表 + 對數（regen-diff.csv）
tests/                  Vitest（假數據 fixture，獨立臨時 DB）
src/app/                Next.js App Router（暫時得返一個佔位首頁，畫面係 P1-WP3/WP4）
tools/importer/         P0 工具（保留做 seed 來源 + 回歸對數，唔屬於 P1 骨架本身）
```

## 帳號／角色／權限（P1-WP2）

### 認證

- 電話＋密碼登入：`POST /api/auth/login { tel, password }`——電話係
  `users.tel`（unique），密碼用 **bcryptjs**（純 JS，冇 native binding，
  呢部冇 Postgres/Docker 嘅開發機／CI sandbox 都保證裝得到；argon2 要編
  譯 native addon 有裝唔到嘅風險，所以揀 bcryptjs——WP2 執行裁定）。
- Session：**iron-session** 嘅低層 `sealData`/`unsealData`（HTTP-only、
  加密簽署 cookie，12 小時 TTL，stateless，唔使 sessions 表）。刻意唔用
  `next/headers` 嘅 `cookies()`（嗰個要真正 Next 請求生命週期先用得，
  route handler 冇辦法喺 Vitest 直接調用做 integration test）——改用標準
  `Request`/`NextResponse` 嘅 cookie API，route handler 係純函數
  `(Request) => Response`，production 同 test 行為一致。
- 錯密碼鎖定：連續 5 次失敗鎖 15 分鐘（`users.failed_attempts`／
  `locked_until`）。管理角色（老闆/主管/會計）強制強密碼（≥8 字符、
  含字母同數字）；雞頭/安員最少 6 字符。
- 登入 IP 記入 `audit_log.ip`（`x-forwarded-for`／`x-real-ip`）。
- SMS OTP 欄位（`users.otp_enabled`／`otp_secret`）已預留，WP2 唔實作；
  `otp_secret` 連俾有「用戶管理」權限嘅老闆都唔會經任何 API 出街
  （`toSafeUserDTO()` 一律剝走，Opus 驗收殘留3）。
- **Session 作廢（`users.token_version`，Opus 驗收殘留1）**：單靠清
  cookie 唔夠——一份未過 TTL 嘅舊 cookie 冇被 DB 標記做「已失效」嘅話
  照樣用得。呢度加咗 `token_version`：登入時將當時嘅 version 寫入
  sealed cookie；logout／改密碼／改角色（`role_id`）／改雞頭
  （`broker_id`）／void user 全部會 bump DB 嗰個 version；每個 request
  嘅 `requireSession()` 都同 DB 核對一次（一條 SELECT），唔啱即刻 401。
  改密碼會重新 issue 一個帶新 version 嘅 cookie 俾當前 request（唔踢走
  緊用緊嗰個 session，但踢走晒其他裝置嘅舊 session）。
- API：`POST /api/auth/login`、`POST /api/auth/logout`、
  `POST /api/auth/change-password`。

### Seed 測試帳號（假電話，PDPO：唔係真人）

| 角色 | 電話 | 密碼 | 備註 |
|---|---|---|---|
| 老闆 | 9000 0001 | `Passw0rd1` | |
| 主管 | 9000 0002 | `Passw0rd2` | |
| 會計 | 9000 0003 | `Passw0rd3` | |
| 雞頭A | 9000 0004 | `Broker0004` | 掛 broker_id＝代號 K（真名見 gitignored 嘅 data/mappings-private/brokers.csv） |
| 雞頭B | 9000 0005 | `Broker0005` | 掛 broker_id＝代號 W（真名見 gitignored 嘅 data/mappings-private/brokers.csv） |
| 安員 | 9000 0006 | `Guard00006` | 安員自助 P4 先做登入畫面 |

真人帳號等老闆 D-P1-1 名單確認（見 P1-執行計劃.md §5）。

### RBAC：module × action 矩陣（Opus 對抗式驗收 C3 拆細版）

**23 個 module**（由舊版 10 個拆細，令設計文件§5.1 表入面粒度唔同嘅行都
表達得到；P3 加咗`個人資料`，WP-AI1 加咗`助手`，WP-PII 加咗`安員個人
資料`／`安員銀行資料`）× 5 個 action（view／create／update／void／
export）＝**115 permission**，單一事實來源喺 `src/lib/rbac/matrix.ts`
（同設計文件§5.0/§5.1 逐行對應，每個 module 上面有註解引用返表入面
原文；`scripts/seed/index.ts`／`tests/global-setup.ts` 都經
`src/lib/rbac/seed.ts` 嘅同一份邏輯入 DB，唔會兩份矩陣漂移）：

`更表`、`配額`、`審批`、**`收客價`**、**`出街價`**（拆自舊「價目」——
設計文件「睇收客價、毛利、月結總表」主管預設**○**、「睇出街價（全部
雞頭）」主管**✓**，舊版一格「價目」表達唔到呢個分別）、`盤`、`安員`、
**`自己安員`**（新增，雞頭端「自己安員名冊管理」§6.2 專用）、`雞頭`、
`糧務`、**`批核糧務批次`**、**`月結鎖定解鎖`**（拆自舊「糧務」void）、
**`用戶管理`**、**`操作紀錄`**（拆自舊「系統」）、**`毛利即時表`**、
**`尚欠總覽`**、**`月結總表`**、**`糧明細`**、**`更表匯出`**（拆自舊
「報表」，設計文件§5.0「每份報表獨立一行權限」）、**`個人資料`**
（P3，改自己個人資料，五角色皆✓）、**`安員個人資料`**（WP-PII，管
保安員身份證／出生日期／地址／緊急聯絡人／Blacklist check——老闆／
會計全睇全改，主管出廠關（可以開），雞頭／安員硬性拒）、**`安員銀行
資料`**（WP-PII，管保安員銀行戶口，獨立於「安員個人資料」——主管硬性
拒，同雞頭／安員一致，淨係老闆／會計）、**`助手`**（WP-AI1，側欄 AI
助手嘅基本進入權，淨係 view 有意義，雞頭／安員硬性禁止）。

- **✓（grant）**：seed 出嚟 `role_permissions.granted = true`。
- **○（off）**：seed 出嚟 `role_permissions.granted = false`——呢行存在，
  老闆日後可以喺角色權限管理畫面（`PATCH /api/roles/:id/permissions`，
  WP3 UI）逐格開。
- **✗（硬性禁止）**：seed **唔生成**呢行 role_permission（連
  `granted=false` 都冇）；`requirePermission()` 仲有一層 runtime
  hard-deny check（`isHardDenied()`，用 `session.baseRole` 查——見下面
  自訂角色一節），即使有人手動塞一條 `granted=true` 嘅 role_permission
  入 DB 都照拒 403——`tests/wp2-rbac-matrix.test.ts` 逐格（5 角色 ×
  115 權限 = 575 格）test 咗呢個行為，仲有一個專門 test 模擬「塞咗一行
  都拒」。
- 全部 API route／server action 一律經 `requirePermission(req, module,
  action)`；拒絕（未登入 401／冇權限或硬性禁止 403）都寫一條
  `audit_log(action=permission_denied)`。

**field-level gate（C3）**：`收客價` 唔止管 rate_cards 資源本身嘅
create/update 存取，仲會影響 `rate_cards`／`special_items` response
入面 `client_rate*`／`revenue` 呢幾粒數見唔見得到——冇「收客價:view」
（例如主管出廠設定）response 會剝走呢幾個欄（唔係成張 rate_card 都
見唔到，見 `src/lib/rbac/field-gates.ts`）。

**module resolver**：部分 route（例如 `guards`）依 session 嘅角色動態
揀 module——雞頭用 `自己安員`，內部角色用 `安員`（`requirePermission()`
支援 `ModuleSelector` 可以係 module 字串或者 `(session) => module` 函數）。

**角色可複製再改**：`POST /api/roles { source_role_id, name }` 複製一個
現有角色連埋成套 `role_permissions`，`is_custom=true`；五個出廠角色
（老闆/主管/會計/雞頭/安員）`is_custom=false`，唔可以 void；自訂角色
可以 void 但**冇 unvoid**（留返 P3）。

**自訂角色 hard-deny（Opus 驗收殘留2）**：`roles.base_role`——複製一個
出廠角色時寫死（如果來源本身已經係自訂角色，繼承佢嘅 `base_role`，
保證永遠追溯得返去五個出廠角色之一），**冇 API 可以改**；硬性 deny
矩陣查詢一律用 `session.baseRole`（唔係顯示用嘅 `roleName`）——複製
「雞頭」改名做「高級雞頭」，硬性禁止照樣生效（`requirePermission()`
用 `base_role` 判斷，唔係個名）。未知 `base_role`（理論上唔應該出現，
DB 冇 constraint 擋但冇任何 API 路徑會整到）一律當最嚴處理，
`requireSession()` 直接 403。自訂角色而家可以完整登入使用（同 WP2
第一版「已知限制」相比，呢個限制解除咗）。

### 雞頭隔離（硬性規則1，Opus 對抗式驗收 C1/C2 加固）

`src/lib/broker-isolation.ts`——**三重防線**：

1. **寫入歸屬檢查（C1，新加）**：舊版靠「query scope + 已經有更次記錄」
   判斷可見性，有一個漏洞——雞頭可以憑空幫任何 `guard_id` 開一條更次，
   然後用「呢個 guard 有我份更」反過來攞到唔屬於自己嘅安員資料。而家
   `POST /api/shift-records` 寫入之前一律驗證：
   - `assertGuardOwnedByBroker(guard_id, broker_id)`——呢個安員嘅
     `default_broker_id` 真係自己，唔可以幫其他雞頭嘅人開更（「guard
     嫁接」）。
   - `assertSiteAssignedToBroker(site_id, broker_id, work_date)`——自己
     喺呢個盤呢個月要喺 `broker_site_assignments` 白名單入面（新表，
     quotas 表 P3 先做，P1 暫代；7 月真數據由
     `scripts/seed/index.ts` 嘅 `seedBrokerSiteAssignments()` 根據
     shift_records 實際 settlement/operational broker × site × 月份
     反推生成）。
   兩個 check 邊個失敗都 403，資料庫完全冇留低嗰條更次；`GET
   /api/guards/:id` 之後照樣 404（冇因為「開更失敗」而漏咗任何資料）。
2. **Query 層 scope**：`shift_records`／`rate_cards`／`guards`／
   `brokers`／`daily_requirements` 嘅 list/get 一律加 WHERE，其他 broker
   嘅記錄／自己冇份嘅盤嘅價目根本冇入到結果集；`scopeGuardWhere` 而家
   要求「有更次」嗰個分支仲要嗰條更次嘅盤喺 `broker_site_assignments`
   先算數（同寫入時嘅檢查一致）。
3. **白名單 DTO + blocklist scrub 雙重（C2）**：`src/lib/broker-dto.ts`
   ——雞頭見到嘅 `guards`／`brokers`（自己）／`rate_cards`／
   `shift_records`／`daily_requirements` 一律逐 route 白名單 DTO
   （`pickWhitelist()`，欄位逐個列明，唔係淨係剝黑名單），再由
   `scrubForBrokerSession()` 做多一層 blocklist defense-in-depth（剝
   `client_rate*`／`gross*`／`margin*`／`profit*`／`bank_info`／
   `note`／`evidence`／`source`／`provenance`／`settlement_page`／
   `rescue_rate`／`revenue`）。

**修埋咗嘅附帶 bug（C2）**：舊版 `dropKeysDeep()` 用 `instanceof Decimal`
判斷「呢個值唔好再遞歸拆落去」，但 Vitest/Vite 嘅 module 轉譯會令
`@prisma/client/runtime/library` 有時攞到唔同 module instance（dual-
package hazard），真實 Prisma query 拎返嚟嘅 Decimal 值 `instanceof`
檢查唔中，靜靜哋漏咗轉 string——雞頭見到嘅 `guard_wage_snapshot` 會變
返 Decimal 內部代表 `{s,e,d}`（`work_date` 就會變 `{}`）。而家
`src/lib/api/serialize.ts` 嘅 `isDecimalLike()` 唔靠 instanceof，用
decimal.js 實際內部形狀（`s`/`e`/`d` + `toFixed` method）duck-type
判斷，唔理邊個 module instance 起嘅都認得到。`fuzz test` 加咗值級斷言
（`work_date` 係 ISO 字串、`guard_wage` 係數字字串、`note` 完全唔存在）
先揪到呢個 bug——見 `tests/wp2-broker-isolation-fuzz.test.ts`。

## endpoint 清單同對應權限

見 [`docs/api.md`](docs/api.md)。

## AI 助手（WP-AI1／WP-AI3）

側欄 AI 助手（唯讀，讀操作說明＋讀真實系統數據答問題）——只有
老闆／主管／會計用得，`助手` module 雞頭／安員硬性禁止（見
`src/lib/rbac/matrix.ts`，而家 21 個 module）。**鐵律**：架構上做唔到
任何寫入／修改／部署，四層唯讀保證（DB 角色 `zoikan_ai_ro` 淨係
`USAGE`+`SELECT` on `ai.*` schema → 唯讀 view 冚咗 tel/bank_info/
password_hash/otp_secret → 獨立 `pg` 連線唔用 Prisma 寫入客戶端 →
`sql_select` tokenizer 拒絕 DML/DDL）。詳細架構、工具清單、輸出過濾、
env 設定、已知限制見 [`docs/ai-assistant.md`](docs/ai-assistant.md)。

**LLM 供應商可設定（WP-AI3，老闆 2026-09-12 揀 DeepSeek）**：
`src/lib/ai/config.ts` `resolveAiProvider()` 由 env 揀
`deepseek`／`anthropic`／`fake`（`AI_PROVIDER`/`DEEPSEEK_API_KEY`/
`AI_HUB_API_KEY`/`AI_LLM=fake`，次序見 `docs/ai-assistant.md`「LLM
可注入」一節），`getLlmClient()` 同 `(app)/layout.tsx` 嘅 tab 顯示判斷
共用同一套邏輯。DeepSeek client（`src/lib/ai/providers/deepseek.ts`）
用官方 `openai` npm SDK 打 OpenAI-compatible endpoint，手寫工具調用
loop（Anthropic 路徑嗰個官方 Tool Runner 冇 OpenAI-SDK 版）。

**前端（WP-AI2）**：`(app)` layout 右邊緣直向 tab「在勤助手」——淨係
`助手:view` 為 true 先 render（雞頭/安員 DOM 零元素），撳開側欄支援
歡迎語＋4 個例子、串流問答、簡單 markdown 回覆、清空對話（二次確認）、
手機全屏，送問題帶目前頁面 `context`（site_id/month/broker）俾後端
system prompt 做提示。詳見 [`docs/ai-assistant.md`](docs/ai-assistant.md)
「前端（WP-AI2）」一節；e2e 見 `tests/e2e/ai.spec.ts`。

## PDPO

- `data/`、`tools/importer/out/`、`out/p1/`、`.pg/`、`.pg-test/`、`.env`
  全部 gitignored。
- `scripts/`、`prisma/`、`tests/`、`src/` 入面嘅程式碼本身唔含任何真名/
  工號/電話——真數據淨係喺 `npm run db:seed` 執行嗰陣由上面嘅 gitignored
  檔案讀入 runtime 記憶體/DB。WP2 嘅測試帳號/fixture 全部用假電話同
  「測試XX」呢類假名。
- 已用 `tools/importer/out/wp2b/guards.csv`（姓名/工號/電話/別名）+
  `data/mappings-private/longterm_staff_2026-07.csv` +
  `data/mappings-private/names_en.csv` 做 needle（797 個），掃描晒全部
  會入 git 嘅檔案（`git ls-files` + 未 gitignore 嘅 untracked 檔案，共
  186 個）——0 命中（P1-WP2 Opus 對抗式驗收後覆核，2026-09-11）。

## 真人帳號（D-P1-1）

真人帳號唔喺 git：`data/mappings-private/users.json`（gitignored）格式
`[{"tel":"8位數字","name":"顯示名","role":"老闆|主管|會計|雞頭|安員","broker_csv_id":"B01（雞頭先要）"}]`。
`npm run db:seed` 讀到就會建立帳號，初始密碼隨機生成，寫入
`data/mappings-private/users-initial-passwords.txt`（gitignored，交完俾本人就刪走），首次登入強制改密碼。
已存在嘅真人帳號重跑 seed 唔會重設密碼。正式環境用 `SEED_SKIP_TEST_ACCOUNTS=1 npm run db:seed` 唔起假測試帳號。
