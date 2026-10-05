# WP-STAFF-FIELDS 第一階段（本機抽取，無任何個人資料入 git）

輸出全部喺 `data/2026-10/staff-fields/`（gitignored）。命令（冇加 npm script，因 package.json 唔喺本包範圍）：

1. `tools/importer/venv/bin/python scripts/staff-import/py/typed-sources.py` → `typed-sources.json`（Maxwell 前線名單兩個分頁、U Team 名單、BOCHK Payroll Editor 7／8 月；Payroll Editor 用 Excel 預設唯讀密碼解密，同 `tools/importer` 做法）。
2. `npx tsx scripts/staff-import/13-fields-crops.ts [--offset K --limit N --manifest NAME]` → `crops/`、`crops-manifest*.json`（可斷點續跑，可分段並行；頁面 300dpi 快取喺 `pages/`，完成後可刪）。
3. `npx tsx scripts/staff-import/14-fields-queue.ts` → `read-tasks.json`（每個裁圖要讀乜欄，詞彙見 `lib/fields-spec.ts`）、`second-read-queue.json`（盲讀包：id／裁圖路徑／欄名，唔含任何讀數）。
4. `python3 scripts/staff-import/py/fields-sheets.py --idx 0,1,..` → `sheets/`（每人裁圖疊成聯絡表，標籤只係內部 id，方便視覺讀）。
5. 視覺讀數：第一讀數寫入 `first-read.json` 或分批 `first-read-bNN.json`，格式 `{ "<裁圖id>": { "legible": "clear|unsure|illegible", "fields": {欄名: 原文或 null}, "unsure": [睇唔清嘅欄] } }`；睇唔清嘅欄唔入候選（唔估）。第二次盲讀（驗收階段）寫 `second-read.json`／`second-read-bNN.json`，格式相同；未有就當未做。
6. `npx tsx scripts/staff-import/15-fields-merge.ts` → `person-fields-ext.json`、`summary.json`（只有計數）。

## 每欄輸出
`{ value, status: confirmed|review|missing, candidates:[{value,sources}], sources[], reasons[] }`。

## 確認規則（`lib/fields-ext.ts resolveField`）
- 候選正規化後逐字相同；多個唔同值 → `review`（`sources_disagree`，候選全留）。
- 獨立證據類別（打字名單算一個、本機 OCR、視覺第一讀、第二盲讀）≥2 → `confirmed`。
- 淨係打字名單 → `confirmed` + `typed_list_only`（等驗收抽查）。
- 淨係手寫第一讀 → `review` + `handwritten_form_only` + `second_read_pending`；第二盲讀一致先升 `confirmed`（reason 仍留 `handwritten_form_only`）。
- 印刷單一讀 → `review` + `single_read`。
- 驗證：屆滿日 2015–2040、簽發日 2000–今日（2026-10-05）、入職日 1990–今日；電話香港 8 位（首位 2–9，語意同 `normalizeTelHk`）；許可證號碼前段須等於身份證號（否則 `permit_no_not_matching_hkid`）。
- 許可證號碼格式（由牌照卡實物歸納）：`<字母 1–2>-<6 位數字>-<檢查碼 0–9 或 A>[-<3 位序號>]`；卡面有 4 段（含序號）同 3 段（無序號）兩種；打字名單通常欠序號，前 3 段相同嘅讀數會補上序號（flag `typed_permit_no_serial_filled`）。
- 許可證 A／B／C／D 到期日各自一欄，`siaPermitTypes` 由有到期日嘅類別衍生；DB 對應 `siaPermitNo`／`siaPermitAExpiry`／`siaPermitBExpiry`（C／D 暫無欄，保留喺輸出）。
- Maxwell 名單 QAS 日期：過去＝簽發（`qasIssueDate`）、未來＝到期（`qasExpiryDate`）；平安咭欄當到期日（`safetyCardExpiry`）。

## 銀行（老闆 2026-10-05：唔再用手寫申請表）
- 主來源＝Payroll Editor 戶口；身份靠硬鍵（Maxwell／U Team 行戶口號碼＝Payroll Editor 戶口 且姓名 token 相同）→ `confirmed`；只靠英文姓名對到 → `review`（`bank_identity_name_only`）；對唔到 → 獨立一行（key `pe:<銀行編號>:<尾 4 位>`）`review`（`bank_identity_unknown`）。
- 銀行卡／存摺副本（印刷）讀數：一致加 `bank_copy_agrees`，唔一致 `review`（`bank_copy_disagrees`）；冇 Payroll Editor 只有副本 → `review`（`bank_copy_only`）。銀行名稱由銀行編號對 HKICL 表（對唔到 → `bank_code_not_in_hkicl_table`，review）。

## 申請表版式
`lib/fields-locate.ts detectTemplate`：威信（wilson；第 1 頁個人資料，第 2 頁續頁含其他牌照＋兩位緊急聯絡人，部分版式第 1 頁有銀行欄）、在勤（maxwell；單頁，只有 1 個緊急聯絡人格）、other。威信第一款版式冇緊急聯絡人格（`template_without_emergency_section`）。「可到職日期」係可上班日，唔當入職日期。

## 補充（全量視覺讀數後）
- `py/fields-batch-sheets.py [--only ids.json --prefix r1-]`：按 spec 分組疊成批次聯絡表（`bsheets/`，標籤＝裁圖 id）供視覺讀（可分批交 sub-agent，每批寫 `first-read-bNN-pKK.json`）。銀行副本只出 OCR 有銀行字眼嘅頁。
- `13-fields-crops.ts --redo-missing --manifest r1`：對 label 定位失敗（OCR 標籤被讀花）嘅申請表，用版式相對位置補裁（`how` 為 `relative_*`／`maxwell_relative_title`）；`14` 會按 key 合併多份 manifest。
- `16-permit-ocr.ts`：牌照卡裁圖放大＋四向重跑本機 Apple Vision → `permit-ocr2.json`（獨立「本機 OCR」讀數；與整頁 OCR 同屬一個證據類別）。
- 入職日期：逐工號帶自己嘅入職日期（`staffNumbers[].hireDate`，Maxwell／U Team／申請表各自來源）；人層面 `hireDate` 取最早，reason `earliest_of_staff_numbers`；同一工號內來源自相矛盾先 `review`。
- 牌照號碼：候選前段須等於身份證號（有對得上先剔走其餘，flag `permit_no_candidates_discarded_not_matching_hkid`）；其一欠序號時補成較長嗰個（flag `permit_no_serial_filled`）。
- 「在勤兼職資料.xlsx 的副本」其實係普通 xlsx（與 `在勤兼職資料-copy.xlsx` md5 相同），只係 openpyxl 拒讀副檔名「的副本」；已改讀 `-copy.xlsx`，取 MP 工號（補 `extraStaffNosFromParttimeList`）。表內「頭印日期／尾印日期」唔係入職日期，只存喺 typed-sources.json，唔當入職來源。
- 盲讀包 `second-read-queue.json` 只含手寫裁圖；印刷頁（牌照卡、銀行副本）以 本機OCR＝視覺讀數 確認。
