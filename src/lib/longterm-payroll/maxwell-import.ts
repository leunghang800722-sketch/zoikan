// WP-LTPAY Phase 2（老闆 2026-09-26 指令；§20.4 Phase 2「Maxwell 名單」）：
// Maxwell 長工名單（`Maxwell All Staff List (Front Line).xlsx`）解析器——
// **零 DB 依賴**純函數，跟 `src/lib/roster-upload/parse.ts` 一致嘅分工
// 手法（parse 純函數 → match/service 先掂 DB）。欄位對應抄自 8 月試算
// `data/2026-09/aug-payroll-trial/scripts/s04_longterm.py`（S04 段），
// 逐欄寫死同一個 column index——Maxwell 呢份表冇表頭同義字問題（老闆
// 每月覆蓋同一份範本），唔需要 roster-upload 嗰種「逐盤 layout 偵測」。
//
// 兩個分頁：「在職名單」（status=active）／「離職名單」（status=left）。
// 表頭喺第 2 行，資料由第 3 行開始。
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { parse as parseCsvSync } from "csv-parse/sync";

export interface MaxwellStaffRow {
  sheetRow: number;
  status: "active" | "left";
  staffNo: string | null; // MG 號（col 3）
  nameEn: string | null; // col 4
  name: string | null; // col 5（中文姓名）
  site: string | null; // col 2
  dob: string | null; // col 7，ISO date
  age: number | null; // col 8
  tel: string | null; // col 11
  position: string | null; // col 14
  commencement: string | null; // col 18，Commencement Date
  contractEnd: string | null; // col 19
  /** Probation Period (Months)——原文可以係 1／3／"No"，`null`＝冇試用期或空白。 */
  probationMonths: number | null;
  workingHour: number | null; // col 22
  basic: number | null; // col 23，Monthly Salary
  newBasic: number | null; // col 24
  newBasicEff: string | null; // col 25
  perfAllow: number | null; // col 26
  restDay: string | null; // col 27，"Yes"／"No"
  statHoliday: string | null; // col 28
  annualLeave: number | null; // col 29，Entitle Annual Leave（日／年）
  /** 掃全行表頭搵「MPF」+「Enrol」嗰欄。 */
  mpfEnroll: string | null;
  /** 掃全行表頭搵「Last」／「離職」／「Resign」／「Termination」嗰欄
   * （離職名單先有意義；在職名單通常搵唔到，留 null）。 */
  lastDay: string | null;
}

export interface ParsedMaxwellWorkbook {
  rows: MaxwellStaffRow[];
  warnings: string[];
}

const COL = {
  site: 2,
  staffNo: 3,
  nameEn: 4,
  name: 5,
  dob: 7,
  age: 8,
  tel: 11,
  position: 14,
  commencement: 18,
  contractEnd: 19,
  probationMonths: 20,
  workingHour: 22,
  basic: 23,
  newBasic: 24,
  newBasicEff: 25,
  perfAllow: 26,
  restDay: 27,
  statHoliday: 28,
  annualLeave: 29,
} as const;

const SHEETS: Array<{ name: string; status: "active" | "left" }> = [
  { name: "在職名單", status: "active" },
  { name: "離職名單", status: "left" },
];

/** 公式結果可以係 Invalid Date（例如 #VALUE! 嘅日期公式）——真 Maxwell 檔
 * 就有，原本 `toISOString()` 直接拋 RangeError 令成個導入 500（Opus 5.5 驗收）。 */
function isoOrNull(d: Date): string | null {
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function cellText(cell: ExcelJS.Cell | undefined): string | null {
  if (!cell) return null;
  const v = cell.value;
  if (v === null || v === undefined) return null;
  if (typeof v === "object") {
    const obj = v as unknown as Record<string, unknown>;
    if (Array.isArray((obj as { richText?: unknown }).richText)) {
      const text = (obj.richText as Array<{ text?: string }>).map((t) => t.text ?? "").join("");
      return text.trim() || null;
    }
    if ("result" in obj) {
      const r = (obj as { result: unknown }).result;
      if (r instanceof Date) return isoOrNull(r);
      if (r === null || r === undefined) return null;
      return String(r).trim() || null;
    }
    if (v instanceof Date) return isoOrNull(v);
    return null;
  }
  const s = String(v).trim();
  return s === "" ? null : s;
}

function cellDate(cell: ExcelJS.Cell | undefined): string | null {
  if (!cell) return null;
  const v = cell.value;
  if (v instanceof Date) return isoOrNull(v);
  if (v && typeof v === "object" && "result" in (v as unknown as Record<string, unknown>)) {
    const r = (v as { result: unknown }).result;
    if (r instanceof Date) return isoOrNull(r);
  }
  const t = cellText(cell);
  if (t && /^\d{4}-\d{2}-\d{2}/.test(t)) return t.slice(0, 10);
  return null;
}

function cellNum(cell: ExcelJS.Cell | undefined): number | null {
  if (!cell) return null;
  const v = cell.value;
  if (typeof v === "number") return v;
  if (v && typeof v === "object" && "result" in (v as unknown as Record<string, unknown>)) {
    const r = (v as { result: unknown }).result;
    if (typeof r === "number") return r;
  }
  return null;
}

/** Probation Period 欄可以係 1／3／"No"／空白——正規化做 number|null
 * （"No"／空白／0 → null＝冇試用期，跟 compute.ts 嘅 `probationMonths:
 * null` 約定一致）。 */
function normalizeProbation(raw: string | null): number | null {
  if (!raw) return null;
  const t = raw.trim();
  if (/^no$/i.test(t) || t === "0") return null;
  const n = Number(t);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Opus 5.5 驗收（2026-09-27）：真實 Maxwell 名單有覆蓋成條欄嘅 data
 * validation（下拉選單），ExcelJS 載入時逐格展開，直接拋 `RangeError: Too
 * many properties to enumerate`——即係真檔案**一上載就 500**（單元測試用
 * 合成 workbook 冇 validation，所以冇揪到）。解析淨係讀儲存格值，validation
 * 冇用，載入前喺 zip 入面剷走 `<dataValidations>`／`<x14:dataValidations>`。 */
async function stripDataValidations(buffer: Buffer): Promise<Buffer> {
  const zip = await JSZip.loadAsync(buffer);
  let touched = false;
  for (const name of Object.keys(zip.files)) {
    if (!/^xl\/worksheets\/[^/]+\.xml$/.test(name)) continue;
    const xml = await zip.file(name)!.async("string");
    const stripped = xml.replace(/<dataValidations\b[\s\S]*?<\/dataValidations>/g, "").replace(/<x14:dataValidations\b[\s\S]*?<\/x14:dataValidations>/g, "");
    if (stripped !== xml) {
      zip.file(name, stripped);
      touched = true;
    }
  }
  return touched ? Buffer.from(await zip.generateAsync({ type: "nodebuffer" })) : buffer;
}

export async function parseMaxwellWorkbook(buffer: Buffer): Promise<ParsedMaxwellWorkbook> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load((await stripDataValidations(buffer)) as unknown as ArrayBuffer);
  const warnings: string[] = [];
  const rows: MaxwellStaffRow[] = [];

  for (const { name, status } of SHEETS) {
    const ws = workbook.getWorksheet(name);
    if (!ws) {
      warnings.push(`搵唔到分頁「${name}」——呢個 workbook 可能唔係 Maxwell 標準範本，跳過`);
      continue;
    }
    // 表頭喺第 2 行——掃一次搵 MPF Enrollment／離職日期欄。
    let mpfEnrollCol: number | null = null;
    let lastDayCol: number | null = null;
    const headerRow = ws.getRow(2);
    headerRow.eachCell({ includeEmpty: false }, (cell, colNumber) => {
      const label = cellText(cell) ?? "";
      if (/mpf/i.test(label) && /enrol/i.test(label)) mpfEnrollCol = colNumber;
      if (/last|離職|resign|termination/i.test(label)) lastDayCol = lastDayCol ?? colNumber;
    });

    const maxRow = ws.rowCount;
    for (let r = 3; r <= maxRow; r++) {
      const row = ws.getRow(r);
      const staffNo = cellText(row.getCell(COL.staffNo));
      const name5 = cellText(row.getCell(COL.name));
      if (!staffNo && !name5) continue; // 空行

      rows.push({
        sheetRow: r,
        status,
        staffNo,
        nameEn: cellText(row.getCell(COL.nameEn)),
        name: name5,
        site: cellText(row.getCell(COL.site)),
        dob: cellDate(row.getCell(COL.dob)),
        age: cellNum(row.getCell(COL.age)),
        tel: cellText(row.getCell(COL.tel)),
        position: cellText(row.getCell(COL.position)),
        commencement: cellDate(row.getCell(COL.commencement)),
        contractEnd: cellDate(row.getCell(COL.contractEnd)),
        probationMonths: normalizeProbation(cellText(row.getCell(COL.probationMonths))),
        workingHour: cellNum(row.getCell(COL.workingHour)),
        basic: cellNum(row.getCell(COL.basic)),
        newBasic: cellNum(row.getCell(COL.newBasic)),
        newBasicEff: cellDate(row.getCell(COL.newBasicEff)),
        perfAllow: cellNum(row.getCell(COL.perfAllow)),
        restDay: cellText(row.getCell(COL.restDay)),
        statHoliday: cellText(row.getCell(COL.statHoliday)),
        annualLeave: cellNum(row.getCell(COL.annualLeave)),
        mpfEnroll: mpfEnrollCol ? cellDate(row.getCell(mpfEnrollCol)) : null,
        lastDay: lastDayCol ? cellDate(row.getCell(lastDayCol)) : null,
      });
    }
  }

  if (!rows.length) warnings.push("兩個分頁都冇解析到任何長工行——請確認上載嘅檔案同 Maxwell 範本格式一致");
  return { rows, warnings };
}

// ---------------------------------------------------------------------------
// CSV 路徑（Opus 5.5 驗收 2026-09-27 加）：正式站操作員淨係可以上載 CSV
// ——Maxwell「在職名單」／「離職名單」兩個分頁各自喺 Excel「另存新檔 →
// CSV UTF-8」，一次過上載兩個檔。欄位位置同 xlsx 完全一樣（第 2 行表頭、
// 第 3 行起資料；CSV 第 N 欄＝xlsx 第 N 欄），所以同一套 COL 對應。CSV
// 入面嘅係「顯示格式」文字，要逆返：
//   - 日期：`2026-08-01`、`1/8/2026`（香港 d/m/yyyy，Maxwell 範本自訂格式
//     `d/m/yyyy`）、`01-Aug-2026`（範本 `dd-mmm-yyyy`）；斜線日期如果成個
//     檔有任何一格「第二段 >12」就當成個檔係 m/d（美式區域設定匯出），
//     否則一律 d/m，並且兩段都 ≤12 嘅會出 warning 提醒覆核。
//   - 金額：`$15,000`／`15,000.00`／`(100)`（負數）。
// ---------------------------------------------------------------------------
export interface MaxwellCsvFile {
  status: "active" | "left";
  text: string;
}

const MONTH_ABBR: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const DATE_COLS = [COL.dob, COL.commencement, COL.contractEnd, COL.newBasicEff];

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}
function validYmd(y: number, m: number, d: number): string | null {
  if (!(y >= 1900 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1) return null;
  return `${y}-${pad2(m)}-${pad2(d)}`;
}
function expandYear(y: number): number {
  return y < 100 ? 2000 + y - (y > 50 ? 100 : 0) : y;
}

/** 解析 CSV 日期文字；`slashOrder` 由成個檔一齊決定（見上面）。 */
export function parseCsvDate(raw: string | null, slashOrder: "dmy" | "mdy"): string | null {
  if (!raw) return null;
  const t = raw.trim();
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(t);
  if (m) return validYmd(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /^(\d{1,2})[-\s]([A-Za-z]{3})[A-Za-z]*[-\s,]+(\d{2,4})$/.exec(t);
  if (m && MONTH_ABBR[m[2].toLowerCase()]) return validYmd(expandYear(Number(m[3])), MONTH_ABBR[m[2].toLowerCase()], Number(m[1]));
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(t);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const y = expandYear(Number(m[3]));
    return slashOrder === "dmy" ? validYmd(y, b, a) : validYmd(y, a, b);
  }
  return null;
}

/** 解析 CSV 金額／數字文字（`$15,000`、`15,000.00`、`(100)`、`12`）。 */
export function parseCsvNumber(raw: string | null): number | null {
  if (!raw) return null;
  let t = raw.trim().replace(/[$,\s]/g, "").replace(/^HK\$?/i, "");
  let neg = false;
  const paren = /^\((.*)\)$/.exec(t);
  if (paren) {
    neg = true;
    t = paren[1];
  }
  if (t.startsWith("-")) {
    neg = !neg;
    t = t.slice(1);
  }
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  const n = Number(t);
  return neg ? -n : n;
}

function csvCell(row: string[], col: number): string | null {
  const v = row[col - 1];
  if (v === undefined || v === null) return null;
  const t = String(v).trim();
  return t === "" ? null : t;
}

export function parseMaxwellCsv(files: MaxwellCsvFile[]): ParsedMaxwellWorkbook {
  const warnings: string[] = [];
  const rows: MaxwellStaffRow[] = [];
  const grids = files.map((f) => {
    const text = f.text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
    const grid = parseCsvSync(text, { relax_column_count: true, skip_empty_lines: false }) as string[][];
    return { status: f.status, grid };
  });

  // 成批檔一齊決定斜線日期次序（見檔頭）。
  let sawMonthFirst = false;
  let sawDayFirst = false;
  const ambiguous = new Set<string>();
  for (const { grid } of grids) {
    const header = grid[1] ?? [];
    const extraDateCols = header.map((h, i) => ({ h: String(h ?? ""), col: i + 1 })).filter(({ h }) => (/mpf/i.test(h) && /enrol/i.test(h)) || /last|離職|resign|termination/i.test(h)).map(({ col }) => col);
    for (const r of grid.slice(2)) {
      for (const col of [...DATE_COLS, ...extraDateCols]) {
        const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(csvCell(r, col) ?? "");
        if (!m) continue;
        if (Number(m[1]) > 12) sawDayFirst = true;
        else if (Number(m[2]) > 12) sawMonthFirst = true;
        else if (m[1] !== m[2]) ambiguous.add(m[0]);
      }
    }
  }
  if (sawMonthFirst && sawDayFirst) warnings.push("CSV 入面斜線日期有「日/月」亦有「月/日」兩種寫法——請用 Excel 將日期欄改做 yyyy-mm-dd 格式再匯出，唔好估");
  const slashOrder: "dmy" | "mdy" = sawMonthFirst && !sawDayFirst ? "mdy" : "dmy";
  if (ambiguous.size && !sawMonthFirst && !sawDayFirst) {
    warnings.push(`CSV 斜線日期全部兩段都 ≤12（例如 ${[...ambiguous].slice(0, 3).join("、")}），分唔到日/月定月/日——已按香港 d/m/yyyy 讀，導入後請喺合約表覆核入職日；最穩陣係匯出前將日期欄改做 yyyy-mm-dd`);
  }

  for (const { status, grid } of grids) {
    const header = grid[1] ?? [];
    let mpfEnrollCol: number | null = null;
    let lastDayCol: number | null = null;
    header.forEach((h, i) => {
      const label = String(h ?? "");
      if (/mpf/i.test(label) && /enrol/i.test(label)) mpfEnrollCol = i + 1;
      if (/last|離職|resign|termination/i.test(label)) lastDayCol = lastDayCol ?? i + 1;
    });
    if (!header.some((h) => String(h ?? "").trim())) warnings.push(`${status === "active" ? "在職名單" : "離職名單"} CSV 第 2 行冇表頭——請確認係由 Maxwell 範本直接匯出（第 1 行標題、第 2 行表頭）`);
    for (let i = 2; i < grid.length; i++) {
      const r = grid[i];
      const staffNo = csvCell(r, COL.staffNo);
      const name5 = csvCell(r, COL.name);
      if (!staffNo && !name5) continue;
      const d = (col: number) => parseCsvDate(csvCell(r, col), slashOrder);
      rows.push({
        sheetRow: i + 1,
        status,
        staffNo,
        nameEn: csvCell(r, COL.nameEn),
        name: name5,
        site: csvCell(r, COL.site),
        dob: d(COL.dob),
        age: parseCsvNumber(csvCell(r, COL.age)),
        tel: csvCell(r, COL.tel),
        position: csvCell(r, COL.position),
        commencement: d(COL.commencement),
        contractEnd: d(COL.contractEnd),
        probationMonths: normalizeProbation(csvCell(r, COL.probationMonths)),
        workingHour: parseCsvNumber(csvCell(r, COL.workingHour)),
        basic: parseCsvNumber(csvCell(r, COL.basic)),
        newBasic: parseCsvNumber(csvCell(r, COL.newBasic)),
        newBasicEff: d(COL.newBasicEff),
        perfAllow: parseCsvNumber(csvCell(r, COL.perfAllow)),
        restDay: csvCell(r, COL.restDay),
        statHoliday: csvCell(r, COL.statHoliday),
        annualLeave: parseCsvNumber(csvCell(r, COL.annualLeave)),
        mpfEnroll: mpfEnrollCol ? d(mpfEnrollCol) : null,
        lastDay: lastDayCol ? d(lastDayCol) : null,
      });
    }
  }
  if (!rows.length) warnings.push("CSV 冇解析到任何長工行——請確認係 Maxwell「在職名單」／「離職名單」分頁匯出嘅 CSV");
  return { rows, warnings };
}

// ---------------------------------------------------------------------------
// 配對：Maxwell 行 → 系統內長工（用姓名＋MG／U 號）。純函數，用 caller
// 預先查好嘅 in-memory 候選名單（同 roster-upload/match.ts 一致手法，
// 唔逐行 await DB）。
// ---------------------------------------------------------------------------
export interface GuardCandidate {
  guardId: string;
  nameZh: string;
  staffNoMw: string | null; // MG 號
  staffNo: string | null; // U 號
}

type MaxwellMatchStatus = "matched_staff_no" | "matched_name" | "unmatched";

export interface MaxwellMatchResult {
  row: MaxwellStaffRow;
  guardId: string | null;
  status: MaxwellMatchStatus;
}

/** 逐行配對：① MG 員工編號完全一致（最可靠——員工編號表 unique，唔會
 * 重用）；② 冇 staff_no 或搵唔到就試中文姓名完全一致（唯一先算配到，
 * 撞名就當搵唔到，交俾人手覆核，寧缺莫錯）。 */
export function matchMaxwellRows(rows: MaxwellStaffRow[], candidates: GuardCandidate[]): MaxwellMatchResult[] {
  const byStaffNoMw = new Map<string, GuardCandidate>();
  const byName = new Map<string, GuardCandidate[]>();
  for (const c of candidates) {
    if (c.staffNoMw) byStaffNoMw.set(c.staffNoMw, c);
    const key = c.nameZh.replace(/\s+/g, "");
    byName.set(key, [...(byName.get(key) ?? []), c]);
  }

  return rows.map((row) => {
    if (row.staffNo) {
      const hit = byStaffNoMw.get(row.staffNo);
      if (hit) return { row, guardId: hit.guardId, status: "matched_staff_no" };
    }
    const nameKey = (row.name ?? "").replace(/\s+/g, "");
    if (nameKey) {
      const nameHits = byName.get(nameKey);
      if (nameHits && nameHits.length === 1) return { row, guardId: nameHits[0].guardId, status: "matched_name" };
    }
    return { row, guardId: null, status: "unmatched" };
  });
}
