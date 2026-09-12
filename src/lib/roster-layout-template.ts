// P1-WP3（第二輪，2026-09-12 規劃裁定）：更表版面模板——「序列骨架」，
// 唔係 block 分組。`sites.roster_layout` 存一個**由上而下順序**嘅
// section 列表，匯出時順序逐個 render，唔靠絕對 row number（上一版
// 嘅做法）。呢個模板嘅內容一律喺 seed 時由 `data/`（`tools/importer/
// out/wp1/rows.csv`、`tools/importer/out/wp2b/shift_records.csv`、
// `tools/importer/out/wp2b/shift_types.csv`、`data/2026-07/*.xlsx` 原檔）
// runtime 逐行讀出反推，寫入 `scripts/seed/lib/roster-layout.ts`——**冇
// 任何 literal 寫死喺呢個檔案／export 邏輯入面**。
export type RosterLayoutKind = "standard" | "digital_port" | "citybus";

/** 一格非空 cell——`colOffset` = 相對 label_col（Name 欄）嘅位移（可以
 *係負數）。 */
export interface BannerCell {
  colOffset: number;
  value: string | number;
}

/** total_group 入面一行嘅寫法：`cells` = col1..labelCol 嘅 literal 內容
 * （逐格，同 header 果類，唔理乜嘢文字，原樣抄），`metric` 話畀
 * export 知 labelCol 之後（逐日）嗰段點計：
 *   - "worked"：呢個 group `scopeCodes` 嘅 record_type=shift 逐日人數
 *   - "required"：`scopeCodes` 涉及嘅 shift_type 逐日 daily_requirements 之和
 *   - "shortfall"：max(0, required-worked)
 *   - "literal"：搵唔到已知 metric（唔識嘅標籤）——逐日值都凍結做 seed
 *     嗰刻讀到嘅原始值（冇 DB 語義，只可以照抄）。
 */
export interface TotalGroupRow {
  cells: BannerCell[];
  metric: "worked" | "required" | "shortfall" | "literal";
  literalDayValues?: Array<string | number | null>; // metric="literal" 先用到
  /** Gate 1 階段 2（純加法）：呢一行嘅 raw 字面（見下面 `RawRow`）——
   * export 時如果匯出緊嘅正正係模板捕捉嗰個月（`hasAnyProvenanceRows`，
   * 見 src/lib/roster-export.ts）就逐格照抄（連原檔會出現嘅負數「尚欠」
   * 呢類 `Math.max(0,...)` 計唔返嘅值都啱），唔係就照舊行 metric 計法
   * （新月份冇 raw 可用）。 */
  rawRow?: RawRow;
}

/** Gate 1 階段 1（規劃裁定，2026-09-12：分階段純加法）：一格 raw 字面——
 * formula 格存 `{formula,result}`（result=cached 值），其餘格直接存
 * resolved 字面。呢個形狀同時俾兩條路用：(a) `shift_records.provenance.
 * raw_row`（見 `scripts/seed/lib/roster-raw.ts`，逐條有更次記錄嘅安員行
 * 用）；(b) `guard_rows` section 嘅 `rawRows`（下面，逐個原檔 row 一份，
 * 唔理呢一行有冇對應 shift_record——蓋住「成月零更、冇任何 shift_record
 * 掛得住」嘅安員行，例如淨係喺 special_items 記單一調整、7 月冇正式更
 * 記錄嘅人）。 */
export type RawCellValue = string | number | { formula: string; result: string | number | null };
export type RawRow = Record<string, RawCellValue>;

export type RosterSection =
  /** Gate 1 階段 2（純加法）：`rawRow` 存呢一行成行嘅原始字面（包括
   * `cells` 冧唔到嘅欄，例如原檔喺 labelCol 之外重用返嗰段位置寫額外
   * 裝飾字——見 header 個案）；export 時喺 `hasAnyProvenanceRows` 先用，
   * 冇（新月份）就照舊用 `cells`（相對 offset，舊路徑完全冇改）。 */
  | { kind: "banner"; cells: BannerCell[]; rawRow?: RawRow }
  /** Gate 1 階段 2（純加法）：`dateRowRaw`／`labelRowRaw` 存 header 呢
   * 兩行（「Date」+ 逐日日期；欄位 label + 逐日星期幾）嘅成行原始字面
   * ——實測發現原檔有啲檔喺 label 行 labelCol+DAYS 之後重用返個位置
   * 印多幾欄裝飾字（例如逐個請假代號嘅小計欄 header：RD/SH/AL/SL/NL），
   * 舊有 `emitDateRow`/`emitHeaderLabelsRow`（用 DAYS 動態算日期／星期
   * 幾）淨係識寫到 labelCol+DAYS 為止，寫唔到呢啲額外欄——`rawRow` 有
   * 就逐格照抄成行（連呢啲額外欄），冇（新月份）先跌返舊有動態計法。 */
  | {
      kind: "header";
      labels: string[];
      dateRowRaw?: RawRow;
      labelRowRaw?: RawRow;
      /** Gate 2（`--derived`）：原檔有啲檔喺 labelCol+DAYS 之後重用位置
       * 多印幾欄「按請假代號分類嘅小計欄」header（例如逐個
       * RD/SH/AL/SL/NL 各一欄），逐個代號文字（唔係 PII，係
       * LeaveCode enum 值本身），俾 derived fallback 用嚟寫返呢幾格
       * 嘅 legend label（同 `guard_rows.trailingSummaryCodes` 一致）。 */
      trailingSummaryCodes?: string[];
    }
  /** P1-WP3 第三輪規劃裁定（2026-09-12）：**唔准用啟發式分辨「齊整定
   * 交錯」**——`rowFrom`／`rowTo` = 原檔呢個 block 嘅安員行 row 範圍
   * （由 `wp1/rows.csv` 反推）。Export 時直接攞呢個 site×月**任何**
   * shift_record 嘅 `provenance.cell` row 落喺呢個範圍之內嘅記錄，
   * **照原檔 row 次序**逐行出（唔存在嘅 row=blank_guard_row）；7 月
   * 原檔實測即係還原返逐行交錯嘅次序，唔使判斷邊種分組。`shiftTypeCodes`
   * （DB shift_type.id 陣列，命名歷史遺留）保留做**冇 provenance 嘅新
   * 月份**（例如 UI 開 8 月新增）嘅 fallback membership——跌返用
   * shift_type 順序→雞頭代號→姓名排序。`hasTrailingTotal`：呢個
   * section 逐行喺日期欄之後多一格「行內合計」（例如
   * `COUNTIF(G5:AK5,"D")`）——export 時用當時月份嘅實際日數計位置。 */
  | {
      kind: "guard_rows";
      rowFrom: number;
      rowTo: number;
      shiftTypeCodes: string[];
      minRows: number;
      hasTrailingTotal?: boolean;
      /** Gate 1 階段 1（純加法）：逐個原檔 row number（string key）→ 呢
       * 一行嘅 raw 字面。Export 揀返返一行嘅優先次序：(1) 呢一行有
       * shift_record 掛住 `provenance.raw_row` 就用嗰個（見
       * `src/lib/roster-export.ts`）；(2) 冇 shift_record（成月零更）
       * 但呢度有就用呢個；(3) 都冇就跌返舊有 DB 推導邏輯（完全冇改）。 */
      rawRows?: Record<string, RawRow>;
      /** Gate 2（`--derived`）：同 `header.trailingSummaryCodes` 一致——
       * `hasTrailingTotal` 主總計欄（呢一行自己更別代號嘅出現次數）
       * 之後，原檔仲有幾多欄係「呢一行按請假代號分類嘅小計」（例如
       * RD/SH/AL/SL/NL 各一欄）。derived fallback 逐個代號喺 `days`
       * map 度數返出現次數，純 DB 推導，唔靠 raw 字面。 */
      trailingSummaryCodes?: string[];
      /** Gate 2 規劃裁定修正（2026-09-12）：`hasTrailingTotal` 之前係
       * 「成個 section 得一個 boolean」（淨係睇 firstGuardRow）——實測
       * 發現原檔本身唔一致：同一個 section 入面有啲行有自己嘅
       * COUNTIF 主計欄，有啲（緊鄰嘅另一行）冇（原檔自己漏咗落公式，
       * 唔係邏輯問題）。逐個原檔 row number（string）記低邊行*真係*有
       * 自己嘅主計欄，derived fallback 揀返返呢一行個別判斷，唔再靠
       * 成個 section 一刀切。冇呢個欄（舊模板／未重新 seed）就跌返
       * `hasTrailingTotal`（完全冇改）。 */
      trailingTotalRows?: string[];
    }
  | { kind: "blank"; rows: number }
  /** 一組 Total/所需人手/尚欠（或者原檔用嘅其他字眼）——`rowFrom`／
   * `rowTo` = 呢組數值涵蓋邊個原檔 row 範圍嘅安員（同 guard_rows 一樣
   * 用 provenance row 直接對應，唔靠 fuzzy-match rank 文字估）；
   * `scopeCodes`（DB shift_type.id，fallback 用）留低做冇 provenance
   * 情況嘅後備 scope。 */
  | { kind: "total_group"; rowFrom: number; rowTo: number; scopeCodes: string[]; rows: TotalGroupRow[]; hasTrailingTotal?: boolean }
  /** Catch-all：一行冇對應到以上任何分類嘅 literal 內容（罕見，凍結）。
   * Gate 1 階段 2：`rawRow` 同 banner 一致（成行原始字面 fallback 優先）。 */
  | { kind: "literal_row"; cells: BannerCell[]; rawRow?: RawRow };

export interface RosterLayoutTemplate {
  layout: RosterLayoutKind;
  sections: RosterSection[];
  /** 城巴專用：sub_site（"Property Name"）出現次序，跟原檔 8 廠合併嘅
   * 次序（gate script 用嚟決定逐個 depot workbook 拼埋一齊嘅次序）。 */
  depotOrder?: string[];
  source?: string;
}

export function isRosterLayoutTemplate(v: unknown): v is RosterLayoutTemplate {
  if (!v || typeof v !== "object") return false;
  const t = v as Record<string, unknown>;
  return typeof t.layout === "string" && Array.isArray(t.sections);
}
