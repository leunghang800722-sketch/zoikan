# WP1 importer — 更表 extractor + 內部對數

執行單位（WP1）：extract（①）+ validate（④），對應 `P0-執行計劃.md` §6 pipeline
設計同 §7 WP1 驗收準則。輸入係 `data/2026-07/*.xlsx`（20 個 7 月更表，PDPO 資料，
唔入 git）；輸出全部喺 `out/wp1/`（一樣唔入 git，因為源頭有個人資料）。

> 呢份 README 已經反映 Opus 5 驗收「有條件通過」之後嘅 6 項修正（見文末
> 「驗收修正記錄」）。

## 裝機

```bash
cd tools/importer
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

**WP3 額外要裝 `pdftotext`（poppler-utils）**：`wp3_io.py` runtime 呼叫
命令行 `pdftotext -layout` 解析發票／月結 PDF（唔係 pip 套件，`pip install`
唔會幫你裝），冇裝會令 `run-wp3`／`test_wp3.py` 嘅 PDF 相關步驟直接失敗
（`FileNotFoundError`／`subprocess` 報錯搵唔到命令）。

```bash
# macOS
brew install poppler

# Debian/Ubuntu
sudo apt-get install poppler-utils
```

裝完之後 `which pdftotext` 應該有輸出先算成功。冇 `data/reference-global/
Invoice-Record-*.pdf`／`data/2026-07/reference/2026-07-月結總表-FinalR2.pdf`
呢啲本機專用資料嘅環境，相關 pytest 會自動 skip（見下面「行」段），
但如果你有齊資料想跑 `run-wp3`，`pdftotext` 就一定要裝。

## 行

```bash
source venv/bin/activate   # 每個新 shell 都要 source 一次

python -m importer extract      # 只做 ①，出 records/rows/hidden-sheets/unparsed/review/summary
python -m importer validate     # 只做 ④，讀返 out/wp1/* 做內部對數（唔重開 xlsx）
python -m importer run-wp1      # 兩個一齊行（一句重跑成套）
```

行 `pytest`（表頭定位、統計行識別、分類、(time_slot,code) 逐日對數、
rank_billing、end-to-end 對目標數字）：

```bash
source venv/bin/activate
pytest -q
```

`tests/test_end_to_end.py` 要讀真實 `data/2026-07/*.xlsx`，喺冇呢個目錄嘅環境（例如
CI）會自動 skip，唔會令成個 test suite fail。

**輸出穩定性**：連續行幾次 `run-wp1`，13 個輸出檔（`records.jsonl` 除外用
JSONL 逐行比較都一樣）全部應該 byte-identical（md5 一樣）。所有 `json.dumps`
呼叫都帶 `sort_keys=True`，衝突清單嘅 evidence 都用 `sorted()` 過先砌 dict，
唔靠 Python `set` 嘅（受 hash randomisation 影響嘅）迭代次序。

## 輸出檔案（`out/wp1/`）

| 檔案 | 內容 |
|---|---|
| `records.jsonl` | 一格一行。每個非空日期格一條記錄，帶埋出處（file/sheet/row/col/cell_ref）同分類（kind）。`work_date` 用格仔自己嗰個真日期（`date.isoformat()`），唔係寫死 `2026-07-DD`。 |
| `rows.csv` | 一個安員行一行，帶埋逐行重算嘅 work/ot/leave/pointer/unknown 數，同 sheet 自己嗰欄「月總更數」（`sheet_row_total`）、其他 trailing 統計欄（`sheet_row_extra_json`，例如 RD/SH/AL/SL/NPL 逐行統計）。 |
| `hidden-sheets.csv` | 5 個檔有隱藏「工作表1」，呢度記低（唔讀入 records）：檔名、sheet 名、狀態、max_row/col、A2/B2 內容做證據。 |
| `sheet-stats.csv` | 逐個統計行（Total／所需人手／尚欠／早加夜／other）逐日／逐 trailing 欄嘅原始值同轉換後數值，加埋 `time_slot`／`code`／`sub_site`（見「統計行自己嘅時段/代號」）。 |
| `unparsed.csv` | 解讀唔到嘅格仔／可疑行，**包括日期唔喺 2026-07 嘅格仔**（見下）。呢次跑出嚟係 **0 條**。 |
| `review-rows.csv` | 「成行冇 broker/time/rank/staff_no/tel/name_en/sub_site」而被當統計行（role=other）處理嘅行，逐條留底俾人手覆核，唔係靜靜歸類完就算。呢次跑出嚟 **2 條**（數碼港 CP1-4 r45、CP5 r33，兩個檔「早加夜」合計行之後嗰行冇文字標籤）。 |
| `summary.csv` | 逐檔一行：work 更數（唔計 external/pointer）、external、pointer、ot、leave、unknown，加 `work_per_shift`／`work_monthly_ic`（見「rank_billing」）同按 broker_code／code／rank／(城巴)sub_site／billing_group 分佈。 |
| `validate-report.md` | 人手睇嘅五類內部對數摘要——**逐條列明**，每條帶 `explanation`，唔淨係計數。 |
| `validate-row-total-mismatch.csv` | 檢查①：逐安員行 work 更數 vs sheet 自己嘅月總更數欄。 |
| `validate-day-total-mismatch.csv` | 檢查②：逐 `(time_slot, code[, sub_site])` 逐日 work 數 vs sheet Total 行（唔再靠 block_id，見下）。 |
| `validate-same-day-multi-shift.csv` | 檢查③：同一人（staff_no，冇就 name+tel）同一日出現喺多過一條記錄，跨檔都查，每條有 `explanation`（合法已知例子 / 撞號 false positive）。 |
| `validate-missing-staff-no.csv` | 檢查④a：缺 staff_no 嘅安員行（**已濾走 external**——Wilson Guard/Supervisor 本來就冇在勤工號），每條有 `explanation`（Event Guard 臨時工 vs 真缺）。 |
| `validate-identity-conflicts.csv` | 檢查④b：同一 staff_no 對應唔同名 / 同一名對應唔同 staff_no / **同一電話對應唔同 staff_no**，每條有 `explanation`（用電話同工號嘅相似度自動分類「一號兩人」定「一人兩號」）。 |
| `validate-duplicate-rows-in-file.csv` | 檢查⑤：同一檔內同一 staff_no 開多過一行，每條有 `explanation`（正常拆行 vs 工號可能撞用）。 |

## 三種欄位排法點樣分辨（唔靠寫死欄號）

全部靠表頭定位（見 `importer/layout.py`）：

1. 搵成張 sheet 入面邊行有個格仔 == `"Date"`，而且下一格係真日期 —— 呢個 col 就係
   **label_col**，同下一行 `Name` 表頭嘅 col 一定一樣（三種排法都係）。
2. 睇 `Name` 嗰行（label_col 嗰行下一行）點樣排：
   - 有 `"Property Name"` 字眼 → **citybus**（城巴車廠，D 欄=邊個車廠，記做
     `sub_site`）。
   - `Name` 前一格空白、再前一格係 `"Tel"` → **digital_port**（數碼港三檔，F=
     英文名/公司名 `name_en`，G=中文名）。
   - 其他 → **standard**（其餘 17 檔）。
3. 每種排法嘅 broker/time/rank/staff_no/tel/(name_en|sub_site) 全部係相對
   label_col 嘅固定 offset（見 `layout.LAYOUT_OFFSETS`），唔係固定英文字母欄號。

## 統計行識別

- Label 欄（同 Name 同一 column）嘅值喺 `mappings/stat_row_labels.csv`
  出現（`Total`／`所需人手`／`尚欠`／`早加夜`）→ 當統計行，唔當安員。
- 數碼港啲 sheet 喺「早加夜」合計行之後仲有一行冇文字標籤、但成行 broker/
  time/rank/staff_no/tel/(name_en|sub_site) 全部空白、只有 label 欄一個數字
  同逐日數字 —— 呢行都當「統計行」（`role=other`），唔當佢係個叫「19」嘅安員，
  **同時寫一條入 `review-rows.csv`** 俾人手覆核（唔靜靜歸類完就算）。

### 統計行自己嘅時段/代號（`_stat_row_context`，修正②嘅核心）

以前逐日對數用 `block_id`（「由上一個 Total/所需人手/尚欠 三行組收尾，到下
一個三行組收尾」之間嘅安員行）做單位，但啟航1331 有啲位（例如 2230-0730 嗰
組，SIC/IC/N 三種代號嘅安員行連續排埋一齊，中間冇分隔統計行，跟住先出三組
獨立嘅 Total/所需人手/尚欠）令呢個 block 定義同 sheet 自己嘅「一個 Total 得
返一個代號」唔一致，逐日對數出現 155 條差異。

依家 `_emit_stat_row` 改為喺 Total/所需人手/尚欠 行自己度直接讀返 **時段**同
**代號**，唔靠 block 位置：

- **"aligned" 排版**（17/20 檔，包括全部 standard/digital_port/citybus 檔）：
  Total 行同自己嘅安員行用同一套欄位對齊——時段喺 `field_col('time_slot')`，
  代號喺 `field_col('staff_no')`（借用嗰個位，因為統計行冇真係 staff no；例
  如 皓日 Total 行：D 欄='D'）。
- **"shifted" 排版**（淨係啟航1331）：Total 行嘅文字向右移咗兩欄——
  `field_col('time_slot')` 反而係空白，時段變咗喺 `field_col('staff_no')`
  （例如 `'0700-1500'`）；乾淨代號要等落一行「所需人手」嘅
  `field_col('tel')` 先讀到（例如 `'IC'`），然後 patch 返上 Total 行嘅
  sheet_stats 記錄。
- 邊個排版由**文字本身嘅形狀**判斷（`\d{3,4}-\d{3,4}` 係時段、`N Hours` 係
  時數、其他先當代號），唔靠檔名——第 21 個更表就算用第三種排法都應該啱。

`validate.check_day_total_mismatch` 改用 `(file, sheet, time_slot, code,
sub_site)` 做 key。但同一個 key 可以喺一個 sheet 出現兩次以上、屬於兩組完全
唔同嘅人（HKU座頭有兩個獨立嘅「2300-0715／C」block，Total 分別係 31 同
76，中間隔住一個 C1 block）——純粹 sum 埋一齊會錯。所以每個 key 嘅每次
Total 行出現都有自己嘅 row 位置，逐條 work record 用 `bisect` 揀「呢一行之
後最近嘅一次 Total 行」嚟歸屬（安員行實務上一定喺總結佢哋嗰個 Total 行之
前），完全唔使 block_id 都做得到，兼且唔會將唔相關嘅兩組人加埋。

**改完之後**：19/20 檔 0 差異；淨低 **1 條**（啟航1331，`time_slot=0730-1930,
code=D, day=3, recomputed=7, sheet_total=11, diff=-4`）——4 個 Event Guard
（自己時段係 1000-1900）7月3日嘅 D 更，sheet 自己嘅「0730-1930 早更 D」
Total 行連佢哋埋一齊計（11 = 7 個正更 D + 4 個 Event Guard D），但佢哋嘅
`time_slot` 記錄同正更 D 唔同，所以拆返出嚟就見到差 4。呢個唔係 code bug，
係源頭表格自己將兩個時段嘅人合埋一條數，已經喺 `validate-report.md` 第 2
節同 pytest（`test_event_guard_merged_into_different_time_slot_total_shows_up`）
入面解釋。

### Total 行自己都讀唔到 context 嗰陣，點算（第二輪複驗修正）

有啲 Total 行連 `_stat_row_context` 都攞唔到嘢——城巴車廠「柴灣城巴車廠
0700-1900 日更」嗰個 Total 行（row 44）自己前 6 欄全部空白，連 `time_slot`
都冇。以前呢種行會直接俾 `check_day_total_mismatch` 跳過（`if not ts:
continue`），連累佢對應嘅 100 條安員記錄同 31 個日格完全冇被攞去比對過
（唔係比對到但啱數，係**根本冇比對**）。

依家 `_extract_visible_sheet` 追蹤緊「呢個 block 上一個成功讀到嘅安員行」嘅
`(time_slot, rank, sub_site)`（`last_guard_context`，每個 block 收尾就reset，
唔會漏咗去第二個唔相關嘅組），Total 行自己讀唔到 `time_slot`/`sub_site` 嗰
陣就 fallback 用返呢個——**純粹靠位置繼承，唔靠檔名判斷**，第 21 個檔案有
同類情況都會自動修到。城巴柴灣個案修完之後，31 個原本讀唔到 time_slot 嘅
Total 日格全部變 0。

**覆蓋率**（`compute_day_total_coverage`，寫喺 `validate-report.md` §2）：
3,288 條 work 記錄，**已比對 3,284 條、未能比對 4 條**（全部係啟航1331
Event Guard——佢哋自己時段 1000-1900 從來冇對應嘅 Total 行，數會喺
`0730-1930/D` 嗰條差異度解釋咗，見上面）；1,488 個 Total 日格，**未能比對
0 個**（改之前係 31 個）。未能比對嘅記錄／日格會喺 report 逐條列原因，唔淨
係計數。

## rank_billing（修正⑤：CP5 180 拆 25，唔靠寫死 CP5）

`mappings/rank_billing.csv` 淨係列**例外**（`早更IC` → `monthly_ic`），其他
rank 一律用 `DEFAULT_BILLING_GROUP`（`per_shift`），改個 CSV 就可以加多啲例
外，唔使喺 code 度認邊個檔案。`summary.csv` 加咗 `work_per_shift`（總數扣走
月費制嘅） 同 `work_monthly_ic` 兩欄，仲有 `billing_breakdown`（完整 JSON，
以防第日出多過兩種 billing_group）。數碼港 CP5：`work_internal=205`
= `work_per_shift=180` + `work_monthly_ic=25`。

## Excel 日期污染（啟航1331）

啟航1331 部分 Total／尚欠格被 Excel 存做日期／時間格式（例如 `1900-01-01`
其實係 `1`，`1900-01-04` 係 `4`，`00:00:00` 係 `0`）。`importer/excel_dates.py`
嘅 `to_number()` 負責解碼：Excel serial = 格仔日期 − 1899-12-31 嘅日數
（+ 時間部分嘅分數）。

## 日期覆核（修正⑥）

`work_date` 唔再係寫死嘅 `f"2026-07-{day:02d}"`，改用
`mapping.date_values[col]`（表頭 Date 行自己讀出嚟嘅真 `date` 物件）
`.isoformat()`。如果格仔日期嘅年/月唔係 2026-07（`EXPECTED_YEAR_MONTH`），
會寫一條入 `unparsed.csv` 提人手覆核，但記錄本身仍然照抽（唔靜靜跳過）。
呢次 20 個檔全部日期都喺 2026-07 之內，冇觸發過呢個警示。

## 已知假設 / 邊界情況（跟 P0-執行計劃.md §3 對齊）

- 只讀可見 sheet `2026`；5 個隱藏「工作表1」（HKU Y更、HKU座頭、數碼港、
  啟航1331、城巴車廠）全部排除，內容記入 `hidden-sheets.csv` 留底。
- `數據中心` 格仔 kind=`pointer`，唔當更次；真正嗰更喺「數碼港 CP5 數據中心」
  檔自己嘅 `D` 格計一次。
- `name_en` 含 `Wilson Guard` 或 `Wilson Supervisor` → `external=True`，
  照抽但唔計入 `work_internal`，亦唔算「缺 staff_no」（本來就冇工號）。
- HKU Y更 姓名後綴 `(上)`／`(摩)`／` (上)`（前面可以有一個空格）拆做
  `name`（去咗後綴）+ `location_tag`（上村／摩星嶺），原文存喺 `name_raw`。
- `OT1`（HKU座頭 0615-0715）kind=`ot`，唔計入 work 更數，但保留記錄。
- `NPL`/`NL`、`OFF`/`RD` 依家分開存代號（`code_raw` 保留原文），但都歸
  `kind=leave`；邊個當邊個嘅決定喺 `mappings/cell_codes.csv` 個 description
  欄，可以按需要改。
- 城巴 `sub_site`（邊個車廠）淨係城巴車廠檔先有值，其他檔一律 `None`。
- 冇 staff_no 嘅安員行（Event Guard 臨時工、部分散工）用 `name+tel` 做身份，
  對數檢查③④⑤都跟呢個規則。
- 金額完全冇涉及；日期用 `date`(ISO 字串)，冇用 float。

## 對照表（`mappings/*.csv`，人手可改）

- `cell_codes.csv`：格仔代號 → kind（work/ot/leave/pointer）+ 中文說明。
- `stat_row_labels.csv`：統計行標籤 → role（total/required/shortfall/
  combined_total）。
- `rank_billing.csv`：rank → billing_group 例外表（淨係列例外，其他 rank
  默認 `per_shift`）。

改呢啲檔之後淨係 rerun `python -m importer run-wp1` 就會反映在全部輸出度，
唔使改 code。

**PDPO 注意（WP2b 用到嘅 `names_en.csv`）**：70 行真實員工中英文姓名對照表
唔放喺 `mappings/`（會入 git），改放 `data/mappings-private/names_en.csv`
（`data/` 全個 gitignore）。`mappings/names_en.example.csv` 用假數據示範
格式；`importer/paths.NAMES_EN_CSV` 已經指去私有路徑，rerun `run-wp2b` 前
確保呢個檔存在。

**PDPO 注意（雞頭真名，`mappings/brokers.csv` vs
`data/mappings-private/brokers.csv`）**：雞頭（結算單位）嘅真名／花名唔
准出現喺會入 git 嘅檔案。`mappings/brokers.csv`（會入 git）只留代號
（K/W/G/D/T/P/Y）同結構欄（`kind`/`settlement_type`）——`canonical_name`／
`aliases` 對住 K/W/G/D/T/P 呢 6 個代號（B01-B05＋B08）刻意留空，真名經
`private_mappings.py` 讀 gitignored 嘅 `data/mappings-private/brokers.csv`；
Y（公司兵）呢類本身就係內部/業務稱呼、唔算個人 PDPO 資料嘅代號，正常
填喺呢個檔。

真名同糧明細頁實際出現嘅別名寫法（例如同一個雞頭喺唔同頁大階/簡稱唔
同）放喺 `data/mappings-private/brokers.csv`（`data/` 全個 gitignore，
本機專用），格式：

```
broker_csv_id,code,canonical_name,aliases,master_roster_aliases
B01,K,<真名>,<真名>-LINK;<真名>-1331,
B02,W,<真名>,<大階變體>,
B03,G,<真名>,<另一種拼法>;<另一種拼法>-LINK,
B04,D,<真名>,<真名>,
B05,T,<真名>,<真名>,<總表用嘅姓氏稱呼>
```

- `code`：對應 `mappings/brokers.csv` 嘅代號。
- `canonical_name`：呢個雞頭嘅真名，`importer/private_mappings.py` 讀出
  嚟補返 `mappings/brokers.csv` 留空嘅 `canonical_name`。
- `aliases`：糧明細頁實際出現嘅寫法（`;` 分隔），同 `mappings/
  brokers.csv` 嘅 `aliases` 一齊餵入 `BrokerIndex` 做比對；`data/
  mappings-private/brokers.csv` 有值先會補呢一層，唔存在就淨係得
  `mappings/brokers.csv` 本身嘅（安全）值。
- `master_roster_aliases`：淨係「在勤總表」用嘅額外稱呼（例如某雞頭喺
  總表用姓氏稱呼，唔係糧明細頁格式），只畀 `master_roster.py` 自己嘅
  對照表用，唔會餵入 `BrokerIndex`（唔影響 `out/wp2b/brokers.csv`
  輸出）。

冇 `data/mappings-private/brokers.csv`（例如新 clone 未攞到 `data/`）：
`importer/private_mappings.py` 全部 function 一律 fallback 用代號本身，
並經 `logging` 出一次 warning（同一代號/原因淨係警告一次），唔會
raise、唔會靜默扮成功；依賴真名先做得到嘅比對／報表（例如糧明細頁
`settlement_unit` 對唔到真實字面值）會相應失效，相關單元測試會自動
`skip`（見 `tests/test_wp4.py`／`tests/test_wp5.py` 嘅
`has_private_brokers()` 判斷）。

## 驗收修正記錄（Opus 5「有條件通過」→ 6 項修正）

1. **輸出穩定性**：`check_identity_conflicts` 改為對住 `sorted()` 過嘅 list
   砌 evidence（唔再直接迭代 `set`），加埋全部 `json.dumps(..., sort_keys=True)`。
   連跑 3 次 md5 一樣（見上面「輸出穩定性」）。
2. **啟航1331 逐日差異 155→1**：見「統計行自己嘅時段/代號」一節。
3. **validate-report.md 逐條列明**：五類檢查全部加 `explanation` 欄，report
   唔再淨係計數/前 30 條，改為全部列晒。
4. **缺 staff_no 濾走 external**：23→12 條（Event Guard 4 + 真缺 8）。
5. **CP5 180/25 拆分**：見「rank_billing」一節。
6. **work_date 用真日期**：見「日期覆核」一節。

另加一個護欄：有姓名但 broker/time/rank/staff_no/tel/name_en/sub_site 全部
空白而被當統計行嘅行，同時寫入 `review-rows.csv`（見上面「統計行識別」）。

### 「已收貨，兩項尾數」（Opus 5 複驗通過後）

1. **PDPO：test fixture 唔用真員工資料** —— `tests/test_layout.py` 原本三個
   layout test 嵌咗真員工嘅 staff_no/電話/姓名（城巴檔一個真實案例）。
   `tools/` 將來會入 git，呢啲屬於員工個人資料，唔應該留喺 code 度。已經
   全部換做假數據（`U99999 / 9999 9999 / 測試員甲｜乙｜丙`），連
   `tests/test_classify.py` 入面用嚟測 HKU Y更 姓名後綴拆分／external
   marker 嘅真名都一併換咗做「測試員甲～戊」/「Sample Guard One/Two」——
   呢啲測試淨係驗證字串處理邏輯，同真人身份完全無關，換咗做假數據唔影響
   測試意義。
2. **validate ② 覆蓋率披露 + Total 行 context 繼承**：見上面「Total 行自己
   都讀唔到 context 嗰陣，點算」一節。修正之後 3,288 條 work 記錄有
   3,284 條比對過（原本淨係 3,184 條，104 條被靜靜跳過），1,488 個 Total
   日格全部攞去比對過（原本 31 個完全冇被攞去比對）。

## WP3（⑤ rates 價目反推 ＋ ⑥ report 三份報表）

執行單位（WP3）：rates（⑤）+ report（⑥），對應 `P0-執行計劃.md` §6 pipeline
同 §7 WP3 驗收準則。輸入係 `out/wp2b/*.csv`（六份規範化 CSV）＋
`data/2026-07/transcribed/*.csv`（WP2a 糧明細）＋
`data/reference-global/Invoice-Record-*.pdf`（發票，`pdftotext -layout`
runtime 解析）＋ `data/2026-07/reference/2026-07-月結總表-FinalR2.pdf`（月結，
只做總數層面跨月證據，唔可以直接當價）。輸出全部喺 `out/wp3/`（唔入 git）。

```bash
source venv/bin/activate
python -m importer run-wp3      # ⑤+⑥ 一齊行
```

### 輸出檔案（`out/wp3/`）

| 檔案 | 內容 |
|---|---|
| `rate_cards.csv` | 一條 rate 一行：`site_id/shift_type_id/broker_id/guard_id`（後兩者可空）做 key，`client_rate/guard_wage/broker_fee/payout_rate` 四個金額欄，`billing_model`（per_shift/monthly_fixed/admin_fee/special），`status`（solved/pending）＋ `evidence`/`note` 逐條可追溯。 |
| `shift_records_priced.csv` | `shift_records.csv` ＋ `client_rate_snapshot/guard_wage_snapshot/broker_fee_snapshot/client_rate_id/payout_rate_id/pricing_note` 六個新欄。**monthly_fixed/admin_fee/special 嘅 billing_model 唔逐更 stamp client_rate_snapshot**（見下面「兩個真實 bug」）——淨係留低 `client_rate_id` 話你知邊條靜態卡，snapshot 刻意留空。 |
| `unpriced.csv` | 完全配唔到價（client_rate 同 guard_wage/broker_fee 都冇）嘅記錄，逐條列原因（`(有pending rate_card未解到)` vs 純粹搵唔到）。 |
| `kai1331-daily-residuals.csv` | 啟航1331 K 段線性解嘅逐日 predicted/actual/residual。 |
| `invoice-lines.csv` / `billing-unit-solve.csv` | 發票逐行解析結果、逐開票單位嘅解值同 pending 原因。 |
| `rates-report.md` | 人手睇嘅總覽：rate_cards 分佈、收客價逐開票單位表、K-1331 線性解結果、抽樣覆核、unpriced 摘要、三份報表 diff 統計。 |
| `sample-audit.csv` | 隨機 30 條 shift_records_priced ＋ 5 個開票單位嘅抽樣覆核結果。 |
| `reports/roster/*.xlsx` | 更表 round-trip：由 `out/wp1/rows.csv`+`records.jsonl`（原始格仔）配合 shift_records 嘅 external 判斷重現，20 個檔一個一個。 |
| `reports/roundtrip-diff.csv` | 更表 round-trip 差異，`category` 欄：`external_row_excluded`（客戶自己嘅人成行剔走）、`identity_merge`/`identity_split`（身份合併決定直接帶出）、`stat_recompute`（Total/尚欠由 `records.jsonl` 逐 sub-group work 格重算再同 `sheet-stats.csv` 原值交叉核對，唔啱嘅入呢類）、`needs_review`（冇解釋嘅先至入呢類）。**目標 `needs_review`=0**：實測全部差異都落咗前三類，`stat_recompute` 淨係剩 1 條（啟航1331，已知 Event Guard 併總嗰1條）。 |
| `reports/payroll/雞頭糧明細-regenerated.xlsx` + `reports/payroll-diff.csv` | 由 `shift_records_priced.csv` 逐結算單位（`settlement_page` 優先，冇就 `settlement_unit`）聚合（**每個sheet加咗Total行**：更數/工資/雞頭費/金額），同 `payroll-rows.csv`（先按 guard+site 合併 1-15/16-31 兩頁）逐行對金額。`category` 欄：`ok`／`shift_count_diff`（連逐頁總更數 vs `payroll-pages.csv` 嘅 `policy_total_shifts` 唔啱嘅 `site_label="__PAGE_TOTAL__"` 條目）／`near_name`（difflib 近似姓名候選，同site優先、跨site/su做fallback）／`mixed_row`／`ot_or_adjustment`（`shift_kind!=normal` 嘅OT/調整/月費/flat_referral 行）／`tool_bug`。**目標 `tool_bug`=0**。 |
| `reports/月結總表-regenerated.xlsx` + `reports/monthly-diff.csv` | 由 `shift_records_priced.csv` 逐盤聚合（用 `base_shifts`/`base_revenue`，唔含 `billing_units.csv` 嘅 extra_shifts，先啱好對得住R2自己拆開印嘅副行如「獨立雞頭費」），同 R2 逐行對（`pdftotext -layout` regex 解析）。`category`／`reason` 欄：`known`（接入 `wp3_rates.KNOWN_SHIFT_COUNT_DIFFS` + P0-執行計劃§3.7「冇逐日來源」清單嘅人手可讀解釋）／`needs_review`（冇已知原因）。 |

### rate 反推邏輯（⑤）

1. **出街價（guard_wage+broker_fee）**：逐行讀 `payroll-rows.csv`（T/D/
   G/公司兵/W，`shift_kind=normal`），**按 guard_id 分組**（唔係按
   數值分組——兩個唔同安員啱啱好同價好常見，如果淨靠數值分組會將佢哋
   撈埋一碌，導致其中一個冇專屬卡嗰個安員，pricing 嗰陣跌落粗嘅
   (site,broker) 層先，錯誤襲用第二個安員嘅價，見下面「兩個真實 bug」）。
   K-LINK/G-LINK/LINK公司兵（LINK C7 細盤）只記證據，唔生成入
   shift_records_priced。
2. **啟航1331（K 段）**：`shift_records.csv`（`settlement_unit=K`,
   `source=roster_code_site_page`）逐日逐更別（7 個 shift_type）數，對住
   `payroll-rows.csv` K-1331 頁 31 個逐日總額用 `numpy.linalg.lstsq`
   最小二乘解。**偵測完全共線嘅欄**（中Zone IC/夜Zone IC/夜Zone SIC 逐日
   人數全月完全相等，數學上冇辦法拆開個別價），merge 做一組；殘差超過
   1000 蚊嘅門檻嘅一律唔當 solved。**目前 7 個更別全部 pending**——唔止
   3 個共線嘅冇獨立解，連本身應該可解嘅 4 個都因為殘差太大（模型擬合唔
   夠好，可能仲有未知結構例如假日加價）而未達 solved 門檶，逐日殘差見
   `kai1331-daily-residuals.csv`。7/31 係已知離群日（總額係其他日子嘅
   約2.4倍，但WP2a已經逐格核對過完全對數，唔係轉錄錯）。
3. **收客價**：發票金額 ÷ `shift_records.csv` 更數（`record_type=shift`,
   `is_external=False`, `out_of_scope=False`），逐開票單位嘗試：(a) 整除；
   (b) 「人數最多嘅更別」vs「其餘全部」兩個價（5蚊網格brute force，
   `known_rates_from_payroll` 篩走冇喺歷史payroll出現過嘅價，避免網格
   巧合）；(c) OT按鐘公式 `count*rate+ot_hours*(rate/8.25)`（HKU C更
   199×700+8h 完全對得上，容許 0.02 蚊四捨五入誤差）；(d) 更數±10搵乾淨
   價（唔代表更數啱，只供 WP4 覆核，例如數碼港 CP1-4 234→230更×930完全
   啱）；全部試完都唔到 → pending，note 逐項記低試過乜。5/6月發票只做
   跨月參考，唔生成 rate_card。

### 兩個真實 bug（開發期間發現並修正，留底俾人參考）

1. **pricing.py 揀 rate_card 嗰陣，guard 專屬卡跌咗去粗層撞用第二個人嘅價**：
   G0039（創富車廠(夜) autopay，T只收30/更介紹費，guard_wage應該係
   空；PDPO：只記guard_id，具體人可查out/wp2b/guards.csv）因為自己張卡冇
   guard_wage，`_pick_card` 舊邏輯見到呢層冇非空值就
   繼續向粗嘅 (site,broker) 層搵，喺嗰層撞到 G0127（現金，680/更）張卡，
   錯誤攞咗680用。修正：一旦喺任何一層搵到 candidate（就算冇非空值、
   就算ambiguous）就即刻停，唔會再向粗層搵。同時 Section A 嘅 group key
   由「(site,broker,wage,fee) 數值」改做「(site,broker,guard_id或姓名)」，
   避免兩個啱啱好同價嘅唔同安員一開始就撈埋一碌。回歸測試見
   `tests/test_wp3.py::test_pricing_does_not_leak_rate_across_guards_with_same_site_broker`。
2. **monthly_fixed/special 嘅 client_rate 逐更 stamp 再加總會乘大好多倍**：
   IFC monthly_fixed=35,000，如果照per_shift咁stamp落佢40條shift_record
   嘅client_rate_snapshot，月結總表逐更加埋會變1,400,000。修正：
   monthly_fixed/admin_fee/special 呢三種 billing_model 唔逐更 stamp
   snapshot，`build_monthly_report` 直接用 rate_cards 嘅靜態值。啟航1331
   Event（special）仲有個衍生bug：張卡冇填 shift_type_id，會經 site-level
   fallback 漏俾成個 S017 普通1331更次（嗰啲更次嘅client_rate本身仲
   pending緊，錯誤襲用咗Event嘅11,700）；修正：Event張卡填返
   shift_type_id=ST0026（Event Guard），淨係嗰4個真Event Guard更次先會
   撈到。回歸測試見
   `tests/test_wp3.py::test_monthly_report_does_not_multiply_monthly_fixed_by_shift_count`。

### WP3c：三份報表版面對齊人手版（2026-09）

- **龍譽（S043）／惠康貨倉（S044）**：P0-執行計劃§2 B4「補單」特殊收入項
  決定落地——`wp3_rates.py` 加 `SPECIAL_INCOME_SITES`，兩個 site 嘅
  rate_cards 由 `billing_model=per_shift, status=pending` 改做
  `billing_model=special, status=solved`（唯一改咗 `wp3_rates.py` 嘅位，
  純粹跟返規劃session裁定，冇動任何價目反推邏輯）。
- **月結總表 `base_shifts`/`base_revenue`**：`build_monthly_report` 加咗
  呢兩個唔含 `billing_units.csv` extra_shifts 嘅純量，同R2逐行diff專用
  （月結對照P&L sheet繼續用含extra嘅`shifts`/`revenue`）——修正咗
  「HKU Y更170真更＋94獨立雞頭費」呢類R2自己拆開印副行嘅site，之前逐
  更加埋咗extra再同R2主行比，屈出一個假264 vs 170嘅diff。
- **月結總表 unpriced_rows 併入更數**：之前月結報表淨係計
  `shift_records_priced.csv`（`priced_rows`），完全冇rate card嘅記錄（例如
  啟航1331大部分更別，P1/P2待老闆答）會被漏晒，令規總更數大幅低估。而家
  `build_monthly_report` 多接一個 `unpriced_rows` 參數，將呢啲「有
  shift_record但rate仲未反推完」嘅記錄計落更數（但唔計revenue，revenue
  本身未知）。
- **roster round-trip 統計行重算**：`build_roster_reports` 新增由
  `records.jsonl` 逐 `(file, block_id, day)` 嘅 `kind=="work"` 格仔數重算
  Total、同 `尚欠=所需人手－Total` 交叉核對 `out/wp1/sheet-stats.csv` 原值
  （`所需人手`本身係policy輸入，唔重算）。**啟航1331例外**：呢個file嘅
  Total行受Excel日期污染，擾亂咗WP1 block切界，令 `records.jsonl` 同
  `sheet-stats.csv` 兩條抽取路徑對同一個physical更別sub-group編咗唔同嘅
  `block_id`（實測B0喺records.jsonl涵蓋咗「早Zone IC」+「早更」兩組人，
  但sheet-stats.csv嘅B0淨係「早Zone IC」嗰組）；淨係呢個file改用
  `(day, time_slot, code)` 做key（仲要將「尚欠」row個唔可靠code欄，用
  同一日同一time_slot嘅「Total」row個code override返），先啱好對得住。
  結果：`needs_review`=0，`stat_recompute` 剩1條（啟航1331，已知Event
  Guard併總）。
- **payroll-diff category taxonomy**：`build_payroll_report` 加咗sheet
  Total行、`payroll-pages.csv` policy_total_shifts逐頁核對、同六類
  category分類（見上面表格）。`near_name` 用 `difflib.get_close_matches`
  （cutoff先0.5同site_id優先搜，搵唔到先擴大去全部site/su），對應
  P0-執行計劃§8 WP2b裁定嘅「近似名（WP2b已知近似名，見
  out/wp2b/name-near-match.csv）入人手確
  認清單，唔自動合併」——呢啲已知pair而家喺payroll-diff會自動配對到
  `near_name`，唔會跌落`tool_bug`。
- **monthly-diff category/reason**：接入 `wp3_rates.KNOWN_SHIFT_COUNT_
  DIFFS`（P0-執行計劃§4已知更表vs R2細差）＋ §3.7「月結有更表冇、冇逐日
  來源」site清單，逐盤自動判 `category=known`／`needs_review`。仲加咗
  `AMBIGUOUS_AGGREGATE_R2_LABELS`（城巴車廠合計行，同數碼港合計行一樣
  skip，因為8個depot個別site已經逐個對過，證實517完全啱，剩返嘅30蚊差
  係§3.8已知嘅西九龍疑似津貼）、`EXTRA_LABEL_TO_SITE`（獨立雞頭費副行，
  已摺埋入S006）、`EVENT_SUBLINE_LABELS`（啟航1331Event副行，帶埋S017
  嘅已知原因，唔屈假match）。

**已知未完成（留俾規劃session決定，唔喺WP3c範圍內做咗）**：`reports/
roster/*.xlsx` 現時每檔一個flatten嘅單sheet（雞頭代號/A欄resolved/時段/
更別/Staff No./電話/姓名/1-31/月總更數/備註），**未完全重現原檔嘅block
結構**（每個更別一個獨立嘅Date行/星期行/Total-所需人手-尚欠三行、三種
排法各自嘅欄序、數碼港「早加夜」合計行）。呢個係P0-執行計劃§3.1嘅完整
要求，但構建一個逐block位置/合併儲存格/三種排法都要視覺級精確重現嘅
xlsx engine係獨立工程量（規劃session之前已經評估過），WP3c呢次淨係做咗
`roundtrip-diff.csv` 嘅內容正確性（逐格code_raw/統計行都有重算核對），
未做視覺版面reproduction。

### xlsx 輸出穩定性嘅已知限制

CSV／MD 全部連跑三次 byte-identical（md5 一樣）。xlsx **內容**（用
`openpyxl.load_workbook` 讀返嚟嘅逐格值）連跑三次都一樣，但 xlsx **檔案
本身嘅 raw bytes** 唔一定一樣——已經將 `docProps/core.xml` 嘅
created/modified 定死做常數（`_save_stable`），但 Python `zipfile`
（openpyxl save 底層用嘅 library）仲會將「而家」時間寫入 ZIP 入面每個
member 自己嘅 timestamp 欄位，呢層冇再深入 monkey-patch。如果將來要做到
連 xlsx raw bytes 都 byte-identical，需要 patch `zipfile.ZipInfo` 嘅
`date_time`。

### 對照表（新增）

- `mappings/invoice_site_aliases.csv`：發票項目文字（例如「HKU C更」
  「Wilson Control」）→ `site_id`，WP3 自己嘅對照表，唔會改
  `mappings/sites.csv`（WP2b 已驗收）。

## WP4 — ⑦ reconcile：三層對數＋差異解釋工作簿

執行單位（WP4）：對應 `P0-執行計劃.md` §1（三層對數定義、收貨標準「零
『未解釋』差異」）、§3.4-3.8、§4、§5、§8。**WP4 唔重推 WP1/WP2b/WP3 嘅
業務邏輯，淨係讀佢哋喺 `out/wp1/`、`out/wp2b/`、`out/wp3/` 嘅輸出**，喺
呢個之上砌第三層——逐條差異分類、配出處、標老闆問題編號。

```bash
source venv/bin/activate
python -m importer run-wp4     # ⑦ reconcile -> out/wp4/*
```

### 輸出檔案（`out/wp4/`）

| 檔案 | 內容 |
|---|---|
| `differences.csv` | 核心交付：逐條差異 `diff_id, layer(L1/L2/L3), site_or_unit, ours, theirs, diff, unit, provenance, category, explanation, recommended_action, status(explained/awaiting_boss), boss_question_ref`。**`status` 唔會出現 `needs_review`**：追唔到根因嘅差異一樣要有分類＋出處，落 `awaiting_boss`，`boss_question_ref` 一定係 P1-P6/D3/N3/N5/N6/N7/Q2/Q3/Q4/Q5/Q6 呢個固定集合入面嘅值（**「新」呢個未分流佔位符第二版之後唔准再出現**——WP4第二版逐條追到出處先分流，追極都追唔到嘅真新問題直接開新編號，唔留低「新」）。`category` 固定集合 WP4第三版加咗「歸屬衝突」（`broker-conflicts.csv` 嗰5條更表雞頭代號 vs 糧明細對唔上邊個雞頭出糧，屬歸屬問題，唔係「更表漏咗一個更」，唔應該撈埋落更表漏填）。 |
| `P0-對數工作簿-2026-07.xlsx` | 老闆版：`總覽`→`L1 更數`→`L2 成本`→`L3 收入`→`差異清單`→`待老闆決定`→`已裁定口徑` 七個 sheet，全部中文標籤，**唔含 site_id/guard_id/rate_id 呢類內部代碼，亦唔含 `.csv` 檔名／`gate=`／`mixed_site_label`／`monthly_fee_day`／`day-mismatch` 呢類工程術語**（`wp4_workbook._boss_text` 先用一個技術詞→中文轉換表`_TERM_MAP`，先至用 regex 剝走殘留代碼——順序好緊要：好多技術詞組本身係 WP3 產生嘅句子一部分，例如「已摺埋入S006嘅billing_units.csv extra_shifts_from_monthly」，如果淨係剝碼會剩低「已摺埋入嘅billing_units.csv extra_shifts_from_monthly」呢種斷咗頭嘅爛句，一定要先轉詞、後剝碼，句子先讀得通；工號 Uxxxxx 呢種員工本身已經用緊嘅業務代號唔算內部代碼，唔剝）。`差異清單` sheet 同 `待老闆決定` sheet **都唔帶 `diff_id`（D0開頭代碼）**——呢個係內部追蹤代號，唔係老闆睇嘅嘢。`待老闆決定` sheet 第二版改咗做**一行=一條問題**（7欄：問題編號／一句問題／涉及安員或盤／日期／影響更數／影響金額／我哋建議），唔會再出現「1 vs 0 更（有/冇=1/0）」呢類機器句；WP4第三版起呢7欄全部（包括日期／影響更數／影響金額）都經過 `_boss_text` 轉換，避免內部代碼／技術詞漏入呢幾欄。xlsx save 之前用 `_save_stable`（同 `wp3_reports._save_stable` 同一原則）定死 `docProps/core.xml` 嘅created/modified，內容 hash（逐格值）連跑三次一致。 |
| `P0-對數工作簿-2026-07-technical.xlsx` | 同上七個 sheet，但保留 `diff_id`／`site_id` 等內部代碼＋完整 `provenance`，俾要追出處嘅人（開發／Opus 驗收）用。 |
| `wp4-report.md` | 人手睇嘅摘要（逐層/分類統計、待老闆決定清單）。 |

### 三層對數點做

- **L1 更數**：主要重用 `out/wp3/reports/monthly-diff.csv`（R2 vs regen 逐 site 已有嘅 reason），加人手覆核落嘅分類/status（`_L1_SITE_OVERRIDE`／`_L1_PRICE_PENDING`），另外手砌數碼港 CP1-4／CP5 IC、LINK C7、兩個「月結以外」客戶（代號見 client-names.json）呢幾條 `monthly-diff.csv` 冇直接對應行嘅已知項。「更表多填」vs「更表漏填」兩個分類方向要跟數字大細啱（更表數字大過對方＝多填，細過對方＝漏填），唔可以淨係得一個「漏填」桶。單一 guard 嘅 site（例如都會大學學生宿舍）如果 `adjustments.csv` 有一條 OT 調整（`_site_ot_adjustment`，guard_id→guards_by_id→name_zh→adjustments.csv 全部 runtime 配對），R2/發票會將呢條 OT 調整當多 1 個「底更」計落更數，屬口徑差異，自動 `explained`。行政費制 site 如果 `billing-unit-solve.csv` 已經 `solved(admin_fee)`（`_site_admin_fee_solved`），更數差純屬分母計法唔同，都自動 `explained`。R2 月結某啲 row（例如「獨立雞頭費」）會撞名重複，`monthly-diff.csv` 用 label 匹配可能派錯 site——WP4 呢層用 `row_no`（唔係名）做例外key喺 wp4 側改正 mapping。
- **L2 成本**：
  - 現金結算單位（T/W/G/D/公司兵……）：重用 `out/wp3/reports/payroll-diff.csv`（頁總計＋逐人），逐條讀 category 做 `explained`/`awaiting_boss` 分類。**刻意唔喺 source code 寫死安員真名**——`shift_count_diff` 用 data-driven 訊號分類，由高至低：(0) 呢個 guard_id 有冇喺 `out/wp2b/day-mismatch.csv` 出現過、已經有（人手覆核咗嘅）結論（`_guard_day_mismatch_resolution`，跟 `_DAY_MISMATCH_NEEDS_REVIEW_OVERRIDE` 用 guard_id/site_id/work_date 做 key）——有嘅話直接跟返嗰個結論，避免同一個人嘅疑點喺兩個唔同來源分別開多一次問題；(1) 呢個安員個名有冇喺 day-mismatch.csv category=`substitution` 出現過（創富 30/31 補更嗰種成本轉移）；(2) note 入面嘅 payroll 更數係咪帶小數（半更/OT 小時標記慣例）。全部訊號都冧唔到先算真係查唔到，`awaiting_boss`（`Q6`）。`mixed_site_label`（一個 guard 橫跨幾個 site 嘅 composite label）用 `_true_shift_total_for_guard` 由 `shift_records.csv` 重新計呢個 guard_id 橫跨*所有*site 嘅真實更次總數（原 note 嘅 site_ids 清單有已知 WP3 bug，會漏咗部分 site），差距為 0 就係假陽性、直接唔輸出；有殘差先按方向分類做「更表多填」／「更表漏填」。近似名（`name-near-match.csv`）如果同一個 `roster_guard_id` *仲*喺 `unresolved-guards.csv` 或者 `payroll-diff.csv` 嘅 `near_name` 類別出現，即代表多個獨立資料流互相印證係同一人，直接 `explained`（建議合併身份）；單一來源出現先真係要人手/HR確認（`N6`）。
  - K-1331：`out/wp3/kai1331-daily-residuals.csv` 逐日 Σ 對總額，7/31 單日殘差幾乎解釋晒成個月嘅逐日彙總殘差，第二版合併做一條差異行掛 `P3`（第一版分開兩條分別問 P1/P2 同 P3 係重複計）。
  - 長工 autopay：`wp4_bochk.py` 解密讀 `data/2026-07/reference/2026-07-長工autopay-BOCHK-PayrollEditor.xls`（`msoffcrypto`+`xlrd`，密碼 `VelvetSweatshop`，**淨係攞英文名同金額，唔讀戶口號碼**），跟 `data/mappings-private/names_en.csv` 嘅 `tier`（longterm/small）分組，vs Σ(autopay_longterm 更次 × R2 月結出街價) 名義攤分——按 §3.6 規則二，呢個差異預期唔會等，接受總數層面對。老闆版工作簿「總覽」sheet 明文加一句：呢個差額係名義攤分，唔係「數唔平」，唔可以當總覽嘅差異金額計。
  - 月結成本欄（逐盤）vs 我哋成本：`R2Row.cost`（`wp3_r2.parse_r2_rows`）vs `shift_records_priced.csv` 嘅 `guard_wage_snapshot+broker_fee_snapshot`，**淨係喺現金結算佔≥50%更次嘅 site 先比較**（autopay 為主嘅 site 呢個比較天生唔完整，會製造假差異，見 `build_l2_cost_column` docstring）。
- **L3 收入**：重用 `out/wp3/gate-results.csv`（逐開票單位）＋ `billing-unit-solve.csv`（未解嘅開票單位）＋ 發票張數/缺號（D3）。`gate=PASS(known_shift_gap)`／`PASS(no_shift_records)` 呢類「已知類型嘅缺口」喺 explanation 明文分開兩種講法：`diff=0.00` 嘅係「對平」（`explained`，純粹記低個 gate 通過咗），`diff` 非0 嘅明文寫「差額已入差異清單」（實際殘差已經喺呢度或者同 site 嘅 L1/L2 差異行反映；如果嗰個 site 喺 `_L1_SITE_OVERRIDE` 已經有人手覆核落嘅結論，呢度跟返嗰個結論，唔會齊頭一律當已對平）。

### WP4第三版：Opus 總驗收後最後修正

1. **Q6 Weave OL 影響金額 0 → 5,400**：`gate-results.csv#S004` 印嘅係發票22,500 vs snapshot 27,900，diff=-5,400——31更嘅工都做咗，但發票淨係開咗25更嗰單，即潛在少開5,400收入。以前呢條L3差異行（D0106）錯誤落咗預設嘅「口徑差異／explained／冇ref」分支，同L1嗰邊嘅結論矛盾；而家 `build_l3_gate_results` 喺冇 `billing_adjustments.csv` 記錄嘅 site 都會查返 `_L1_SITE_OVERRIDE`，跟返L1已有嘅結論（category/status/boss_ref）。
2. **啟航1331（S017）唔准標「範圍外／Q2」**：`build_l3_billing_unit_solve` 嘅 `skip_site_ids` 以前淨係計 `_L1_PRICE_PENDING`（九龍企業大廈／恆星樓），漏咗喺 `_L1_SITE_OVERRIDE`（唔喺 `_L1_PRICE_PENDING`）嘅啟航1331，跌落最後嘅 else 分支變咗「範圍外／Q2」，同「啟航1331屬P0範圍內、純粹7個更別價目未反推完」呢個事實矛盾。而家 S017 主單位＋「啟航1331 Event」副線都改行「價目待補」掛 `P1;P2`。
3. **人手覆核結論冇出到落 explanation**：`_resolve_day_mismatch_row` 以前淨係 `return override[0], override[1], override[2]`，漏咗 `override[3]`（WP4第二版6條 `_DAY_MISMATCH_NEEDS_REVIEW_OVERRIDE` 人手覆核落嘅forensic結論全文），令呢啲結論從來冇出到落 `differences.csv` 嘅 explanation。而家 return 埋第4個元素，`build_l2_day_mismatch` 攞嚟拼落explanation；同時 `status=explained` 嘅 day-mismatch 行唔會再用「人手覆核／等老闆確認」做 `recommended_action`（改做「已有明確解釋（見說明入面嘅覆核結論），唔使再問。」），亦會清走 WP2b 原始 `note` 欄寫死喺句尾、`explained` 之後變咗 stale 嘅「需人手覆核」字眼（WP2b `wp2b_run.py` 偵測到「roster有、payroll冇」即寫呢句、同之後嘅category分類係兩個獨立步驟，WP4唔改WP2b source，淨係喺呈現層拎走）。
4. **D0091 K殘差補一句**：「其餘30日毛殘差53,893（5.9%），淨額抵銷至0，係因為啟航1331七個更別單價未解（P1／P2）」——由 `kai1331-daily-residuals.csv` 即場計，區分「毛殘差」（逐日abs(residual)加埋，冇正負抵銷）同「淨殘差」（正負互相抵銷），先睇得出「30日睇落好似對得幾好」呢句結論其實靠正負抵銷嚟撐大個假象。
5. **五條broker歸屬衝突（D0055-D0059）開新分類「歸屬衝突」**：以前錯誤歸咗做「更表漏填」（更表A欄雞頭代號 vs 糧明細/推斷結果對唔上邊個雞頭出糧，係歸屬問題，唔係更數缺口），固定 `CATEGORIES` 集合加咗 `CAT_BROKER_CONFLICT = "歸屬衝突"`。
6. **啟航1331 R2成本應為863,740+90,000（row22獨立雞頭費）=953,740**：`build_l2_cost_column` 以前淨係用R2 row21（863,740）嚟比，漏咗row22嘅90,000（已經喺L1 `row_no=22` 改正歸屬摺入啟航1331，但L2成本比較嗰陣冇跟埋加返）。而家用 `extra_cost_by_site` 加返呢90,000，P1/P2嘅影響金額由-812,410改咗做-902,410；D0005（L1嗰條90,000歸屬行）措辭由「已改正歸屬，唔使再問」改做「已改正歸屬並計入，唔使再問」，講清楚呢90,000唔止改咗歸屬，仲真係計咗落成本比較。
7. **P6「三條細殘差」改「五條」**：舊文字寫「三條」但實際列咗5項（HKU C更OT678.80、Weave RR+150、都會大學+140、控制室+1,350、西九龍+30）；而家 `_p6_money_impact` 由 `billing_adjustments.csv` 即場加埋（真殘差合計2,348.80），同控制室（S031）月費制口徑缺口（gate-results.csv invoice-snapshot=19,830）分開講清楚——控制室嗰條淨係1,350屬細殘差，19,830嗰個大數包含咗L1已經解釋清楚嘅22更口徑差（22×840=18,480），唔係「細殘差」嘅一部分。
8. **老闆版「我哋建議」等7欄改人話**：`wp4_workbook._boss_text()`（原名 `_scrub_boss_text`）加咗一個技術詞→中文轉換表 `_TERM_MAP`，喺剝碼之前先將 `.csv` 檔名／`gate=`／`mixed_site_label`／`monthly_fee_day`／`day-mismatch`／`site_or_unit`／`guard_id` 等等轉做人話中文；剝碼順序改做「成組代碼（例如`G0157/G0033`）一齊剝走」行先、先至「單個代碼」，避免剝完剩低「得/兩個人輪」呢種斷咗頭嘅分隔符；`\b`（word boundary）對中文字唔work（Python `\w`／`\b` 將中文字都當word char，「見site_or_unit相同」呢種貼住中文字嘅identifier用`\b`會匹配失敗），改用 ASCII-only 嘅負向lookaround。`tests/test_wp4.py::test_boss_workbook_has_no_technical_jargon` 斷言老闆版全部sheet全部格冇呢啲詞。
9. **README固定集合補N3／Q2**：呢兩個標喺 `boss_question_ref` 嘅行 `status` 一律 `explained`，純粹係追溯標籤，見上面「老闆待答問題編號」一節；`tests/test_wp4.py::test_boss_question_ref_in_fixed_set` 擴到檢查*全部*行（唔淨係 awaiting_boss）。三個「分唔到類靜靜併入Q6」嘅 fallback 分支（`build_l1` 嘅 shifts_diff／revenue_diff 兩個 else 分支、`build_l2_payroll_diff` 嘅 category fallback）改咗做 `raise AssertionError`——依家全部有資料嘅 site／category 都已經喺對應 override／分類表分咗類，如果第21個site或者新category跌落呢啲分支，代表分類邏輯漏咗，寧願即刻爆出嚟都唔可以扮已經追查過。
10. **pytest 新增**：xlsx 內容 hash（逐格值，剝走docProps/zip metadata）連跑3次一致（`test_xlsx_content_hash_stable_across_reruns`）；Q6金額5,400（`test_q6_weave_ol_money_impact_is_5400`）；S017唔係範圍外（`test_s017_kaihang_not_out_of_scope`）；explained行冇「人手覆核」字眼（`test_explained_rows_never_say_needs_manual_review`）；老闆版全部格冇工程術語（`test_boss_workbook_has_no_technical_jargon`）。

### 老闆待答問題編號（P0-執行計劃§8 + WP4第二／三版）

`boss_question_ref` 淨係准喺呢個固定集合出現：`P1 P2 P3 P4 P5 P6 D3 N3 N5 N6 N7 Q2 Q3 Q4 Q5 Q6`——前 13 個係 `P0-執行計劃.md §8` 原有嘅老闆待答問題，`Q3`／`Q4`／`Q5` 係 WP4第二版新併嘅 3 條真新問題（HKU醫學院第5更、數碼港CP1-4差4更、HKU座頭/HKU醫學院一組7/31細差），`Q6`（Weave OL 31 vs 25更差6更，WP4第三版加埋潛在少開5,400收入嘅發現，見下面）係 WP4第二版誠實開嘅第14條——追查咗「扣Weave醫院道17/6」呢條線索都追唔到邊6日，寧願多開一條問題都唔扮已解釋（見 `_L1_SITE_OVERRIDE["S004"]` 記低嘅追查過程）。

**`N3`／`Q2` 唔算「待老闆決定」問題**：呢兩個標喺 `boss_question_ref` 嘅行 `status` 一律 `explained`（唔會出現喺「待老闆決定」sheet，`build_boss_facts` 淨係收集 `status=awaiting_boss` 嘅行），純粹係「呢條差異屬於邊個已知裁定/已知缺口」嘅追溯標籤——`N3`＝§3.7「月結有更表冇、冇逐日來源」清單（國泰城/卓弘/嘉捷/ICBC/哈羅/都會大學夜巡邏共6個site）；`Q2`＝§5範圍確認已知悉（LINK C7、兩個「月結以外」客戶）。因為都係喺 `boss_question_ref` 呢一欄出現，所以都要落喺固定集合入面，`tests/test_wp4.py::FIXED_BOSS_REFS` 同呢度一致（16個ref）。

**WP4第三版修正**：Weave OL（S004）嘅 L3 差異行（`gate-results.csv#S004`：發票22,500 vs snapshot 27,900，diff=-5,400）以前錯誤跌落預設嘅「口徑差異／explained／冇ref」分支，同L1嗰邊「更表多填6更、純粹更次計法差異」嘅結論矛盾——31更嘅工都做咗，但發票淨係開咗25更嗰單，即潛在少開5,400收入，先係真金錢缺口，唔淨係更次計法差異。`build_l3_gate_results` 而家喺冇 `billing_adjustments.csv` 記錄嘅 site 都會查返 `_L1_SITE_OVERRIDE`，跟返嗰個site喺L1已經有嘅人手覆核結論（category/status/boss_ref），唔會齊頭一律當「已對平」。啟航1331（S017）主單位＋Event副線（`billing-unit-solve.csv` 兩條 pending 記錄）同一原因以前錯誤標咗「範圍外／Q2」，而家改行「價目待補」掛 `P1;P2`，同L1嘅啟航1331價目問題一併等老闆答。

### PDPO

`wp4_run.py`／`wp4_workbook.py`／`wp4_bochk.py` 全部**唔喺 source code 寫死安員真名/電話**（`tools/` 全 repo 用 `out/wp2b/guards.csv` 真名/電話做 needle 掃描，零命中）。BOCHK `.xls` 嘅銀行戶口號碼／銀行編號一律唔讀出嚟（`wp4_bochk.load_payroll_editor_rows` 淨係 return 英文名同金額）。

**2026-09-10（WP5c 必修5）修正**：以前 `build_l2_day_mismatch`／`build_l2_broker_conflicts`／`build_l2_unresolved_guards` 幾個函數會直接將 `name_zh`（真名，runtime 由 `out/wp2b/guards.csv` 讀出嚟）寫入 `differences.csv` 嘅 `explanation` 欄，最終流入 `data/2026-07/deliverables/` 兩份工作簿（老闆版 `_boss_text()` 淨識剝技術詞、唔識剝人名，會直接漏出去）。而家呢幾條 call site 已經改用 `guard_id`（唔再帶 `name_zh`），另外 `run_wp4()` 喺寫 `differences.csv`／起工作簿之前，會用 `_redact_guard_names_in_rows()` 對逐條差異行嘅 `site_or_unit`／`ours`／`theirs`／`explanation`／`recommended_action`／`provenance` 六個文字欄，掃一次全部安員嘅 `name_zh`／`name_variants`（由長至短排序）做最後把關嘅安全網，撞中就代做 `（guard_id）`——保證 `out/wp4/differences.csv` 同兩份工作簿全部唔會出現任何安員真名，需要真名一律去 `out/wp2b/guards.csv` 用 `guard_id` 查（`out/`／`data/deliverables/` 都唔入 git）。

## 一句重跑全套

**執行次序要跟**：`run-wp5` 一定要行喺 `run-wp4` 之前——WP4 嘅 `build_l2_gongsi_bing_gap`／`build_l2_haiyang_new_site` 會讀 `out/wp5/master_summary.csv`／`master_posts.csv`／`master_assignments.csv`，冇呢啲檔（未行過 `run-wp5`）就會靜靜少計一批差異行（實測：`differences.csv` 由 149 行跌到 147 行，唔會 fail，但結果唔完整——`run_wp4()` 而家會喺呢種情況打印 WARNING）。`run-wp2b`／`run-wp5` 之間冇互相依賴（見下面「WP5」節），跟住呢個次序行一次就夠，唔使重複行任何一個工作包。

```bash
cd tools/importer && source venv/bin/activate && python -m importer run-wp1
python -m importer run-wp2b
python -m importer run-wp3
python -m importer run-wp5
python -m importer run-wp4
```

驗收證據（2026-09-10）：乾淨 checkout（`rm -rf out`）跟住呢個次序行 3 次，`out/wp2b/shift_records.csv`／`out/wp4/differences.csv`／`out/wp5/master_assignments.csv` 三次 md5 完全一致。

## WP5 — 在勤總表（Roster/Summary）解析 + rule 0.1／0.2 歸屬確認

執行單位（WP5）：解析老闆 2026-09-10 交嘅「在勤總表」`data/2026-07/reference/
2026-07-在勤總表-PostOrder-Roster-Summary (Drive 2026-09-10).xlsx`（`Roster`
＋`Summary` 兩個 sheet），做「邊個安員邊日屬邊個雞頭」嘅權威來源，對應
`P0-執行計劃.md` §8 WP5 章節。冇呢個檔（本機專用資料，唔入 git）嘅環境，
`tests/test_wp5.py` 全部自動 skip。

```bash
source venv/bin/activate
python -m importer run-wp5     # 解析總表 -> out/wp5/*（唔含真名）
```

### 點解要有 WP5（rule 0.1／0.2）

`normalize.py` 嘅 `resolve_settlement_for_row()` 一直靠糧明細逐人配對
（rule 1）＋盤級糧單 fallback（rule 1.6）反推邊個安員屬邊個雞頭，但總表
先係老闆自己嘅權威記錄——**rule 0.1**（逐 guard_id）／**rule 0.2**（逐
site+day 配額消去法）將總表嘅逐日 broker 分佈擺喺呢啲舊規則之前：

- **rule 0.1**（`normalize.py`）：呢個 guard_id 喺總表逐日出現，而且對佢
  嘅 broker 分佈夠集中（預設 ≥70%，`master_roster.build_guard_broker_
  confirmations()`）——`settlement_unit` 跟總表確認，`source=master_
  roster`。
- **rule 0.2**（`wp2b_run.py`）：rule 0.1 冇覆蓋到（總表冇填雞頭名嗰啲
  盤，例如 HKU Y更）嘅弱證據記錄（`source` 係 `inferred_guard`／`none`），
  用逐 `(site_id, work_date)` 嘅總表配額扣減晒已經有具名證據嘅記錄之後，
  剩低嗰截如果單一 broker_code 就用嚟 override（`source=master_roster_
  site`）。

**2026-09-10 修（必修1）：`settlement_page` 唔准俾 rule 0.1／0.2 覆寫。**
`settlement_page` 係「呢條更次歷史上喺邊一張糧單頁出現過」（糧單頁面重現、
逐頁殘差對數要用嘅維度），同「總表確認呢個安員宜家歸邊個雞頭結算」係兩
件事——兩者可以唔一致（例如總表覆核發現某安員其實係公司兵，但佢嗰條更
歷史上寫喺 G 頁）。rule 0.1／0.2 而家淨係改 `settlement_unit`，總表
嘅原始判斷改記入兩個新欄 `master_broker_code`／`master_broker_source`
（值 `rule0.1`／`rule0.2`），`settlement_page` 保留返糧明細原有嘅值（有
真糧單證據就係嗰張糧單嘅標籤，冇就留空——總表唔係糧單，冇對應糧單頁
可以重現）。呢個分工令 `wp3_reports.py` 嘅逐頁糧單重現（`settlement_page
or settlement_unit` 做 sheet 分組）唔會將總表confirm但冇糧單證據嘅記錄
錯誤計入某張*真.糧單*嘅逐頁 Total。

### 冇循環依賴（必修2）

`wp2b_run.py` 嘅 rule 0.1／0.2 需要「邊個 guard_id 對應邊個真名」嚟同總
表逐日 remark 配對，但呢個配對表以前要靠獨立行 `run-wp5`（讀
`out/wp2b/guards.csv` 做 redaction）先產生到——形成「`run-wp5` 要
`out/wp2b/guards.csv` 已經存在，`out/wp2b/guards.csv` 又要 `run-wp2b`
先有」嘅循環依賴，冇代碼強制兩次 `run-wp2b` 嘅執行次序，乾淨 checkout
淨係行一次會靜靜跌落舊規則。而家 `run-wp2b` 唔再靠 `run-wp5` 嘅輸出：
`master_roster.build_rule01_rule02_inputs(guards)` 喺 `run-wp2b` 自己個
process 入面，用啱啱由 `resolve_identities()` 攞到嘅 guards list（喺
rule 0.1/0.2 之前已經確定，唔受佢哋影響），就地重新解析總表 xlsx、就地
redact、就地統計 rule 0.1／0.2 要嘅兩個表——一次 `run-wp2b` 一個 process
內就搞掂，唔使中間檔案、唔使跑兩次、唔使預先行過 `run-wp5`。獨立
`run-wp5` CLI 命令仍然保留（畀人手審核/PDPO 掃描總表本身用），但已經唔
係 `run-wp2b` 嘅依賴。

### 輸出檔案（`out/wp5/`，唔入 git；`run-wp5` 每次清空重寫，`reconcile/`
子目錄除外）

| 檔案 | 內容 |
|---|---|
| `master_posts.csv` | 逐崗位（block/sub_block/customer_label/property/...），已 redact。 |
| `master_assignments.csv` | 逐崗位逐日格（broker_code/work_date/remark），已 redact。 |
| `master_summary.csv` | Summary sheet 逐雞頭逐日／全月 PAID Amount 等統計。 |
| `unmapped-master.csv` | 對唔到 `site_id` 嘅崗位，逐條有已知原因或者「待人手核對」。 |
| `master_site_map.csv` | block/sub_block/property code/customer_label pattern → site_id 對照（由 `SITE_MAP_RULES` 生成，人手要改係改呢個常數本身，唔係呢個輸出檔）。 |
| `master_guard_broker_confirmations.csv`／`master_site_day_broker_counts.csv` | rule 0.1／0.2 嘅診斷/審核輸出——**`run-wp2b` 唔再靠呢兩個檔**（見上面「冇循環依賴」），純粹畀人手覆核用。 |
| `reconcile/rule02-overrides.csv`／`reconcile/rule02-conflicts.csv` | 其實係 `run-wp2b` 寫嘅審核輸出（記低 rule 0.2 逐日消去法 override 咗邊條記錄、邊啲記錄總表指向多過一個 broker_code 冇派到）。2026-09-10 修（必修8）：擺喺 `out/wp5/reconcile/` 純粹歷史原因，`clean_out_wp5_dir()` 而家明確跳過呢個子目錄，唔會俾 `run-wp5` 清走。 |

2026-09-10 修（必修10）：`master_site_map.csv`／`master_guard_broker_
confirmations.csv`／`master_site_day_broker_counts.csv` 三個自動生成檔
已經由 `mappings/` 搬去 `out/wp5/`——`mappings/` 淨係留返人手維護嘅對照
表（`SITE_MAP_RULES` 呢類生成規則喺 source code、唔喺 CSV）。

### PDPO（總表有真人姓名）

`master_roster.py` 讀嘅原始 Excel 有真人姓名（`remark`／`customer_label`
後綴）。根據「真名唔准入 `tools/`」，本模組將所有解析到嘅真名一律用
guard_id 代替（搵唔到就用 `[NAME:?]` 呢個唔可逆嘅佔位符），先至寫落
`out/wp5/` 嘅 CSV——`customer_label`／`guard_name_hint`／`remark` 三個欄
都經過 `Redactor`，原始姓名唔會進入任何輸出檔案。`tests/test_wp5.py::
test_no_raw_guard_names_in_wp5_outputs`／`test_master_site_map_csv_has_
no_names` 用 `out/wp2b/guards.csv` 嘅真名/名字變體做 needle 掃描
`out/wp5/*.csv`／`mappings/master_site_map.csv`（現已搬去 `out/wp5/`），
零命中。

### WP5c（2026-09-10）必修6／7／11–16

- **必修6**：`wp3_rates.solve_kai1331_main_gate()`——啟航1331主發票
  （MW-2026-07005）唔再交俾generic per-invoice-line loop（收掉永遠
  pending嘅RC0155），改用「Σ6個非Event更別已solved嘅client_rate_
  snapshot（A2 master_roster_rate卡）+ 4個Event Guard(1000-1900)cell以
  1,200/更計入主發票 + 已知1更count缺口」嘅真口徑，喺`wp3_run.py`額外補
  一行gate/billing-unit-solve結果。驗證：非Event snapshot 1,197,900 +
  已知1更缺口殘差1,200 = 1,199,100 = R2月結row21「啟德1331」印嘅營業額
  （獨立來源互證）；發票1,203,900 = 1,199,100 + 4×1,200；
  MW-2026-07006（Event，11,700）獨立核實 = 6×1,350+4×900（pdftotext
  核對）。gate-results.csv由32行升到33行，S017變真PASS（唔係
  PASS(known_shift_gap)）。`tests/test_wp3.py::
  test_s017_kai1331_main_invoice_gate_real_pass`鎖住。
- **必修7**：`master_roster.build_site_day_broker_counts()`（rule 0.2
  用嘅逐(site,day)配額）而家隔走`other`欄＝「甩更」／「取消」嘅格
  （`NO_SHOW_OTHER_VALUES`常數）——實測3格：row116 d8（2026-07-08，
  無返/8月扣）、row174 d14（2026-07-14）、row175 d10（2026-07-10，客戶
  取消）。口徑：`master_assignments.csv`逐日格總數3,393唔變（原始解
  析），`run_wp5_parse()`summary嘅`broker_dist_total`（隔走之後嘅「更
  次」）3,390。`build_rule01_rule02_inputs()`嘅記憶體版assign_mem而家
  都帶埋`other`欄，兩條路徑（獨立`run-wp5`／`run-wp2b`內嵌解析）一致。
  `tests/test_wp5.py::test_no_show_and_cancelled_cells_excluded_from_
  broker_counts`鎖住。
- **必修12**：`master_roster.build_master_roster_only_rows()`＋
  `wp2b_run.py`新增一段——「月結有、更表冇」site（國泰城84／M+25／
  CP5 IC 24／控制室22[第3位安員]／威信Patrol 20／ICBC 2／哈羅1，共178
  條）由總表逐崗位（post）補生成`shift_records`（`source=
  master_roster_only`），逐崗位自己嘅`client_rate`／`payout_rate`（總表
  表頭欄，唔靠反推）直接寫落`out/wp2b/master-roster-only-rates.csv`，
  `wp3_rates.build_master_roster_only_rate_cards()`讀嚟生成solved
  rate_cards。冇姓名嘅崗位（國泰城/ICBC/哈羅/東濤苑）逐post一個佔位
  guard（`get_or_create_payroll_guard`）；有姓名嘅（控制室第3位、威信
  Patrol、M+）由customer_label剝走已知崗位標籤前綴（
  `_extract_master_roster_only_guard_name`，`_MASTER_ROSTER_ONLY_LABEL_
  PREFIXES`處理「威信控制室」「威信Patrol」呢類sites.csv冇收錄嘅寫
  法）攞真名注冊新guard_id。Dedup：`(site_id,work_date,guard_id)`
  已存在就跳過（東濤苑總表嗰1格同G糧單頁證實係同一日、同一broker，
  跳過，淨低0條新增）；`wp3_reports.group_key()`加多一個source分支
  （`總表補入庫-{site_id}`），防止呢啲冇糧單證據嘅記錄計落*真.糧單*嘅
  逐頁Total（同必修1嘅`master_roster`/`master_roster_site`分支同一個
  問題）。控制室gate由PASS(known_shift_gap)（18,480缺口）變真PASS
  （差返0.08蚊quantize尾數）；國泰城/ICBC/哈羅gate變真PASS（diff=
  0.00）。`tests/test_wp3.py::test_master_roster_only_sites_real_gate_
  pass`鎖住。
- **必修13**：`mappings/referral_fee_rates.csv`（人手費率表：
  broker_id, site_id或DEFAULT, rate_per_shift）＋`master_roster.
  validate_referral_fee_rates()`——總表20條「長工雞頭費 (X)」彙總行
  （`is_broker_fee_row=True`）逐block驗證：amount÷rate=implied長工更數，
  同該(block,sub_block,shift) group底下實際`(8)長工`格數比較。費率：
  K 啟航1331 60／其餘50；W 啟航1331 50／其餘30；T(總表姓氏稱呼) Weave
  50／其餘30（由數據反推證實，唔係plan draft原文「T(總表姓氏稱呼)30」flat講法——
  Weave/T block用30除唔盡，用50先啱啱好，見`referral_fee_rates.
  csv`嘅note）；G 30。7月總額58,120（K40,590／W 10,230／
  T 6,520／G 780）分毫不差，20行入面18行match，淨低2組已知
  差異掛P3a：啟航1331 12h夜更（implied 222 vs 實際197，多25更）、
  九龍企業大廈（implied 23 vs 實際24，少1更）。`shift_records.csv`加
  `referral_fee_snapshot`欄——淨係喺已經有具體`referral_broker`（
  T/G，共251條，嚟自payroll頁面證據）先stamp，rule 0.1/0.2嘅
  `(8)長工`記錄冇逐更嘅具體雞頭證據，留空（唔喺呢個粒度砌數）。
  `tests/test_wp5.py::test_referral_fee_rates_reconcile_with_known_
  two_exceptions`鎖住。
- **必修11／順手**：`master_roster.build_wp5_report()`／
  `write_wp5_report()`——`out/wp5/wp5-report.md`真係生成（解析統計、
  崗位對site_id口徑、site map指標、啟航1331K逐日缺口表、長工雞頭費
  PAID對數），全部數字由交付檔即場算。獨立核實結果：303個崗位入面269
  個對到site_id、20條長工雞頭費彙總行、14條真.unmapped（6條7月全0更、
  8條各1更嘅個別雞頭/HQ特殊收入項——**呢個口徑同plan draft原文「14
  unmapped全0更」唔同，8條實際各有1更，已修正**）；啟航1331K逐日
  缺口總數-16，逐日：7/1 -6、7/14 -4、7/19 -1、7/25 -2、7/26 -1、
  7/27 -1、7/30 -1（**7/25實測係-2，唔係plan draft原文嘅-1，已修正**，
  加埋岩岩好-16）。`tests/test_wp5.py::
  test_wp5_report_generated_with_verified_sections`鎖住。
- **必修14**：`wp4_run.py`新增`build_l2_longterm_broker_bucket_
  exposure()`同Q10——data-driven掃`shift_records.csv`揾`guards.csv`
  is_longterm=True但settlement_unit唔係autopay_longterm（即被計落現金
  雞頭桶）嘅記錄，PDPO：全部用guard_id（唔喺source code寫死任何真名，
  同§8 item14原文有真名唔同——嗰段文字淨係喺`P0-執行計劃.md`呢個規劃
  文件出現，唔准抄落`tools/`）。P2a「已答問題」入面「HKU Y更140」呢個
  數改做「待Q10」，唔再當已確定事實引用。`Q10`已加入`_BOSS_QUESTION_
  TEXT`／`_BOSS_QUESTION_REF_ORDER`／`tests/test_wp4.py::
  FIXED_BOSS_REFS`。
- **必修15**：D5（`build_l2_gongsi_bing_gap`）收窄——逐guard_id分類：
  (a)已有真.payroll_ref證據嘅剔除（已經計落`ours_total`）；(b)
  is_longterm=True嘅4位長工（79,914.52，同Q10同一結構性成因）改
  status=explained；(c)淨低嘅先至係真.缺頁，awaiting_boss掛D5——實測
  4個guard_id（唔係plan draft原文得2個：威信Patrol/啟航1331嗰2個之外，
  必修12新增嘅控制室第3位安員／M+安員都冇payroll_ref，一併計落真.缺
  頁，合共71,999.46，**比plan draft原文闊，因為必修12令呢2個新guard
  identity第一次存在**）。三者總額79,914.52+71,999.46+已剔除嘅covered
  總額+未resolve嘅金額＝總表公司兵PAID Amount 392,886.71，分毫不差
  （internal reconciliation identity）。Q4（`數碼港CP1-4`）由寫死嘅
  「7/29+1、7/30+2、7/31+1」改做即場逐日對比
  `shift_records.csv`（is_external=False）vs`master_assignments.csv`
  （非空/EXTERNAL/UNKNOWN/OTHER嘅broker）計，核實結果同原文一致。
  Q9（海洋廠）降級：status由awaiting_boss改做explained，移出「待老闆
  決定」清單（唔喺`_FOLLOWUP_REFS_EVEN_IF_EXPLAINED`），改做備註，
  留返P1先問。`tests/test_wp4.py::
  test_d5_narrowed_autopay_explained_and_gap_reconciles`／
  `test_q4_daily_breakdown_matches_master_roster`鎖住。
- **必修16**：D0134（P3a／實測係Weave Robinson+P6嗰行）status核實——
  技術版／老闆版工作簿嘅「差異清單」sheet用同一個`status_zh = _STATUS_
  ZH.get(r["status"], r["status"])`映射、由同一個`diff_rows`list讀，
  逐格核實兩個workbook嘅status完全一致（`explained`↔`已解釋`、
  `awaiting_boss`↔`待老闆決定`），冇發現不一致——單一source of truth
  by construction，寫低呢個驗證結果做記錄。
