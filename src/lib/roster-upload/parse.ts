// WP-ROSTER-UPLOAD Phase A（§15.3）：更表檔案（xlsx）解析器——移植
// `tools/importer/importer/extract.py`（P0 匯入用嘅 python 版）＋
// `data/2026-09/aug-payroll-trial/scripts/s02_extract.py` 7 個 8 月試算
// patch，用 exceljs（package.json 已有）改寫做呢個系統嘅**常駐**功能
// （唔係一次性離線工具）。
//
// 同 P0 importer 唔同嘅地方（刻意簡化，Phase A 唔需要）：
//   - 唔做 Total/所需人手/尚欠 嘅逐日對數（果套喺 P0 WP1 用嚟驗證匯入
//     結果，Phase A「更表 vs 系統已報更」對數留返 Phase B，呢層淨係讀
//     Total/所需人手/尚欠 三種標籤行嚟識別「呢行唔係安員行」，成行跳過，
//     唔生成 roster_upload_rows，亦唔理呢啲行自己嘅日格數值）。
//   - 唔做 HKU Y更姓名 "(上)"/"(摩)" 後綴拆分、external marker 判斷——
//     Phase A schema 冇 location_tag/is_external 呢類欄，呢層留返 Phase B
//     寫 shift_records 嗰陣先需要。
//   - 唔碰 Excel 日期污染格式（`excel_dates.to_number`）——嗰個係
//     Total/尚欠格先會中招，呢層根本唔讀呢啲格嘅數值。
//
// 輸出純結構（呢個檔案零 DB 依賴，`import type {} from "@/lib/db"` 都冇）
// ——盤名/更別/安員/雞頭嘅對照留俾 `src/lib/roster-upload/match.ts`
// （拎住呢度嘅輸出＋DB 查詢結果先做）。
import ExcelJS from "exceljs";
import { buildMapping, findDateHeaders, fieldCol, LAYOUT_OFFSETS, type ColumnMapping, type LayoutName } from "./layout";
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

// 只認可見嘅 `2026` 或 `2026.<月>`（8 月試算 patch 5：恆星樓／葵發大廈嘅
// 工作表叫 `2026.08`）——`相`（相片分頁）、`工作表1`（隱藏舊分頁）呢類
// 一律唔啱呢個 pattern，跳過。
const ROSTER_SHEET_RE = /^2026(\.\d{1,2})?$/;

export interface ParsedCellRow {
  /** 原檔行號（呢個安員行嘅 row number），一個安員行可以有多個 ParsedCellRow（逐日一格）。 */
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

export interface SheetParseWarning {
  row: number;
  reason: string;
}

export interface ParsedSheet {
  sheetName: string;
  siteRaw: string | null;
  layouts: LayoutName[]; // 呢個 sheet 入面出現過嘅 layout（正常一個 sheet 得一種，但唔寫死）
  noBrokerCol: boolean;
  maxDateHeaderGap: number;
  blockCount: number;
  subSiteNames: string[];
  rows: ParsedCellRow[];
  warnings: SheetParseWarning[];
}

export interface ParseSuccess {
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
  subSiteNames: string[];
  warnings: string[];
}

export interface ParseFailure {
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
    const raw = ws.getRow(2).getCell(col).value;
    if (asDate(raw) !== null) continue;
    const v = clean(raw);
    if (v) return v;
  }
  for (let col = 1; col <= 6; col++) {
    const raw = ws.getRow(1).getCell(col).value;
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
    if (clean(ws.getRow(row).getCell(c).value) !== null) return false;
  }
  return true;
}

const IDENTITY_FIELDS = ["brokerCode", "timeSlot", "rank", "staffNo", "tel", "nameEn", "subSite"] as const;

function hasIdentitySignal(ws: ExcelJS.Worksheet, row: number, mapping: ColumnMapping): boolean {
  for (const name of IDENTITY_FIELDS) {
    const col = fieldCol(mapping, name);
    if (col !== null && clean(ws.getRow(row).getCell(col).value) !== null) return true;
  }
  return false;
}

function field(ws: ExcelJS.Worksheet, row: number, mapping: ColumnMapping, name: (typeof IDENTITY_FIELDS)[number]): string | null {
  const col = fieldCol(mapping, name);
  if (col === null) return null;
  return clean(ws.getRow(row).getCell(col).value);
}

function isoDateUTC(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
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
  const subSiteNames = new Set<string>();

  for (let i = 0; i < headers.length; i++) {
    const [dateRow, labelCol] = headers[i]!;
    const mapping = buildMapping(ws, dateRow, labelCol);
    layouts.add(mapping.layout);
    if (mapping.noBrokerCol) noBrokerCol = true;
    if (mapping.dateHeaderGap > maxGap) maxGap = mapping.dateHeaderGap;

    const startRow = mapping.headerRow + 1;
    const endRow = i + 1 < headers.length ? headers[i + 1]![0] - 1 : ws.rowCount;

    for (let r = startRow; r <= endRow; r++) {
      if (isRowBlank(ws, r, mapping)) continue;

      const labelVal = clean(ws.getRow(r).getCell(mapping.labelCol).value);
      if (labelVal && STAT_ROW_LABELS.has(labelVal)) continue; // Total/所需人手/尚欠/早加夜——唔係安員行

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
      const nameRaw = clean(ws.getRow(r).getCell(mapping.labelCol).value);

      if (subSite) subSiteNames.add(subSite);

      if (nameRaw === null) {
        warnings.push({ row: r, reason: "安員行冇姓名（Name 欄空白）但呢行有其他欄有值，懷疑 block 邊界判斷錯咗" });
        continue;
      }

      for (let col = mapping.dateStartCol; col <= mapping.dateEndCol; col++) {
        const rawCode = clean(ws.getRow(r).getCell(col).value);
        if (rawCode === null) continue;
        const dateObj = mapping.dateValues.get(col);
        if (!dateObj) continue;
        const codeKind = classifyCode(rawCode);
        const rowWarnings: string[] = [];
        if (codeKind === "unknown") {
          rowWarnings.push(`格仔代號「${rawCode}」未喺對照表出現，人手覆核`);
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
      }
    }
  }

  return {
    sheetName,
    siteRaw,
    layouts: [...layouts],
    noBrokerCol,
    maxDateHeaderGap: maxGap,
    blockCount: headers.length,
    subSiteNames: [...subSiteNames],
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
export async function parseRosterWorkbook(buffer: Buffer | ArrayBuffer, fileName: string): Promise<ParseResult> {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer as ExcelJS.Buffer);
  } catch (err) {
    return { ok: false, fileName, error: `壞檔，讀唔到 xlsx：${err instanceof Error ? err.message : String(err)}`, skippedSheets: [] };
  }

  const skippedSheets: Array<{ name: string; reason: string }> = [];
  const matchedSheets: ExcelJS.Worksheet[] = [];
  for (const ws of workbook.worksheets) {
    if (ws.state !== "visible") {
      skippedSheets.push({ name: ws.name, reason: `分頁狀態=${ws.state}（隱藏），跳過` });
      continue;
    }
    if (!ROSTER_SHEET_RE.test(ws.name.trim())) {
      skippedSheets.push({ name: ws.name, reason: "分頁名唔係「2026」或「2026.<月>」，當非更表分頁跳過" });
      continue;
    }
    matchedSheets.push(ws);
  }

  if (!matchedSheets.length) {
    return { ok: false, fileName, error: "搵唔到可見嘅「2026」或「2026.<月>」更表工作表", skippedSheets };
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
  for (const s of sheets) {
    for (const w of s.warnings) warnings.push(`[${s.sheetName}] row ${w.row}：${w.reason}`);
  }
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
    subSiteNames: [...subSiteNames],
    warnings,
  };
}
