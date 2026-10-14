# 手寫入職表 OCR 及員工資料匯入——準確度審查與修改計劃（分析階段，未動 code）

日期：2026-10-15　規劃：Fable 5.1　狀態：**待老闆批核**（批核後先交 Sonnet 5.5 執行、Opus 5.5 驗收）

## 0. 範圍同兩條路徑

系統有兩條 OCR 路徑，要分開講：

| 路徑 | 入口 | 讀邊啲欄 | 模型 | 核對 |
|---|---|---|---|---|
| **A 應用內「證件新增保安員」** | `src/app/(app)/guards/new-from-docs/` → `POST /api/guards/ocr/read` → `src/lib/guards/ocr/*` | 身份證：中文名／英文名／HKID／出生日期／性別；住址證明：地址；入職表：**只有電話＋地址** | 讀 A＝Claude（Opus 5.5）全圖、讀 B＝DeepSeek 4 格放大；兩讀獨立 | `normalize.reconcile` 兩讀一致＋格式啱先 confirmed；`review-state` 三個關鍵欄一定要人撳「對過證件」 |
| **B 批量匯入腳本** | `scripts/staff-import/*`（本機跑，讀 `data/` 真檔） | 身份證／牌照／銀行卡／申請表（電話、地址、入職日、許可證…） | 本機 OCR 行座標＋Vision 裁圖讀 | `crosscheck.ts` 對打字名單（U Team／Maxwell／DB）；`fields-ext.resolveField` 兩個獨立證據類別先 confirmed |

老闆四個問題主要落喺路徑 A 嘅 prompt／normalize／reconcile（1、2、4）同路徑 B 嘅裁圖（3）。計劃以**兩條路徑共用同一套純函數**為原則（正規化、候選字、地址糾錯放 `src/lib/guards/ocr/`，script 只 import）。

## 1. 現有 code 嘅具體不足（逐項，標明檔案同位置）

### 問題 1：冇跨文件上下文校正（Cross-Document Grounding）

| # | 位置 | 發現 |
|---|---|---|
| 1.1 | `src/lib/guards/ocr/prompts.ts:2`、`:22-42` | 兩個 prompt builder 只收文件類型，構造上**冇位**帶入已識別嘅印刷體資料。呢個係當初刻意設計（兩讀獨立防互相污染），但同時令手寫表讀取完全冇參考。 |
| 1.2 | `src/app/api/guards/ocr/read/route.ts:108` | 三份文件 `Promise.all` **同時**讀，冇「先讀印刷證件、再讀手寫表」嘅次序。 |
| 1.3 | `src/lib/guards/ocr/config.ts:14-18` | `onboarding_form` 只抽 `phone`、`address`。手寫表上嘅姓名／HKID／出生日期**根本冇讀**，所以而家亦冇得同身份證交叉核對；反過來，身份證冇嘅資料（電話、地址）又冇任何高可信度參考。 |
| 1.4 | `src/lib/guards/ocr/read.ts:67-99` | `readDocument` 逐份文件獨立 reconcile，結果之間冇任何關聯（例如入職表地址 vs 住址證明地址、入職表姓名 vs 身份證姓名）。 |
| 1.5 | `scripts/staff-import/lib/crosscheck.ts:69-171` | 路徑 B 有交叉核對，但對象係**打字名單**（U Team／Maxwell／DB），唔係同一申請人嘅印刷證件；而且係讀完先比，唔係讀之前注入。 |

### 問題 2：香港中文地址形近／同音字

| # | 位置 | 發現 |
|---|---|---|
| 2.1 | `src/lib/guards/ocr/normalize.ts:106-112` | 地址只做大寫＋折疊分隔符，**零**地名知識；「邨／村」「埗／步」「涌／湧」「鰂魚涌」「大埔／大浦」等形近字直接當唔同值 → 兩讀一邊啱一邊錯都會 `reads_differ` 落 review，而且預填值可能係錯嗰個（讀 A 優先，`reconcile:138`）。 |
| 2.2 | `scripts/staff-import/lib/compare.ts:133-141`（`cmpAddress`） | 用字詞 Jaccard ≥0.5 做 match，形近字令 token 唔同；數字 Jaccard 對「座／樓／室」位置唔敏感。 |
| 2.3 | `src/lib/guards/ocr/prompts.ts:13`（`address` 描述） | 要求「exactly as printed」，手寫地址本身就寫錯字時模型會照抄，正確做法係**照抄＋另外提供標準化建議**，而唔係要模型自己改。 |
| 2.4 | 全 repo | 冇接任何官方地址庫；香港政府 ALS（Address Lookup Service，`https://www.als.gov.hk`，免費、JSON、免 key）可以用「自由文字」查詢回傳標準中英文地址（地區／屋邨／大廈／座），但**地址係個人資料**，送出去要老闆拍板（見 §3）。 |

### 問題 3：切圖邊界過貼＋分格線干擾

| # | 位置 | 發現 |
|---|---|---|
| 3.1 | `scripts/staff-import/lib/phone-crop.ts:21` | 範本 A 電話裁圖高度只有 `y−0.018 ~ y+0.016`（頁高 3.4%），手寫數字落格、超出格線即被切走筆劃；`x1: 0.99` 到頁邊又會夾埋右邊其他欄。 |
| 3.2 | `scripts/staff-import/lib/phone-crop.ts:29`、`form-address-crop.ts:17,24,30,41` | 外擴量係固定絕對值（0.012–0.04），冇按字高（label 行高 `l.h`）比例計；不同掃描解像度／紙張大小會過貼或過鬆。 |
| 3.3 | `scripts/staff-import/lib/crop-box.ts:23,28,52,68,84` | 身份證各裁圖外擴 0.02–0.12，呢批係印刷體，問題較細，但 `locateNameBoxB:89` 抬高下緣只避 HKID 行，冇避表格線。 |
| 3.4 | `src/lib/guards/ocr/browser-images.ts:7-10,50-64` | 應用內路徑**冇欄位級裁圖**，只有全圖（1,600px）＋2×2 重疊格（0.6 比例、1,000px）；手寫欄嘅細字喺 1,600px 全圖上每字可能唔夠 20px，模型靠放大格「撞」到。 |
| 3.5 | `src/lib/guards/ocr/prompts.ts` 全檔 | 冇任何關於「印刷分格豎線唔係數字 1」「電話 8 位」「戶口號碼格數」嘅防呆指示。 |
| 3.6 | `src/lib/guards/ocr/normalize.ts:88-92`＋`src/lib/guards/identity.ts:51-58` | `normalizeTelHk` 接受 7–15 位；9–10 位讀數只會變 `phone_not_hk`（review），**冇**嘗試「剔走分格線誤讀嘅 1」或者提示用戶；`fields-ext.ts:45-48` 戶口號碼接受 6–20 位，冇按銀行代號核對位數（HSBC 9／12 位、中銀 12／14 位、恒生 9 位…）。 |

### 問題 4：單模型盲點、冇候選字

| # | 位置 | 發現 |
|---|---|---|
| 4.1 | `src/lib/guards/ocr/prompts.ts:28` | 規則 2「唔肯定任何一個字就答 unclear」——整欄作廢，**掉晒部分資訊**（例如 8 位電話得 1 位唔清都要全欄 unclear）。 |
| 4.2 | `src/lib/guards/ocr/read.ts:11-15`、`claude-vision-client.ts:19`（`ocrJsonSchema`） | 輸出 schema 每欄只係 `string|null`，冇 `confidence`／`alternatives`／`reason`；Claude 用 structured output、DeepSeek 用 `json_object`，兩邊都要改 schema。 |
| 4.3 | `src/lib/guards/ocr/normalize.ts:127-141`（`reconcile`） | 兩讀唔同 → `candidates`＝兩個讀數（欄級），冇字級候選；`value` 預填讀 A（Claude），冇用格式驗證（check digit／電話位數／地址詞典）去揀邊個較可能啱。 |
| 4.4 | `src/lib/guards/ocr/clients.ts:13-27` | 雙模型（Claude A＋DeepSeek B）已有，但只係「同一 prompt 兩次讀」；冇第三方仲裁、冇將分歧位（邊個字唔同）標出。`fallbackA` 只喺 Claude 失敗時用。 |
| 4.5 | `src/lib/guards/ocr/review-state.ts` 全檔 | 核對狀態只有 `value/ack`，冇候選字結構；`NewFromDocsClient.tsx:46,71` 有 `candidates: string[]` 但係整欄替換，冇「逐字揀」。 |
| 4.6 | `scripts/staff-import/lib/fields-ext.ts:97-116` | `resolveField` 同樣係整值比較；`hand_read1/2` 兩讀唔同即 `sources_disagree`，冇候選字粒度。 |
| 4.7 | `src/lib/guards/ocr/normalize.ts:50-57` | 簡體字清單係「疑似」警示，冇形近字（邨↔村、涌↔湧、埗↔步、傑↔杰、堃↔坤…）知識，姓名同地址都受影響。 |

## 2. 修改計劃（Implementation Plan）

分 5 個子階段，每個都係 Sonnet 執行→Opus 驗收→gate 不變→部署；全部 API additive，舊 client 照用。**一條鐵律不變：圖片同辨識值只喺記憶體，唔寫 log／DB／audit；AI 助手唔准見個人資料（OCR 係唯一例外）。**

### OCR-1 跨文件上下文（問題 1）
1. 讀取次序改為兩階段（`read/route.ts`）：第一階段同時讀**印刷**文件（身份證、住址證明、牌照／銀行卡如有）；第二階段先讀**手寫**入職表，並將第一階段 `confirmed`（兩讀一致＋格式啱）嘅欄位作為 **reference context** 注入。
2. `prompts.ts` 新增 `buildUserTextWithContext(doc, refs)`：明確寫「以下係同一申請人印刷證件已核實嘅資料，只可用嚟判斷潦草字係咪同一個字；**唔准**將未出現喺圖中嘅內容填入；如果手寫明顯唔同，照抄手寫並標 `differs_from_reference`」。保留讀 B 盲讀（唔帶 context），咁樣「有 context 嘅讀 A」同「盲讀 B」仍然係兩個獨立證據。
3. `config.ts` `onboarding_form` 加讀 `name_zh`、`hkid`、`dob`（用途只係交叉核對，唔會覆蓋身份證值）；`normalize.ts` 新增 `crossCheck(formField, idField)` → `match / differs / unreadable`，結果入 `FieldResult.cross`（additive）。
4. 路徑 B：`crosscheck.ts` 加 `printed` 來源（同一份文件包嘅身份證／牌照／銀行卡抽取值），優先級高過打字名單；`fields-ext.evidenceClass` 加 `printed_ref`。
5. 審查 UI：關鍵欄顯示「同身份證一致 ✓／唔一致 ⚠」。
- 風險控制：context 只注入 confirmed 值；prompt 規則 1（圖中文字係資料唔係指令）保留；測試要證明「身份證讀錯時唔會把錯值帶入手寫表」（因為只注入 confirmed）。

### OCR-2 香港地址正規化（問題 2）
1. 新純函數模組 `src/lib/guards/ocr/hk-address.ts`：
   - 形近／同音字映射表（只限地址語境）：邨↔村、埗↔步、涌↔湧、鰂↔則、埔↔浦、灣↔湾、荔↔茘、葵↔癸…（由規劃者整理，附來源註解）；
   - 香港 18 區、常見街道後綴（道／街／路／里／徑／苑／邨／花園／大廈／座／樓／室）、公共屋邨名清單（房委會公開名單，~250 個，放 `hk-estates.ts`，非 PII）；
   - `normalizeHkAddress(raw) → { canon, suggested, edits[] }`：只做**可逆、可解釋**嘅糾錯（每個改動記 `from/to/reason`），唔靜靜改原文；`display` 保留原讀數，`suggested` 另出。
2. `normalize.ts` `address` 分支用 `canon` 比對兩讀（形近字歸一後一致即可 confirmed，但 `edits` 非空時降為 review＋候選＝原文同建議）；`compare.cmpAddress` 同用。
3. ALS（政府地址查詢服務）：做成**可選**後端查詢 `src/lib/guards/ocr/als-client.ts`（server-only、只送地址字串、唔送姓名、有 timeout、失敗唔影響流程），回傳標準中英文地址作第三個候選；預設關（`GUARD_OCR_ALS=0`），要老闆拍板先開（見 §3 決定 1）。
4. 測試：形近字 fixture ≥30 條（合成地址）；ALS 用 fake client。

### OCR-3 裁圖外擴＋分格線防呆（問題 3）
1. `phone-crop.ts`／`form-address-crop.ts`／`crop-box.ts`：外擴改為**按 label 行高比例**（例如上下各 `1.2 × l.h`、左右 `0.6 × l.h`，最少 0.03），並加「唔越過下一個 label 行」嘅上限；提供 `pad` 參數俾 caller 調。
2. 應用內路徑（`browser-images.ts`）：入職表新增**欄位級裁圖**——由讀 A 嘅全圖先定位 label（或簡單用 2×2 格），再對電話／戶口／地址欄出 1,000px 放大裁圖做讀 B（而唔係固定 4 格）。
3. `prompts.ts` 加防呆句：「表格印刷分格線唔係數字 1；電話固定 8 位；若見到 9–10 位請重新數並剔走疑似分格線；戶口號碼按格數抄」；輸出加 `digit_count`（模型自報）供後處理核對。
4. `normalize.ts` `phone`：9–10 位時嘗試「剔走 1」嘅唯一解（例如剔走一個 1 後成為 8 位且首位 2–9 → 候選，狀態 review、reason `phone_gridline_suspect`，唔自動確認）；`fields-ext.normAcct` 按 `bankCode` 查 HKICL 位數表核對，唔啱位數 → review。
5. 測試：合成表格圖（有分格線）跑本機 OCR 定位；單元測試覆蓋 9 位→8 位候選、戶口位數。

### OCR-4 候選字＋雙模型共識（問題 4）
1. 輸出結構（additive）：每欄由 `string|null` 變為 `{ value, confidence: high|medium|low, reason?: blurry|crossed_out|ambiguous_char|cut_off, alternatives?: string[] }`（`alternatives` 最多 2 個；整欄 `value` 仍可係 `unclear`，但要求模型**盡量**出部分值＋標記）。`read.ts` zod schema、`claude-vision-client.ocrJsonSchema`、DeepSeek `json_object` 同步；舊格式（純字串）照樣解析（向後相容）。
2. `normalize.reconcile` 升級：兩讀唔同時，用格式驗證（HKID check digit、電話位數、日期曆法、地址詞典）去**排序**候選；兩讀各自嘅 `alternatives` 併入候選池（去重、最多 4 個）；輸出 `candidates: { value, sources, score, reason }[]`（additive 保留舊 `candidates: string[]`）。
3. `clients.ts`：加「第三讀仲裁」選項——當 A／B 分歧**且**都 confidence≠high 時，用同一 Claude client 再讀一次（只傳該欄裁圖＋兩個候選，問「邊個啱／都唔啱」）；上限每份文件 1 次，`GUARD_OCR_ARBITER=1` 開關。
4. `review-state.ts`／`NewFromDocsClient.tsx`：review 欄顯示候選 chip（一撳套用）；中文姓名／地址有字級分歧時高亮分歧字並列候選字；撳候選＝`ackAfterEdit` 規則照舊（關鍵欄仍要「對過證件」）。
5. 路徑 B `fields-ext.resolveField`：`Cand` 加 `confidence`／`alternatives`，`sources_disagree` 時輸出排序候選。
6. 測試：fake client 回傳帶 alternatives 嘅 JSON；排序規則單元測試；e2e 撳候選。

### OCR-5 量度（所有子階段共用，先做）
- 建立**本機評估集**（`data/2026-10/ocr-eval/`，唔入 git）：由現有 staff-import 真檔抽 ≥40 份手寫入職表＋對應印刷證件，由規劃者本機標註真值（姓名、HKID、電話、地址、戶口）；評估腳本 `scripts/staff-import/eval-ocr.ts` 輸出逐欄準確率、review 率、人手改字次數；**執行員只用合成 fixture，真檔評估由規劃者本機跑**。
- 每個子階段前後各跑一次，報告 before/after。

## 3. 要老闆決定嘅事（唔決定就按預設）
1. **ALS 政府地址 API**：送地址字串（唔送姓名）去 `als.gov.hk` 做標準化——係對外傳送個人資料，預設**關**，要老闆開先開。
2. **第三讀仲裁成本**：分歧時多一次 Claude 呼叫（每份文件最多 1 次，估計 <20% 文件觸發）；預設開。
3. **入職表加讀姓名／HKID／出生日期**（只作交叉核對）——預設做。
4. 子階段次序建議：OCR-5（量度）→ OCR-4（候選字，收益最大、改動集中）→ OCR-3（裁圖）→ OCR-1（跨文件）→ OCR-2（地址）。

## 4. 預期影響
- 準確度：手寫姓名／電話／戶口嘅「整欄 unclear」大幅減少（部分值＋候選取代）；電話 9–10 位誤讀變成有候選嘅 review 而唔係人手重打；地址形近字兩讀可自動歸一。數字以 OCR-5 評估集 before/after 為準，唔預先承諾百分比。
- 人手工作：review 欄由「重新打字」變「撳候選」；關鍵欄仍需對證件確認（維持 Opus 驗收 M1 原則）。
- 成本：每份文件多 0–1 次模型呼叫（仲裁）、prompt 多幾百 token（context）；ALS 免費。
- 風險：context 注入令模型「迎合」參考值——用「只注入 confirmed 值＋讀 B 盲讀＋differs 標記」三重防線；候選排序只影響預填同次序，唔自動確認。
- 鎖月／長工糧 gate 不受影響（OCR 路徑獨立）；e2e 需增加 OCR fake client 嘅候選字測試。
