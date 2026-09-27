// WP-POSTORDER-CSV（老闆 2026-09-26 緊急）：正式站操作員工具處理唔到
// binary（.xlsm／.xlsx），淨係可以用 Google Sheets「下載為 CSV」。呢個
// 測試檔驗證 `src/lib/guard-fix/postorder.ts` 嘅 CSV grid 解析路徑同
// xlsm 路徑「格位置邏輯一致」——由同一份合成 workbook（同
// `tests/wp-ltshift-postorder-parse.test.ts` 一樣嘅 fixture）分別行
// xlsm 路徑（`parsePostorderLongtermPostsFromWorkbook`／
// `parsePostorderReferralRowsFromWorkbook`）同「模擬 Google Sheets 匯出
// CSV」路徑（先將 workbook 逐格讀成值，stringify 做 CSV，模擬 Sheets
// 「下載為 CSV」嘅輸出，再行 `parsePostorderLongtermPostsFromCsvGrid`／
// `parsePostorderReferralRowsFromCsvGrid`），兩邊結果逐項比對。
//
// 鐵則：test 唔准帶真名——合成 fixture 用假人名，同現有
// `wp-ltshift-postorder-parse.test.ts` 一致手法。用真檔
// `data/2026-09/msg-file/Postorder - Aug 2026.xlsm`（`data/` gitignored、
// 唔入 git）嗰個 it() 用 `it.skipIf(!fs.existsSync(...))`——冇呢個檔嘅
// 環境（例如 CI、其他人 clone 呢個 repo）會自動 skip，唔會紅。
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";
import {
  parsePostorderLongtermPostsFromWorkbook,
  parsePostorderReferralRowsFromWorkbook,
  parsePostorderLongtermPostsFromCsvGrid,
  parsePostorderReferralRowsFromCsvGrid,
  parsePostorderFromCsv,
} from "@/lib/guard-fix/postorder";

// ---------------------------------------------------------------------------
// 「模擬 Google Sheets 下載為 CSV」——逐格讀值（richText/Date/formula
// result 攤平做純文字，同 postorder.ts 內部 `valueToText()` 一致做法），
// RFC4180 quote（逗號/引號/換行先 quote，引號 double 埋）。
// ---------------------------------------------------------------------------
function cellPlainValue(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") {
    if ("richText" in (v as Record<string, unknown>)) {
      return (v as { richText: Array<{ text?: string }> }).richText.map((t) => t.text ?? "").join("");
    }
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    if ("result" in (v as Record<string, unknown>)) {
      return cellPlainValue((v as { result: unknown }).result);
    }
    return "";
  }
  return String(v);
}

function csvEscape(s: string): string {
  if (s === "") return "";
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function worksheetToSimulatedCsv(ws: ExcelJS.Worksheet, maxCol: number): string {
  const lines: string[] = [];
  for (let r = 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const cells: string[] = [];
    for (let c = 1; c <= maxCol; c++) cells.push(csvEscape(cellPlainValue(row.getCell(c).value)));
    lines.push(cells.join(","));
  }
  return lines.join("\r\n");
}

function buildRosterSheet(wb: ExcelJS.Workbook) {
  const ws = wb.addWorksheet("Roster");
  // WP-POSTORDER-ROBUST：表頭由「客戶名稱」／「物業名稱」／「雞頭名」
  // 字眼自己搵，fixture 要帶齊（同真樣本一致，逐日 block 由「雞頭名」
  // 子欄起，「備註」隔籬）。
  ws.getRow(7).values = ["客戶名稱", "Customer Code", "物業名稱", "更份", "上單價", "外判價", "時間", "1-8月", "雞頭名", "備註", "其他", "救更價", "Unbilled", "Paid", "2-8月", "雞頭名", "備註", "其他", "救更價", "Unbilled", "Paid", "3-8月", "雞頭名", "備註"];
  ws.getCell("A9").value = "測試盤 甲蟲蟲";
  ws.getCell("C9").value = "測試";
  ws.getCell("I9").value = "(8) 長工";
  ws.getCell("J9").value = "甲蟲蟲";
  ws.getCell("P9").value = "(8) 長工";
  ws.getCell("Q9").value = "甲蟲蟲";
  ws.getCell("W9").value = "(2) 淦";
  ws.getCell("X9").value = "乙屎蟲";
  ws.getCell("A10").value = "另一盤 乙屎蟲";
  ws.getCell("C10").value = "另一";
  ws.getCell("I10").value = "(8) 長工";
  ws.getCell("J10").value = "乙屎蟲";
  // 帶逗號／引號嘅備註，驗證 CSV quote/escape 唔會撞散格位置。
  ws.getCell("A11").value = "第三盤, 有逗號 丙金蟲";
  ws.getCell("C11").value = "第三";
  ws.getCell("I11").value = "(8) 長工";
  ws.getCell("J11").value = "丙金蟲";
  return ws;
}

function buildPostOrderSheet(wb: ExcelJS.Workbook) {
  const ws = wb.addWorksheet("PostOrder");
  ws.getRow(7).values = ["客戶名稱", "Customer Code", "物業名稱", "更份", "上單價", "外判價", "時間"];
  ws.getCell("A8").value = "測試盤 甲蟲蟲";
  ws.getCell("C8").value = "測試";
  ws.getCell(8, 39).value = 20;
  ws.getCell("A9").value = "測試盤 丙金蟲";
  ws.getCell("C9").value = "測試";
  ws.getCell(9, 39).value = 5;
  ws.getCell("A10").value = "長工雞頭費 (淦)";
  ws.getCell("C10").value = "淦";
  ws.getCell("F10").value = { formula: "50*SUM(AM8,AM9)", result: 1250 };
  return ws;
}

const ROSTER_MAX_COL = 240;
const POSTORDER_MAX_COL = 60;

describe("WP-POSTORDER-CSV：CSV grid 路徑 vs xlsm 路徑（合成 workbook）", () => {
  it("parsePostorderLongtermPostsFromCsvGrid：長工格解析同 xlsm 路徑逐項相等（冇公式依賴）", () => {
    const wb = new ExcelJS.Workbook();
    const ws = buildRosterSheet(wb);
    const fromWorkbook = parsePostorderLongtermPostsFromWorkbook(wb);
    const csvText = worksheetToSimulatedCsv(ws, ROSTER_MAX_COL);
    const fromCsv = parsePostorderLongtermPostsFromCsvGrid(csvText);

    const sortKey = (p: { siteLabelRaw: string; guardNameRaw: string }) => `${p.siteLabelRaw}\u0000${p.guardNameRaw}`;
    const sortedWb = [...fromWorkbook].sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
    const sortedCsv = [...fromCsv].sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
    expect(sortedCsv).toEqual(sortedWb);
    expect(fromCsv).toHaveLength(3); // 甲蟲蟲/乙屎蟲/丙金蟲
  });

  it("parsePostorderReferralRowsFromCsvGrid：brokerLabelRaw／excelAmount／rowIndex 相等，rate／shifts／sites／names 因冇公式老實答 null／空（唔估）", () => {
    const wb = new ExcelJS.Workbook();
    const ws = buildPostOrderSheet(wb);
    const fromWorkbook = parsePostorderReferralRowsFromWorkbook(wb);
    const csvText = worksheetToSimulatedCsv(ws, POSTORDER_MAX_COL);
    const fromCsv = parsePostorderReferralRowsFromCsvGrid(csvText);

    expect(fromWorkbook).toHaveLength(1);
    expect(fromCsv).toHaveLength(1);
    const wbRow = fromWorkbook[0];
    const csvRow = fromCsv[0];

    // 呢幾樣兩條路徑都攞得到（唔靠公式）。
    expect(csvRow.rowIndex).toBe(wbRow.rowIndex);
    expect(csvRow.brokerLabelRaw).toBe(wbRow.brokerLabelRaw);
    expect(csvRow.excelAmount).toBe(wbRow.excelAmount);

    // xlsm 路徑由公式推返 rate/shifts/sites/names。
    expect(wbRow.rate).toBe(50);
    expect(wbRow.shifts).toBe(25);
    expect(wbRow.siteLabelsRaw).toEqual(["測試盤"]);
    expect(wbRow.guardNamesRaw.sort()).toEqual(["丙金蟲", "甲蟲蟲"]);

    // CSV 路徑冇公式文字，呢幾樣冧唔返，老實答 null／空（唔估）——見
    // postorder.ts 檔頭註解。
    expect(csvRow.rate).toBeNull();
    expect(csvRow.shifts).toBe(0);
    expect(csvRow.siteLabelsRaw).toEqual([]);
    expect(csvRow.siteLabelsFallbackRaw).toEqual([]);
    expect(csvRow.guardNamesRaw).toEqual([]);
    expect(csvRow.formula).toBeNull();
  });
});

const REAL_POSTORDER_FILE = path.resolve(__dirname, "../data/2026-09/msg-file/Postorder - Aug 2026.xlsm");
const hasRealFile = fs.existsSync(REAL_POSTORDER_FILE);

describe.skipIf(!hasRealFile)("WP-POSTORDER-CSV：CSV grid 路徑 vs xlsm 路徑（真檔 Postorder - Aug 2026.xlsm，data/ gitignored，冇呢個檔嘅環境自動 skip）", () => {
  it("Roster：模擬 CSV 匯出嘅長工格解析同 xlsm 路徑逐項相等", async () => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(REAL_POSTORDER_FILE);
    const ws = wb.getWorksheet("Roster");
    expect(ws).toBeTruthy();
    if (!ws) return;

    const fromWorkbook = parsePostorderLongtermPostsFromWorkbook(wb);
    const csvText = worksheetToSimulatedCsv(ws, Math.max(ws.columnCount, ROSTER_MAX_COL));
    const fromCsv = parsePostorderLongtermPostsFromCsvGrid(csvText);

    const cellCount = (rows: typeof fromWorkbook) => rows.reduce((acc, p) => acc + p.cellCount, 0);
    const pairKey = (p: { siteLabelRaw: string; guardNameRaw: string }) => `${p.siteLabelRaw}\u0000${p.guardNameRaw}`;
    const sortedWb = [...fromWorkbook].sort((a, b) => pairKey(a).localeCompare(pairKey(b)));
    const sortedCsv = [...fromCsv].sort((a, b) => pairKey(a).localeCompare(pairKey(b)));

    // 逐項相等（(盤,人) 組合、每組合格數）——唔硬編碼老闆講嘅「1,295／56」
    // 呢類數字（會隨總表版本飄，淨係要求兩條路徑自己夾得埋）。
    expect(sortedCsv).toEqual(sortedWb);
    expect(cellCount(fromCsv)).toBe(cellCount(fromWorkbook));
    console.log(`[wp-postorder-csv] Roster 長工格：${fromWorkbook.length} 組合、${cellCount(fromWorkbook)} 格（xlsm／CSV 兩條路徑一致）`);
  });

  it("PostOrder：模擬 CSV 匯出嘅介紹費行 brokerLabelRaw／excelAmount／rowIndex 同 xlsm 路徑逐項相等", async () => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(REAL_POSTORDER_FILE);
    const ws = wb.getWorksheet("PostOrder");
    expect(ws).toBeTruthy();
    if (!ws) return;

    const fromWorkbook = parsePostorderReferralRowsFromWorkbook(wb);
    const csvText = worksheetToSimulatedCsv(ws, Math.max(ws.columnCount, POSTORDER_MAX_COL));
    const fromCsv = parsePostorderReferralRowsFromCsvGrid(csvText);

    expect(fromCsv).toHaveLength(fromWorkbook.length);
    const byRow = new Map(fromCsv.map((r) => [r.rowIndex, r]));
    for (const wbRow of fromWorkbook) {
      const csvRow = byRow.get(wbRow.rowIndex);
      expect(csvRow, `row ${wbRow.rowIndex} 喺 CSV 路徑搵唔到`).toBeTruthy();
      expect(csvRow?.brokerLabelRaw).toBe(wbRow.brokerLabelRaw);
      expect(csvRow?.excelAmount).toBe(wbRow.excelAmount);
      // CSV 路徑冇公式，rate 一律 null（唔估）——同單元測試一致行為。
      expect(csvRow?.rate).toBeNull();
    }
    const totalExcelAmount = fromWorkbook.reduce((acc, r) => acc + (r.excelAmount ?? 0), 0);
    console.log(`[wp-postorder-csv] PostOrder 介紹費行：${fromWorkbook.length} 行，excelAmount 合計 $${totalExcelAmount}（xlsm／CSV 兩條路徑 brokerLabelRaw／excelAmount 一致）`);
  });
});

// ---------------------------------------------------------------------------
// WP-POSTORDER-ROBUST（老闆 2026-09-27 緊急）：操作員貼咗嘅真實 Google
// Sheets「下載為 CSV」樣本——表頭實際喺第 8 行（第 1 行合併日期大標題、
// 第 7 行 Total 行帶引號千分位數字），同埋 236 個「物業名稱」／「客戶
// 名稱」欄好可能係垂直合併儲存格，CSV 匯出淨係最頂一格有值。呢個
// describe 直接由呢個真實形狀砌 CSV 文字（唔靠 worksheetToSimulatedCsv
// 個 helper），驗證 §19 舊版「表頭硬編碼第 7 行、資料硬編碼第 8 行起」
// 解析器對真樣本會漏晒（merged blank cells 令 `!prop` continue 跳晒），
// 而新版表頭自動偵測＋物業/客戶名稱向下補值（forward-fill）解得返。
// ---------------------------------------------------------------------------
const BOM = "﻿";

function csvEscapeRaw(s: string): string {
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function rowsToCsv(rows: string[][], opts?: { bom?: boolean; eol?: string }): string {
  const eol = opts?.eol ?? "\r\n";
  const text = rows.map((r) => r.map(csvEscapeRaw).join(",")).join(eol);
  return (opts?.bom ?? true) ? BOM + text : text;
}

/** 真實樣本形狀：第 1 行合併日期大標題（欄數少過表頭）、第 2-6 行雜項、
 * 第 7 行 Total（引號千分位數字）、第 8 行先係表頭、第 9 行起先係資料
 * ——「數碼港 XX」呢個長工格喺第 10 行，第 9 行係冇雞頭資料嘅 section
 * header（同真實 `Postorder - Aug 2026.xlsm` 個 pattern 一致）。 */
function realShapedRosterRows(opts?: { longtermMarker?: string; mergeBlankPropClient?: boolean }): string[][] {
  const marker = opts?.longtermMarker ?? "(8) 長工";
  const mergeBlank = opts?.mergeBlankPropClient ?? false;
  const header = [
    "客戶名稱", "Customer Code", "物業名稱", "更份", "上單價", "外判價", "時間",
    "1-8月", "雞頭名", "備註", "其他", "救更價", "Unbilled (Y=1 /N = 0 )", "Paid (Y=1 /N = 0 )",
    "2-8月", "雞頭名", "備註", "其他", "救更價", "Unbilled (Y=1 /N = 0 )", "Paid (Y=1 /N = 0 )",
  ];
  return [
    ["", "", "", "", "", "", "", "1-8月", "", "", "", "", "", "", "2-8月"], // row1：合併日期大標題，欄數少過表頭
    ["週六", "", "", "", "", "", "", "", "", "", "", "", "", "", "週日"], // row2
    ["Day Shift", "", "", "37", "37"], // row3（欄數再短）
    ["Middle Shift"], // row4
    ["Night Shift"], // row5
    ["Total"], // row6
    ["", "", "", "", "", "", "", "  3,305,129 "], // row7：Total 行，引號千分位數字
    header, // row8：表頭
    ["數碼港 12hrs (D/S)", "", "數碼", "", "", "", "", ""], // row9：section header，冇雞頭資料
    // row10：真正長工格——mergeBlank=true 就模擬垂直合併儲存格 CSV 匯出
    // 之後「物業名稱」／「客戶名稱」淨係最頂一格有值，呢一行兩欄都空。
    [mergeBlank ? "" : "數碼港 XX", "", mergeBlank ? "" : "數碼", "Day", "930", "#REF!", "0750-1950", "數碼", marker, "XX", "", "", "", "", "數碼", marker, "XX", "", "", "", ""],
  ];
}

describe("WP-POSTORDER-ROBUST：真實 Google Sheets 匯出形狀（表頭飄行＋合併儲存格）", () => {
  it("表頭喺第 8 行（第 1 行合併日期標題令行號飄咗）——長工格照樣解到（同真樣本一致，唔靠寫死第 7/8 行）", () => {
    const csvText = rowsToCsv(realShapedRosterRows());
    const result = parsePostorderFromCsv({ rosterCsv: csvText, postorderCsv: "客戶名稱,Customer Code,物業名稱,更份,上單價,外判價,時間,Total Shift" });
    expect(result.rosterParseError).toBeNull();
    expect(result.rosterHeaderRow).toBe(8);
    expect(result.rosterDayBlockWidth).toBe(7);
    expect(result.rosterFirstDayCol).toBe(8);
    expect(result.longtermPosts).toHaveLength(1);
    expect(result.longtermPosts[0].cellCount).toBe(2); // day1 + day2
    expect(result.longtermPosts[0].guardNameRaw).toBe("XX");
  });

  it("物業名稱／客戶名稱垂直合併儲存格（CSV 匯出淨係最頂一格有值）——向下補值先解得返，唔會漏晒整批長工格", () => {
    // 真實production bug 根源：舊版見到 `!prop` 就 continue，成批帶
    // 「(8) 長工」嘅行因為合併儲存格得返頂格有值而全部漏咗
    // （老闆話「1,295 格 → 0」）。
    const withoutFill = realShapedRosterRows({ mergeBlankPropClient: true });
    const csvText = rowsToCsv(withoutFill);
    const cells = parsePostorderLongtermPostsFromCsvGrid(csvText);
    // row10（真正長工資料行）物業/客戶名稱都空，但上一行（row9）有
    // 「數碼」——向下補值之後 row10 應該用返 row9 嘅「數碼」做
    // siteLabelFallbackRaw，繼續計到 2 格。
    expect(cells).toHaveLength(1);
    expect(cells[0].cellCount).toBe(2);
    expect(cells[0].siteLabelFallbackRaw).toBe("數碼");
    expect(cells[0].guardNameRaw).toBe("XX");
  });

  it("全形括號／冇空格嘅「長工」標記都認得（NFKC 令（8）長工／(8)長工／(8) 長工一致）", () => {
    for (const marker of ["（8）長工", "(8)長工", "(8) 長工", "(8)　長工"]) {
      const csvText = rowsToCsv(realShapedRosterRows({ longtermMarker: marker }));
      const cells = parsePostorderLongtermPostsFromCsvGrid(csvText);
      expect(cells, `marker=${marker}`).toHaveLength(1);
      expect(cells[0].cellCount, `marker=${marker}`).toBe(2);
    }
  });

  it("BOM＋CRLF＋引號千分位數字（第 7 行 Total）唔會令 csv-parse 拋錯或者拉歪行號", () => {
    const csvText = rowsToCsv(realShapedRosterRows(), { bom: true, eol: "\r\n" });
    expect(csvText.startsWith(BOM)).toBe(true);
    expect(() => parsePostorderLongtermPostsFromCsvGrid(csvText)).not.toThrow();
    const cells = parsePostorderLongtermPostsFromCsvGrid(csvText);
    expect(cells).toHaveLength(1);
  });

  it("搵唔到表頭（冇「客戶名稱」／「物業名稱」字眼）→ 老實答 parseError，唔靜靜當 0", () => {
    const csvText = rowsToCsv([
      ["呢份唔係 Roster", "亂七八糟", ""],
      ["數碼港 XX", "", "數碼", "Day", "930", "", "0750-1950", "數碼", "(8) 長工", "XX"],
    ]);
    const result = parsePostorderFromCsv({ rosterCsv: csvText, postorderCsv: null });
    expect(result.longtermPosts).toHaveLength(0);
    expect(result.rosterHeaderRow).toBeNull();
    expect(result.rosterParseError).toMatch(/搵唔到表頭/);
  });

  it("表頭前面多一行／少一行（前置行數飄動）都搵到同一個表頭、日期 block 闊度", () => {
    const base = realShapedRosterRows();
    const extraRow = rowsToCsv([["額外一行"], ...base]);
    const oneLess = rowsToCsv(base.slice(1));
    const resultExtra = parsePostorderFromCsv({ rosterCsv: extraRow, postorderCsv: null });
    const resultLess = parsePostorderFromCsv({ rosterCsv: oneLess, postorderCsv: null });
    expect(resultExtra.rosterHeaderRow).toBe(9); // 表頭跟住成個 grid 落多一行
    expect(resultExtra.longtermPosts).toHaveLength(1);
    expect(resultExtra.longtermPosts[0].cellCount).toBe(2);
    expect(resultLess.rosterHeaderRow).toBe(7); // 表頭跟住成個 grid 上多一行
    expect(resultLess.longtermPosts).toHaveLength(1);
    expect(resultLess.longtermPosts[0].cellCount).toBe(2);
  });
});
