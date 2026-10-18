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
