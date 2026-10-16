# WhatsApp 群組 AI 自動報更與請假／替更分流模組 — 實施計劃書（分析階段，未動 code）

> 規劃：Fable 5.1（2026-10-16）。純分析＋計劃，等老闆批核先開工。執行照常規：Sonnet 5.5 執行、Opus 5.5 驗收、gate 不變先 merge／部署。

## 0. 一句總結

喺 Zeabur 另開一個 WAHA（WhatsApp HTTP API）容器，用公司專用號碼被動入群**只聽唔講**；群組訊息經 HMAC 簽名嘅 webhook 入系統，先落庫（messageId 冪等），再由排程 job 做「零成本規則過濾 → DeepSeek 結構化解析 → 程式碼配對（唔靠 AI 認人）→ 信心分流」：全部硬鍵齊、冇撞更 → 以 `source="whatsapp"`、`status=pending_approval` 寫入排更（經現有鎖月 transaction 保護，主管一鍵批核）；任何唔確定 → 寫入現有 Triage 分流題（原話＋候選人一鍵揀）。替更（改第二個人嘅更）首階段一律落 Triage。

## 1. 現有架構對齊（已讀 code，事實）

| 範疇 | 現況 | 對本模組嘅含義 |
|---|---|---|
| 保安員識別 | `Guard`（`nameZh`／`nameEn`／`tel`／`nameAliases: String[]`）、`GuardPhone`（多電話，`@@unique([guardId, tel])`）；**冇 `GuardNameAlias` 表**。`src/lib/roster-upload/match.ts` 有現成 `GuardMatchIndex`（`byName`／`byAlias`／`byNameAndTel`／`byAliasAndTel`／工號）同一套「對唔到→null，唔准估」規則；`src/lib/guards/identity.ts normalizeTelHk`。 | 直接重用 index：發訊人電話 → `GuardPhone`／`Guard.tel`；花名 → `nameAliases`。花名學習＝Triage 答題後加 alias（同 `month-close/auto/guard-match.ts linkIdentityToGuard` 一樣做法，journal＋audit）。 |
| 盤口識別 | `Site.aliases: String[]`；`src/lib/month-close/auto/site-match.ts classifySiteName`（exact／auto／propose／new，分辨字規則：CP1-4 vs CP5 永不自動合併）。 | 文字指明盤口直接用 `classifySiteName`；群組綁定另起表（見 §4）。 |
| 更別 | `ShiftType`（每盤 `code`＝N/C/A/B/IC…、`startTime`／`endTime`）；`time-range.ts shiftTypeTimeSlot`；`cell-codes.ts classifyCode`（shift／leave／ot／marker）＋`LeaveCode`（AL/NL/RD/SL/SH）。 | 「早／中／夜」要對返該盤 `ShiftType`：用 `startTime` 時段＋每盤可選「口語→更碼」對照（§4 表 `whatsapp_groups.shift_word_map`）。 |
| 排更寫入 | `POST /api/shift-records/batch`：每格 `{guard_id, shift_type_id, work_date, code}`，plan→tx 內 `assertMonthNotLockedTx`（FOR SHARE，防 TOCTOU）、重用已取消行、計價 snapshot、quota 警示、audit；`status` 主管＝confirmed、雞頭＝`pending_approval`；`/[id]/approve`／`/reject` 已有。 | **唔另寫一套寫入**：抽 batch 嘅 plan＋apply 核心做可重用 service（`src/lib/shift-records/write.ts`），WhatsApp 用同一路徑，`source="whatsapp"`、`provenance={message_id, group_jid, sender_hash}`。 |
| 鎖月 | `month-lock.ts`：`assertMonthNotLocked`（route 層）＋`assertMonthNotLockedTx`（tx 內）。 | 所有 WhatsApp 寫入喺 tx 內再查一次；鎖咗月 → 唔寫、出 Triage 題「鎖月中，人手處理」。 |
| 長工病假／頂位 | `sl-confirm.ts`：SL 段要人手確認先出 4/5；`cover-shifts.ts` 只讀認定頂位更。 | WhatsApp 寫入 `leave_code=SL` 嘅 leave 格後，現有長工糧草稿流程照舊彈「病假待確認」；頂位更由 settlement broker 規則自動認定，本模組唔另計。 |
| AI 呼叫 | `src/lib/ai/llm.ts LlmClient`（DeepSeek 預設，Claude 可切）、`providers/deepseek.ts`（OpenAI 相容、工具呼叫、`MAX_TOKENS`）；`ai-rate-limit.ts` 每人每日上限。**AI 鐵律**：`zoikan_ai_ro` 只可 SELECT `ai` schema，AI 唔可以見 PII，OCR 係唯一例外（記憶體處理）。 | 訊息原文含姓名／花名／電話＝PII → **要老闆批第二個例外**（§8 決策 1）：解析器只喺記憶體收訊息原文，唔傳保安員名單，唔落 AI log。 |
| Triage | `TriageSession(sourceType, sourceRef)` unique；`TriageQuestion(kind, groupKey, evidenceJson, optionsJson, answer…)`；`resolve.ts`／`apply.ts`（preview→submit，previewHash）／`batch-accept.ts`（MC_SOURCES 白名單）／`jobs/triage-reminder.ts`。`kind` 係字串但 `types.ts QuestionKind` 聯集＋`KIND_LABEL`。 | 新增 `sourceType="whatsapp"`、新 kind 六種（§6）；`optionsJson` 用現有 option 機制（揀候選 guard／建 alias／略過）；`batch-accept` 加入 `whatsapp` 來源嘅「有預填高信心」題。 |
| 排程／通知 | `src/lib/scheduler`（cron、lock、runner）＋`jobs/registry.ts`；`notify/create.ts`（`assertNoPii`）。 | 解析 job 掛入 registry（每 30 秒）；「有新分流題」用現有通知（唔含 PII）。 |
| 部署 | 單一 Next standalone Docker（Zeabur）；冇 docker-compose；而家冇任何 webhook／HMAC 路由（`createHmac` 只用於 continuation／person-key）。 | WAHA 另開 Zeabur service（§7）；webhook 係系統第一條無 session 嘅公開路由，要獨立安全設計（§3）。 |

## 2. 資料流（總覽）

```
WhatsApp 群組 ──► WAHA 容器（被動）──webhook(HMAC)──► POST /api/webhooks/whatsapp
   │ 落庫 whatsapp_messages（message_id unique＝冪等）→ 200
   ▼ job whatsapp-parse（每 30s，scheduler lock）
   ├─ 第 0 層：群組綁定？發訊人？規則打分（零成本）→ ignored / candidate
   ├─ 第 1 層：DeepSeek json_object → 1..n 條 intent（raw 片段＋相對日期 token）
   ├─ 程式碼解析：日期（HK 時區、訊息時間為基準）／盤口（classifySiteName）／
   │              人（電話→GuardPhone；花名→nameAliases；唔准估）／更碼（ShiftType）
   ├─ 衝突檢查：同人同日同更／請假 vs 更／鎖月／過去日子
   └─ 分流：全硬鍵 ∧ 無衝突 → shift-records write（pending_approval，source=whatsapp）
             否則 → TriageQuestion（原話＋候選一鍵揀）→ 答題 apply 走同一 write
```

## 3. 核心問題 1：Webhook 接收、冪等、安全

### 3.1 路由
`POST /api/webhooks/whatsapp`（Next route；**唔經 session／RBAC**，獨立保護）。只接受 WAHA 事件 `message`（唔訂 `message.any`／`message.ack`／`presence`）。

### 3.2 來源驗證（三重）
1. **HMAC**：WAHA 內置 `WHATSAPP_HOOK_HMAC_KEY` → 每個 webhook 帶 `X-Webhook-Hmac`（sha512，對 raw body）＋`X-Webhook-Hmac-Algorithm`。系統用 `crypto.createHmac("sha512", WA_WEBHOOK_HMAC_KEY)` 對 **raw body bytes**（唔係 re-serialize 嘅 JSON）計算，`timingSafeEqual` 比對；key 只放 Zeabur env，唔入 git。
2. **共享 secret header**：WAHA `WHATSAPP_HOOK_CUSTOM_HEADERS=X-Zoikan-Hook:<random>`，雙重保險（HMAC 失敗或 header 唔啱 → 401，唔落庫，唔 log body）。
3. **私網**：WAHA 同 Next 同一 Zeabur 專案，hook URL 用內部服務名（`http://zoikan:8080/...`）；外網路徑 `/api/webhooks/*` 由 middleware 擋（只接受帶內部 header 嘅請求；如 Zeabur 唔支援私網就用 IP allowlist＋HMAC）。

### 3.3 冪等／防重覆
- `whatsapp_messages.message_id` **unique**（WAHA `payload.id`），另 `(session, chat_jid, message_id)` 索引。處理順序：先驗簽 → `INSERT … ON CONFLICT DO NOTHING` → 200。重覆投遞（WAHA 重試、網絡抖動）＝no-op 200。
- 事件時間窗：`timestamp` 早過 72 小時或喺未來 10 分鐘以外 → 落庫但標 `ignored:stale`（防重放）。
- body 上限 64 KB；非 JSON／schema 唔啱 → 400（唔記 body）。
- `fromMe=true`（公司號碼自己發）→ 忽略；非群組（`@g.us` 以外）→ 落庫標 `ignored:not_group`（唔處理私訊，私隱）。
- 媒體（圖／語音／貼圖）：只記 `media_type`，**唔下載**（首階段唔做語音／圖片報更；§8 決策 7）。

### 3.4 回應策略
Webhook 只做「驗簽＋落庫」，<50 ms 回 200；解析由 job 做（WAHA 等回應超時會重試，重試會被冪等吸收）。

### 3.5 資料表 `whatsapp_messages`
| 欄 | 說明 |
|---|---|
| id, session, chat_jid, message_id (unique), sender_jid, sender_tel_norm, sender_guard_id?, ts, text, media_type?, quoted_message_id? | 原始 |
| status: received→filtered→parsed→routed→done / ignored / error；filter_score, filter_reasons[] | 第 0 層 |
| parsed_json（LLM 原始輸出）、llm_provider／model／tokens、error | 第 1 層 |
| retention: `redacted_at`（§7.5 保留期後 text 置空、只留 hash） | 私隱 |

## 4. 核心問題 3：群組與盤口綁定

新表 `whatsapp_groups`（唔改 `Site`——一個盤可以有幾個群，一個大群可以多盤）：

| 欄 | 說明 |
|---|---|
| group_jid (unique), label, active | WAHA 群 id（`xxxx@g.us`）；label 由系統自動抓群名（非 PII） |
| kind: `site` / `multi_site` / `broker` / `office` / `ignored` | `site`＝單盤群（訊息冇講盤就預設呢個盤）；`multi_site`＝大群（必須文字指明盤口）；`broker`＝判頭群（settlement broker 預填）；`ignored`＝唔處理 |
| site_id?, broker_id? | 綁定 |
| shift_word_map (json) | 該群口語→更碼，例如 `{"早":"A","夜":"N","通宵":"N"}`；冇就用 `ShiftType.startTime` 時段推（06–12 早、12–18 中、18– 夜） |
| auto_write (bool, default false), auto_confirm (bool, default false) | §6 分流開關（分群逐步放開） |
| created_by, updated_at | audit |

UI：「WhatsApp 報更」頁 → 群組列表（WAHA `GET /api/{session}/groups` 同步）、綁盤口、揀 kind、口語對照、開關。權限：新 module「WhatsApp 報更」（老闆 config；老闆／會計／主管 view；雞頭硬性 D——群組原話含其他雞頭嘅人）。

**大群文字指盤**：先用 `classifySiteName(rawSite, 全部 active sites)`：`exact`／`auto` 先採用；`propose`／`new` → Triage `wa_site_ambiguous`。單盤群入面文字指明**另一個**盤 → 以文字為準但降級（唔自動寫，出 Triage）。

## 5. 核心問題 2：兩層過濾＋AI 結構化解析＋私隱邊界

### 5.1 第 0 層（零成本規則，code 內純函數 `src/lib/whatsapp/filter.ts`）
打分（0–100），≥40 先交 AI：
- 群組 `kind=ignored` 或未綁定 → ignore（但落庫，俾文員喺 UI 見到「未綁定群組有訊息」）。
- 文字長度 <2 或純 emoji／貼圖／媒體 → ignore。
- 關鍵詞命中加分：日期 token（`聽日|今日|後日|大後日|星期[一二三四五六日]|\d{1,2}[/／月]\d{1,2}|\d{1,2}號`）、請假（`病假|SL|AL|年假|放假|唔返|返唔到|請假|告假`）、更（`早|中|夜|通宵|A更|B更|N更|C更|返工|開工|OT|加班|頂|替|換更|補更`）、盤口 alias 命中、發訊人係已知保安員／判頭。
- 減分：問句（`？|?|幾時|邊個`）、謝謝／收到／OK 類、轉發長文、連結。
- 回覆（quoted）訊息：帶上被回覆嘅文字做上下文（只限同群 24 小時內）。
- 所有規則可喺 `whatsapp_groups` 層面微調閾值；UI 顯示「被過濾」訊息俾人抽查，調校誤殺。

### 5.2 第 1 層（DeepSeek json_object；`src/lib/whatsapp/parse.ts`）
- 輸入：訊息原文、訊息時間（HK）、群組 kind、**該群／該盤嘅更碼表**（非 PII：`[{code:"A", label:"早", time:"07:00-15:00"}…]`）、口語對照、被回覆文字。**唔傳保安員名單**（§5.4）。
- 輸出 schema（strict）：
```json
{ "noise": false,
  "intents": [{
    "type": "shift|leave|cover|cancel|unclear",
    "date": { "raw": "聽日", "kind": "relative|absolute|range", "iso_guess": "2026-10-17", "to_iso_guess": null },
    "site_raw": "海濱",
    "persons": [{ "raw": "陳大文", "role": "worker" }, { "raw": "李四", "role": "replaced" }],
    "self_reference": true,
    "shift_raw": "早", "shift_code_guess": "A", "hours": null,
    "leave_raw": "病假", "leave_code_guess": "SL",
    "confidence": 0.86, "evidence": "聽日17號海濱陳大文返早"
  }] }
```
- Prompt 策略：system prompt 列明「只抽取，唔推斷未出現嘅內容；相對日期只回 raw＋以訊息時間（HK）推算嘅 iso_guess，最終由程式決定；一句可以多條指令；替更＝兩條（replaced 嘅人 cancel／leave ＋ worker 嘅 shift）」；few-shot 用**合成**例子（測試甲／乙、假日期）；`temperature 0`、`reasoning_effort low`、輸出上限 2,000（吸收 OCR-5.6 教訓：思考 token 計入上限，要真 API 實測）；DeepSeek 失敗退回 Claude（`LlmClient` 已支援）。
- 日期最終解析喺 code：`src/lib/whatsapp/dates.ts`（HK 時區、以訊息 `ts` 為「今日」；「聽日 17 號」同時有相對＋絕對 → 兩者一致先採用，否則 `wa_date_ambiguous`；「下星期一」＝下一個星期一；range「17–19 號」展開逐日）。

### 5.3 人嘅配對（code，唔靠 AI 認人；`src/lib/whatsapp/resolve.ts`）
重用 `GuardMatchIndex`（`service.ts` 起 index 嘅做法）：
1. `self_reference`（「我聽日…」／冇提名）→ `sender_tel_norm` 對 `GuardPhone.tel`／`Guard.tel`（全表唯一先算硬鍵；一個電話掛多人 → `wa_person_ambiguous`）。
2. 有名／花名 → `byName`／`byAlias`；同群組綁定盤口近 60 日有更嘅保安員優先排序（只影響候選次序，唔影響「唯一先自動」）；唯一命中＝硬鍵；多個 → `wa_person_ambiguous`（候選列出，Triage 一鍵揀）；零命中 → `wa_person_unknown`（Triage：揀人並加 alias／建新保安員走現有流程／略過）。
3. 判頭群：發訊人係判頭（`Broker` 聯絡電話）→ 人名候選先限該判頭近 60 日有更嘅保安員。
4. 花名學習：Triage 答「係 X」→ `nameAliases` 加 raw（同 guard-fix link 一致，journal＋audit）；同一花名第二次直接命中。

### 5.4 私隱邊界
- LLM 只見**訊息原文**（含人名／花名——老闆要批例外）＋非 PII 上下文；**唔見**保安員名單、電話、工號、DB 任何資料；唔用 `zoikan_ai_ro`。
- 訊息原文存 DB（主庫，同 shift_records 一樣受 RBAC）；AI log／app log／notify 只記 message_id、分數、intent 數。
- 發訊人電話只存正規化值＋`sender_guard_id`；UI 顯示用保安員姓名（有權限者）；雞頭角色永遠睇唔到本模組。
- 保留期（§7.5）。

## 6. 核心問題 4：信心分流與 Triage 整合

### 6.1 自動寫入條件（全部要齊，缺一即 Triage）
1. 盤口：群綁定單盤，或文字 `exact`／`auto`。
2. 保安員：硬鍵（發訊人電話唯一、或名／花名唯一命中）。
3. 日期：唯一解析、**唔早過今日 −2 日**、**唔遲過 +45 日**、所屬月份未鎖。
4. 更碼：對到該盤唯一 `ShiftType`（或請假碼合法）。
5. 衝突：同人同日已有非取消記錄而更別唔同（或已有請假）→ 唔自動；同更已存在 → no-op（回覆「已存在」唔寫）；盤口當日該更已滿（`DailyRequirement`／quota 警示）→ 唔自動。
6. `intent.type ∈ {shift, leave}`；`cover`／`cancel` 首階段一律 Triage（§8 決策 3）。
7. 群組 `auto_write=true`。

### 6.2 寫入方式
- 經共用 write service（由 batch 抽出）：tx 內 `assertMonthNotLockedTx` → 重用已取消行 → 計價 snapshot → `status=pending_approval`（群組 `auto_confirm=true` 先 confirmed；§8 決策 2）→ audit（`source=whatsapp`、provenance 帶 `message_id`）→ `whatsapp_intents.result_ref=shift_record_id`。
- 批核：現有 `/api/shift-records/[id]/approve`／`reject`；排更頁加「來自 WhatsApp」標記＋原話 tooltip；新「WhatsApp 待批」清單（一鍵批核多條）。

### 6.3 Triage 題（新 kind，入 `types.ts QuestionKind`＋`KIND_LABEL`）
| kind | 觸發 | options | apply |
|---|---|---|---|
| `wa_person_ambiguous` | 名／花名／電話對到多人 | 候選 guard 列表（顯示姓名／工號／近 60 日盤口）、略過 | 揀人 → 加 alias（可選）→ 走 §6.2 寫入 |
| `wa_person_unknown` | 零命中 | 搜尋揀人（現有 guard-search）、「新保安員」（導去入職流程，唔喺度建）、略過 | 同上 |
| `wa_site_ambiguous` | 盤口 propose／new／單盤群指另一盤 | 候選盤 | 定盤後重跑解析 |
| `wa_date_ambiguous` | 相對／絕對唔一致、range 唔清 | 日期輸入（預填 guess） | 定日後重跑 |
| `wa_shift_conflict` | 同人同日撞更／請假 vs 更／鎖月／額滿 | 「以 WhatsApp 為準（取消舊）」「保留舊」「人手改」 | 取消舊＋寫新（同 tx） |
| `wa_unparsed` | AI 判 noise=false 但 intent 不完整／`cover` 首階段 | 「人手入更」（深連結去排更格預填）、「忽略」 | — |

- `TriageSession`：`sourceType="whatsapp"`，`sourceRef=<group_jid>:<YYYY-MM>`（每群每月一個 session，`groupKey=message_id:idx` 冪等）；owner＝群組綁定盤嘅主管（冇就老闆）。
- `evidenceJson`：原話、發訊人（guard id／電話尾 4 位）、解析結果、候選；UI 題目卡顯示「WhatsApp 原話」＋群名＋時間。
- `batch-accept`：`wa_person_ambiguous` 有唯一「近 60 日同盤」候選、`wa_shift_conflict` 預設「保留舊」呢類可入批量接受白名單（老闆決定）。
- 提醒：現有 `jobs/triage-reminder.ts` 照用；每日摘要「WhatsApp：收 N、自動 M、分流 K、忽略 J」（唔含 PII）。

## 7. 核心問題 5：部署與運維

### 7.1 架構
- Zeabur 同一專案新增 service `waha`（image `devlikeapro/waha`，NOWEB engine；**唔用** Chromium engine 慳資源）、持久 volume 掛 `/app/.sessions`（session 檔，重啟唔使再掃 QR）；env：`WHATSAPP_HOOK_URL=http://<next-service>:8080/api/webhooks/whatsapp`、`WHATSAPP_HOOK_EVENTS=message`、`WHATSAPP_HOOK_HMAC_KEY`、`WHATSAPP_HOOK_CUSTOM_HEADERS`、`WAHA_API_KEY`（Next 查群組列表用）、`WAHA_DASHBOARD_ENABLED=false`（或 basic auth 只限老闆 IP）、`WHATSAPP_DOWNLOAD_MEDIA=false`。
- Next 側：`WA_WEBHOOK_HMAC_KEY`、`WA_WEBHOOK_HEADER_SECRET`、`WAHA_BASE_URL`、`WAHA_API_KEY`、`WA_ENABLED=0/1`（總開關，預設關）。
- 現有 Dockerfile **唔改**；唔用 docker-compose（Zeabur 服務間私網）。本機開發：`docker run devlikeapro/waha` ＋ ngrok 指向本機（只限開發者測試群）。

### 7.2 防封號守則（WhatsApp 非官方客戶端有被封風險——§8 決策 4）
- **純被動**：系統永遠唔 call 任何 send／typing／presence／read-receipt API；code review 加 lint 規則擋 `/api/sendText` 等路徑。
- 專用公司 SIM 號碼（唔用老闆私人號），先養號 1–2 星期、人手入群；一次只入 ≤10 個群，逐週加。
- 保持 WAHA 長期在線（volume 持久、健康檢查自動重啟）；唔頻密登出／重掃。
- 唔抓歷史訊息（唔 call chat history），只聽新訊息；唔下載媒體。
- 一旦封號：WAHA 事件 `session.status=FAILED` → 通知老闆；後備＝主管人手轉發／照舊人手入更（系統其他部分唔受影響）。

### 7.3 可用性／監控
- `GET /api/whatsapp/health`：WAHA session 狀態、最後收到訊息時間、job 積壓數、最近 24 小時錯誤數；`jobs/nightly-month-health` 加一行。
- 超過 6 小時冇任何群組訊息（工作日）→ 通知老闆「WhatsApp 橋接可能斷線」。
- Job 失敗重試 3 次後 `status=error`，UI 可「重新處理」。

### 7.4 成本估算
每群每日約 30–80 條訊息，第 0 層通常過濾 70%+；10 個群 → 每日約 100–250 次 DeepSeek 呼叫，每次 <1,500 token，月費用可忽略；Claude 只做後備。

### 7.5 保留期／刪除
訊息原文保留 90 日（§8 決策 6）後置空（保留 hash、解析結果、result_ref），audit 照舊永久；群組解除綁定時唔刪歷史。

## 8. 要老闆拍板嘅決策點

| # | 決策 | 建議 |
|---|---|---|
| 1 | **AI 鐵律第二個例外**：解析器可以見訊息原文（含人名／花名／電話），記憶體處理、唔傳名單、唔落 AI log | 批准（同 OCR 例外同款） |
| 2 | 自動寫入狀態：`pending_approval`（主管一鍵批）定直接 `confirmed` | 首 2 個月 pending_approval；按群逐個開 `auto_confirm` |
| 3 | 替更（頂／換，改第二個人嘅更）：首階段一律 Triage 定可自動 | Triage；觀察 1 個月數據再決定 |
| 4 | 接受非官方 WhatsApp 客戶端嘅封號風險；用專用公司號碼 | 接受，專用 SIM；後備人手流程 |
| 5 | 傳唔傳候選花名清單俾 LLM 提高認人率 | 唔傳（私隱）；靠 Triage 學 alias |
| 6 | 訊息原文保留期 | 90 日 |
| 7 | 語音／圖片報更 | 首階段唔做；只記有媒體 |
| 8 | 試點群組 | 揀 2 個單盤群＋1 個判頭群試 2 星期 dry-run |
| 9 | 新 RBAC module「WhatsApp 報更」權限矩陣 | 老闆 config／老闆、會計、主管 view／雞頭 D |

## 9. 分階段實施

| 階段 | 內容 | 驗收標準 |
|---|---|---|
| **W0 基建** | 表 `whatsapp_groups`／`whatsapp_messages`／`whatsapp_intents`（只加）；webhook（HMAC＋secret＋冪等＋限制）；WAHA Zeabur service；群組同步＋綁定 UI；health；RBAC module；`WA_ENABLED` 總開關 | 真實群組訊息落庫、重覆投遞 0 重覆、HMAC 錯 401；Playwright 綁定流程；gate 不變 |
| **W1 解析（dry-run）** | 第 0 層過濾、DeepSeek 解析、日期／盤口／人／更碼解析、衝突檢查；**只記錄建議，唔寫更**；「建議 vs 實際排更」對照頁 | 試點 2 星期：自動建議準確率（對照人手排更）≥90%、誤殺率 <5%；真 API schema／上限實測（OCR 教訓） |
| **W2 Triage** | 六種新 kind、session 建立、答題 apply（經共用 write service）、alias 學習、batch-accept 白名單、提醒 | 文員喺 Triage 一鍵處理；答題後寫入正確、鎖月擋住 |
| **W3 自動寫入** | 共用 write service（由 batch 抽出，batch 行為不變）；條件 §6.1；pending_approval；排更頁「來自 WhatsApp」標記＋待批清單 | 試點群 auto_write 開；撞更 0 次自動覆蓋；audit 完整 |
| **W4 請假／替更／SL** | leave 碼寫入、SL 接現有病假確認、cover 兩段式（Triage）、cancel | 長工糧草稿正確彈病假確認 |
| **W5 運維** | 保留期 job、每日摘要、封號告警、口語對照 UI、指標儀表 | 連續 4 週無人手干預運行 |

每階段：Sonnet 執行 → Opus 驗收 → gate（locked-months／ltpay-aug）不變 → 部署 → 試點數據回報老闆。

## 10. 風險與對策
- **封號**：§7.2；系統設計成「WhatsApp 斷咗照常運作」。
- **AI 讀錯日期／人**：日期由 code 最終決定；人只靠硬鍵；其餘全部 Triage——寧願多問，唔准估。
- **webhook 被偽造**：HMAC＋secret＋私網三重；401 唔落庫。
- **鎖月 TOCTOU**：同 batch 一樣 tx 內 `assertMonthNotLockedTx`。
- **PII 外洩**：LLM 唔見名單；log／notify `assertNoPii`；雞頭角色硬性 D；保留期。
- **大群噪音**：第 0 層閾值可調＋被過濾訊息可抽查；`multi_site` 群冇指明盤口一律唔自動。
