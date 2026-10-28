// WP-ROSTER-UPLOAD Phase A（§15.3）：更表檔案（xlsx）解析器——移植
// `tools/importer/importer/extract.py`（P0 匯入用嘅 python 版）＋
// `data/2026-09/aug-payroll-trial/scripts/s02_extract.py` 7 個 8 月試算
// patch，用 exceljs（package.json 已有）改寫做呢個系統嘅**常駐**功能
// （唔係一次性離線工具）。
//
// 同 P0 importer 唔同嘅地方（刻意簡化，Phase A 唔需要）：
//   - 唔做 Total/所需人手/尚欠 嘅逐日對數（果套喺 P0 WP1 用嚟驗證匯入
//     結果，Phase A「更表 vs 系統已報更」對數留返 Phase B，呢層淨係讀
//     Total/所需人手/尚欠 三種標籤行嚟識別「呢行唔係保安員行」，成行跳過，
//     唔生成 roster_upload_rows，亦唔理呢啲行自己嘅日格數值）。
//   - 唔做 HKU Y更姓名 "(上)"/"(摩)" 後綴拆分、external marker 判斷——
//     Phase A schema 冇 location_tag/is_external 呢類欄，呢層留返 Phase B
//     寫 shift_records 嗰陣先需要。
//   - 唔碰 Excel 日期污染格式（`excel_dates.to_number`）——嗰個係
//     Total/尚欠格先會中招，呢層根本唔讀呢啲格嘅數值。
//
// 輸出純結構（呢個檔案零 DB 依賴，`import type {} from "@/lib/db"` 都冇）
// ——盤名/更別/保安員/雞頭嘅對照留俾 `src/lib/roster-upload/match.ts`
// （拎住呢度嘅輸出＋DB 查詢結果先做）。
import ExcelJS from "exceljs";
import { buildMapping, findDateHeaders, fieldCol, rawCell, withTimeInBrokerCol, LAYOUT_OFFSETS, type ColumnMapping, type LayoutName } from "./layout";
import { normalizeTimeRange } from "./time-range";
import { classifyCode, otHoursFromCode, STAT_ROW_LABELS, type CodeKind } from "./cell-codes";

function clean(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "object") {
    const v = value as Record<string, unknown>;
    if (Array.isArray((v as { richText?: unknown }).richText)) {
      const s = (v.richText as Array<{ text?: string }>).map((t) => t.text ?? "").join("");
      return clean(s);
    }
    if ("result" in v) return clean(v.result);
    if (value instanceof Date) return clean(value.toISOString());
    return null;
  }
  const s = String(value).trim();
  return s === "" ? null : s;
}

function asDate(value: unknown): Date | null {
  if (value instanceof Date) return value;
  if (value && typeof value === "object" && "result" in (value as Record<string, unknown>)) {
    const r = (value as { result: unknown }).result;
    if (r instanceof Date) return r;
  }
  return null;
}

// 只認可見嘅 `<年>` 或 `<年>.<月>`（8 月試算 patch 5：恆星樓／葵發大廈嘅
// 工作表叫 `2026.08`）——`相`（相片分頁）、`工作表1`（隱藏舊分頁）呢類
// 一律唔啱呢個 pattern，跳過。驗收 2026-09-23：原本寫死 `2026`，2027 年
// 1 月嘅更表（分頁叫 `2027`）會成個 parse_failed——改做任何 20xx 年份。
//
// HIST-2：1–3 月歷史更表分頁名係 `202601`（YYYYMM，冇點）——再容許
// `<年>[.|-]?<月>`（`202601`／`2026-01`／`2026.01`／`2026.8`）。
const ROSTER_SHEET_RE = /^20\d{2}([.-]?\d{1,2})?$/;

// HIST-2 fallback：冇任何分頁名對到 ROSTER_SHEET_RE 時（`202512-202601`、
// `Feb+Mar`、`Mar`），改揀「可見、名唔係相片／預設工作表／Summary 類、而且
// 搵到 Date 日期表頭」嘅分頁。
// 前綴比對（容許尾巴 " (2)"／數字／copy，例如「Summary (2)」「工作表1 (2)」「Sheet1 (2)」「總表2」「相 (2)」）。
const NON_ROSTER_SHEET_RE = /^(相片?(?=$|[\s\d(（_-])|photos?|工作表|sheet|summary|總結|總表|總數|統計)/i;

export interface ParsedCellRow {
  /** 原檔行號（呢個保安員行嘅 row number），一個保安員行可以有多個 ParsedCellRow（逐日一格）。 */
  rowIndex: number;
  subSiteName: string | null;
  workDate: string; // ISO date "YYYY-MM-DD"
  rawCode: string;
  codeKind: CodeKind;
  staffNoRaw: string | null;
  nameRaw: string | null;
  telRaw: string | null;
  rankRaw: string | null;
  timeRaw: string | null;
  brokerCodeRaw: string | null;
  hours: number | null;
  warnings: string[];
}

interface SheetParseWarning {
  row: number;
  reason: string;
}

interface ParsedSheet {
  sheetName: string;
  siteRaw: string | null;
  layouts: LayoutName[]; // 呢個 sheet 入面出現過嘅 layout（正常一個 sheet 得一種，但唔寫死）
  noBrokerCol: boolean;
  maxDateHeaderGap: number;
  blockCount: number;
  subSiteNames: string[];
  /** Phase B-0：呢個 sheet 入面由橫向合併格展開出嚟嘅格數（3 格合併 D
   * ＝計 3，唔包括冇合併嘅格）。 */
  mergedExpandedCount: number;
  /** 表頭（Date 列）真日期（YYYY-MM-DD，去重）——截短判斷只認表頭覆蓋，唔睇「有更嘅日子」。 */
  headerDates: string[];
  rows: ParsedCellRow[];
  warnings: SheetParseWarning[];
}

interface ParseSuccess {
  ok: true;
  fileName: string;
  sheets: ParsedSheet[];
  skippedSheets: Array<{ name: string; reason: string }>;
  siteRaw: string | null;
  layoutKey: string;
  rows: ParsedCellRow[]; // 逐 sheet rows 攤平
  totalCellCount: number;
  shiftCount: number; // code_kind=shift 嘅格數（唔計 leave/ot/marker/unknown）
  codeBreakdown: Record<string, number>;
  codeKindBreakdown: Record<CodeKind, number>;
  dateRange: { min: string; max: string } | null;
  /** 表頭真日期範圍／日數（所有分頁聯集）——WP-ONE-CLICK-AUTO 截短判斷用。 */
  headerDateRange: { min: string; max: string } | null;
  headerDays: number;
  /** N5：表頭所有真日期（ISO，排序）——variance 只數落喺上載月份內嘅日子。 */
  headerDates: string[];
  subSiteNames: string[];
  /** Phase B-0：全檔由橫向合併格展開出嚟嘅格數總和。 */
  mergedExpandedCount: number;
  warnings: string[];
}

interface ParseFailure {
  ok: false;
  fileName: string;
  error: string;
  skippedSheets: Array<{ name: string; reason: string }>;
}

export type ParseResult = ParseSuccess | ParseFailure;

const SKIP_ROW1_WORDS = new Set(["年", "月", "日", "保安值勤表", "Roster"]);

function isPureNumberLike(s: string): boolean {
  return /^\d+(\.\d+)?$/.test(s);
}

/** 盤名：先掃 row2 頭 6 欄（A2／B2／C2 都出現過），搵唔到先 fallback 去
 * row1（8 月試算 patch 2+7：Garden East／希慎廣場盤名喺 A1，A2 淨係得
 * 一個日期格）。 */
function getSiteRaw(ws: ExcelJS.Worksheet): string | null {
  for (let col = 1; col <= 6; col++) {
    const raw = rawCell(ws, 2, col);
    if (asDate(raw) !== null) continue;
    const v = clean(raw);
    if (v) return v;
  }
  for (let col = 1; col <= 6; col++) {
    const raw = rawCell(ws, 1, col);
    if (asDate(raw) !== null || typeof raw === "number") continue;
    const v = clean(raw);
    if (v && !SKIP_ROW1_WORDS.has(v) && !isPureNumberLike(v)) return v;
  }
  return null;
}

function isRowBlank(ws: ExcelJS.Worksheet, row: number, mapping: ColumnMapping): boolean {
  const colsToCheck = new Set<number>();
  for (const off of Object.values(LAYOUT_OFFSETS[mapping.layout])) {
    // 8 月試算 patch 6：Garden East／希慎廣場冇雞頭碼欄，offset 計出嚟嘅
    // 欄號可以 <1——一定要跳過，唔可以讀 column index < 1 嘅格。
    const col = mapping.labelCol + off;
    if (col >= 1) colsToCheck.add(col);
  }
  colsToCheck.add(mapping.labelCol);
  for (let c = mapping.dateStartCol; c <= mapping.dateEndCol; c++) colsToCheck.add(c);
  for (const [c] of mapping.trailingCols) colsToCheck.add(c);
  for (const c of colsToCheck) {
    if (clean(rawCell(ws, row, c)) !== null) return false;
  }
  return true;
}

const IDENTITY_FIELDS = ["brokerCode", "timeSlot", "rank", "staffNo", "tel", "nameEn", "subSite"] as const;

function hasIdentitySignal(ws: ExcelJS.Worksheet, row: number, mapping: ColumnMapping): boolean {
  for (const name of IDENTITY_FIELDS) {
    const col = fieldCol(mapping, name);
    if (col !== null && clean(rawCell(ws, row, col)) !== null) return true;
  }
  return false;
}

function field(ws: ExcelJS.Worksheet, row: number, mapping: ColumnMapping, name: (typeof IDENTITY_FIELDS)[number]): string | null {
  const col = fieldCol(mapping, name);
  if (col === null) return null;
  const v = clean(rawCell(ws, row, col));
  // HIST-4：電話欄剝走隱形 Unicode 控制／格式字元（U+202C 等），NBSP 等空白變普通空格。
  if (v !== null && name === "tel") return v.normalize("NFKC").replace(/[\p{Zs}\t\n\r]+/gu, " ").replace(/[\p{Cc}\p{Cf}]/gu, "").trim() || null;
  return v;
}

/** HIST-3：舊模板冇雞頭碼欄、時段喺雞頭碼欄位置。三個條件全部要成立（免一個打錯字令成個 block 錯位）：
 * (i) 雞頭碼欄所有非空值都係 HHMM-HHMM，而且有值嘅行數 ≥ 90% 人名行（人名行＝有姓名、非統計行、有任何身份欄值）；
 * (ii) 原本時段欄（雞頭碼欄右手邊）冇一個值係 HHMM-HHMM（真舊模板嗰欄係職級文字；兩邊都係時段＝標準排法，唔移）。 */
function brokerColHoldsTimeSlots(ws: ExcelJS.Worksheet, mapping: ColumnMapping, startRow: number, endRow: number): boolean {
  const col = fieldCol(mapping, "brokerCode");
  const timeCol = fieldCol(mapping, "timeSlot");
  if (col === null) return false;
  let seen = 0;
  let personRows = 0;
  for (let r = startRow; r <= endRow; r++) {
    const labelVal = clean(rawCell(ws, r, mapping.labelCol));
    if (!labelVal || STAT_ROW_LABELS.has(labelVal)) continue;
    if (!hasIdentitySignal(ws, r, mapping)) continue;
    personRows += 1;
    if (timeCol !== null) {
      const t = clean(rawCell(ws, r, timeCol));
      if (t !== null && normalizeTimeRange(t) !== null) return false;
    }
    const v = clean(rawCell(ws, r, col));
    if (v === null) continue;
    if (normalizeTimeRange(v) === null) return false;
    seen += 1;
  }
  return seen > 0 && seen >= personRows * 0.9;
}

function isoDateUTC(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// Phase B-0（§15.3 第 1 項，老闆 2026-09-23 答）：日期格橫向合併跨 N 個
// 日期欄（例如 8/11–8/13 三格合併寫一個 D）＝嗰 N 日**每日一格**同一個
// 代號（3 格合併 D＝3 更），逐格出警告「由合併格展開（第 x/N 日）」俾
// 會計覆核。直行合併（姓名跨兩行）唔受呢個函數影響，照舊淨計第一行
// （`rawCell()` 對「母格喺上面幾行」嘅 slave 格繼續當空白）。
function addressRowNum(address: string): number {
  const m = /^[A-Za-z]+(\d+)$/.exec(address);
  return m ? Number(m[1]) : -1;
}

interface DateMergeGroup {
  /** 呢個 group 喺 [dateStartCol,dateEndCol] 範圍入面實際包含嘅欄（按次序）。 */
  cols: number[];
  rawValue: string | null;
  /** 橫跨多過一個日期欄嘅合併——先要逐格出「由合併格展開」warning。 */
  isMultiCol: boolean;
  /** 合併範圍伸出咗 dateEndCol 以外（例如連埋備註欄）——淨係展開咗日期
   * 欄嗰部分，要另外出一個警告講呢件事。 */
  extendsBeyondRange: boolean;
  /** 驗收 2026-09-23：合併範圍由日期欄前面（例如 Name／日薪欄）伸入日期
   * 欄——母格唔係日期格，個值（通常係姓名）唔係代號，當空白跳過＋警告。 */
  startsBeforeRange?: boolean;
}

function collectDateMergeGroups(ws: ExcelJS.Worksheet, row: number, startCol: number, endCol: number): DateMergeGroup[] {
  const groups: DateMergeGroup[] = [];
  let col = startCol;
  while (col <= endCol) {
    const cell = ws.getRow(row).getCell(col);
    if (cell.isMerged && addressRowNum(cell.master.address) !== row) {
      // 母格喺上面幾行（直行合併延伸落嚟呢個日期格，理論上罕見）——當
      // 空白跳過，唔起 group（同姓名欄嘅直行合併行為一致）。
      col += 1;
      continue;
    }
    if (cell.isMerged && Number(cell.master.col) < startCol) {
      // 驗收 2026-09-23：母格喺日期欄前面（例如姓名格合併伸入第一個日期
      // 欄）——之前會將姓名當代號展開入日期格。當空白跳過＋警告。
      const masterAddress = cell.master.address;
      const cols = [col];
      let probe = col + 1;
      while (probe <= endCol && ws.getRow(row).getCell(probe).isMerged && ws.getRow(row).getCell(probe).master.address === masterAddress) {
        cols.push(probe);
        probe += 1;
      }
      groups.push({ cols, rawValue: null, isMultiCol: false, extendsBeyondRange: false, startsBeforeRange: true });
      col = probe;
      continue;
    }
    const masterAddress = cell.isMerged ? cell.master.address : cell.address;
    const cols = [col];
    let probe = col + 1;
    while (probe <= endCol) {
      const probeCell = ws.getRow(row).getCell(probe);
      if (probeCell.isMerged && probeCell.master.address === masterAddress) {
        cols.push(probe);
        probe += 1;
      } else {
        break;
      }
    }
    let extendsBeyondRange = false;
    // 驗收 2026-09-23：淨係最後一個日期格同備註欄合併（日期部分得 1 格）
    // 之前唔會出警告——改做只要 group 去到 endCol 而且係合併格就檢查。
    if (cell.isMerged && cols[cols.length - 1] === endCol) {
      const afterCell = ws.getRow(row).getCell(endCol + 1);
      if (afterCell.isMerged && afterCell.master.address === masterAddress) extendsBeyondRange = true;
    }
    // slave 格嘅 `.value` 本身已經自動鏡射母格個值（exceljs 特性），淨係
    // 讀 group 第一格（唔理係咪母格本身）就攞到正確值，唔使額外攞
    // `cell.master.value`。
    groups.push({ cols, rawValue: clean(cell.value), isMultiCol: cols.length > 1, extendsBeyondRange });
    col = probe;
  }
  return groups;
}

/** WP-ROSTER-UPLOAD Phase B-1（B1-8 第 5 項）：CP5「數據中心」指針格
 * ——`code_kind=marker` 嘅「數據中心」格代表「呢個格之後（同一行，即
 * 同一個保安員嗰條 `row_index`，跟住落嚟嘅日子）」轉咗去數據中心子盤，
 * 直至（呢個 row_index 行本身完結）。逐個 `row_index` 天然就係「下一個
 * 標題」嘅邊界（一個保安員一條完整月線），唔使額外追蹤空白段。淨係喺
 * 呢行本身未由「子盤」欄（`subSite` 直接讀嘅值）填過先套用——有真實
 * 子盤欄值就尊重佢，唔畀 marker 蓋過去。
 *
 * Post-processing pass（喺一個 sheet 全部 rows 收集晒之後先行），冇改
 * 動 `extractSheet()` 逐格解析核心邏輯，避免連累 gate:roster-parse
 * 36/36 嘅真實 CP5 檔案（現存主檔入面有 2 粒「數據中心」marker 格，
 * dev DB 未必真係將「數據中心」set 做 CP5 嘅 `parent_site_id` 子盤——
 * 單元測試 `tests/roster-upload-parse-data-center-pointer.test.ts` 用
 * 合成資料證明呢個 pass 本身邏輯啱，唔靠 dev DB 結構，任務書允許呢種
 * 「合成測試證明」做法）。 */
export function applyDataCenterMarkerPointer(rows: ParsedCellRow[]): ParsedCellRow[] {
  const byRow = new Map<number, ParsedCellRow[]>();
  for (const r of rows) {
    const list = byRow.get(r.rowIndex) ?? [];
    list.push(r);
    byRow.set(r.rowIndex, list);
  }
  const out: ParsedCellRow[] = [];
  for (const group of byRow.values()) {
    const sorted = [...group].sort((a, b) => (a.workDate < b.workDate ? -1 : a.workDate > b.workDate ? 1 : 0));
    let active = false;
    for (const cell of sorted) {
      if (cell.codeKind === "marker" && cell.rawCode.trim() === "數據中心") {
        active = true;
        out.push(cell);
        continue;
      }
      out.push(active && !cell.subSiteName ? { ...cell, subSiteName: "數據中心" } : cell);
    }
  }
  out.sort((a, b) => (a.rowIndex !== b.rowIndex ? a.rowIndex - b.rowIndex : a.workDate < b.workDate ? -1 : a.workDate > b.workDate ? 1 : 0));
  return out;
}

function extractSheet(ws: ExcelJS.Worksheet, sheetName: string): ParsedSheet | { error: string } {
  const siteRaw = getSiteRaw(ws);
  const headers = findDateHeaders(ws);
  if (!headers.length) {
    return { error: `工作表「${sheetName}」搵唔到 Date 表頭，冇任何資料被讀取` };
  }

  const rows: ParsedCellRow[] = [];
  const warnings: SheetParseWarning[] = [];
  const layouts = new Set<LayoutName>();
  let noBrokerCol = false;
  let maxGap = 0;
  let mergedExpandedCount = 0;
  const subSiteNames = new Set<string>();
  const headerDates = new Set<string>();

  for (let i = 0; i < headers.length; i++) {
    const [dateRow, labelCol] = headers[i]!;
    let mapping = buildMapping(ws, dateRow, labelCol);
    const startRow = mapping.headerRow + 1;
    const endRow = i + 1 < headers.length ? headers[i + 1]![0] - 1 : ws.rowCount;
    // HIST-3：雞頭碼欄值全部係時段 → 當冇雞頭碼欄（noBrokerCol），欄位向左移一格。
    if (brokerColHoldsTimeSlots(ws, mapping, startRow, endRow)) mapping = withTimeInBrokerCol(mapping);
    for (const d of mapping.dateValues.values()) headerDates.add(isoDateUTC(d));
    layouts.add(mapping.layout);
    if (mapping.noBrokerCol) noBrokerCol = true;
    if (mapping.dateHeaderGap > maxGap) maxGap = mapping.dateHeaderGap;

    for (let r = startRow; r <= endRow; r++) {
      if (isRowBlank(ws, r, mapping)) continue;

      const labelVal = clean(rawCell(ws, r, mapping.labelCol));
      if (labelVal && STAT_ROW_LABELS.has(labelVal)) continue; // Total/所需人手/尚欠/早加夜——唔係保安員行

      if (!hasIdentitySignal(ws, r, mapping)) {
        warnings.push({
          row: r,
          reason: "呢行有值但 broker/time/rank/staff_no/tel/name_en/sub_site 全部空白，當統計行跳過，人手覆核係咪啱",
        });
        continue;
      }

      const brokerCodeRaw = field(ws, r, mapping, "brokerCode");
      const timeRaw = field(ws, r, mapping, "timeSlot");
      const rankRaw = field(ws, r, mapping, "rank");
      const staffNoRaw = field(ws, r, mapping, "staffNo");
      const telRaw = field(ws, r, mapping, "tel");
      const subSite = field(ws, r, mapping, "subSite");
      const nameRaw = clean(rawCell(ws, r, mapping.labelCol));

      if (subSite) subSiteNames.add(subSite);

      if (nameRaw === null) {
        warnings.push({ row: r, reason: "保安員行冇姓名（Name 欄空白）但呢行有其他欄有值，懷疑 block 邊界判斷錯咗" });
        continue;
      }

      // Phase B-0（老闆 2026-09-23 答）：日期格橫向合併跨 N 個日期欄＝嗰
      // N 日每日一格同一個代號，逐格展開＋逐格警告；跨出日期欄範圍（例
      // 如連埋備註欄）就淨係展開日期欄部分＋另加一個警告。
      const mergeGroups = collectDateMergeGroups(ws, r, mapping.dateStartCol, mapping.dateEndCol);
      for (const group of mergeGroups) {
        if (group.startsBeforeRange) {
          const firstCell = ws.getRow(r).getCell(group.cols[0]!);
          warnings.push({
            row: r,
            reason: `合併儲存格（${firstCell.master.address} 開始）由日期欄前面伸入日期欄（${firstCell.address}），嗰幾格當空白跳過，人手覆核`,
          });
        }
        if (group.extendsBeyondRange) {
          const firstCell = ws.getRow(r).getCell(group.cols[0]!);
          warnings.push({
            row: r,
            reason: `合併儲存格（${firstCell.address} 開始）延伸到日期欄範圍以外（例如備註欄），淨係展開日期欄部分，人手覆核`,
          });
        }
        const rawCode = group.rawValue;
        if (rawCode === null) continue;
        const codeKind = classifyCode(rawCode);
        const totalDays = group.cols.length;
        if (group.isMultiCol) mergedExpandedCount += totalDays;
        group.cols.forEach((col, idx) => {
          const dateObj = mapping.dateValues.get(col);
          if (!dateObj) return;
          const rowWarnings: string[] = [];
          if (codeKind === "unknown") {
            rowWarnings.push(`格仔代號「${rawCode}」未喺對照表出現，人手覆核`);
          }
          // HIST-3：x／X 係空缺標記（唔計更）；正式月份亦照認，但逐格留警告等人手確認，免靜靜由 unknown 變唔計。
          if (codeKind === "marker" && /^x$/i.test(rawCode.trim())) {
            rowWarnings.push("代號 x 當空缺標記，唔計更，人手確認係咪空缺");
          }
          if (group.isMultiCol) {
            rowWarnings.push(`由合併格展開（第 ${idx + 1}/${totalDays} 日）`);
          }
          rows.push({
            rowIndex: r,
            subSiteName: subSite,
            workDate: isoDateUTC(dateObj),
            rawCode,
            codeKind,
            staffNoRaw,
            nameRaw,
            telRaw,
            rankRaw,
            timeRaw,
            brokerCodeRaw,
            hours: codeKind === "ot" ? otHoursFromCode(rawCode) : null,
            warnings: rowWarnings,
          });
        });
      }
    }
  }

  // B1-8 第 5 項：`applyDataCenterMarkerPointer()`（見上面）**刻意未接
  // 落呢個 pipeline**——實測 `npm run gate:roster-parse` 對住真實 8 月
  // CP5 主檔（2 粒「數據中心」marker 格）跑呢個函數會令
  // `sub_site_names` 由 `[]` 變 `[數據中心]`，同 `tests/fixtures/
  // roster-parse-aug-2026.json`（8 月試算 python importer 產生嘅 ground
  // truth）唔夾，令 35/36（本來 36/36）。即係話任務書「該格之後嘅行
  // ……屬數據中心子盤」呢條規則，同呢兩粒真實 marker 格嘅已知正確行為
  // （唔propagate）有出入——唔敢喺冇進一步同老闆/會計核實嘅情況下就咁
  // 假設邊個啱，所以淨係留低呢個 pure function（同佢自己嘅合成單元
  // 測試，見 tests/roster-upload-parse-data-center-pointer.test.ts）
  // 證明個邏輯本身啱，但唔接落 `extractSheet()`，保 gate 36/36。回報會
  // 講呢個矛盾，等老闆/會計話事應該點做（例如：兩粒真實 marker 格會唔
  // 會其實係人手輸入錯誤，定係呢個 pointer 語意本身仲要再問清楚範圍）。
  return {
    sheetName,
    siteRaw,
    layouts: [...layouts],
    noBrokerCol,
    maxDateHeaderGap: maxGap,
    blockCount: headers.length,
    subSiteNames: [...subSiteNames],
    mergedExpandedCount,
    headerDates: [...headerDates].sort(),
    rows,
    warnings,
  };
}

function buildLayoutKey(sheets: ParsedSheet[]): string {
  const layoutNames = new Set<string>();
  const modifiers = new Set<string>();
  for (const s of sheets) {
    for (const l of s.layouts) layoutNames.add(l);
    if (s.noBrokerCol) modifiers.add("no-broker-col");
    if (s.maxDateHeaderGap > 0) modifiers.add(`date-gap:${s.maxDateHeaderGap}`);
    if (s.blockCount > 1) modifiers.add("multi-block");
    if (s.layouts.includes("citybus") && s.subSiteNames.length > 1) modifiers.add("multi-subsite");
  }
  const base = [...layoutNames].sort().join(",") || "unknown";
  return [base, ...[...modifiers].sort()].join("+");
}

/** 解析一份更表 xlsx（buffer）。純結構輸出，冇任何 DB 依賴。 */
export async function parseRosterWorkbook(buffer: Buffer | ArrayBuffer, fileName: string, opts: { uploadMonth?: Date } = {}): Promise<ParseResult> {
  const monthPrefix = opts.uploadMonth ? `${opts.uploadMonth.getUTCFullYear()}-${String(opts.uploadMonth.getUTCMonth() + 1).padStart(2, "0")}-` : null;
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer as ExcelJS.Buffer);
  } catch (err) {
    return { ok: false, fileName, error: `壞檔，讀唔到 xlsx：${err instanceof Error ? err.message : String(err)}`, skippedSheets: [] };
  }

  const skippedSheets: Array<{ name: string; reason: string }> = [];
  const matchedSheets: ExcelJS.Worksheet[] = [];
  const fallbackWarnings: string[] = [];
  const nameUnmatched: ExcelJS.Worksheet[] = [];
  for (const ws of workbook.worksheets) {
    if (ws.state !== "visible") {
      skippedSheets.push({ name: ws.name, reason: `分頁狀態=${ws.state}（隱藏），跳過` });
      continue;
    }
    if (!ROSTER_SHEET_RE.test(ws.name.trim())) {
      nameUnmatched.push(ws);
      continue;
    }
    matchedSheets.push(ws);
  }

  if (matchedSheets.length) {
    for (const ws of nameUnmatched) {
      skippedSheets.push({ name: ws.name, reason: "分頁名唔係「<年份>」或「<年份>.<月>」（亦接受 YYYYMM／YYYY-MM），當非更表分頁跳過" });
    }
  } else {
    const fallbackCandidates: ExcelJS.Worksheet[] = [];
    // HIST-2 fallback：揀有 Date 表頭、名唔屬相片／Summary 類嘅可見分頁。
    for (const ws of nameUnmatched) {
      if (NON_ROSTER_SHEET_RE.test(ws.name.trim())) {
        skippedSheets.push({ name: ws.name, reason: "分頁名屬相片／預設工作表／Summary 類，當非更表分頁跳過" });
        continue;
      }
      if (findDateHeaders(ws).length === 0) {
        skippedSheets.push({ name: ws.name, reason: "分頁名唔符標準格式，而且搵唔到 Date 日期表頭，當非更表分頁跳過" });
        continue;
      }
      fallbackCandidates.push(ws);
    }
    // 多過一個候選：只採用格數最多嗰個（避免複製分頁／統計分頁重複計格），其餘記 skipped＋needs-review 警告。
    if (fallbackCandidates.length > 0) {
      let best = fallbackCandidates[0]!;
      if (fallbackCandidates.length > 1) {
        // 有上載月份：先睇「Date 表頭落喺上載月份嘅日數」最多，平手先睇格數；冇上載月份只睇格數。
        let bestScore: [number, number] = [-1, -1];
        for (const ws of fallbackCandidates) {
          const r = extractSheet(ws, ws.name);
          const rows = "error" in r ? 0 : r.rows.length;
          const inMonth = "error" in r || !monthPrefix ? 0 : r.headerDates.filter((x) => x.startsWith(monthPrefix)).length;
          if (inMonth > bestScore[0] || (inMonth === bestScore[0] && rows > bestScore[1])) {
            best = ws;
            bestScore = [inMonth, rows];
          }
        }
        for (const ws of fallbackCandidates) {
          if (ws !== best) skippedSheets.push({ name: ws.name, reason: `分頁名唔符標準格式，同時有 Date 表頭嘅分頁超過一個，只採用上載月份表頭日數最多（平手睇格數）嘅「${best.name}」，此分頁跳過（避免重複計格），人手覆核` });
        }
        fallbackWarnings.push(`[分頁名 fallback] 有 ${fallbackCandidates.length} 個唔符標準名而有 Date 表頭嘅分頁，只採用「${best.name}」，需要人手覆核`);
      }
      matchedSheets.push(best);
      fallbackWarnings.push(`[分頁名 fallback] 「${best.name}」唔符標準分頁名，因為有 Date 日期表頭而採用，人手覆核`);
    }
  }

  if (!matchedSheets.length) {
    return {
      ok: false,
      fileName,
      error: "搵唔到可見嘅更表工作表（分頁名例如 2026／2026.08／202601，或有 Date 日期表頭嘅分頁）",
      skippedSheets,
    };
  }

  const sheets: ParsedSheet[] = [];
  for (const ws of matchedSheets) {
    const result = extractSheet(ws, ws.name);
    if ("error" in result) {
      skippedSheets.push({ name: ws.name, reason: result.error });
      continue;
    }
    sheets.push(result);
  }

  if (!sheets.length) {
    return { ok: false, fileName, error: "全部候選工作表都搵唔到 Date 表頭", skippedSheets };
  }

  const rows = sheets.flatMap((s) => s.rows);
  const codeBreakdown: Record<string, number> = {};
  const codeKindBreakdown: Record<CodeKind, number> = { shift: 0, leave: 0, ot: 0, marker: 0, unknown: 0 };
  let dateMin: string | null = null;
  let dateMax: string | null = null;
  const subSiteNames = new Set<string>();
  const warnings: string[] = [];

  for (const row of rows) {
    codeBreakdown[row.rawCode] = (codeBreakdown[row.rawCode] ?? 0) + 1;
    codeKindBreakdown[row.codeKind] += 1;
    if (dateMin === null || row.workDate < dateMin) dateMin = row.workDate;
    if (dateMax === null || row.workDate > dateMax) dateMax = row.workDate;
    if (row.subSiteName) subSiteNames.add(row.subSiteName);
  }
  const allHeader = new Set<string>(sheets.flatMap((sh) => sh.headerDates));
  const headerSorted = [...allHeader].sort();
  for (const s of sheets) {
    for (const w of s.warnings) warnings.push(`[${s.sheetName}] row ${w.row}：${w.reason}`);
  }
  const xMarkerCells = rows.filter((x) => x.codeKind === "marker" && /^x$/i.test(x.rawCode.trim())).length;
  if (xMarkerCells > 0) warnings.push(`[x 標記] 有 ${xMarkerCells} 格代號 x 當空缺標記，唔計更，人手確認係咪空缺`);
  warnings.push(...fallbackWarnings);
  for (const skipped of skippedSheets) {
    warnings.push(`[分頁跳過] ${skipped.name}：${skipped.reason}`);
  }

  return {
    ok: true,
    fileName,
    sheets,
    skippedSheets,
    siteRaw: sheets[0]!.siteRaw,
    layoutKey: buildLayoutKey(sheets),
    rows,
    totalCellCount: rows.length,
    shiftCount: codeKindBreakdown.shift,
    codeBreakdown,
    codeKindBreakdown,
    dateRange: dateMin && dateMax ? { min: dateMin, max: dateMax } : null,
    headerDateRange: headerSorted.length ? { min: headerSorted[0]!, max: headerSorted[headerSorted.length - 1]! } : null,
    headerDays: headerSorted.length,
    headerDates: headerSorted,
    subSiteNames: [...subSiteNames],
    mergedExpandedCount: sheets.reduce((sum, s) => sum + s.mergedExpandedCount, 0),
    warnings,
  };
}
