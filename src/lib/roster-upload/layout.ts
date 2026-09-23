// WP-ROSTER-UPLOAD Phase A（§15.3）：表頭定位式 layout 偵測——移植
// `tools/importer/importer/layout.py`（三種排法）＋
// `data/2026-09/aug-payroll-trial/scripts/s02_extract.py` patch 1（日期
// 表頭容許最多 2 欄 gap）、patch 6（冇雞頭碼欄唔准 <1 欄號）。用
// exceljs（唔係 openpyxl），但欄位定位嘅原則一模一樣：全部靠表頭文字
// 定位，唔寫死欄號。
import type { Worksheet } from "exceljs";

export type LayoutName = "standard" | "digital_port" | "citybus";

const STANDARD_OFFSETS = { brokerCode: -5, timeSlot: -4, rank: -3, staffNo: -2, tel: -1 } as const;
const DIGITAL_PORT_OFFSETS = { brokerCode: -6, timeSlot: -5, rank: -4, staffNo: -3, tel: -2, nameEn: -1 } as const;
const CITYBUS_OFFSETS = { brokerCode: -6, timeSlot: -5, rank: -4, subSite: -3, staffNo: -2, tel: -1 } as const;

export const LAYOUT_OFFSETS: Record<LayoutName, Record<string, number>> = {
  standard: STANDARD_OFFSETS,
  digital_port: DIGITAL_PORT_OFFSETS,
  citybus: CITYBUS_OFFSETS,
};

export type FieldName = "brokerCode" | "timeSlot" | "rank" | "staffNo" | "tel" | "nameEn" | "subSite";

export interface ColumnMapping {
  dateRow: number;
  headerRow: number;
  labelCol: number; // == Name 欄，三種排法都一樣
  layout: LayoutName;
  dateStartCol: number;
  dateEndCol: number;
  dateValues: Map<number, Date>; // col -> 嗰格自己嘅真日期
  trailingCols: Array<[number, string]>; // [(col,label), ...]
  // 8 月試算 patch 6：呢個 mapping 嘅 layout 雖然係 standard，但 broker_code
  // offset 計出嚟嘅欄號 <1（例如 Garden East／希慎廣場，Name 喺 E 欄）——
  // 冇雞頭碼欄，用嚟砌 layout_key。
  noBrokerCol: boolean;
  // patch 1：呢個 block 嘅日期表頭同第一個真日期之間隔咗幾多欄（0=貼住，
  // 1/2=中間有額外欄，例如「日薪」）。
  dateHeaderGap: number;
}

export function fieldCol(mapping: ColumnMapping, name: FieldName): number | null {
  const offsets = LAYOUT_OFFSETS[mapping.layout];
  const off = offsets[name];
  if (off === undefined) return null;
  const col = mapping.labelCol + off;
  return col >= 1 ? col : null;
}

function clean(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  // exceljs 公式格：{formula, result} 或 richText 格：{richText:[...]}
  if (typeof value === "object") {
    const v = value as Record<string, unknown>;
    if (v.richText && Array.isArray(v.richText)) {
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

/** 讀格仔原始值。**合併儲存格淨係左上角（master）有值**，其餘被合併嘅格
 * 一律當空——同 python 版 openpyxl `MergedCell.value is None` 行為一致。
 * exceljs 預設會將 master 嘅值「複製」俾每一個被合併嘅格（例如一格 `AL`
 * 橫跨 3 日會變 3 格 AL、一個姓名直跨兩行會變兩行都有名），同 P0／8 月
 * 試算規則唔一致，會靜靜多計更數，所以喺呢度統一截斷（驗收 2026-09-23）。 */
function rawCell(ws: Worksheet, row: number, col: number): unknown {
  const cell = ws.getRow(row).getCell(col);
  if (isMergedSlave(cell)) return null;
  return cell.value;
}

/** 呢格係咪「被合併、唔係左上角」嗰啲格。 */
export function isMergedSlave(cell: { isMerged: boolean; address: string; master: { address: string } }): boolean {
  return cell.isMerged && cell.master.address !== cell.address;
}

function isDateValue(value: unknown): value is Date {
  if (value instanceof Date) return true;
  if (value && typeof value === "object" && "result" in (value as Record<string, unknown>)) {
    return (value as { result: unknown }).result instanceof Date;
  }
  return false;
}

function asDate(value: unknown): Date | null {
  if (value instanceof Date) return value;
  if (value && typeof value === "object" && "result" in (value as Record<string, unknown>)) {
    const r = (value as { result: unknown }).result;
    if (r instanceof Date) return r;
  }
  return null;
}

// patch 1：「Date」表頭之後最多隔幾多格仍然當係同一組日期表頭（CTB 6907／
// 都會大學嘅「日薪」欄，Date 表頭同第一個真日期之間多咗一欄）。
const MAX_DATE_GAP = 2;

function firstDateCol(ws: Worksheet, row: number, startCol: number): { col: number; gap: number } | null {
  for (let off = 1; off <= MAX_DATE_GAP; off++) {
    const v = rawCell(ws, row, startCol + off);
    if (isDateValue(v)) return { col: startCol + off, gap: off - 1 };
  }
  return null;
}

/** 搵成張 sheet 入面每一個 (row,col) 令 col 格仔 === "Date" 而且附近有真
 * 日期（patch 1：容許最多 2 欄 gap）嘅表頭。一行最多算一個。 */
export function findDateHeaders(ws: Worksheet): Array<[number, number]> {
  const headers: Array<[number, number]> = [];
  const maxRow = ws.rowCount;
  const maxCol = ws.columnCount;
  for (let r = 1; r <= maxRow; r++) {
    for (let c = 1; c <= maxCol; c++) {
      const v = clean(rawCell(ws, r, c));
      if (v === "Date") {
        if (firstDateCol(ws, r, c) !== null) headers.push([r, c]);
        break; // 一行最多一個 Date 表頭
      }
    }
  }
  return headers;
}

const CITYBUS_MARKER = "Property Name";

export function detectLayout(ws: Worksheet, headerRow: number, labelCol: number): LayoutName {
  for (let c = 1; c <= labelCol; c++) {
    if (clean(rawCell(ws, headerRow, c)) === CITYBUS_MARKER) return "citybus";
  }
  const left1 = clean(rawCell(ws, headerRow, labelCol - 1));
  const left2 = labelCol - 2 >= 1 ? clean(rawCell(ws, headerRow, labelCol - 2)) : null;
  if (left1 === null && left2 === "Tel") return "digital_port";
  return "standard";
}

export function buildMapping(ws: Worksheet, dateRow: number, labelCol: number): ColumnMapping {
  const found = firstDateCol(ws, dateRow, labelCol);
  const dateStartCol = found?.col ?? labelCol + 1;
  const dateHeaderGap = found?.gap ?? 0;

  const dateValues = new Map<number, Date>();
  let c = dateStartCol;
  while (true) {
    const v = asDate(rawCell(ws, dateRow, c));
    if (v === null) break;
    dateValues.set(c, v);
    c += 1;
  }
  const dateEndCol = dateValues.size ? c - 1 : dateStartCol - 1;

  const headerRow = dateRow + 1;
  const layout = detectLayout(ws, headerRow, labelCol);

  const trailingCols: Array<[number, string]> = [];
  const maxCol = ws.columnCount;
  c = dateEndCol + 1;
  let blankRun = 0;
  let first = true;
  while (c <= maxCol) {
    const labelStr = clean(rawCell(ws, headerRow, c)) ?? "";
    if (first) {
      trailingCols.push([c, labelStr || "月總更數"]);
      first = false;
      blankRun = 0;
      c += 1;
      continue;
    }
    if (labelStr === "") {
      blankRun += 1;
      if (blankRun >= 2) break;
      c += 1;
      continue;
    }
    blankRun = 0;
    trailingCols.push([c, labelStr]);
    c += 1;
  }

  const brokerColOffset = LAYOUT_OFFSETS[layout].brokerCode;
  const noBrokerCol = brokerColOffset === undefined ? false : labelCol + brokerColOffset < 1;

  return {
    dateRow,
    headerRow,
    labelCol,
    layout,
    dateStartCol,
    dateEndCol,
    dateValues,
    trailingCols,
    noBrokerCol,
    dateHeaderGap,
  };
}

export { clean, rawCell };
