// P1-WP3 Gate 1 階段 1（規劃裁定，2026-09-12：分階段、純加法，唔改任何
// 現有欄／邏輯，每階段跑 gate 交真數）——「raw 字面」：對 21 份原檔
// （`data/2026-07/*.xlsx`）逐個安員行（由 `tools/importer/out/wp1/
// rows.csv` 嘅 file/row 定位——同 `scripts/seed/lib/roster-layout.ts`
// 用緊嗰個 CSV 一致嘅定位方式），將成行非空 cell 嘅原始字面（col→值；
// formula 格存 `{formula,result}`，見 `cell-literal.ts`）寫入呢一行
// 對應嘅**每一條** shift_records 嘅 `provenance.raw_row`（同一安員行
// 嘅所有 records 存同一份——揀簡單嗰個，唔起獨立 row-level 索引表）。
//
// `src/lib/roster-export.ts` render 安員行時，如果搵到 `raw_row` 就逐格
// 用 raw literal（新增一個分支）；冇 `raw_row`（新月份，或者呢一行成個
// 7 月都冇任何一日有值、冇對應 shift_record 可以掛——呢種情況由
// `roster-layout.ts` 嘅 `guard_rows.rawRows` 頂上，見嗰個檔案）就跌返
// 舊有嘅 DB 推導邏輯（舊路徑一格都冇改）。
//
// Fail-soft：冇 `data/2026-07/` 或 `wp1/rows.csv` 就跳過，唔會令成個
// `db:seed` throw（同 `roster-layout.ts`／`leave-code-raw.ts` 同一個
// 慣例）。
import ExcelJS from "exceljs";
import { Prisma, type PrismaClient } from "@prisma/client";
import { readCsv } from "./csv";
import { OUT, DATA } from "./paths";
import { rowRawLiteral } from "./cell-literal";
import fs from "node:fs";

const ROWS_CSV = OUT("wp1/rows.csv");

type RowsCsvRow = { file: string; row: string };

function parseCellRow(cellRef: string): number | null {
  const m = cellRef.match(/^[A-Za-z]+(\d+)$/);
  if (m) return Number(m[1]);
  const n = Number(cellRef);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export async function enrichShiftRecordsWithRawRow(
  prisma: PrismaClient,
): Promise<{ rowsWithData: number; rowsAttached: number; recordsUpdated: number; skippedReason?: string }> {
  const dataDir = DATA("2026-07");
  if (!fs.existsSync(ROWS_CSV) || !fs.existsSync(dataDir)) {
    return {
      rowsWithData: 0,
      rowsAttached: 0,
      recordsUpdated: 0,
      skippedReason: "wp1/rows.csv 或 data/2026-07/ 唔存在——跳過 raw_row（唔會令成個 seed fail）",
    };
  }
  const rowsCsv = readCsv<RowsCsvRow>(ROWS_CSV);

  // 逐 (file,row) 索引呢一行對應嘅 shift_records id——一次過攞晒全部
  // 有 provenance.cell 嘅記錄嚟建索引，唔逐行行 DB query（296 行 rows.csv
  // × 逐行 query 會好慢）。
  const allRecords = await prisma.shiftRecord.findMany({ select: { id: true, provenance: true } });
  const idsByFileRow = new Map<string, string[]>();
  for (const rec of allRecords) {
    const p = (rec.provenance ?? {}) as Record<string, unknown>;
    const file = typeof p.file === "string" ? p.file : null;
    const cell = typeof p.cell === "string" ? p.cell : null;
    if (!file || !cell) continue;
    const rowNum = parseCellRow(cell);
    if (rowNum === null) continue;
    const key = `${file}|${rowNum}`;
    if (!idsByFileRow.has(key)) idsByFileRow.set(key, []);
    idsByFileRow.get(key)!.push(rec.id);
  }

  const workbookCache = new Map<string, ExcelJS.Workbook | null>();
  async function getWorkbook(file: string): Promise<ExcelJS.Workbook | null> {
    if (workbookCache.has(file)) return workbookCache.get(file)!;
    const filePath = `${dataDir}/${file}`;
    if (!fs.existsSync(filePath)) {
      workbookCache.set(file, null);
      return null;
    }
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(filePath);
    workbookCache.set(file, wb);
    return wb;
  }

  let rowsWithData = 0;
  let rowsAttached = 0;
  let recordsUpdated = 0;

  for (const r of rowsCsv) {
    const rowNum = parseCellRow(r.row);
    if (rowNum === null) continue;
    const wb = await getWorkbook(r.file);
    if (!wb) continue;
    const ws = wb.getWorksheet("2026") ?? wb.worksheets[0];
    if (!ws) continue;

    const rawRow = rowRawLiteral(ws, rowNum);
    if (!rawRow) continue;
    rowsWithData++;

    // 呢一行喺 7 月完全冇任何一日有值（成行淨係人事資料、成月0更）就
    // 唔會有對應 shift_record——冇嘢可以掛 raw_row，跳過（由
    // roster-layout.ts 嘅 guard_rows.rawRows 頂上）。
    const ids = idsByFileRow.get(`${r.file}|${rowNum}`);
    if (!ids || ids.length === 0) continue;

    await prisma.$executeRaw(
      Prisma.sql`UPDATE shift_records SET provenance = COALESCE(provenance, '{}'::jsonb) || jsonb_build_object('raw_row', ${JSON.stringify(rawRow)}::jsonb) WHERE id IN (${Prisma.join(ids)})`,
    );
    rowsAttached++;
    recordsUpdated += ids.length;
  }

  return { rowsWithData, rowsAttached, recordsUpdated };
}
