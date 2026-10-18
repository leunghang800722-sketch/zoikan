# 分流題卡 inline 顯示原文件欄位裁圖 — 方案（TE-1，2026-10-18）

> 老闆要求：凡 OCR 讀唔到／有問題嘅分流題，題卡要直接顯示當初文件相應欄位（身份證號／姓名／出生日期／電話／地址）嘅裁圖，覆核人對住圖打返正確資料；唔要連結去 Drive 搵。280 條現有題要補做。
> 民隱／身份證敏感：方案先經 Opus 把關，再由 Sonnet 實作、Opus 驗收。

## 1. 鐵律對照（事實，唔係假設）

- **AI 助手鐵律**（memory／P3 記錄原文）：`zoikan_ai_ro` 只可 SELECT `ai` schema；新表永遠唔入 `ai` schema；**AI 唔可以見 PII**；OCR 係唯一例外——**OCR 讀取路徑**嘅圖片同讀值只喺記憶體，唔寫 log／DB／audit。
- 鐵律嘅對象係「AI 讀取／處理」嗰條路徑（防止 AI 管線靜靜留低證件圖同讀值）。**主資料庫本身一直存 PII**（保安員表、身份證號、地址）並由 RBAC 保護；而且生產 DB 已經存上載檔案 bytes（更表／Postorder／員工名單三張表，`file_bytes bytea`，雞頭硬性 deny）。
- 結論：**「覆核證據裁圖」唔係 AI 路徑產物，而係人手覆核用嘅文件證據**，同更表上載檔案同類。只要做到 (a) 唔入 `ai` schema、AI 角色永遠讀唔到；(b) 只存**欄位裁圖**（唔存成頁／成張證件）、細圖；(c) 受「保安員個人資料:view」RBAC、雞頭硬性 deny；(d) 唔經 AI OCR route 寫入（由本機批量腳本或人手上載，走獨立 API）；(e) 有保留期，答完題後自動刪——**唔違反鐵律文字，亦守住精神**。
- 「存 Drive 連結＋顯示時即讀」**唔建議**：生產伺服器要持有 Drive 服務帳戶憑證（新增一組 secret）、每次顯示要下載整份 PDF（含成張身份證）再即時渲染裁圖（Docker 冇 pdftoppm／要加 sharp），延遲高、手機體驗差，而且顯示嗰刻伺服器記憶體一樣見到成頁——**暴露面反而大過只存細裁圖**。

## 2. 做法

### 2.1 資料
- 新表 `triage_evidence_images`（public schema；**唔入 ai schema**；`ai.audit_log` 排除）：`id`、`session_id`、`question_id?`（可空：先按人配）、`person_key`（server HMAC key，同 `triage_questions.person_key`）、`guard_id?`、`field`（hkid|name_zh|name_en|dob|phone|address|permit_no|…）、`doc_kind`（id_card|onboarding_form|address_proof|sia_permit）、`image_bytes bytea`（PNG/JPEG，**≤120 KB**，長邊 ≤800px）、`width`、`height`、`sha256`、`source`（`batch_crops`|`manual_upload`）、`created_by`、`created_at`、`expires_at`（**安全網上限**：建立後 180 日；跳過留返人手嘅題 30 日）、`deleted_at`。**主規則係「答題即刪」（老闆 2026-10-18 確認）：題目 answered／superseded／session done 嗰一刻，同一 tx 內即時 hard delete 該題嘅裁圖（唔等保留期）**；保留期只係漏網之魚（跳過、遲遲未答、session 棄置）嘅後備時限。索引 `(session_id, person_key, field)`。
- 唔存成頁、唔存檔名（檔名含真名）、唔存 Drive 路徑。

### 2.2 來源
- **現有 280 題（補做）**：本機已有批量管線裁圖——電話 469、出生日期 315、姓名 315、地址 245、入職表地址 87、牌照／銀行／表格欄 2,063 張（`data/2026-10/staff-import/{out,crops}`、`data/2026-10/staff-fields/crops`）。本機腳本 `scripts/staff-import/20-triage-evidence.ts`：按分流題所需欄（由 question kind／review_fields 推）揀裁圖（冇現成就由原 PDF 頁按 `crop-box.ts`／`field-crops.ts` 幾何即時裁，身份證號用身份證號碼區域），縮至長邊 800px、JPEG q80、≤120 KB，打包 **zip**（`manifest.json`＋圖；manifest 只含 `match{hkid, staff_numbers}`＋field＋doc_kind，同 TR-1 proposals 一樣由伺服器推返 personKey）。
- **上載**：分流 session 卡「⋯ → 上載覆核裁圖」（同 TR-1 對話框）→ `POST /api/triage/sessions/[id]/evidence-images`（multipart zip ≤8 MB，每 zip ≤300 張；`jszip` 已係依賴）→ 伺服器校驗身份（同 TR-2 身份防呆：推導 key 同 evidence 一致）→ 寫表；dry run 顯示「配對到 N 題、M 張」。分批上載（約 280 題 × 1–3 張 ≈ 600 張 → 3–4 個 zip）。
- **日後新題**：批量導入時同一腳本一併出 zip（導入包嘅姊妹檔）；應用內「上載證件建檔」產生嘅單人題（罕見）——前端已有欄位裁圖（OCR-3），提交導入時一併 POST（同一 API，單人）。

### 2.3 顯示
- 題卡（`TriageDialog`／手機覆核畫面）：有裁圖嘅欄位喺對應輸入框**上方 inline 顯示**（可放大），`GET /api/triage/evidence-images/[id]`（image/jpeg，`Cache-Control: private, no-store`，要「保安員個人資料:view」＋可睇該 session；雞頭 403）；冇圖就唔顯示（唔阻答題）。375px。
- **答題即刪**：submitAnswer／supersede／session done 同一 tx 內 delete 該題裁圖（撤銷回填唔需要圖：撤銷係還原資料值，唔係重看圖）；跳過（skipped）嘅題圖保留至 30 日後由每日 job 刪；任何圖最長 180 日（建立起計）必刪。job 每日 03:30 清 `expires_at` 過期行。

### 2.4 安全／私隱
- RBAC：讀圖要「保安員個人資料:view」＋ session 可見；寫入要「導入分診:update」；雞頭／保安員角色硬性 deny。
- AI：`zoikan_ai_ro` 無權；`ai.audit_log`／任何 `ai.*` 視圖排除此表；AI 診斷工具唔會引用。
- Audit：只記計數（上載 N 張、配對 M 題）、唔記圖／唔記欄值。
- 大小限制防塞爆 DB：單張 ≤120 KB、每題 ≤4 張、全表上限告警（>200 MB）。
- 傳輸：HTTPS；回應 no-store；圖 URL 要 session cookie，唔可分享。

## 3. 工作量
- 本機腳本（裁圖揀選／即時裁／zip）：0.5 日；伺服器 API＋表＋顯示＋保留 job＋測試：1 日；Opus 驗收＋補做上載：0.5 日。**約 2 個工作日**；首批 280 題補做可以喺 API 上線當日完成。

## 4. 風險
- 身份證圖片入 DB（雖然係欄位裁圖）：靠 RBAC＋保留期＋no-store 控制；比起 Drive 全份 PDF 對任何有 Drive 權限嘅人開放，風險更細。
- 裁圖幾何唔準（手寫越格）：用 OCR-3 嘅外擴規則；同時提供「睇成頁」？——**唔提供**（唔存成頁）；裁唔準嘅欄 Eric 仍可跳過留人手。
- 批量管線裁圖嘅人↔文件對應靠工號／身份證（同 TR-1 一樣防呆），配對錯人會顯示錯圖——伺服器身份檢查擋；再加「裁圖所屬工號尾 2 位」唔顯示（避免再露 PII）。

## 5. 要老闆知／決定
- 已確認（老闆 2026-10-18）：答題即刪；跳過 30 日、最長 180 日只係安全網。
- 係咪接受「只存欄位裁圖、唔存成頁」（成頁要睇就去 Drive）。

## 6. Opus 把關結果（2026-10-18）——納入條件（全部採納）
- **M1 決定紀錄**：本方案推翻 2026-09-17「唔存掃描檔，原檔留 Drive」嘅決定嘅一部分——**只存欄位裁圖**（唔存成頁／成張證件）、答題即刪、最長 180 日。老闆 2026-10-18 明確要求「截返相應欄位嘅圖直接貼喺題卡」，視為對呢個例外嘅確認；本文件即係紀錄。
- **M2 範圍**：今次只做本機批量補做（batch_crops）同日後批量導入嘅姊妹 zip；**剔除**「應用內 OCR 欄位裁圖一併 POST」——要另開一項、老闆明確批准、修訂 docs/api.md 鐵律文字先做。
- **M3 權限**：讀圖按欄位映射現有 field-group：姓名／出生日期／地址／身份證號 → 「安員個人資料:view」；電話 → 「安員:view」；銀行欄**剔除範圍**；另加 `restrictedKindsFor` 同 `canAccessOwnedBy`（主管只睇自己嗰批）。
- **M4 bytes 白名單**：`image_bytes` 只由圖片 GET 讀；所有 session／題目 JSON DTO 用 META_SELECT（照 `meta-select.ts`）並加白名單測試，斷言 JSON 永不含 bytes（`brandSafeResponse` 只係 type cast，runtime 唔過濾）。
- **M5 保留不變式**：圖以 `(session_id, person_key, field)` 為鍵；**只要仍有 open 或 skipped 題需要該欄，圖就存在；否則同一 tx 刪除**。覆蓋：submitAnswer（`beforeCommit`，`updateMany count===1` 之後）、TR-2 部分作答（只刪已答欄）、跳過可再答（保留至 30 日）、session done 喺 commit 後（由不變式＋job 處理，唔靠 done 事件）、supersede 兩類（key 輪換刪舊 person_key；重新導入同人同欄新題沿用舊圖）。每日 job（registry＋advisory lock、分批）清 30 日／180 日安全網同孤兒圖；audit 只計數。每類情況都要測試。
- **M6 zip 安全**：entry 名必須係不透明 id（唔准真名）；伺服器唔回顯 entry 名／manifest 內容（回應、error、`app_error_log` 都唔准）；限解壓總量（≤32 MB）／entry 數（≤400）；驗 JPEG／PNG magic bytes；manifest 必須有 `match`，冇就整個拒絕。
- **M7 配對**：本機腳本由同一條 extract 記錄（文件→人）同時產生裁圖同 `match`，唔分開兩次配對；伺服器只驗 manifest 身份同題目 evidence 一致（驗唔到圖內容）；上載前 dry-run 顯示計數，首批由人喺 UI 抽查 10 題。
- **M8 身份證裁圖**：唔可以包含相片頭像——姓名區、號碼區各自裁，避開相片區（幾何用身份證版面比例，另加測試圖）。
- **M9 顯示／隔離**：唔用 `next/image`（會落磁碟快取）；回應 `Cache-Control: private, no-store`＋`X-Content-Type-Options: nosniff`；新表加入 `ai.audit_log` NOT IN；加 `zoikan_ai_ro` 讀唔到新表嘅真連線隔離測試（同 WhatsApp 表一樣）。
- **S1 應用層加密（採納）**：`image_bytes` 用 AES-256-GCM 加密後存；key 由現有 `SESSION_SECRET` 經 HKDF（info `triage-evidence-v1`）派生，**唔加新 secret**；DB 備份／dump 唔係明文。
- **S2**：每欄 ≤2 張、每題總數 ≤12；**S3**：睇圖寫只計數 audit（題 id＋張數）；**S4**：本機腳本剝走 EXIF／APPn，伺服器驗 header；**S5**：補做次序＝先跑 TR 自動答題，再上載裁圖。
- **N**：hard delete 後磁碟要 VACUUM／WAL／快照先清（S1 加密令備份非明文）；本機 `data/ops/` 備份納入保留政策；工作量改估 2.5–3 日。

## 7. 裁圖來源優先順序（老闆 2026-10-18 補充）
每類欄位定一個來源優先順序，有優先文件就用優先文件，冇先退到入職表：

| 欄位 | 第一優先 | 退而求其次 | 備註 |
|---|---|---|---|
| 身份證號、中文姓名、英文姓名、出生日期、性別 | **身份證副本**（id_card 頁）對應區域（號碼區／姓名區分開，避開相片區） | 入職表該欄手寫格 | 同「證件為準」規則一致 |
| 住址 | **住址證明**（address_proof 頁）地址區 | 入職表住址欄 | 冇住址證明（或讀唔出頁）先用入職表 |
| 電話 | 入職表電話欄 | — | 證件冇電話 |
| 牌照號碼／屆滿日 | 牌照卡副本 | 入職表牌照欄 | 日後擴展 |

- 本機腳本按此表揀來源；zip manifest 每張圖帶 `doc_kind`（id_card／address_proof／onboarding_form／sia_permit）同 `priority`（1＝優先來源、2＝退而求其次），**兩個來源都有時可以兩張都出**（每欄 ≤2 張，優先來源排前），題卡先顯示優先來源，第二張摺埋「亦見入職表手寫」。
- 題卡顯示來源標籤（「身份證副本」／「住址證明」／「入職表手寫」）俾覆核人知道對住邊份文件。
