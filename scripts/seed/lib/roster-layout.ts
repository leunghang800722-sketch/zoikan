// P1-WP3（第二輪規劃裁定，2026-09-12）：反推每個 site 嘅更表「序列骨架」
// （`sites.roster_layout`）——逐行行過原檔（`data/2026-07/*.xlsx`），
// 配合 `tools/importer/out/wp1/rows.csv`（邊行係保安員行、邊個 block）、
// `tools/importer/out/wp2b/shift_records.csv`（file→DB site_id、
// roster_broker_code）、`tools/importer/out/wp2b/shift_types.csv`
// （(site_id,time_slot,rank)→code）逐行分類做 section：banner／header／
// guard_rows／blank／total_group／literal_row。**冇任何 literal 寫死喺
// 呢個檔案**——全部 runtime 由 data/ 讀出。
import ExcelJS from "exceljs";
import type { PrismaClient } from "@prisma/client";
import { readCsv } from "./csv";
import { CSV, OUT, DATA } from "./paths";
import { rowRawLiteral } from "./cell-literal";
import fs from "node:fs";
import type { RosterSection, RosterLayoutKind, RosterLayoutTemplate, BannerCell, TotalGroupRow, RawRow } from "../../../src/lib/roster-layout-template";

const ROWS_CSV = OUT("wp1/rows.csv");

type RowsCsvRow = { file: string; row: string; block_id: string; layout: string; sub_site: string; time_slot: string; rank: string };
type ShiftRecordCsvRow = { site_id: string; shift_type_id: string; provenance_file: string; provenance_cell: string };
type ShiftTypeCsvRow = { shift_type_id: string; site_id: string; code: string; time_slot: string; rank: string };

const LABEL_COL: Record<RosterLayoutKind, number> = { standard: 6, digital_port: 7, citybus: 7 };
// 原檔一律係 2026 年 7 月（31 日）——seed 淨係處理呢個月嘅原檔，呢個
// 常數係「seed 來源月份嘅日數」，唔係業務邏輯寫死（同
// scripts/report/*.ts 嘅 DEFAULT_REPORT_MONTH 精神一致）；export 嗰邊
// 用返*匯出月份*自己實際日數計位置，唔會凍結 31。
const JULY_DAYS = 31;

// 結構性關鍵字（唔係 PDPO——呢啲係全部原檔通用嘅版面詞彙，唔係個人資料，
// 同 LeaveCode enum 值一樣係業務詞彙）。用嚟喺原檔逐行掃嗰陣認得「呢行
// 係咪 Total/所需人手/尚欠 trio」。
const WORKED_LABELS = ["Total"];
const REQUIRED_LABELS = ["所需人手"];
const SHORTFALL_LABELS = ["尚欠"];

function parseCellRow(cellRef: string): number | null {
  const m = cellRef.match(/^[A-Z]+(\d+)$/);
  return m ? Number(m[1]) : null;
}

function cellPlainValueRaw(v: unknown): string | number | null {
  if (v === null || v === undefined || v === "") return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (Array.isArray(o.richText)) {
      const s = (o.richText as Array<{ text?: string }>).map((t) => t.text ?? "").join("");
      return s === "" ? null : s;
    }
    if ("result" in o) return cellPlainValueRaw(o.result);
    return null;
  }
  if (typeof v === "string" || typeof v === "number") return v;
  return null;
}

/** 共用公式（sharedFormula）嘅 follower cell，`.value` 得返
 * `{sharedFormula:"G8"}`（冇內嵌 `result`）——真正 cached 數值喺
 * `cell.result`（ExcelJS 獨立屬性）。同
 * `scripts/report/roster-export-diff.ts` 嘅 `cellEffectiveRaw()` 一致
 * 手法。 */
function cellPlainValue(cell: ExcelJS.Cell): string | number | null {
  const v = cell.value;
  if (v && typeof v === "object" && !(v instanceof Date)) {
    const o = v as unknown as Record<string, unknown>;
    // 任何 formula 形狀嘅 value（"formula" 或 "sharedFormula"，master
    // 定 follower）一律用 `cell.result`（獨立屬性）攞 cached 數值——
    // 實測發現：master formula cell（`{"formula":...,"ref":...,
    // "shareType":"shared"}`）同「有部分 result 內嵌」嘅 formula cell
    // 都可以一律咁做，`cell.result` 永遠準確、唔使睇 `.value` 入面有
    // 冇 "result" 呢個 key。
    if (!Array.isArray(o.richText) && ("formula" in o || "sharedFormula" in o)) {
      return cellPlainValueRaw(cell.result);
    }
  }
  return cellPlainValueRaw(v);
}

function isBlankCellValue(cell: ExcelJS.Cell): boolean {
  return cellPlainValue(cell) === null;
}

/** 原檔有啲檔喺日期欄之後多一格「行內合計」（例如
 * `COUNTIF(G5:AK5,"D")`——一個保安員嗰行自己嘅月更數，或者 Total 行嘅
 * `SUM(G10:AK10)`）。用嗰行第一格（`labelCol+JULY_DAYS+1`）有冇嘢嚟
 * 判斷。 */
function hasTrailingTotalAt(ws: ExcelJS.Worksheet, row: number, labelCol: number): boolean {
  return !isBlankCellValue(ws.getCell(row, labelCol + JULY_DAYS + 1));
}

/** Gate 2（`--derived`）：主總計欄（`labelCol+JULY_DAYS+1`）之後，讀
 * header 嗰行（`labelCol+JULY_DAYS+2` 開始）逐格 literal 文字，直到
 * 撞到空格為止——原檔有啲檔喺呢度多印幾欄「按請假代號分類嘅小計」
 * legend（例如 RD/SH/AL/SL/NL），文字本身係 LeaveCode enum 值，唔係
 * PII，純粹版面結構——同 WORKED_LABELS/REQUIRED_LABELS 呢類已有嘅
 * 結構關鍵字掃描手法一致。 */
function trailingSummaryLabelsAt(ws: ExcelJS.Worksheet, headerRow: number, labelCol: number): string[] {
  const out: string[] = [];
  let col = labelCol + JULY_DAYS + 2;
  for (;;) {
    const v = cellPlainValue(ws.getCell(headerRow, col));
    if (v === null) break;
    const text = String(v).trim();
    if (!text) break;
    out.push(text);
    col++;
    if (out.length > 20) break; // 保險上限，唔會失控掃到成張 sheet
  }
  return out;
}

function rowCells(ws: ExcelJS.Worksheet, row: number, labelCol: number): BannerCell[] {
  const out: BannerCell[] = [];
  const r = ws.getRow(row);
  r.eachCell({ includeEmpty: false }, (cell, col) => {
    const v = cellPlainValue(cell);
    if (v !== null) out.push({ colOffset: col - labelCol, value: v });
  });
  return out;
}

function isRowBlank(ws: ExcelJS.Worksheet, row: number): boolean {
  let blank = true;
  ws.getRow(row).eachCell({ includeEmpty: false }, () => {
    blank = false;
  });
  return blank;
}

function labelColText(ws: ExcelJS.Worksheet, row: number, labelCol: number): string {
  const v = cellPlainValue(ws.getCell(row, labelCol));
  return v === null ? "" : String(v).trim();
}

function matchesAny(text: string, needles: string[]): boolean {
  return needles.some((n) => text.includes(n));
}

interface GuardSubRun {
  startRow: number;
  endRow: number;
  timeSlot: string;
  rank: string;
  dbShiftTypeId: string | null;
}

export async function seedRosterLayouts(
  prisma: PrismaClient,
  siteIdMap: Map<string, string>,
  shiftTypeIdMap: Map<string, string>,
): Promise<{ sitesUpdated: number; skippedReason?: string }> {
  if (!fs.existsSync(ROWS_CSV) || !fs.existsSync(CSV.shiftRecords) || !fs.existsSync(CSV.shiftTypes)) {
    return { sitesUpdated: 0, skippedReason: "wp1/rows.csv 或 wp2b/shift_records.csv 或 wp2b/shift_types.csv 唔存在——跳過 roster_layout（唔會令成個 seed fail）" };
  }
  const dataDir = DATA("2026-07");
  if (!fs.existsSync(dataDir)) {
    return { sitesUpdated: 0, skippedReason: "data/2026-07/ 唔存在——跳過 roster_layout（唔會令成個 seed fail）" };
  }

  const rowsCsv = readCsv<RowsCsvRow>(ROWS_CSV);
  const shiftRecordsCsv = readCsv<ShiftRecordCsvRow>(CSV.shiftRecords);
  const shiftTypesCsv = readCsv<ShiftTypeCsvRow>(CSV.shiftTypes);

  // P1-WP3 第二輪修正：`RosterSection.guard_rows/total_group` 嘅
  // `shiftTypeCodes` 陣列**實際存嘅係 DB shift_type.id**（唔係 code 文字
  // 字面）——原因：`(site_id, code, start_time)` 先至係 unique，同一個
  // site 入面兩個唔同 shift_type 可以有**一樣嘅 code**（例：啟航1331
  // 早/夜兩個 Zone IC 都叫 "IC"）。如果用 code 字串嚟揀「呢個 section
  // 揀邊啲 guard」，會將唔同 shift_type、但 code 撞名嘅保安員錯誤咁撈埋
  // 同一行，導致成個檔案 row 數對唔返原檔（實測 3172/啟航1331 都撞到
  // 呢個 bug）。用 DB id 先保證每個 section 揀返*嗰一個*shift_type。
  const dbShiftTypeIdByKey = new Map<string, string>(); // site_id|time_slot|rank -> DB shift_type.id
  // Gate 2（規劃裁定，2026-09-12）：total_group scope 匹配用——原檔
  // 「所需人手」嗰行 labelCol-1 欄通常直接印住個 shift_type CSV 原始
  // code（例如「SIC」「IC」「N」），比「Total」嗰行印嘅正式角色名
  // （例如「高級IC」）更可靠、更貼近 subRuns 嘅 dbShiftTypeId（見下面
  // total_group 偵測嗰段）。
  const csvCodeByDbShiftTypeId = new Map<string, string>();
  for (const r of shiftTypesCsv) {
    const dbId = shiftTypeIdMap.get(r.shift_type_id);
    if (dbId) dbShiftTypeIdByKey.set(`${r.site_id}|${r.time_slot}|${r.rank}`, dbId);
    if (dbId) csvCodeByDbShiftTypeId.set(dbId, r.code);
  }

  const siteIdByFileRow = new Map<string, string>(); // file|row -> P0 site_id
  const fileToSiteIds = new Map<string, Set<string>>();
  for (const r of shiftRecordsCsv) {
    if (!r.provenance_file || !r.site_id) continue;
    const rowNum = parseCellRow(r.provenance_cell || "");
    if (rowNum !== null) siteIdByFileRow.set(`${r.provenance_file}|${rowNum}`, r.site_id);
    if (!fileToSiteIds.has(r.provenance_file)) fileToSiteIds.set(r.provenance_file, new Set());
    fileToSiteIds.get(r.provenance_file)!.add(r.site_id);
  }

  // 城巴 depot 次序（跨全部 rows，file 級，唔理 block_id）。
  const depotOrderByFile = new Map<string, string[]>();
  for (const r of rowsCsv.slice().sort((a, b) => Number(a.row) - Number(b.row))) {
    if (r.layout !== "citybus" || !r.sub_site) continue;
    const order = depotOrderByFile.get(r.file) ?? [];
    if (!order.includes(r.sub_site)) order.push(r.sub_site);
    depotOrderByFile.set(r.file, order);
  }

  // block_id -> { file, layout, site_id, rows:[{row,timeSlot,rank}] }（每個
  // block 淨係要知道邊個 file／邊個 site_id／逐行 timeSlot+rank，先可以
  // 分返做 guard sub-run）。
  type BlockAgg = { file: string; layout: RosterLayoutKind; siteId: string | null; rows: Array<{ row: number; timeSlot: string; rank: string }> };
  const blocks = new Map<string, BlockAgg>();
  for (const r of rowsCsv) {
    const rowNum = Number(r.row);
    if (!Number.isFinite(rowNum)) continue;
    const layout = (["standard", "digital_port", "citybus"] as const).includes(r.layout as RosterLayoutKind) ? (r.layout as RosterLayoutKind) : "standard";
    let agg = blocks.get(r.block_id);
    if (!agg) {
      agg = { file: r.file, layout, siteId: null, rows: [] };
      blocks.set(r.block_id, agg);
    }
    agg.rows.push({ row: rowNum, timeSlot: r.time_slot, rank: r.rank });
    const bySiteRow = siteIdByFileRow.get(`${r.file}|${rowNum}`);
    if (bySiteRow) agg.siteId = bySiteRow;
    else if (!agg.siteId) {
      const candidates = fileToSiteIds.get(r.file);
      if (candidates && candidates.size === 1) agg.siteId = [...candidates][0]!;
    }
  }

  // 逐 file 攞返所有 block（按 minRow 排序）——先至知道每個 block 嘅
  // banner/span 邊度開始邊度完（下一個 block 嘅 banner 開始位置）。
  type FileBlock = { blockId: string; siteId: string | null; layout: RosterLayoutKind; minRow: number; guardRows: Array<{ row: number; timeSlot: string; rank: string }> };
  const blocksByFile = new Map<string, FileBlock[]>();
  for (const [blockId, agg] of blocks) {
    if (agg.rows.length === 0) continue;
    const minRow = Math.min(...agg.rows.map((r) => r.row));
    if (!blocksByFile.has(agg.file)) blocksByFile.set(agg.file, []);
    blocksByFile.get(agg.file)!.push({ blockId, siteId: agg.siteId, layout: agg.layout, minRow, guardRows: agg.rows.sort((a, b) => a.row - b.row) });
  }
  for (const list of blocksByFile.values()) list.sort((a, b) => a.minRow - b.minRow);

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

  // 逐 site 收集 section（一個 site 可能跨幾個 block，甚至幾個 file——
  // 城巴嗰 8 廠全部嚟自同一個 file，但邏輯上一視同仁）。
  const sectionsBySite = new Map<string, RosterSection[]>();
  const layoutBySite = new Map<string, RosterLayoutKind>();

  for (const [file, fileBlocks] of blocksByFile) {
    const wb = await getWorkbook(file);
    if (!wb) continue;
    const ws = wb.getWorksheet("2026") ?? wb.worksheets[0];
    if (!ws) continue;

    // Gate 2（`--derived`）：城巴車廠嗰種一個 file 好幾個 depot 嘅情況，
    // 淨係第一個 depot 有自己嘅 header（見 hasOwnHeader）——後面嗰啲
    // depot 嘅 guard_rows 仍然有同一組 trailing summary 欄（RD/SH/AL/
    // SL/NL），但冇自己嘅 header 行可以讀 legend 文字。用「呢個 file
    // 上一次讀到嘅 legend」頂上（同一個檔基本上全部 block 用緊同一套
    // 版面），跨檔案／跨 file 重設。
    let lastKnownTrailingSummaryCodes: string[] = [];

    for (let bi = 0; bi < fileBlocks.length; bi++) {
      const fb = fileBlocks[bi]!;
      if (!fb.siteId) continue;
      const dbSiteId = siteIdMap.get(fb.siteId);
      if (!dbSiteId) continue;
      const labelCol = LABEL_COL[fb.layout];

      const dateRow = fb.minRow - 2;
      const headerRow = fb.minRow - 1;
      const bannerRow1 = dateRow - 2;
      const bannerRow2 = dateRow - 1;
      // Gate 1 階段 2（規劃裁定，2026-09-12）：城巴車廠 8 廠合併——實測
      // 發現淨係第一個 depot（喺呢個檔案入面 minRow 最細嗰個）先有成套
      // 「banner1/banner2/Date/header」4 行裝飾；第二個 depot 開始直接
      // 由 guard_rows 開始（冇重複裝飾），上一個 depot 自己嗰組
      // Total／所需人手／尚欠 trailer 跟住喺*下一個* depot 嘅 guard_rows
      // 之前（唔係緊貼住上一個 depot 嘅 guard_rows 之後就完，中間可能
      // 隔住一行 blank）。舊有假設「every block 前面一定有 4 行裝飾」
      // 對單一 site 一個 file 嘅檔（其餘 20 份全部 0-diff）啱，但對呢種
      // 多 depot 共用一個 file 嘅情況錯——`spanEnd` 會錯誤咁將呢個 depot
      // 自己嘅 trailer（total_group）當做下一個 depot 嘅裝飾行，令 seed
      // 完全冇偵測到呢組 total_group（連帶累埋下一個 depot 嘅「banner/
      // header」錯誤咁捕捉咗上一個 depot 嘅 trailer 內容）。
      //
      // 修法：唔再盲目假設「every block 前面一定有 4 行裝飾」——用
      // content-based 判斷（呢個 block 嘅 dateRow 個 labelCol 格係咪真係
      // 個「Date」字面，同 `src/lib/roster-export.ts` `emitDateRow()`
      // 寫嘅字面一致，唔係 PDPO 個人資料，純粹版面結構關鍵字，同
      // WORKED_LABELS/REQUIRED_LABELS/SHORTFALL_LABELS 呢類已有嘅結構
      // 關鍵字同一類）——冇「Date」就當呢個 block 冇自己嘅裝飾行，直接
      // 由 guard_rows 開始；`spanEnd`（決定上一個 block 嘅 trailer 掃到
      // 邊）跟住呢個判斷嚟推：下一個 block 有裝飾就保留 4 行畀佢，冇就
      // 一路掃到下一個 block 嘅 guard_rows 前一行為止。
      const hasOwnHeader = dateRow >= 1 && cellPlainValue(ws.getCell(dateRow, labelCol)) === "Date";
      const nextHasOwnHeader =
        bi + 1 < fileBlocks.length ? (() => {
          const nb = fileBlocks[bi + 1]!;
          const nbDateRow = nb.minRow - 2;
          return nbDateRow >= 1 && cellPlainValue(ws.getCell(nbDateRow, LABEL_COL[nb.layout])) === "Date";
        })() : true;
      const spanEnd =
        bi + 1 < fileBlocks.length
          ? nextHasOwnHeader
            ? fileBlocks[bi + 1]!.minRow - 2 - 2 - 1 // 下一個 block 嘅 bannerRow1 之前一行
            : fileBlocks[bi + 1]!.minRow - 1 // 下一個 block 冇裝飾行，直接掃到佢 guard_rows 前一行
          : ws.rowCount; // 最後一個 block 用成張 sheet 尾

      const sections: RosterSection[] = sectionsBySite.get(dbSiteId) ?? [];
      layoutBySite.set(dbSiteId, fb.layout);

      if (hasOwnHeader) {
        if (bannerRow1 >= 1) sections.push({ kind: "banner", cells: rowCells(ws, bannerRow1, labelCol), rawRow: rowRawLiteral(ws, bannerRow1) ?? undefined });
        if (bannerRow2 >= 1) sections.push({ kind: "banner", cells: rowCells(ws, bannerRow2, labelCol), rawRow: rowRawLiteral(ws, bannerRow2) ?? undefined });
        const trailingSummaryCodes = trailingSummaryLabelsAt(ws, headerRow, labelCol);
        if (trailingSummaryCodes.length > 0) lastKnownTrailingSummaryCodes = trailingSummaryCodes;
        sections.push({
          kind: "header",
          labels: Array.from({ length: labelCol }, (_, i) => labelColText(ws, headerRow, i + 1)),
          dateRowRaw: rowRawLiteral(ws, dateRow) ?? undefined,
          labelRowRaw: rowRawLiteral(ws, headerRow) ?? undefined,
          trailingSummaryCodes,
        });
      }

      // ---- guard sub-run 分組：連續行、同一個 (timeSlot,rank) ----
      // 淨係用嚟幫 total_group 嘅 fallback scope／context fuzzy-match用，
      // 唔會再影響 guard_rows 點分 section（見下面第三輪裁定）。
      const subRuns: GuardSubRun[] = [];
      for (const gr of fb.guardRows) {
        const last = subRuns[subRuns.length - 1];
        if (last && last.timeSlot === gr.timeSlot && last.rank === gr.rank) {
          last.endRow = gr.row;
        } else {
          subRuns.push({ startRow: gr.row, endRow: gr.row, timeSlot: gr.timeSlot, rank: gr.rank, dbShiftTypeId: dbShiftTypeIdByKey.get(`${fb.siteId}|${gr.timeSlot}|${gr.rank}`) ?? null });
        }
      }

      // P1-WP3 第三輪規劃裁定（2026-09-12）：**唔准用啟發式分辨「齊整定
      // 交錯」**——一個 block 嘅成個保安員區域一律開**一個** guard_rows
      // section，記低 `rowFrom`/`rowTo`（原檔 row 範圍）。Export 時直接
      // 用 provenance.cell 嘅 row 喺呢個範圍之內嘅記錄，照 row 次序逐行
      // 出（有記錄先出，冇就係 blank_guard_row）——自然還原原檔逐行
      // 交錯嘅次序，唔使判斷。`shiftTypeCodes` 保留做冇 provenance（新
      // 月份）嘅 fallback membership。
      const allBlockCodes = [...new Set(subRuns.map((r) => r.dbShiftTypeId).filter((c): c is string => !!c))];
      let cursor = headerRow + 1;
      if (fb.guardRows.length > 0) {
        const lastGuardRow = Math.max(...fb.guardRows.map((r) => r.row));
        const firstGuardRow = Math.min(...fb.guardRows.map((r) => r.row));
        if (firstGuardRow > cursor) sections.push({ kind: "blank", rows: firstGuardRow - cursor });
        // Gate 1 階段 1（純加法）：逐行捕捉 raw 字面，做 `rawRows`
        // fallback——蓋住「呢一行成個 7 月都冇任何一日有值，冇對應
        // shift_record 可以掛 provenance.raw_row」嘅保安員行（見
        // `scripts/seed/lib/roster-raw.ts` 頂註解、`src/lib/
        // roster-export.ts` 嘅揀選優先次序）。
        const rawRows: Record<string, RawRow> = {};
        // Gate 2 規劃裁定修正：逐行（唔淨係 firstGuardRow）check 呢一行
        // 自己有冇主總計欄——原檔實測發現同一個 section 入面唔一定逐行
        // 一致（見 src/lib/roster-layout-template.ts trailingTotalRows
        // 註解）。
        const trailingTotalRows: string[] = [];
        for (let row = firstGuardRow; row <= lastGuardRow; row++) {
          const raw = rowRawLiteral(ws, row);
          if (raw) rawRows[String(row)] = raw;
          if (hasTrailingTotalAt(ws, row, labelCol)) trailingTotalRows.push(String(row));
        }
        const hasTrailingTotal = hasTrailingTotalAt(ws, firstGuardRow, labelCol);
        sections.push({
          kind: "guard_rows",
          rowFrom: firstGuardRow,
          rowTo: lastGuardRow,
          shiftTypeCodes: allBlockCodes,
          minRows: lastGuardRow - firstGuardRow + 1,
          hasTrailingTotal,
          rawRows,
          trailingTotalRows,
          // Gate 2（`--derived`）：跟返呢個 file 最近一次讀到嘅 trailing
          // summary legend（見上面 lastKnownTrailingSummaryCodes 註解）——
          // 冇主總計欄就實冇呢啲額外欄，唔使跟。
          trailingSummaryCodes: hasTrailingTotal ? lastKnownTrailingSummaryCodes : [],
        });
        cursor = lastGuardRow + 1;
      }

      // ---- trailer：cursor..spanEnd，逐行分類 blank／total trio／literal ----
      let blankRun = 0;
      const flushBlank = () => {
        if (blankRun > 0) {
          sections.push({ kind: "blank", rows: blankRun });
          blankRun = 0;
        }
      };
      let r = cursor;
      while (r <= spanEnd) {
        if (isRowBlank(ws, r)) {
          blankRun++;
          r++;
          continue;
        }
        const labelText = labelColText(ws, r, labelCol);
        if (matchesAny(labelText, WORKED_LABELS) && r + 2 <= spanEnd && matchesAny(labelColText(ws, r + 1, labelCol), REQUIRED_LABELS) && matchesAny(labelColText(ws, r + 2, labelCol), SHORTFALL_LABELS)) {
          flushBlank();
          // scope 判斷：搵 labelCol-1 欄嘅文字，fuzzy match 返邊個
          // sub-run；搵唔到就用成個 block 嘅全部 row 範圍（簡單 block
          // 本身淨係一個 sub-run，呢個 fallback 自然啱）。第三輪：scope
          // 都改用 row 範圍（rowFrom/rowTo）做主要判斷依歸，scopeCodes
          // 淨係做冇 provenance 情況嘅 fallback。
          //
          // Gate 2 規劃裁定修正（2026-09-12，實測啟航1331 揪到）：「Total」
          // 嗰行（`r`）嘅 labelCol-1 有時印緊正式角色名（例如「高級IC」），
          // 同 subRuns 嘅 `rank` 原始文字（例如「夜Zone SIC」）冇公共子
          // 字串，fuzzy match 撞唔中，跌返「成個 block」嘅 fallback——
          // 令呢個 total_group 錯誤咁蓋晒成個 block 嘅 3 個角色（所需
          // 人手變咗 3 個角色相加，唔係淨係佢自己嗰個角色）。「所需人手」
          // 嗰行（`r+1`）嘅 labelCol-1 通常直接印住 shift_type CSV 原始
          // code（「SIC」「IC」「N」），同 subRuns 嘅 dbShiftTypeId 更
          // 直接對應——優先試呢個，撞唔中先跌返舊有 rank 文字 fuzzy
          // match（舊路徑完全冇改）。
          const contextText = String(cellPlainValue(ws.getCell(r, labelCol - 1)) ?? "").trim();
          const requiredRowContextText = String(cellPlainValue(ws.getCell(r + 1, labelCol - 1)) ?? "").trim();
          let scopeCodes = allBlockCodes;
          let scopeRowFrom = fb.guardRows.length > 0 ? Math.min(...fb.guardRows.map((g) => g.row)) : cursor;
          let scopeRowTo = fb.guardRows.length > 0 ? Math.max(...fb.guardRows.map((g) => g.row)) : cursor - 1;
          if (subRuns.length > 1 && (contextText || requiredRowContextText)) {
            const matched =
              (requiredRowContextText &&
                subRuns.find((run) => run.dbShiftTypeId && csvCodeByDbShiftTypeId.get(run.dbShiftTypeId) === requiredRowContextText)) ||
              subRuns.find((run) => run.rank && (contextText.includes(run.rank) || run.rank.includes(contextText)));
            if (matched) {
              if (matched.dbShiftTypeId) scopeCodes = [matched.dbShiftTypeId];
              scopeRowFrom = matched.startRow;
              scopeRowTo = matched.endRow;
            }
          }
          const rowsOut: TotalGroupRow[] = [
            { cells: rowCells(ws, r, labelCol), metric: "worked", rawRow: rowRawLiteral(ws, r) ?? undefined },
            { cells: rowCells(ws, r + 1, labelCol), metric: "required", rawRow: rowRawLiteral(ws, r + 1) ?? undefined },
            { cells: rowCells(ws, r + 2, labelCol), metric: "shortfall", rawRow: rowRawLiteral(ws, r + 2) ?? undefined },
          ];
          sections.push({ kind: "total_group", rowFrom: scopeRowFrom, rowTo: scopeRowTo, scopeCodes, rows: rowsOut });
          r += 3;
          continue;
        }
        // 未識別嘅 literal 行（罕見）——連逐日值都凍結（冇 DB 語義）。
        flushBlank();
        const cells = rowCells(ws, r, labelCol);
        sections.push({ kind: "literal_row", cells, rawRow: rowRawLiteral(ws, r) ?? undefined });
        r++;
      }
      flushBlank();

      sectionsBySite.set(dbSiteId, sections);
    }
  }

  let sitesUpdated = 0;
  for (const [dbSiteId, sections] of sectionsBySite) {
    if (sections.length === 0) continue;
    const layout = layoutBySite.get(dbSiteId) ?? "standard";
    // depotOrder：搵返呢個 site 屬邊個 file（城巴專用）。
    let depotOrder: string[] | undefined;
    if (layout === "citybus") {
      for (const [file, order] of depotOrderByFile) {
        const p0Ids = fileToSiteIds.get(file);
        if (p0Ids && [...p0Ids].some((p0) => siteIdMap.get(p0) === dbSiteId)) {
          depotOrder = order;
          break;
        }
      }
    }
    const template: RosterLayoutTemplate = {
      layout,
      sections,
      depotOrder,
      source: `seed:roster-layout.ts (序列骨架) from wp1/rows.csv+wp2b/shift_records.csv+wp2b/shift_types.csv+data/2026-07/*.xlsx (${new Date().toISOString().slice(0, 10)})`,
    };
    await prisma.site.update({ where: { id: dbSiteId }, data: { rosterLayout: JSON.parse(JSON.stringify(template)) } });
    sitesUpdated++;
  }

  return { sitesUpdated };
}
