// P1-WP3 對數 gate：`npx tsx scripts/report/roster-export-diff.ts --month 2026-07`
//
// 讀 data/<month>/*.xlsx（本機、唔喺 git）逐份，靠檔名 fuzzy match 返
// DB 嗰個 site，直接 call `src/lib/roster-export.ts` 嗰個共用函數（唔經
// HTTP）生成 workbook，逐個非空 cell（sheet+row+col）同原檔比較值
// （唔比較格式——字體/顏色/框線）。輸出 out/p1/roster-export-diff.csv
// （差異明細）+ out/p1/roster-export-diff-summary.json（逐檔 summary）。
//
// 誠實原則（P1-執行計劃.md 明文要求）：呢個 gate **唔會**靠「淨係比對
// Total 行」扮逐格核對——逐個 guard 逐日格都真係讀出嚟比對；21 份入面
// 做唔做到全部 0-diff 老實報數，唔砌數。
//
// **Gate 1 現況（2026-09-12 分階段規劃裁定後）**：21/21 份 0-diff，exit 0
// ——`src/lib/roster-export.ts` 逐個安員行／banner／header／total_group
// 優先用 seed 時由原檔逐行讀出嘅 raw 字面（`provenance.raw_row`／
// `roster_layout` 嘅 `rawRow(s)`，見嗰個檔案頂註解），DB 推導淨係喺
// raw 字面唔存在（新月份）先用返。
//
// **`--derived` 模式（Gate 2，規劃裁定階段 3，2026-09-12 修完）**：
// `buildRosterWorkbookForSite` 加 `{derivedOnly:true}`，逼成個 render
// 完全唔用 raw 字面（`guard_rows`/`banner`/`header`/`total_group` 嘅
// `rawRow(s)` 全部唔用）、一律行 DB 推導路徑——驗嗰個推導邏輯本身
// （唔靠 raw 字面遮醜）啱唔啱。逐格分三類（`src/lib/roster-export.ts`
// 嘅 `classifyRosterCell()`）：逐日格（更別／狀態代號）、行首欄（雞頭
// 代號／時段／職級／工號／電話／姓名／英文名／Property Name）、結構格
// （banner/header/total/blank）。**現況：21/21 份 exit 0**——逐日格
// 3,644/3,644（100%，其中 3 格係 `record_type=pointer` 嘅已知排除
// `excluded_by_design`，見 `buildPointerExcludedCells()`）；結構格
// 9,906/9,906（100%，路上修咗幾個真 bug：total_group 嘅 scope 匹配、
// 「尚欠」唔准 clamp 做 0、guard_rows 主總計欄要跟 `record_type=shift`
// 唔係成個 section 嘅 code 集合、同一 section 入面每行要獨立 check
// 有冇自己嘅主總計欄）；行首欄 1,658/1,695（97.8%，容許落差，逐檔
// 分類原因——例如身份合併後 staff_no 為空、roster_broker_code 冇
// provenance 就跌返 settlement broker、英文名冧唔返）。輸出
// out/p1/roster-export-diff-derived.csv／
// out/p1/roster-export-diff-derived-summary.json。
import ExcelJS from "exceljs";
import fs from "node:fs";
import path from "node:path";
import { prisma } from "../seed/lib/db";
import { parseMonthArg } from "./lib/cli-month";
import {
  buildRosterWorkbookForSite,
  KNOWN_LAYOUT_DETECTION_CAVEAT,
  computeGuardRowSpans,
  classifyRosterCell,
  rowHeaderFieldName,
  type GuardRowSpan,
  type RosterCellKind,
} from "../../src/lib/roster-export";
import { isRosterLayoutTemplate } from "../../src/lib/roster-layout-template";
import { readCsv } from "../seed/lib/csv";
import { CSV } from "../seed/lib/paths";

const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

type DiffRow = { file: string; sheet: string; cell: string; db_value: string; orig_value: string };
const diffs: DiffRow[] = [];

type FileSummary = { file: string; matched: string; sameCells: number; diffCells: number; note: string };
const fileSummaries: FileSummary[] = [];
const unmatchedFiles: string[] = [];

function normSpace(s: string): string {
  return s.replace(/\s/g, "");
}

// 同 scripts/report/diff.ts 嘅 ROSTER_FILE_ALIAS_OVERRIDES 同一類已知
// 例外——「核心檔名」同 site canonicalName/aliases 冇一個完全相等
// （多咗個「CP5」），人手補呢個 candidate，唔靠 substring（會撞錯檔）。
const FILE_MATCH_OVERRIDES: Record<string, string[]> = {
  數碼港數據中心: ["數碼港CP5數據中心"],
};

// richText／formula-result／Date 統一 normalize 做可比較嘅 string。
// 逐個欄位獨立 convert（同 src/lib/api/serialize.ts 嘅 pickWhitelist 精神
// 一致），唔理格式（字體/顏色/框線）差異——呢個 gate 淨係比較「值」。
function normalizeCellValue(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (Array.isArray(o.richText)) {
      // P1-WP3 Gate 1 階段 2 修正：richText join 出嚟嘅純文字之前冇
      // trim()——同下面 `typeof v === "string"` 分支唔一致（嗰邊有
      // trim()），令「原檔用 richText 存、DB 匯出用 plain string 存」
      // 嘅同一個值（例如尾隨空格「早更IC 」）誤判做差異（實測：數碼港
      // CP5 R5C3/R7C3）。呢個 gate 本身明文淨係比較「值」唔理格式，
      // richText 同 plain string 應該一視同仁 trim。
      return (o.richText as Array<{ text?: string }>).map((t) => t.text ?? "").join("").trim();
    }
    if ("result" in o) return normalizeCellValue(o.result);
    if ("text" in o) return String(o.text);
    return JSON.stringify(o);
  }
  if (typeof v === "string") {
    // Excel formula cached result 有時係 ISO datetime string（午夜 UTC）
    // 代表一個純日期——同真正 Date 值 normalize 做同一種表示先比得到。
    const m = v.match(/^(\d{4}-\d{2}-\d{2})T00:00:00\.000Z$/);
    if (m) return m[1]!;
    return v.trim();
  }
  return String(v);
}

// P1-WP3 第二輪：共用公式（sharedFormula）嘅 follower cell，`.value`
// 得返 `{sharedFormula:"G8"}`（冇內嵌 `result`）——真正 cached 數值喺
// `cell.result`（ExcelJS 嘅獨立屬性，唔係 `.value` 嘅一部分）。原本
// `normalizeCellValue()` 淨係睇 `.value`，會將呢類 cell 讀成
// `'{"sharedFormula":"G8"}'` 文字（實測：3172 殷樺花園原檔一撞到
// 就令逐格對數誤判做差異）。
function cellEffectiveRaw(cell: ExcelJS.Cell): unknown {
  const v = cell.value;
  if (v && typeof v === "object" && !(v instanceof Date)) {
    const o = v as unknown as Record<string, unknown>;
    // 任何 formula 形狀（master "formula" 或 follower "sharedFormula"）
    // 一律用 `cell.result`（獨立屬性）——實測 master shared-formula cell
    // 都會出現 `.value` 冇 "result" key 嘅情況，唔淨係 follower 先咁樣。
    if (!Array.isArray(o.richText) && !("text" in o) && ("formula" in o || "sharedFormula" in o)) {
      return cell.result;
    }
  }
  return v;
}

function sheetCellMap(ws: ExcelJS.Worksheet): Map<string, string> {
  const map = new Map<string, string>();
  ws.eachRow((row, rowNumber) => {
    row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
      const norm = normalizeCellValue(cellEffectiveRaw(cell));
      if (norm !== "") map.set(`${rowNumber}:${colNumber}`, norm);
    });
  });
  return map;
}

// Excel 嘅日期 serial epoch（1899-12-30 = serial 0）——淨係啱用喺
// serial<60（即係 1900 年 3 月之前，仲未撞到 Excel 嗰個「1900 係閏年」
// 歷史 bug 嘅範圍）；呢個 gate 用嚟嘅場景（細過 1000 嘅 serial）完全
// 喺呢個安全範圍之內。
const EXCEL_SERIAL_EPOCH_UTC = Date.UTC(1899, 11, 30);

function excelSerialFromDate(d: Date): number {
  return Math.round((d.getTime() - EXCEL_SERIAL_EPOCH_UTC) / 86400000);
}

// P1-WP3 Gate 2 規劃裁定（2026-09-12）：原檔有啲 total_group 格（例如
// 「所需人手」）明明存嘅係細整數（例如 1），但個 cell 嘅 number format
// 係日期（好可能係複製貼上原檔上面嘅 Date 行、format 冇跟住清），令
// ExcelJS 讀出嚟嘅 `.value` 變咗一個 Date 物件（例如 1899-12-31）。
// 呢個 gate 淨係比較「值」，唔准將呢種格當做真係一個日期字面（真正 2026
// 年嘅日期 serial 應該係 46000+，遠大過 1000）——serial<1000 就當「呢個
// Date 物件其實想表達嘅係個細整數」，換返做個 serial number（同嗰個原本
// 嘅細整數一致）先比較。淨係喺 structural 格（total_group／banner／
// header／blank，唔係逐日格／行首欄）先套用，避免萬一逐日格出現任何
// 睇落似日期嘅罕見值都被誤判。
function normalizeOrigValueForDerived(v: unknown, kind: RosterCellKind): string {
  if (kind === "structural" && v instanceof Date) {
    const serial = excelSerialFromDate(v);
    if (serial >= 0 && serial < 1000) return String(serial);
  }
  return normalizeCellValue(v);
}

function sheetCellMapClassified(ws: ExcelJS.Worksheet, classify: (row: number, col: number) => RosterCellKind): Map<string, string> {
  const map = new Map<string, string>();
  ws.eachRow((row, rowNumber) => {
    row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
      const kind = classify(rowNumber, colNumber);
      const norm = normalizeOrigValueForDerived(cellEffectiveRaw(cell), kind);
      if (norm !== "") map.set(`${rowNumber}:${colNumber}`, norm);
    });
  });
  return map;
}

function compareSheets(fileLabel: string, sheetName: string, dbWs: ExcelJS.Worksheet, origWs: ExcelJS.Worksheet): { same: number; diff: number } {
  const dbMap = sheetCellMap(dbWs);
  const origMap = sheetCellMap(origWs);
  const allKeys = new Set([...dbMap.keys(), ...origMap.keys()]);
  let same = 0;
  let diff = 0;
  for (const key of allKeys) {
    const dbVal = dbMap.get(key) ?? "";
    const origVal = origMap.get(key) ?? "";
    if (dbVal === origVal) {
      same++;
      continue;
    }
    diff++;
    const [r, c] = key.split(":");
    diffs.push({ file: fileLabel, sheet: sheetName, cell: `R${r}C${c}`, db_value: dbVal, orig_value: origVal });
  }
  return { same, diff };
}

function fileCoreName(file: string, monthAbbr: string): string {
  return file
    .replace(/^Roster - \d*\s*/, "")
    .replace(new RegExp(`\\s*-\\s*${monthAbbr}\\s*\\d{4}.*$`), "")
    .trim();
}

// Gate 1／Gate 2 共用嘅「檔名 fuzzy match 返 DB site」邏輯——由 main()
// 抽出嚟，等 --derived 模式（runDerivedGate()）用返同一套，唔會兩份
// 邏輯各自散開、日後漂移。
function matchSiteForFile<T extends { canonicalName: string; aliases: string[] }>(file: string, core: string, coreNoSpace: string, sites: T[]): T | undefined {
  const overrideCandidates = new Set<string>();
  for (const [canon, extra] of Object.entries(FILE_MATCH_OVERRIDES)) {
    if (extra.some((e) => normSpace(e) === coreNoSpace)) overrideCandidates.add(canon);
  }
  let matchedSite = sites.find((s) => {
    const canonNoSpace = normSpace(s.canonicalName);
    if (canonNoSpace === coreNoSpace) return true;
    if (s.aliases.some((a) => normSpace(a) === coreNoSpace)) return true;
    if (overrideCandidates.has(canonNoSpace)) return true;
    return false;
  });
  if (!matchedSite) {
    // C1（自我覆核發現）：短/通用嘅 alias（例如「HKU」）用純 substring
    // match 會撞正唔啱嘅 site——改做「揀全部候選入面 match 到嘅字串
    // 最長嗰個」（最具體），唔係「陣列行到邊個就用邊個」。
    let bestLen = 0;
    for (const s of sites) {
      for (const n of [s.canonicalName, ...s.aliases]) {
        if (!n) continue;
        if (file.includes(n) || core.includes(n)) {
          if (n.length > bestLen) {
            bestLen = n.length;
            matchedSite = s;
          }
        }
      }
    }
  }
  return matchedSite;
}

// ---------------------------------------------------------------------------
// Gate 2（`--derived`）：逐格分三類（逐日格／行首欄／結構格），逐日格＋
// 結構格要求 100%，行首欄容許落差但逐檔列數量＋原因分類。
// ---------------------------------------------------------------------------
type CellBucket = { same: number; diff: number; excluded: number };
// A1（Opus 對抗式驗收第三輪）：`raw_fallback_cells` 逐檔記低「呢個 block
// 用咗 raw-literal fallback（唔係純 DB 推導）」嘅行數，分 external（呢行
// 喺冇 isExternal/source 濾走嘅版本其實有紀錄——即外援/借調安員，DB 冇
// 佢哋嘅完整 provenance 但存在過）／zeroShift（真係成個月嗰行乜更都冇
// 排過，純粹跟原檔印）兩類，等回報有真實嘅「純推導覆蓋率」數字。
type RawFallbackCells = { external: number; zeroShift: number; allCancelled: number };
type DerivedFileSummary = {
  file: string;
  matched: string;
  day: CellBucket;
  structural: CellBucket;
  rowHeader: CellBucket;
  rowHeaderReasons: Record<string, number>;
  rawFallbackCells: RawFallbackCells;
  note: string;
};

const derivedDiffs: DiffRow[] = [];
const derivedFileSummaries: DerivedFileSummary[] = [];
const derivedUnmatchedFiles: string[] = [];
// 上限 5 格，唔洗版（規劃裁定原文）。
const DERIVED_VIOLATION_PRINT_LIMIT = 5;
const derivedViolations: string[] = [];

// P1-WP3 Gate 2 規劃裁定（2026-09-12）：逐日格「已知排除」——P0
// `record_type=pointer` 嘅格（例如數碼港 CP5 指住「數據中心」嗰個
// site 嘅指針格）designed 咗喺 seed 就唔入 shift_records（見
// `scripts/seed/index.ts` `usable = rows.filter(r => r.record_type !==
// "pointer")`），DB 推導（唔靠 raw 字面）自然冇嘢可以填喺呢啲格——呢個
// 係刻意嘅資料設計，唔係推導邏輯 bug。由 `tools/importer/out/wp2b/
// shift_records.csv` 嘅 `record_type=pointer` 行自動算返 (file,row,col)
// 座標（唔寫死），計入 same 但標 `excluded_by_design`。
function colLettersToNumber(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) {
    n = n * 26 + (ch.charCodeAt(0) - 64);
  }
  return n;
}

function parseCellRef(ref: string): { row: number; col: number } | null {
  const m = ref.match(/^([A-Za-z]+)(\d+)$/);
  if (!m) return null;
  return { row: Number(m[2]), col: colLettersToNumber(m[1]!) };
}

/** file -> Set("row:col")，嚟自 `record_type=pointer` 嘅 provenance_cell。
 * Fail-soft：wp2b/shift_records.csv 唔存在就返空 map（唔會令 gate throw，
 * 同其他 seed 依賴 data/ 嘅慣例一致）。 */
function buildPointerExcludedCells(): Map<string, Set<string>> {
  const byFile = new Map<string, Set<string>>();
  if (!fs.existsSync(CSV.shiftRecords)) return byFile;
  type Row = { record_type: string; provenance_file: string; provenance_cell: string };
  const rows = readCsv<Row>(CSV.shiftRecords);
  for (const r of rows) {
    if (r.record_type !== "pointer") continue;
    const cellRef = parseCellRef(r.provenance_cell ?? "");
    if (!cellRef || !r.provenance_file) continue;
    if (!byFile.has(r.provenance_file)) byFile.set(r.provenance_file, new Set());
    byFile.get(r.provenance_file)!.add(`${cellRef.row}:${cellRef.col}`);
  }
  return byFile;
}

function describeCell(
  spans: GuardRowSpan[],
  row: number,
  col: number,
  layout: "standard" | "digital_port" | "citybus",
): { kind: RosterCellKind; fieldName?: string } {
  const kind = classifyRosterCell(spans, row, col);
  if (kind !== "row_header") return { kind };
  const span = spans.find((s) => row >= s.from && row <= s.to);
  const labelCol = span?.labelCol ?? col;
  return { kind, fieldName: rowHeaderFieldName(layout, col, labelCol) };
}

function compareDerivedSheets(
  fileLabel: string,
  dbWs: ExcelJS.Worksheet,
  origWs: ExcelJS.Worksheet,
  spans: GuardRowSpan[],
  layout: "standard" | "digital_port" | "citybus",
  pointerExcluded: Set<string>,
): { day: CellBucket; structural: CellBucket; rowHeader: CellBucket; rowHeaderReasons: Record<string, number> } {
  const classify = (row: number, col: number) => classifyRosterCell(spans, row, col);
  const dbMap = sheetCellMapClassified(dbWs, classify);
  const origMap = sheetCellMapClassified(origWs, classify);
  const allKeys = new Set([...dbMap.keys(), ...origMap.keys(), ...pointerExcluded]);
  const day: CellBucket = { same: 0, diff: 0, excluded: 0 };
  const structural: CellBucket = { same: 0, diff: 0, excluded: 0 };
  const rowHeader: CellBucket = { same: 0, diff: 0, excluded: 0 };
  const rowHeaderReasons: Record<string, number> = {};
  for (const key of allKeys) {
    const [rStr, cStr] = key.split(":");
    const row = Number(rStr);
    const col = Number(cStr);
    const dbVal = dbMap.get(key) ?? "";
    const origVal = origMap.get(key) ?? "";
    const { kind, fieldName } = describeCell(spans, row, col, layout);
    const bucket = kind === "day" ? day : kind === "structural" ? structural : rowHeader;
    if (dbVal === origVal) {
      bucket.same++;
      continue;
    }
    // P1-WP3 Gate 2 規劃裁定：`record_type=pointer` 嘅逐日格——DB 刻意
    // 唔存（設計決定，見上面 buildPointerExcludedCells() 註解），唔係
    // 推導邏輯 bug。計入 same＋excluded（`excluded_by_design`），唔算
    // diff、唔計入 violation 例子。
    if (kind === "day" && pointerExcluded.has(key)) {
      bucket.same++;
      bucket.excluded++;
      continue;
    }
    bucket.diff++;
    derivedDiffs.push({ file: fileLabel, sheet: "2026", cell: `R${row}C${col}`, db_value: dbVal, orig_value: origVal });
    if (kind === "row_header") {
      const reason = `${fieldName ?? `col${col}`}：${dbVal === "" ? "DB 空白" : origVal === "" ? "原檔空白" : "DB≠原檔"}`;
      rowHeaderReasons[reason] = (rowHeaderReasons[reason] ?? 0) + 1;
    } else if (derivedViolations.length < DERIVED_VIOLATION_PRINT_LIMIT) {
      derivedViolations.push(`${fileLabel} R${row}C${col}（${kind}）：db="${dbVal}" orig="${origVal}"`);
    }
  }
  return { day, structural, rowHeader, rowHeaderReasons };
}

async function runDerivedGate(
  month: Date,
  monthLabel: string,
  monthAbbr: string,
  dataDir: string,
  files: string[],
  sites: Awaited<ReturnType<typeof prisma.site.findMany>>,
  cityBusSites: Awaited<ReturnType<typeof prisma.site.findMany>>,
): Promise<void> {
  const DAYS = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 0)).getUTCDate();
  const pointerExcludedByFile = buildPointerExcludedCells();
  const emptySet = new Set<string>();

  for (const file of files) {
    const core = fileCoreName(file, monthAbbr);
    const coreNoSpace = normSpace(core);

    if (coreNoSpace === normSpace("城巴車廠")) {
      const wbOrig = new ExcelJS.Workbook();
      await wbOrig.xlsx.readFile(path.join(dataDir, file));
      const wsOrig = wbOrig.getWorksheet("2026");
      if (!wsOrig) {
        derivedFileSummaries.push({
          file,
          matched: "城巴車廠(8廠合併)",
          day: { same: 0, diff: 0, excluded: 0 },
          structural: { same: 0, diff: 0, excluded: 0 },
          rowHeader: { same: 0, diff: 0, excluded: 0 },
          rowHeaderReasons: {},
          rawFallbackCells: { external: 0, zeroShift: 0, allCancelled: 0 },
          note: "原檔搵唔到 sheet「2026」",
        });
        continue;
      }
      const mergedWb = new ExcelJS.Workbook();
      const mergedWs = mergedWb.addWorksheet("2026");
      const depotOrder = cityBusSites.map((s) => (s.rosterLayout as { depotOrder?: string[] } | null)?.depotOrder).find((d) => Array.isArray(d) && d.length > 0) as string[] | undefined;
      const orderedCityBusSites = depotOrder
        ? [...cityBusSites].sort((a, b) => {
            const ia = depotOrder.findIndex((d) => a.aliases.includes(d) || a.canonicalName === d);
            const ib = depotOrder.findIndex((d) => b.aliases.includes(d) || b.canonicalName === d);
            if (ia === -1 && ib === -1) return a.canonicalName.localeCompare(b.canonicalName);
            if (ia === -1) return 1;
            if (ib === -1) return -1;
            return ia - ib;
          })
        : [...cityBusSites].sort((a, b) => a.canonicalName.localeCompare(b.canonicalName));

      let runningOffset = 0;
      const combinedSpans: GuardRowSpan[] = [];
      const combinedRawFallback: RawFallbackCells = { external: 0, zeroShift: 0, allCancelled: 0 };
      for (const s of orderedCityBusSites) {
        const { workbook, blockCount, rawFallbackCells } = await buildRosterWorkbookForSite(s.id, month, { derivedOnly: true });
        if (rawFallbackCells) {
          combinedRawFallback.external += rawFallbackCells.external;
          combinedRawFallback.zeroShift += rawFallbackCells.zeroShift;
          combinedRawFallback.allCancelled += rawFallbackCells.allCancelled;
        }
        if (blockCount === 0) continue;
        const srcWs = workbook.getWorksheet("2026")!;
        const template = s.rosterLayout as unknown;
        if (isRosterLayoutTemplate(template)) {
          for (const sp of computeGuardRowSpans(template, DAYS)) {
            combinedSpans.push({ ...sp, from: sp.from + runningOffset, to: sp.to + runningOffset });
          }
        }
        for (let r = 1; r <= srcWs.rowCount; r++) {
          const row = srcWs.getRow(r);
          const rowNum = mergedWs.rowCount + 1;
          mergedWs.addRow([]);
          row.eachCell({ includeEmpty: true }, (cell, col) => {
            const v = cellEffectiveRaw(cell);
            if (v === null || v === undefined || v === "") return;
            mergedWs.getCell(rowNum, col).value = v as ExcelJS.CellValue;
          });
        }
        runningOffset += srcWs.rowCount;
      }
      const { day, structural, rowHeader, rowHeaderReasons } = compareDerivedSheets(
        file,
        mergedWs,
        wsOrig,
        combinedSpans,
        "citybus",
        pointerExcludedByFile.get(file) ?? emptySet,
      );
      derivedFileSummaries.push({
        file,
        matched: `城巴車廠 8 廠合併（${orderedCityBusSites.map((s) => s.canonicalName).join("、")}）`,
        day,
        structural,
        rowHeader,
        rowHeaderReasons,
        rawFallbackCells: combinedRawFallback,
        note: depotOrder ? "depot 次序跟 site.roster_layout.depot_order" : "冇搵到 depot_order 模板",
      });
      continue;
    }

    const matchedSite = matchSiteForFile(file, core, coreNoSpace, sites);
    if (!matchedSite) {
      derivedUnmatchedFiles.push(file);
      derivedFileSummaries.push({
        file,
        matched: "(冇配對到)",
        day: { same: 0, diff: 0, excluded: 0 },
        structural: { same: 0, diff: 0, excluded: 0 },
        rowHeader: { same: 0, diff: 0, excluded: 0 },
        rowHeaderReasons: {},
        rawFallbackCells: { external: 0, zeroShift: 0, allCancelled: 0 },
        note: "搵唔到對應 DB site",
      });
      continue;
    }

    const wbOrig = new ExcelJS.Workbook();
    await wbOrig.xlsx.readFile(path.join(dataDir, file));
    const wsOrig = wbOrig.getWorksheet("2026");
    if (!wsOrig) {
      derivedFileSummaries.push({
        file,
        matched: matchedSite.canonicalName,
        day: { same: 0, diff: 0, excluded: 0 },
        structural: { same: 0, diff: 0, excluded: 0 },
        rowHeader: { same: 0, diff: 0, excluded: 0 },
        rowHeaderReasons: {},
        rawFallbackCells: { external: 0, zeroShift: 0, allCancelled: 0 },
        note: "原檔搵唔到 sheet「2026」",
      });
      continue;
    }

    const { workbook, blockCount, layout, rawFallbackCells } = await buildRosterWorkbookForSite(matchedSite.id, month, { derivedOnly: true });
    const wsDb = workbook.getWorksheet("2026")!;
    const template = matchedSite.rosterLayout as unknown;
    const spans = isRosterLayoutTemplate(template) ? computeGuardRowSpans(template, DAYS) : [];
    const { day, structural, rowHeader, rowHeaderReasons } = compareDerivedSheets(file, wsDb, wsOrig, spans, layout, pointerExcludedByFile.get(file) ?? emptySet);
    derivedFileSummaries.push({
      file,
      matched: `${matchedSite.canonicalName}(${layout})`,
      day,
      structural,
      rowHeader,
      rowHeaderReasons,
      rawFallbackCells: rawFallbackCells ?? { external: 0, zeroShift: 0, allCancelled: 0 },
      note: blockCount === 0 ? "DB 呢個月冇呢個 site 嘅 shift_records（0 block）" : spans.length === 0 ? "冇 roster_layout 模板，跌返 buildGenericRosterWorkbook（冇 guard_rows span，全部格當結構格）" : "",
    });
  }

  const outDir = path.resolve(process.cwd(), "out/p1");
  fs.mkdirSync(outDir, { recursive: true });

  const csvPath = path.join(outDir, "roster-export-diff-derived.csv");
  const header = "file,sheet,cell,db_value,orig_value\n";
  const csv =
    header +
    derivedDiffs.map((d) => [d.file, d.sheet, d.cell, d.db_value, d.orig_value].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\n");
  fs.writeFileSync(csvPath, csv);

  const sumBucket = (get: (f: DerivedFileSummary) => CellBucket): CellBucket =>
    derivedFileSummaries.reduce((a, f) => ({ same: a.same + get(f).same, diff: a.diff + get(f).diff, excluded: a.excluded + get(f).excluded }), {
      same: 0,
      diff: 0,
      excluded: 0,
    });
  const totalDay = sumBucket((f) => f.day);
  const totalStructural = sumBucket((f) => f.structural);
  const totalRowHeader = sumBucket((f) => f.rowHeader);
  const zeroDiffFiles = derivedFileSummaries.filter((f) => f.day.diff === 0 && f.structural.diff === 0 && f.matched !== "(冇配對到)").length;

  // A1：加總逐檔 raw_fallback_cells，計返「純推導覆蓋率」——分母用
  // totalDay.same+totalDay.diff（即全部逐日格總數，唔理 excluded），
  // 分子係「冇用 raw fallback」嗰啲格（總數減 external／zeroShift 兩類
  // fallback 行嘅格數估算：呢度用 block 數量做粗略指標，見下面 note）。
  const totalRawFallback: RawFallbackCells = derivedFileSummaries.reduce(
    (a, f) => ({
      external: a.external + f.rawFallbackCells.external,
      zeroShift: a.zeroShift + f.rawFallbackCells.zeroShift,
      allCancelled: a.allCancelled + f.rawFallbackCells.allCancelled,
    }),
    { external: 0, zeroShift: 0, allCancelled: 0 },
  );
  // R2（Opus 對抗式驗收第二輪）：`allCancelled` 計落分子（總 fallback
  // 行數），令「純推導覆蓋率」呢個報表數字會因為有人 void 咗成行嘢而
  // 真係跌——唔靜靜哋當冇事（呢類行雖然係純 DB 推導，但內容已經同
  // 原檔唔一致，見 RosterExportResult.rawFallbackCells 頂註解）。
  const totalRawFallbackRows = totalRawFallback.external + totalRawFallback.zeroShift + totalRawFallback.allCancelled;
  const totalDayCells = totalDay.same + totalDay.diff;
  const pureDerivationCoveragePct = totalDayCells > 0 ? Number((((totalDayCells - totalRawFallbackRows) / totalDayCells) * 100).toFixed(2)) : null;

  const summaryJson = {
    mode: "derived",
    month: monthLabel,
    fileCount: files.length,
    zeroDiffFiles,
    totals: { day: totalDay, structural: totalStructural, rowHeader: totalRowHeader },
    rawFallbackCells: {
      ...totalRawFallback,
      totalRows: totalRawFallbackRows,
      note: "呢度嘅數係「用咗 raw-literal fallback 嘅行數／同原檔已經唔一致嘅行數」（一行可能跨多個逐日格），唔係逐格數——external＝該行喺冇 isExternal/source 濾走版本其實有紀錄（外援/借調安員），zeroShift＝成個月嗰行乜更都冇排過，純粹跟原檔印；allCancelled＝呢一行曾經有記錄但全部已經 void（R1/R2）——純 DB 推導、唔用 raw 字面，但內容已經同原檔唔一致。",
      pureDerivationCoveragePctApprox: pureDerivationCoveragePct,
    },
    unmatchedFiles: derivedUnmatchedFiles,
    fileSummaries: derivedFileSummaries,
    knownLayoutDetectionCaveat: KNOWN_LAYOUT_DETECTION_CAVEAT,
  };
  fs.writeFileSync(path.join(outDir, "roster-export-diff-derived-summary.json"), JSON.stringify(summaryJson, null, 2));

  console.log(`[roster-export-diff --derived] month=${monthLabel}，寫咗 ${derivedDiffs.length} 行差異去 ${csvPath}`);
  console.log("[roster-export-diff --derived] 逐份檔案結果（day＝逐日格／structural＝結構格／row_header＝行首欄）：");
  for (const f of derivedFileSummaries) {
    const reasonSummary = Object.entries(f.rowHeaderReasons)
      .map(([k, v]) => `${k}×${v}`)
      .join("；");
    const rawFallbackSummary =
      f.rawFallbackCells.external + f.rawFallbackCells.zeroShift + f.rawFallbackCells.allCancelled > 0
        ? ` | raw_fallback_rows=${f.rawFallbackCells.external + f.rawFallbackCells.zeroShift + f.rawFallbackCells.allCancelled}（external=${f.rawFallbackCells.external}, zeroShift=${f.rawFallbackCells.zeroShift}, allCancelled=${f.rawFallbackCells.allCancelled}）`
        : "";
    console.log(
      `  ${f.file} -> ${f.matched}: day 相同=${f.day.same}（含 excluded_by_design=${f.day.excluded}）差異=${f.day.diff} | structural 相同=${f.structural.same} 差異=${f.structural.diff} | row_header 相同=${f.rowHeader.same} 差異=${f.rowHeader.diff}${reasonSummary ? "（" + reasonSummary + "）" : ""}${rawFallbackSummary}${f.note ? " | " + f.note : ""}`,
    );
  }
  if (derivedUnmatchedFiles.length) {
    console.log(`[roster-export-diff --derived] 配對唔到嘅檔案（${derivedUnmatchedFiles.length}）: ${derivedUnmatchedFiles.join("; ")}`);
  }
  console.log(
    `[roster-export-diff --derived] summary: day 相同=${totalDay.same}（含 excluded_by_design=${totalDay.excluded}）差異=${totalDay.diff}｜structural 相同=${totalStructural.same} 差異=${totalStructural.diff}｜row_header 相同=${totalRowHeader.same} 差異=${totalRowHeader.diff}`,
  );
  console.log(
    `[roster-export-diff --derived] A1 raw_fallback_cells: 總行數=${totalRawFallbackRows}（external=${totalRawFallback.external}, zeroShift=${totalRawFallback.zeroShift}, allCancelled=${totalRawFallback.allCancelled}）｜純推導覆蓋率（逐日格，粗估）=${pureDerivationCoveragePct === null ? "N/A" : pureDerivationCoveragePct + "%"}`,
  );
  if (derivedViolations.length) {
    console.log("[roster-export-diff --derived] 逐日格／結構格違規例子（上限 5 格）：");
    for (const v of derivedViolations) console.log(`  ${v}`);
  }

  if (totalDay.diff > 0 || totalStructural.diff > 0 || derivedUnmatchedFiles.length > 0) process.exitCode = 1;
}

async function main() {
  const month = parseMonthArg(process.argv.slice(2));
  const monthLabel = `${month.getUTCFullYear()}-${String(month.getUTCMonth() + 1).padStart(2, "0")}`;
  const monthAbbr = MONTH_ABBR[month.getUTCMonth()]!;
  const dataDir = path.resolve(process.cwd(), `data/${monthLabel}`);

  if (!fs.existsSync(dataDir)) {
    console.error(`[roster-export-diff] 搵唔到 ${dataDir}——本機冇呢個月嘅原始 xlsx，做唔到呢個 gate`);
    process.exitCode = 1;
    return;
  }

  const files = fs.readdirSync(dataDir).filter((f) => f.endsWith(".xlsx"));
  const sites = await prisma.site.findMany();
  const cityBusSites = sites.filter((s) => s.clientGroup === "城巴車廠");

  // Gate 2（`--derived`）：完全獨立嘅一條路徑（見 runDerivedGate()），
  // 用完即刻 return，唔會行落面 Gate 1 嗰段（兩個 gate 唔應該喺同一次
  // process 入面一齊跑，输出檔案分開）。
  if (process.argv.includes("--derived")) {
    await runDerivedGate(month, monthLabel, monthAbbr, dataDir, files, sites, cityBusSites);
    return;
  }

  for (const file of files) {
    const core = fileCoreName(file, monthAbbr);
    const coreNoSpace = normSpace(core);

    // ---- 城巴車廠：8 個 DB site 掛喺同一個合併檔（特殊處理，見頂註解） ----
    if (coreNoSpace === normSpace("城巴車廠")) {
      const wbOrig = new ExcelJS.Workbook();
      await wbOrig.xlsx.readFile(path.join(dataDir, file));
      const wsOrig = wbOrig.getWorksheet("2026");
      if (!wsOrig) {
        fileSummaries.push({ file, matched: "城巴車廠(8廠合併)", sameCells: 0, diffCells: 0, note: "原檔搵唔到 sheet「2026」" });
        continue;
      }
      const mergedWb = new ExcelJS.Workbook();
      const mergedWs = mergedWb.addWorksheet("2026");
      let anyBlock = false;
      // P1-WP3 規劃裁定（第二輪）：depot 次序由 `site.roster_layout.
      // depot_order`（seed 時由 data/ 反推，見 scripts/seed/lib/
      // roster-layout.ts）決定，唔再用 canonicalName 字母序估——每個
      // 城巴 DB site 嘅 aliases 入面應該搵到一個 depotOrder 嘅名。
      const depotOrder = cityBusSites.map((s) => (s.rosterLayout as { depotOrder?: string[] } | null)?.depotOrder).find((d) => Array.isArray(d) && d.length > 0) as string[] | undefined;
      const orderedCityBusSites = depotOrder
        ? [...cityBusSites].sort((a, b) => {
            const ia = depotOrder.findIndex((d) => a.aliases.includes(d) || a.canonicalName === d);
            const ib = depotOrder.findIndex((d) => b.aliases.includes(d) || b.canonicalName === d);
            if (ia === -1 && ib === -1) return a.canonicalName.localeCompare(b.canonicalName);
            if (ia === -1) return 1;
            if (ib === -1) return -1;
            return ia - ib;
          })
        : [...cityBusSites].sort((a, b) => a.canonicalName.localeCompare(b.canonicalName));
      for (const s of orderedCityBusSites) {
        const { workbook, blockCount } = await buildRosterWorkbookForSite(s.id, month);
        if (blockCount === 0) continue;
        anyBlock = true;
        const srcWs = workbook.getWorksheet("2026")!;
        // P1-WP3 Gate 1 階段 2 修正：`eachRow()` 冇 `{includeEmpty:true}`
        // 預設會跳過完全冇 cell 嘅 row（`blank` section／`emitBlankRow()`
        // 寫嘅純空行）——逐個 depot 合併嗰陣，每個 depot 自己嘅「blank」
        // gap 行會靜靜哋喺 merge 度冧咗（唔存在喺 mergedWs），累計落去
        // 令之後每一個 depot 嘅內容都向上錯位（實測：8 廠合併 2705 格
        // 差異嘅主因）。`{includeEmpty:true}` 逐行掃到 `srcWs.rowCount`
        // 為止（連空行都經 callback），先至保證逐個 depot 貢獻嘅實際
        // row 數同佢自己個 workbook 嘅 rowCount 一致。
        for (let r = 1; r <= srcWs.rowCount; r++) {
          const row = srcWs.getRow(r);
          // P1-WP3 第三輪：揪到一個真 bug——ExcelJS `row.values` 本身已經
          // 係 1-indexed（index0 係 placeholder，index1=col1……），`addRow()`
          // 接受嘅陣列**都係同一個 1-indexed 慣例**（唔係一般 0-indexed
          // array）。舊版 `.slice(1)` 當咗 `addRow` 要 0-indexed，累計做
          // 咗第二次移位，成個城巴 8 廠合併嘅內容全部向左錯咗一格
          // （3172/啟航1331 呢類單一 site 檔案冇經呢個 merge 路徑，唔會
          // 撞到）。而家直接將 `row.values` 原封不動傳落 `addRow`。
          //
          // Gate 1 階段 2 修正（第二個真 bug）：`row.values` 讀 formula
          // 格嗰陣淨係攞 ExcelJS `cell.value`（`{formula:"..."}`，唔含
          // `result`——`result` 淨係喺獨立嘅 `cell.result` getter 度攞
          // 得到，見 roster-export-diff.ts 頂 `cellEffectiveRaw()` 同一個
          // 手法），實測：`row.values` 逐格 roundtrip 會將 formula 格嘅
          // cached result 整丟（跌返 `undefined`），令好似 COUNTIF 計出
          // 嚟係 0 嘅格喺合併之後變成完全空白。呢個 gate 本身淨係比較
          // 「值」（唔理格式/公式），merge 呢步索性直接用 `cellEffectiveRaw()`
          // 攞返每格嘅 resolved 值（formula 格用 `cell.result`，其餘格
          // 原樣），寫落 mergedWs——唔淨係唔跌值，仲順便令 merged sheet
          // 同 `compareSheets()` 睇緊嘅嘢完全一致（少一重轉換）。
          const rowNum = mergedWs.rowCount + 1;
          mergedWs.addRow([]);
          row.eachCell({ includeEmpty: true }, (cell, col) => {
            const v = cellEffectiveRaw(cell);
            if (v === null || v === undefined || v === "") return;
            mergedWs.getCell(rowNum, col).value = v as ExcelJS.CellValue;
          });
        }
      }
      const { same, diff } = compareSheets(file, "2026", mergedWs, wsOrig);
      fileSummaries.push({
        file,
        matched: `城巴車廠 8 廠合併（${orderedCityBusSites.map((s) => s.canonicalName).join("、")}）`,
        sameCells: same,
        diffCells: diff,
        note: depotOrder
          ? "depot 次序跟 site.roster_layout.depot_order（由 data/ 反推）"
          : "冇搵到 depot_order 模板，跌返用 canonicalName 字母序——位置差異屬預期" + (anyBlock ? "" : "；8 個 site 呢個月全部冇 shift_records（0 block）"),
      });
      continue;
    }

    // ---- 一般情況：一個檔一個 site ----
    const overrideCandidates = new Set<string>();
    for (const [canon, extra] of Object.entries(FILE_MATCH_OVERRIDES)) {
      if (extra.some((e) => normSpace(e) === coreNoSpace)) overrideCandidates.add(canon);
    }
    let matchedSite = sites.find((s) => {
      const canonNoSpace = normSpace(s.canonicalName);
      if (canonNoSpace === coreNoSpace) return true;
      if (s.aliases.some((a) => normSpace(a) === coreNoSpace)) return true;
      if (overrideCandidates.has(canonNoSpace)) return true;
      return false;
    });
    if (!matchedSite) {
      // C1（自我覆核發現）：短/通用嘅 alias（例如「HKU」）用純
      // substring match 會撞正唔啱嘅 site（「HKU座頭 C更」呢個檔案
      // includes("HKU")，令佢錯配去「HKU Y更」，因為個 site 陣列次序
      // 岩岩行到嗰個先）。改做「揀全部候選入面 match 到嘅字串最長嗰
      // 個」（最具體），唔係「陣列行到邊個就用邊個」。
      let bestLen = 0;
      for (const s of sites) {
        for (const n of [s.canonicalName, ...s.aliases]) {
          if (!n) continue;
          if (file.includes(n) || core.includes(n)) {
            if (n.length > bestLen) {
              bestLen = n.length;
              matchedSite = s;
            }
          }
        }
      }
    }
    if (!matchedSite) {
      unmatchedFiles.push(file);
      fileSummaries.push({ file, matched: "(冇配對到)", sameCells: 0, diffCells: 0, note: "搵唔到對應 DB site——見上面 print" });
      console.log(`[roster-export-diff] 配對唔到: ${file}（核心檔名: ${core}）`);
      continue;
    }

    const wbOrig = new ExcelJS.Workbook();
    await wbOrig.xlsx.readFile(path.join(dataDir, file));
    const wsOrig = wbOrig.getWorksheet("2026");
    if (!wsOrig) {
      fileSummaries.push({ file, matched: matchedSite.canonicalName, sameCells: 0, diffCells: 0, note: "原檔搵唔到 sheet「2026」" });
      continue;
    }

    const { workbook, blockCount, layout } = await buildRosterWorkbookForSite(matchedSite.id, month);
    const wsDb = workbook.getWorksheet("2026")!;
    const { same, diff } = compareSheets(file, "2026", wsDb, wsOrig);
    fileSummaries.push({
      file,
      matched: `${matchedSite.canonicalName}(${layout})`,
      sameCells: same,
      diffCells: diff,
      note: blockCount === 0 ? "DB 呢個月冇呢個 site 嘅 shift_records（0 block，原檔可能有資料但 DB 冇對應記錄）" : "",
    });
  }

  const outDir = path.resolve(process.cwd(), "out/p1");
  fs.mkdirSync(outDir, { recursive: true });

  const csvPath = path.join(outDir, "roster-export-diff.csv");
  const header = "file,sheet,cell,db_value,orig_value\n";
  const csv =
    header +
    diffs
      .map((d) => [d.file, d.sheet, d.cell, d.db_value, d.orig_value].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(","))
      .join("\n");
  fs.writeFileSync(csvPath, csv);

  const totalDiff = fileSummaries.reduce((a, f) => a + f.diffCells, 0);
  const totalSame = fileSummaries.reduce((a, f) => a + f.sameCells, 0);
  const zeroDiffFiles = fileSummaries.filter((f) => f.diffCells === 0 && f.matched !== "(冇配對到)").length;
  const summaryJson = {
    month: monthLabel,
    fileCount: files.length,
    zeroDiffFiles,
    totalSameCells: totalSame,
    totalDiffCells: totalDiff,
    unmatchedFiles,
    fileSummaries,
    knownLayoutDetectionCaveat: KNOWN_LAYOUT_DETECTION_CAVEAT,
  };
  fs.writeFileSync(path.join(outDir, "roster-export-diff-summary.json"), JSON.stringify(summaryJson, null, 2));

  console.log(`[roster-export-diff] month=${monthLabel}，寫咗 ${diffs.length} 行差異去 ${csvPath}`);
  console.log(`[roster-export-diff] KNOWN_LAYOUT_DETECTION_CAVEAT: ${KNOWN_LAYOUT_DETECTION_CAVEAT}`);
  console.log("[roster-export-diff] 逐份檔案結果：");
  for (const f of fileSummaries) {
    console.log(`  ${f.file} -> ${f.matched}: 相同=${f.sameCells} 差異=${f.diffCells}${f.note ? " | " + f.note : ""}`);
  }
  if (unmatchedFiles.length) {
    console.log(`[roster-export-diff] 配對唔到嘅檔案（${unmatchedFiles.length}）: ${unmatchedFiles.join("; ")}`);
  }
  console.log(
    `[roster-export-diff] summary: ${fileSummaries.length} 份檔案，${zeroDiffFiles} 份 0-diff，相同格數=${totalSame}，差異格數=${totalDiff}，未配對=${unmatchedFiles.length}`,
  );

  if (totalDiff > 0 || unmatchedFiles.length > 0) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error("[roster-export-diff] 失敗", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
