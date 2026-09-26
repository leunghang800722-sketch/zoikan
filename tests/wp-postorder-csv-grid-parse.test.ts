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
  ws.getRow(7).values = ["客戶名稱", "Customer Code", "物業名稱", "更份", "上單價", "外判價", "時間"];
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
