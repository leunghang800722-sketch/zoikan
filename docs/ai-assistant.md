# AI 助手（WP-AI1）

> 呢個檔案本身唔准有真名／工號／電話（PDPO）。

側欄 AI 助手——「全能解答」：讀操作說明＋讀真實系統數據答問題。只有
**老闆／主管／會計**用得（雞頭／安員硬性禁止，`助手` module，見
`src/lib/rbac/matrix.ts`）。**鐵律**：呢個助手架構上做唔到任何寫入／
修改／部署；用戶叫佢改嘢一律答「呢類改動請聯絡 Eric（老闆）」；亦唔
准生成 SQL／指令俾人手動執行改動，只解釋現狀。老闆已接受業務數據送去
Anthropic（美國）處理，但**電話、銀行資料、密碼、OTP 一律唔准送**。

## 架構

```
用戶（老闆/主管/會計）
  │  POST /api/ai/chat  { message }
  ▼
src/app/api/ai/chat/route.ts
  │ 1. requirePermission(req, "助手", "view")  ← 硬性擋雞頭/安員
  │ 2. 每日上限（src/lib/ai-rate-limit.ts，讀 audit_log 計數）
  │ 3. 讀對話 history（src/lib/ai-conversation.ts，ai_conversations 表）
  │ 4. computeFieldVisibility()（收客價/出街價 view 權）
  │ 5. buildAiTools({session, fieldVisibility}) ← 逐個工具帶住呢個人嘅權限
  │ 6. llmClient.chat({systemPrompt, tools, history, userMessage})
  │      └─ production：AnthropicLlmClient（真 call AI Hub，SDK Tool Runner）
  │      └─ test：FakeLlmClient（腳本化，唔使真 key）
  │ 7. checkOutputGuardAndAudit() ← 最後防線，攔截 DML/DDL/指令樣式
  │ 8. 存返 ai_conversations + 寫 audit_log(ai_chat)
  │ 9. SSE 回傳
  ▼
用戶
```

### 唯讀保證（四層，由外到入）

1. **DB 角色**：`zoikan_ai_ro`（`scripts/db/ensure-ai-role.ts`，
   `npm run db:ensure-ai-role`）——淨係 `GRANT USAGE ON SCHEMA ai` +
   `GRANT SELECT ON ALL TABLES IN SCHEMA ai`，冇任何其他 grant；
   `default_transaction_read_only=on`、`statement_timeout=5s`、
   `search_path=ai`。Postgres view 預設用 view owner（跑 migration
   嗰個主連線用戶）嘅權限讀底層 `public.*`，`zoikan_ai_ro` 本身接觸唔到
   `public` schema 任何一張表。
2. **`ai.*` schema**：唯讀 view（`prisma/migrations/
   20260912130100_wp_ai1_readonly_schema`）——`ai.brokers` 冇
   `bank_info`，`ai.guards` 冇 `tel`，`ai.users` 淨係
   `id/name/role_id/role_name/status`，`ai.audit_log` 嘅
   `before`/`after` 經 `ai.scrub_json()` 再剝一次
   `password_hash/otp_secret/tel/bank_info`。
3. **獨立連線**：`src/lib/ai/db.ts` 用 `pg`（**唔用** `@/lib/db` 嘅
   Prisma 寫入客戶端）連 `AI_DATABASE_URL`，Pool 層再設一次
   `statement_timeout`/`query_timeout`（同角色設定雙重）。
4. **`sql_select` tokenizer**：`src/lib/ai/sql-guard.ts`——只准單句、
   `SELECT`/`WITH` 開頭，拒絕 `;`（多句）、
   `INSERT|UPDATE|DELETE|MERGE|ALTER|DROP|CREATE|TRUNCATE|GRANT|REVOKE|
   SET|RESET|COPY|CALL|DO|EXECUTE|LOCK|INTO`、`FOR UPDATE`/`FOR SHARE`、
   `pg_`、`public.`/`pg_catalog.`/`information_schema`；強制 `LIMIT 200`
   （冇就加；有但 >200 就收緊）。

### 結構性保證點做

`tests/ai-structural-guard.test.ts` 逐檔案掃 `src/lib/ai/**` 同
`src/app/api/ai/**` 嘅**原始碼文字**（去走 comment/string 之後）：

- 零 `@/lib/db` import、零 `prisma.`、零 `$executeRaw`／`$transaction`
- 零 import 任何 `src/app/api/**/route.ts`、零 `fetch(`

呢個係**逐檔案直接**（唔係 transitive）嘅檢查——`src/lib/ai/**` 入面嘅
檔案可以 import 其他既有 lib（`@/lib/rbac/requirePermission`、
`@/lib/api/field-groups`），因為呢啲檔案本身唔喺 scan 嘅 tree 之內，
route.ts 都必然要用 `requirePermission()`（RBAC 引擎本身冇理由喺 AI
呢一側重新發明一套）。真正嘅**業務數據**來源收窄喺
`src/lib/ai/tools/*.ts` 呢一層：另一個更窄嘅斷言逐個工具檔案檢查
`@/lib/*` import 淨係嚟自一個 allowlist（`@/lib/ai/db`、
`@/lib/reports/*`、`@/lib/rbac/requirePermission`、
`@/lib/api/field-groups`）。

`src/lib/ai-conversation.ts`／`src/lib/ai-rate-limit.ts` 刻意擺喺
`src/lib/ai/` 之外（頂層，同 `src/lib/audit.ts` 一樣）——管嘅係助手自己
嘅對話 history／daily rate limit 呢類應用狀態（本身就需要正常讀寫，
唔屬於「AI 查詢業務數據」嗰條唯讀邊界），擺出嚟令結構性掃描唔使開
特殊例外。

## 工具（`src/lib/ai/tools/*.ts`）

全部用 Anthropic SDK `betaZodTool`（`@anthropic-ai/sdk/helpers/beta/
zod`）定義，逐個 request 由 `buildAiTools({session, fieldVisibility})`
（`src/lib/ai/tools/index.ts`）用呢個人嘅 session 現造：

| 工具 | 資料來源 | 需要嘅 module:view | field-level gate |
|---|---|---|---|
| `describe_system` | 打包入 code 嘅摘要（唔碰 DB） | 冇（純文字，冇對應資源） | — |
| `list_sites` | `ai.sites` | `盤` | `sites`（`monthly_fee`） |
| `site_overview` | `ai.sites`/`shift_types`/`daily_requirements`/`shift_records` | `更表` | — |
| `roster` | `ai.shift_records`+`guards`+`shift_types` | `更表` | — |
| `broker_stats` | `ai.shift_records`+`brokers` | `更表` | 手動剝 `estimated_payout`（聚合欄，唔喺 blocklist） |
| `shift_history` | `ai.shift_records` | `更表` | `shift_records` |
| `rate_cards`／`explain_rate_card` | `ai.rate_cards` | `出街價`（基本存取） | `rate_cards`（`client_rate`／`guard_wage`/`broker_fee`/`payout_rate`等） |
| `guard_lookup` | `ai.guards` | `安員` | `guards`（`monthly_salary`；`tel` DB 層已經冇） |
| `gross_margin` | `@/lib/reports/gross-margin.ts`（純讀，用緊 `@/lib/db`——見下） | `毛利即時表` | 手動歸零 revenue/cost/profit/marginPct |
| `monthly_close` | `@/lib/reports/monthly-close.ts` | `月結總表` | 同上 |
| `shortfall` | `@/lib/reports/shortfall.ts` | `尚欠總覽` | 同上（`monthProgress` 入面） |
| `recent_audit` | `ai.audit_log` | `操作紀錄` | `scrubUnknownShape`（before/after 通用欄位名 blocklist） |
| `sql_select` | 任意 `ai.*` SELECT | 逐張表對應嗰個 module（見下「權限」一節） | `scrubUnknownShape`（best-effort，見已知限制） |

**field-group gate**（`src/lib/ai/field-scrub.ts`）直接重用
`src/lib/api/field-groups.ts` 嘅 `CLIENT_RATE_FIELDS`/
`SETTLEMENT_FIELDS`（snake_case）——`ai.*` view 讀出嚟嘅 row 本身就係
snake_case（DB 欄位名），同呢兩個清單完全對得上，唔使做 camelCase 轉換。

## 權限（助手同畫面權限一致）

**規劃裁定（推翻咗 WP-AI1 執行時嘅第一版判斷）**：AI 助手要同畫面權限
一致——「你冇權見嘅報表，助手都唔答」。老闆話「全能」係指*能力範圍*
（讀操作說明＋讀真實系統數據），唔係話可以繞過 RBAC 矩陣；「主管出廠
見唔到毛利即時表」係老闆自己喺矩陣度定嘅設定，AI 助手唔應該變成一條
逕自繞過去嘅後門。

隔離線而家係三條（由粗到細）：

1. **`助手` module**（route 層）——雞頭/安員完全用唔到（硬性）。
2. **逐個工具嘅 module:view**（`src/lib/ai/tools/common.ts` 嘅
   `requireModuleOrDenied()`）——冇對應 module 嘅 view 權，工具直接回
   `{error:"permission_denied", message:"你冇權睇「<module>」，呢個
   問題答唔到。"}`，唔會查任何數據；`describe_system` 例外（純文字說明，
   冇對應資源，唔受呢層管）。逐個工具用邊個 module，見上面「工具」表
   最右第二欄。
3. **收客價／出街價 field-level gate**（`src/lib/ai/field-scrub.ts`）
   ——過咗第 2 條先至判斷邊啲*數字*見唔見得到（例如毛利表有權查，但
   `revenue`/`profit` 跟「收客價:view」歸零）。

**`sql_select` 逐 table 判斷**（`src/lib/ai/sql-guard.ts` 嘅
`TABLE_MODULE_MAP`）——由 `FROM`/`JOIN` 之後嘅識別符抽表名（`ai.xxx`
或者靠 `search_path=ai` 冧返嘅裸表名都認得到），逐張表 map 到嗰個
module，一句查詢涉及嘅每張表都要有 view 權（AND，唔係 OR）；抽到嘅
表名唔喺以下對照表入面（打錯字/未登記嘅 view）一律拒絕，唔當「冇
限制」處理：

| `ai.*` view | module |
|---|---|
| `sites`／`shift_types` | `盤` |
| `brokers`／`broker_site_assignments` | `雞頭` |
| `guards` | `安員` |
| `shift_records`／`daily_requirements`／`quotas` | `更表` |
| `rate_cards`／`referral_fee_rates` | `出街價` |
| `special_items`／`month_closes` | `月結總表` |
| `audit_log` | `操作紀錄` |
| `users` | `用戶管理` |

驗證：`tests/ai-sql-select-permissions.test.ts`（11 條，逐 table/角色
斷言，包括手動開/關 role_permission 模擬「老闆改咗矩陣」嘅場景）、
`tests/ai-chat-isolation.test.ts`（主管出廠問毛利 → 無權訊息；老闆開咗
「毛利即時表:view」但主管仍然冇「收客價:view」→ 有更數/成本、零
revenue）。

## LLM 可注入（WP-AI3：可設定揀供應商）

`src/lib/ai/llm.ts` 匯出 `LlmClient` interface：

```ts
interface LlmClient {
  chat(params: LlmChatParams): Promise<LlmChatResult>;
}
```

`getLlmClient()` 用 `src/lib/ai/config.ts` 嘅 `resolveAiProvider()` 揀
provider（同 `(app)/layout.tsx` 嘅 `isAiConfigured()` 共用同一套邏輯，
唔會出現「tab 顯示咗但打落去 503」）：

1. `AI_LLM=fake`——Playwright e2e 專用假分支，優先過任何真 provider。
2. `AI_PROVIDER` 明文設咗（`anthropic`/`deepseek`/`fake`）就跟呢個。
3. 冇明文設：有 `DEEPSEEK_API_KEY` 就 `deepseek`，否則有 `AI_HUB_API_KEY`
   就 `anthropic`，兩樣都冇就拋 `LlmUnavailableError`（route.ts 轉 503
   `ai_provider_unavailable`）。

**Production——`deepseek`（老闆 2026-09-12 揀）**：`DeepSeekLlmClient`
（`src/lib/ai/providers/deepseek.ts`）——DeepSeek 冇官方 SDK，官方文件用
OpenAI 格式，`new OpenAI({ baseURL: DEEPSEEK_BASE_URL ?? "https://api.
deepseek.com", apiKey: DEEPSEEK_API_KEY })`，model 用
`process.env.AI_MODEL ?? "deepseek-v4-pro"`。`openai` SDK 冇 Anthropic
嗰種官方 Tool Runner helper，所以呢個 client 手寫成個 agentic loop：
`chat.completions.create({ tools, temperature:0.2, max_tokens:4096 })`
→ 有 `tool_calls` 就逐個（可以並行）call 對應工具嘅 `.run()`、逐個包
返做 `role:"tool"` message → 再問一次，最多 `maxToolRounds`（route.ts
傳 8）輪；行齊都仲有 tool_calls，加多一輪冧走 `tools` 逼收尾（唔算入
`maxToolRounds`），等用戶唔會齋收空白回覆。401/429/5xx/網絡錯誤
（`OpenAI.APIError` 同佢啲子類）一律映射做 `LlmUnavailableError`。
工具 schema：**唔使自己再轉一次**——`betaZodTool()`（下面「工具」一節）
內部已經用 zod v4 `z.toJSONSchema()` 將 `inputSchema` 轉咗做
`input_schema` 掛喺每個工具物件度，`toOpenAiTool()` 淨係將呢個 key
搬去 OpenAI 要嘅 `function.parameters`（剝走 `$schema`）。DeepSeek 專屬
prompt 微調：system prompt 尾加一句「用廣東話口語回答（香港中文），
唔好用普通話書面語」（`buildSystemPrompt()` 本身保持 provider-agnostic
唔改，喺 `DeepSeekLlmClient` 入面先 append，見該檔案
`CANTONESE_STYLE_SUFFIX`）。

**Fallback provider——`anthropic`**：`AnthropicLlmClient`（`getLlmClient()`）
——`new Anthropic({ baseURL: AI_HUB_BASE_URL, authToken: AI_HUB_API_KEY })`
（Zeabur AI Hub 用 Anthropic 官方格式，Bearer token），
`client.beta.messages.toolRunner({ ..., stream: true })`（SDK 官方 Tool
Runner，跟 `typescript/claude-api/tool-use.md`/`streaming.md` 嘅寫法，
`pause_turn` 手動 `pushMessages()` resume）。Model 用
`process.env.AI_MODEL ?? "claude-opus-5"`；`thinking:{type:"adaptive"}`、
`output_config:{effort:"medium"}`；system prompt 加
`cache_control:{type:"ephemeral"}`；`max_iterations: 8`（最多 8 輪
工具調用）。

測試：`tests/fixtures/fake-llm.ts` 嘅 `FakeLlmClient`——可以腳本化
「call 邊個工具、傳咩 input」＋「最後答咩」，`chat()` 會真係 call
`params.tools`（route.ts 傳落嚟嘅真工具物件）嘅 `.run()`，等測試可以
驗證真實工具邏輯（field-group gate/DB 查詢），唔淨係 mock 咗成個 route。
`DeepSeekLlmClient` 本身嘅 loop 用 inject 嘅假 `openai` client 單元測試
（`tests/ai-deepseek-client.test.ts`）；14 個工具嘅 schema 轉換用
`tests/ai-deepseek-tool-schema.test.ts`；`resolveAiProvider()`/
`getLlmClient()` 嘅 env 組合用 `tests/ai-provider-config.test.ts`。
Live smoke（真key、控制成本）：`npm run ai:smoke`（`scripts/ai/smoke.ts`），
見「已知限制」下面一條。

## 輸出過濾（`src/lib/ai/output-guard.ts`）

**設計決定（SSE 串流嘅取捨）**：`POST /api/ai/chat` 用 SSE 傳輸，但
**唔會**將模型原始 token 即時轉發俾用戶——先喺 server 側儲齊成個回覆，
行完 `checkOutputGuardAndAudit()` 先至將（可能已經被換成標準回覆嘅）
最終文字切做幾嚿用 SSE `delta` event 送出，跟住一個 `done` event。
咁樣保證用戶（同存落 conversation/audit 嘅記錄）一定唔會見到未經 guard
嘅原始輸出，代價係唔係逐 token 嘅「真」即時串流。

Guard 規則（`checkOutputGuard()`）：
- DML/DDL 語句樣式（`UPDATE x`/`INSERT INTO`/`DELETE FROM`/
  `ALTER TABLE`/`DROP TABLE`/`TRUNCATE TABLE`/`CREATE TABLE`/`GRANT x`/
  `REVOKE x`）
- 字面 `prisma.`／`npm run db:`／`migrate deploy`／`migrate dev`／
  `$executeRaw`／`$transaction`
- 指示性關鍵詞/pattern（「以下步驟」「手動執行」「教你點改」「步驟…
  可以…改」等）

觸發就成段換做標準回覆（`STANDARD_REDIRECT_REPLY`，
`src/lib/ai/system-prompt.ts`）並寫 `audit_log(action=ai_guard_triggered)`。

## 資料表

`ai_conversations`（`prisma/migrations/20260912130000_wp_ai1_conversations`）
——`user_id` unique，`messages` jsonb，最多保留 30 turn（60 條
message，見 `src/lib/ai-conversation.ts`）。每條問答另外寫一條
`audit_log(table_name="ai_chat", action="ai_chat")`，`after` 帶
`question`/`tools_used`/`input_tokens`/`output_tokens`/`guard_triggered`。

## 每日上限

`AI_DAILY_LIMIT`（預設 100，`src/lib/ai-rate-limit.ts`）——讀
`audit_log`（`table_name=ai_chat, action=ai_chat`）計今日（**UTC 曆日**
——規劃裁定，唔額外引入時區依賴，同其他報表用嘅 UTC 月份邊界一致）
已經問咗幾多次，超過就 429（`{error:"rate_limited"}`）。

## Env

見 `.env.example`：

| Env | 用途 |
|---|---|
| `AI_PROVIDER` | `anthropic`/`deepseek`/`fake`；唔填就自動揀（見上面「LLM 可注入」判斷次序） |
| `DEEPSEEK_API_KEY` | DeepSeek API key（OpenAI 格式） |
| `DEEPSEEK_BASE_URL` | DeepSeek base URL，預設 `https://api.deepseek.com` |
| `AI_HUB_BASE_URL` | Zeabur AI Hub base URL（`anthropic` fallback provider 用） |
| `AI_HUB_API_KEY` | AI Hub API key（Bearer token） |
| `AI_MODEL` | 兩個 provider 共用；DeepSeek 冇填預設 `deepseek-v4-pro`，Anthropic 冇填預設 `claude-opus-5` |
| `AI_DATABASE_URL` | `zoikan_ai_ro` 連線字串（`npm run db:ensure-ai-role` 建立） |
| `AI_DB_PASSWORD` | `zoikan_ai_ro` 密碼；冇就 `db:ensure-ai-role` 跳過並 warn |
| `AI_DAILY_LIMIT` | 每人每日問答上限，預設 100 |

冇任何 provider 配置好（冇 `DEEPSEEK_API_KEY`、冇 `AI_HUB_API_KEY`、亦
冇 `AI_LLM=fake`）——`getLlmClient()` 會拋 `LlmUnavailableError`，route
回 503（`{error:"ai_provider_unavailable"}`），唔會噴 stack。

## 已知限制

1. **SSE 唔係逐 token 即時**——見上面「輸出過濾」嘅設計決定：安全
   guarantee（用戶永遠唔會見到未經 guard 嘅原始輸出）優先過真即時
   串流嘅體驗；guard 觸發之後亦都**唔會** abort 緊行嘅 model
   generation（冇加 AbortController），只會停止將內容送俾用戶——日後
   要慳 token 可以加。
2. **`sql_select` 嘅欄位名 scrub 係 best-effort**——`scrubUnknownShape`
   淨係識欄位*名*，一個用假 alias 嘅查詢（例如
   `SELECT cost AS revenue FROM ai.special_items`）理論上可以繞過收客價
   gate（tokenizer 本身刻意簡單，冇做完整 SQL parse/column
   provenance 分析——呢個係規劃裁定「tokenizer 要簡單」嘅刻意權衡）。
3. **`sql_select` tokenizer 嘅 `LIMIT` 偵測淨係揀最後一個出現位置**——
   一個帶 subquery 嘅查詢，subquery 自己嘅 `LIMIT` 有機會被誤判做
   outer LIMIT。
4. **`sql_select` 嘅 table 抽取淨係識 `FROM`/`JOIN` 後面第一個識別符**
   ——同 tokenizer 一樣刻意簡單，唔識別 subquery 巢狀入面奇怪嘅寫法
   （例如 `FROM (SELECT ... ) x, ai.sites y` 呢種逗號分隔嘅舊式 join
   語法，`x`／`y` 呢類 alias 唔會誤判做表名，因為 regex 要求緊接
   `FROM`/`JOIN` 之後）；`UPDATE`/`DELETE` 嗰種語法冧唔到 `FROM`/`JOIN`
   都已經俾 `validateSqlSelect()` 擋咗，唔會走到呢一步。
5. **每日上限用 UTC 曆日**（唔係香港時區凌晨重置）——規劃裁定，見上面
   「每日上限」一節。
6. **AI Hub 唔通嗰陣冇 retry/backoff**——單次 503，前端自己決定要唔要
   俾用戶手動重試。
7. AI 助手唔記得住跨 session 嘅長期偏好（每個 user 一條
   `ai_conversations`，唔係逐 topic 開新對話）。
8. **`DeepSeekLlmClient` 手寫 loop，冇 Anthropic SDK 嗰種官方 Tool
   Runner**——`openai` SDK 冇對應 helper。行為上有兩點同 Anthropic 路徑
   唔完全一樣：(a) `onTextDelta` 唔係逐 token 串流，收尾先一次過 call
   （反正 route.ts 本身冇用呢個 callback，SSE 都係先儲齊先切段送，見
   上面「輸出過濾」）；(b) 8 輪工具調用都用晒仲有 tool_calls，會多加
   一輪冧走 `tools` 逼收尾（唔算入 8 輪），等用戶唔會齋收空白——
   Anthropic Tool Runner 嘅 `max_iterations` 到頂就直接停，行為唔一致，
   規劃裁定「寧願多一輪都要有收尾文字」。
9. **Live smoke（`npm run ai:smoke`）用真 DeepSeek key，會真係扣費**——
   刻意淨係 6 條問題（見 `scripts/ai/smoke.ts` 頂註解），唔會喺 CI/自動
   測試入面跑。

## 前端（WP-AI2）

全站 `(app)` layout 右邊緣一條直向 tab「在勤助手」（`src/components/ai/
AiAssistantSidebar.tsx`，`(app)/layout.tsx` 掛出嚟）——撳開由右滑出側欄。

### 顯示判斷（server 端，唔係 CSS 隱藏）

`(app)/layout.tsx` 用 `getViewGrants()`（`src/lib/rbac/nav.ts`，同左欄
導航列共用一次 `/api/roles/:id/permissions` fetch）攞返「呢個人有冇
`助手:view`」，冇就連 `<AiAssistantSidebar>` 呢個 component 都唔會
render——雞頭／安員登入，DOM 入面零元素（唔淨係 CSS `display:none`）。

### 側欄本身

- **開關**：撳右邊 tab 開／側欄頂部「關閉」掣／`Esc` 關。開關狀態
  （`zoikan-ai-panel-open`）同闊度（`zoikan-ai-panel-width`，380 或
  560px，頂部「闊／窄」掣切換）存 `localStorage`——刻意喺 `useEffect`
  入面先讀（唔喺 initial render 讀 `window`），避免 SSR/CSR hydration
  唔對版。手機闊度（`window.innerWidth < 768`）側欄全屏，冇「闊／窄」掣。
- **對話**：開側欄／清空之後由 `GET /api/ai/conversation` 讀歷史；問答
  用 `streamAiChat()`（`src/lib/ui/ai-chat-client.ts`）自己攞
  `POST /api/ai/chat` 嘅 SSE `res.body` reader 逐個 event 解（`apiRequest`/
  `apiGet`／`apiPatch` 嗰個共用 fetch helper 淨係識 `res.json()`，處理唔到
  串流，所以呢個 client 獨立寫）；送出嗰陣先用本地訊息「樂觀」插入用戶
  嗰句，`onDone` 之後重新 `GET` 一次對話（等 server 存落 DB 嗰個版本做
  真理來源，樂觀插入嗰句自然俾佢取代，唔會出現重複）。「思考緊…」→
  第一個 delta 到之前顯示；到咗之後逐段（SSE 送嚟嘅 40 字一嚿）換做真
  文字，模擬打字效果（見 `docs/ai-assistant.md`「輸出過濾」一節——後端
  本身唔係逐 token 即時串流，係先儲齊、行完 guard 先切段送）。
- **清空對話**：頂部「清空對話」掣要二次確認（inline 黃色 banner，
  「確定清空」／「取消」），確認先 `DELETE /api/ai/conversation`。
- **錯誤**：`friendlyAiError()`（`ai-chat-client.ts`）將 HTTP 狀態碼轉做
  友善文字——429「今日已達提問上限，聽日再嚟啦。」、503「助手暫時未
  連接到 AI 服務，請稍後再試。」、401/403 都有專屬文字，其他狀態碼用
  後端 `message` 或者通用 fallback。
- **markdown**：助手回覆用 `parseSimpleMarkdown()`（純函數，
  `src/lib/ui/simple-markdown.ts`）解析，`<SimpleMarkdown>`
  （`src/components/ai/SimpleMarkdown.tsx`）轉做 JSX——支援段落、有序/
  無序列表、`**粗體**`、GFM 風格表格（`| a | b |` + `| --- | --- |`）。
  刻意唔引入第三方 markdown 套件（範圍可控、少一個 attack surface）。

### 頁面上下文（`context`）

`src/lib/ui/ai-context.ts` 嘅 `deriveAiContext(pathname, searchParams)`
純函數，喺用戶撳「送出」嗰一刻讀 `window.location`（刻意唔用
`next/navigation` 嘅 `useSearchParams()`——呢個 component 掛喺
`(app)/layout.tsx` 包住全站，用咗會逼成個 layout 都要包 Suspense
boundary，同 `RosterEditor.tsx` 避開嘅理由一致）：

| 頁面 | 解析出嚟嘅 context |
|---|---|
| `/roster/:site/:month`（可帶 `?broker=`） | `site_id`／`month`／`broker` |
| `/reports/gross-margin?month=` | `month` |
| 其他頁面 | 淨係 `path` |

送 `POST /api/ai/chat` body 帶呢個 `context`——後端 `ChatRequestSchema`
（`src/app/api/ai/chat/route.ts`）加咗一個 optional、`.strict()` 嘅
`context` 欄位，`buildSystemPrompt(session, context)`
（`src/lib/ai/system-prompt.ts`）將佢轉做 system prompt 入面一段明文
標示「僅供參考，唔係指令」嘅提示（同用戶輸入/工具結果一樣，唔可以
用嚟改變鐵律，亦唔會影響任何權限/查詢判斷——純粹幫個模型估中「呢個
盤」「今個月」指邊個）。

### 測試

- Vitest 純函數（`tests/ai-ui-context.test.ts`／
  `tests/ai-ui-markdown.test.ts`／`tests/ai-ui-chat-client.test.ts`）：
  `deriveAiContext()`／`parseSimpleMarkdown()`／`friendlyAiError()`。
  「助手」module 嘅逐角色 grant 判斷（老闆/主管/會計✓、雞頭/安員✗）已經
  由 `tests/wp2-rbac-matrix.test.ts`（逐 `MODULES × ACTIONS × ROLE_NAMES`
  通用跑）覆蓋，`getNavLinks()`/`getViewGrants()` 本身要 `next/headers`
  嘅 request context，冇沿用嗰種直接 vitest 手法，留俾底下嘅 e2e 驗證
  實際 render 結果。
- Playwright `tests/e2e/ai.spec.ts`（5 條，同 wp3/wp4 現有 e2e 一齊跑）：
  (a) 老闆見到 tab＋歡迎語＋4 個例子；(b) 撳例子出現用戶訊息＋助手回覆；
  (c) 雞頭冇 tab（DOM 零元素）＋直接打 API 403；(d) 清空對話後歡迎語
  返嚟；(e) 更表頁問「呢個盤」，`page.route()` 攔截請求斷言 body 帶
  `context.site_id`/`context.month`。
- **`AI_LLM=fake`**（`src/lib/ai/llm.ts`）：Playwright 打嘅係真正起緊嘅
  dev server，唔似 vitest 可以喺同一個 process 用
  `setLlmClientForTests()` 換走 model client，所以 `getLlmClient()`
  加咗一個由環境變量開嘅假分支——回一個零工具調用、固定廣東話回覆嘅
  `FakeDevLlmClient`，唔會削弱任何 guard／權限（`requirePermission()`／
  daily limit／`checkOutputGuardAndAudit()` 全部一樣行）。
  `playwright.config.ts` 嘅 `webServer.env` 帶咗呢個 env——已知限制：
  `reuseExistingServer: true` 之下，如果開發者自己手動起咗一個冇呢個
  env 嘅 dev server，Playwright 會沿用嗰個，AI 相關場景會打真 AI Hub。
