// WP-LTSHIFT §19（老闆 2026-09-26 第二部分）：讀「Postorder - Aug
// 2026.xlsm」呢類總表（`PostOrder`／`Roster`／`Summary`／`Master` 四個
// sheet），抽兩樣嘢俾 guard-fix plan 用：
//   1. `parsePostorderLongtermPostsFromWorkbook()`——`Roster` sheet 每一
//      日 7 個子欄（[日期,雞頭名,備註,其他,救更價,Unbilled,Paid]，由
//      col H 起，逐日 7 欄），雞頭名寫「(8) 長工」嗰格就係話「呢一更
//      係長工做自己崗位」，「備註」子欄直接寫住邊個長工個名——盤（`物業
//      名稱`，col C）＋人名（備註）逐格計數，就係老闆講嘅「56 個 (盤,
//      人) 組合、1,293 格」嗰個資料源。
//   2. `parsePostorderReferralRowsFromWorkbook()`——`PostOrder` sheet
//      col A 寫「長工雞頭費 (雞頭)」嗰啲行，`外判價` 欄（col F）係公式
//      `=<rate>*SUM(AM<r1>,AM<r2>,...)`，`AM` 欄（col 39,"Total Shift"）
//      已經係嗰行成月更數嘅計算結果，唔使自己逐日逐格重新加。
//
// 兩個都係**純函數**（吃 ExcelJS Workbook，冇 DB 依賴），對唔到就漏
// 呢一格／呢一行，唔會估——同 `src/lib/roster-upload/match.ts` 一貫
// 「對唔到→null，唔准估」嘅原則一致。單元測試用合成 workbook，見
// `tests/wp-ltshift-postorder-parse.test.ts`。
//
// 鐵則：呢個檔冇任何硬編碼真名／工號——`brokerLabelRaw`／`guardNameRaw`
// 呢類值全部嚟自上載嘅檔案內容，唔係寫死喺 code 度。回傳嘅結構只喺
// plan 計算嗰一刻喺記憶體用（`postorder_uploads.parse_summary` 只存
// 數目，唔存呢啲值——見 route.ts）。
//
// WP-POSTORDER-CSV（老闆 2026-09-26 緊急）：正式站操作員（老闆帳號）
// 用嘅工具處理唔到 binary（.xlsm／.xlsx），淨係可以喺 Google Drive 網頁
// 用 Google Sheets 打開再逐個 sheet「下載為 CSV」攞到文字。所以呢個檔
// 加咗一條「CSV 路徑」，同 xlsm 路徑輸出一樣嘅解析結果——做法：兩條路徑
// 都先將嗰個 sheet 讀成一個統一嘅二維 `PostorderGrid`（1-based 行／
// 列，同 ExcelJS `row.getCell(col)` 嘅座標一致），再用**同一套**對 grid
// 操作嘅 `parsePostorderLongtermPostsFromGrid()`／
// `parsePostorderReferralRowsFromGrid()` 邏輯，確保兩條路徑格位置判斷
// 邏輯完全一樣、唔會兩份代碼慢慢飄開。
//
// 兩條路徑有一個**無可避免嘅差異**：介紹費行嘅 `rate`／`shifts`／
// `siteLabelsRaw`／`guardNamesRaw` 呢幾樣嘢，xlsm 路徑係由 col F 嘅
// **公式文字**（`=50*SUM(AM24,AM38)` 呢種，AM24／AM38 可以係完全唔連續
// 嘅員工行，例如數碼港 CP5／數據中心兩個姊妹盤互相 cross-reference）
// 推返出嚟；Google Sheets 「下載為 CSV」淨係匯出公式**計算咗嘅值**，
// 冇公式文字，所以邊幾個員工行俾邊個介紹費行 SUM 埋一齊呢個關係喺 CSV
// 入面客觀上冧唔返——唔估：CSV 路徑呢幾個欄位老實答 `null`／空
// array／0，唔會靠猜位置屈一個答案出嚟。`brokerLabelRaw`（col A 文字
// 直接讀）同 `excelAmount`（col F 嘅快取數值，Sheets 匯出時仍然係
// 呢個公式當其時算低嘅數）兩條路徑都攞得到，`rowIndex` 兩條路徑都係
// 原始 sheet 行號（CSV 匯出保留晒空行，行號唔會飄）。
//
// 呢個設計同 `src/lib/reports/referral-fee.ts` 嘅
// `syncReferralRatesFromPostorder()` 啱啱好夾得埋：嗰個函數淨係識
// upsert `row.rate !== null` 嘅組合——CSV 路徑嘅介紹費行 `rate` 全部
// `null`，自然 0 upsert，跌返用 `referral_fee_rates` 表入面已有嘅費率
// （由 migration 種低，或者之前 xlsm 上載寫低嗰批）：「有公式費率就用
// （xlsm 路徑），冇（CSV 路徑）就用表入面已有費率——效果一樣」。
import ExcelJS from "exceljs";
import { parse as parseCsvSync } from "csv-parse/sync";

const ROSTER_SHEET_NAME = "Roster";
const POSTORDER_SHEET_NAME = "PostOrder";
const AM_COLUMN = 39; // "Total Shift"（COUNTA(H:AL)嘅計算結果）
const DAYS_IN_GRID = 31; // 更表格位固定 31 日（大月留位；細月尾幾組全空，唔影響）
const ROSTER_MIN_COLS = 10 + 7 * DAYS_IN_GRID; // 逐日 7 欄，最後一組嘅備註欄

const POSTORDER_VISA_UNSUPPORTED_REASON =
  "Postorder 總表冇顯式「簽證形式長工」標記（冇獨立分頁／專屬欄位）——" +
  "呢批人 8 月靠老闆人手核對確認，屬一次性業務判斷，未有可重複嘅資料來源可以" +
  "喺 production parser 自動判定，set_visa 暫時一律 0 項";

export interface PostorderLongtermPostCell {
  /** 「客戶名稱」去咗人名尾段嘅字句（優先用嚟 matchSite，比短代號更
   * 具體）——**注意**：呢個字句有時會夾埋 zone/更份代號（例如「啟航
   * 1331 IC」、「啟航1331 K」，IC/K 係 zone 唔係盤名一部分），令
   * `matchSite()` 撞唔中；呢種情況要靠 `siteLabelFallbackRaw`。 */
  siteLabelRaw: string;
  /** 「物業名稱」短代號原文（col C，例：CP5／DC／港C／啟航／柴廠）——
   * `siteLabelRaw` 對唔中 site 嗰陣嘅 fallback，短代號冇 zone 後綴
   * 污染，配合 `sites.aliases` 補齊短代號之後命中率高好多。同
   * `siteLabelRaw` 一樣先都 null＝呢行冇「物業名稱」（理論上唔會出現，
   * 因為呢個 function 本身已經 `if (!prop) continue`）。 */
  siteLabelFallbackRaw: string | null;
  /** 「備註」子欄寫嘅人名原文（未經 matchGuard）。 */
  guardNameRaw: string;
  /** 呢個 (盤,人) 組合喺成份 Roster 表撞中幾多格「(8) 長工」。 */
  cellCount: number;
}

export interface PostorderReferralRow {
  /** PostOrder sheet 原始行號，追溯用。 */
  rowIndex: number;
  /** 介紹費行 col A 括號入面嘅雞頭稱呼原文，例如「淦」/「Wing」/「鄧」。 */
  brokerLabelRaw: string;
  /** 每更費率（由公式 `=<rate>*...` 讀出，讀唔到就 null——CSV 路徑冇
   * 公式文字，一律 null，見檔頭註解）。 */
  rate: number | null;
  /** 呢行公式引用嗰批「AM」欄（更數）加埋嘅總更數（CSV 路徑冇公式，
   * 冧唔返邊幾行屬於呢行，一律 0，見檔頭註解）。 */
  shifts: number;
  /** Excel 自己算低嘅快取金額（col F 嘅 formula result，Google Sheets
   * 匯出 CSV 都會保留呢個計算咗嘅值）——用嚟做總額核對（8 月：21 行
   * 加埋 = 60,520，同外判價欄一致，唔使再乘一次）。 */
  excelAmount: number | null;
  /** 呢行公式引用嗰啲員工行嘅「客戶名稱」去人名字句（去重，見
   * `PostorderLongtermPostCell.siteLabelRaw` 同款註解；CSV 路徑一律
   * 空 array，見檔頭註解）。 */
  siteLabelsRaw: string[];
  /** 呢行公式引用嗰啲員工行嘅「物業名稱」短代號原文（去重）——
   * `siteLabelsRaw` 對唔中嗰陣嘅 fallback（CSV 路徑一律空 array）。 */
  siteLabelsFallbackRaw: string[];
  /** 呢行公式引用嗰啲員工行嘅人名原文（由 col A 尾段中文字截出，去重；
   * CSV 路徑一律空 array）。 */
  guardNamesRaw: string[];
  /** 原始公式文字（audit 用；CSV 路徑冇公式文字，一律 null）。 */
  formula: string | null;
}

export interface PostorderVisaResult {
  supported: false;
  reason: string;
}

export interface PostorderParseResult {
  longtermPosts: PostorderLongtermPostCell[];
  referralRows: PostorderReferralRow[];
  visa: PostorderVisaResult;
  /** 兩個 sheet 攞唔到就記低喺度（唔 throw，等上層決定點處理）。 */
  missingSheets: string[];
}

// ---------------------------------------------------------------------------
// ExcelJS cell 讀值 helper——同 `src/lib/guard-fix/sources.ts` 嘅
// `cellText()` 一致手法（`.value` 係 union type，rich text／formula／
// shared formula 要逐種攤平）。
// ---------------------------------------------------------------------------
function cellText(row: ExcelJS.Row, col1based: number): string | null {
  const v: unknown = row.getCell(col1based).value;
  return valueToText(v);
}

function valueToText(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "object") {
    if ("richText" in (v as Record<string, unknown>)) {
      const s = (v as { richText: Array<{ text?: string }> }).richText.map((t) => t.text ?? "").join("");
      const trimmed = s.trim();
      return trimmed === "" ? null : trimmed;
    }
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    if ("result" in (v as Record<string, unknown>)) {
      return valueToText((v as { result: unknown }).result);
    }
    if ("sharedFormula" in (v as Record<string, unknown>) && "result" in (v as Record<string, unknown>)) {
      return valueToText((v as { result: unknown }).result);
    }
    return null;
  }
  const s = String(v).trim();
  return s === "" ? null : s;
}

/** formula cell 嘅公式文字（讀唔到就 null）——`.formula` 先有先算，`.value`
 * 唔係 formula cell（普通字串/數字/richText）就 null。 */
function cellFormula(row: ExcelJS.Row, col1based: number): string | null {
  const v: unknown = row.getCell(col1based).value;
  if (v && typeof v === "object" && "formula" in (v as Record<string, unknown>)) {
    return String((v as { formula: unknown }).formula);
  }
  return null;
}

/** col A 常見寫法「盤名 人名」／「盤名 CP5 人名」——截尾段 2-4 個中文
 * 字當人名（同 `data/2026-09/aug-payroll-trial/scripts/s05_price.py`
 * `build_po_longterm_posts()` 一致嘅 regex，純粹讀輔助資訊，唔係業務
 * 判斷本身——`parsePostorderReferralRowsFromWorkbook()` 用嚟填
 * `guardNamesRaw`，冇截到就唔放入去，唔會擋公式主體嘅 rate/shifts）。 */
function trailingChineseName(s: string | null): string | null {
  if (!s) return null;
  const m = s.trim().match(/[一-鿿]{2,4}$/);
  return m ? m[0] : null;
}

// ---------------------------------------------------------------------------
// PostorderGrid——xlsm／CSV 兩條路徑共用嘅二維格位表示（1-based 行／
// 列，`grid[r][c]`；`grid[0]`／每行嘅 `[0]` 唔用，純粹等座標同 ExcelJS
// 嘅 `row.getCell(col1based)` 一致，睇落易 map）。格值統一係
// string／null（數字都存做字串，讀嗰陣先 `gridNumber()` 解析——CSV
// 嘅格本身就淨係字串，xlsm 嗰邊用 `cellText()` 攤平之後都係字串，
// 兩條路徑先可以用同一套 grid 邏輯）。
// ---------------------------------------------------------------------------
type PostorderGrid = (string | null)[][];

function gridText(grid: PostorderGrid, r: number, c: number): string | null {
  return grid[r]?.[c] ?? null;
}

const NUMBER_RE = /^-?\d+(\.\d+)?$/;

function gridNumber(grid: PostorderGrid, r: number, c: number): number | null {
  const t = gridText(grid, r, c);
  if (t === null) return null;
  // Sheets 匯出嘅數字格有時帶千分位逗號（例如 "1,250"）——去咗先解析。
  const cleaned = t.replace(/,/g, "").trim();
  if (!NUMBER_RE.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** 由 ExcelJS worksheet 起一個 grid（`minCols` 保證起碼有幾多欄，
 * 就算 ExcelJS 話 `columnCount` 冇咁多、最尾幾欄全空都照樣讀到——
 * 例如 Roster sheet 最尾幾組 31 日格位可能一格都冇填）。 */
function gridFromWorksheet(ws: ExcelJS.Worksheet, minCols: number): PostorderGrid {
  const grid: PostorderGrid = [[]];
  const maxCol = Math.max(ws.columnCount, minCols);
  for (let r = 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const gridRow: (string | null)[] = [null];
    for (let c = 1; c <= maxCol; c++) gridRow.push(cellText(row, c));
    grid.push(gridRow);
  }
  return grid;
}

/** 由 CSV 文字（Google Sheets「下載為 CSV」嘅格式：逗號、引號包裹、
 * cell 入面可以有換行——RFC4180）起一個 grid。`skip_empty_lines:false`
 * 保留晒空行，等行號唔會飄（`rowIndex`／`AM<row>` 呢類參照要行號準）。 */
function gridFromCsvText(csvText: string): PostorderGrid {
  const stripped = csvText.replace(/^﻿/, ""); // Google Sheets CSV 匯出帶 UTF-8 BOM
  const rows = parseCsvSync(stripped, {
    bom: true,
    relax_column_count: true,
    skip_empty_lines: false,
  }) as string[][];
  const grid: PostorderGrid = [[]];
  for (const row of rows) {
    const gridRow: (string | null)[] = [null];
    for (const cell of row) {
      const t = (cell ?? "").trim();
      gridRow.push(t === "" ? null : t);
    }
    grid.push(gridRow);
  }
  return grid;
}

// ---------------------------------------------------------------------------
// 對 grid 操作嘅共用解析邏輯——xlsm／CSV 兩條路徑喺讀成 grid 之後
// 就係用返同一套嘢，格位置判斷唔會兩份代碼飄開。
// ---------------------------------------------------------------------------

/** Roster grid 逐格「(8) 長工」——見檔頭註解。淨係計「備註」子欄有人
 * 名嗰啲格（冇人名就冧唔到係邊個，保守唔計入）。 */
function parsePostorderLongtermPostsFromGrid(grid: PostorderGrid): PostorderLongtermPostCell[] {
  const agg = new Map<string, PostorderLongtermPostCell>();
  const rowCount = grid.length - 1;
  for (let r = 8; r <= rowCount; r++) {
    const prop = gridText(grid, r, 3); // 「物業名稱」（短代號，例：CP5／數碼／柴廠）
    const client = gridText(grid, r, 1); // 「客戶名稱」（完整字句，例：數碼港 CP5 李文豪）
    if (!prop) continue;
    for (let k = 0; k < DAYS_IN_GRID; k++) {
      const brokerCol = 9 + 7 * k;
      const noteCol = 10 + 7 * k;
      const brokerRaw = gridText(grid, r, brokerCol);
      if (!brokerRaw || !brokerRaw.includes("長工")) continue;
      const noteRaw = gridText(grid, r, noteCol);
      if (!noteRaw) continue; // 保守：冇備註人名就唔計呢格
      const stripped = client && client.endsWith(noteRaw) ? client.slice(0, client.length - noteRaw.length).trim() : null;
      const siteLabelRaw = stripped || prop;
      const key = `${siteLabelRaw}\u0000${noteRaw}`;
      const cur = agg.get(key);
      if (cur) cur.cellCount += 1;
      else agg.set(key, { siteLabelRaw, siteLabelFallbackRaw: prop, guardNameRaw: noteRaw, cellCount: 1 });
    }
  }
  return [...agg.values()];
}

/** PostOrder grid「長工雞頭費 (雞頭)」行——見檔頭註解。`formulaAt(r)`
 * 傳 `null`（CSV 路徑冇公式文字）就攞唔到 `rate`／`shifts`／
 * `siteLabelsRaw`／`guardNamesRaw`，老實答空／null，唔估。 */
function parsePostorderReferralRowsFromGrid(grid: PostorderGrid, formulaAt: ((r: number) => string | null) | null): PostorderReferralRow[] {
  const out: PostorderReferralRow[] = [];
  const rowCount = grid.length - 1;
  for (let r = 1; r <= rowCount; r++) {
    const a = gridText(grid, r, 1);
    if (!a || !a.includes("雞頭費")) continue;
    const formula = formulaAt ? formulaAt(r) : null;
    const excelAmount = gridNumber(grid, r, 6);
    const m = a.match(/\(([^)]+)\)/);
    const brokerLabelRaw = (m ? m[1] : a).trim();
    const rateMatch = formula ? formula.match(/^\s*(\d+(?:\.\d+)?)\s*\*/) : null;
    const rate = rateMatch ? Number(rateMatch[1]) : null;

    const refs: number[] = [];
    if (formula) {
      const re = /AM(\d+)(?::AM(\d+))?/g;
      let mm: RegExpExecArray | null;
      while ((mm = re.exec(formula))) {
        const a1 = Number(mm[1]);
        const a2 = mm[2] ? Number(mm[2]) : a1;
        for (let x = a1; x <= a2; x++) refs.push(x);
      }
    }

    let shifts = 0;
    const siteSet = new Set<string>();
    const siteFallbackSet = new Set<string>();
    const nameSet = new Set<string>();
    for (const rr of refs) {
      const amVal = gridNumber(grid, rr, AM_COLUMN);
      if (typeof amVal === "number") shifts += amVal;
      const refClient = gridText(grid, rr, 1);
      const nm = trailingChineseName(refClient);
      if (nm) nameSet.add(nm);
      const stripped = refClient && nm && refClient.endsWith(nm) ? refClient.slice(0, refClient.length - nm.length).trim() : null;
      const refProp = gridText(grid, rr, 3);
      const siteLabel = stripped || refProp;
      if (siteLabel) siteSet.add(siteLabel);
      if (refProp) siteFallbackSet.add(refProp);
    }

    out.push({
      rowIndex: r,
      brokerLabelRaw,
      rate,
      shifts,
      excelAmount,
      siteLabelsRaw: [...siteSet],
      siteLabelsFallbackRaw: [...siteFallbackSet],
      guardNamesRaw: [...nameSet],
      formula,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// xlsm 路徑（公開 API，向下相容——簽名／行為同 refactor 之前一樣，淨係
// 內部改咗做「先讀成 grid，再用共用邏輯」）。
// ---------------------------------------------------------------------------

export async function loadPostorderWorkbook(buffer: Buffer): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  return wb;
}

/** Roster sheet 逐格「(8) 長工」——見檔頭註解。 */
export function parsePostorderLongtermPostsFromWorkbook(wb: ExcelJS.Workbook): PostorderLongtermPostCell[] {
  const ws = wb.getWorksheet(ROSTER_SHEET_NAME);
  if (!ws) return [];
  return parsePostorderLongtermPostsFromGrid(gridFromWorksheet(ws, ROSTER_MIN_COLS));
}

/** PostOrder sheet「長工雞頭費 (雞頭)」行——見檔頭註解。 */
export function parsePostorderReferralRowsFromWorkbook(wb: ExcelJS.Workbook): PostorderReferralRow[] {
  const ws = wb.getWorksheet(POSTORDER_SHEET_NAME);
  if (!ws) return [];
  const grid = gridFromWorksheet(ws, AM_COLUMN);
  return parsePostorderReferralRowsFromGrid(grid, (r) => cellFormula(ws.getRow(r), 6));
}

/** 簽證形式長工——Postorder（`PostOrder`／`Roster`／`Summary`／`Master`
 * 四個 sheet）冇任何顯式簽證形式長工標記（冇獨立 sheet、冇專屬欄位）。
 * 8 月呢批人淨係靠老闆人手核對（`data/2026-09/aug-payroll-verify/
 * scripts/boss_answers.py` 嘅 `VISA_SPONSOR_STAFF`，dev-only、gitignored
 * `data/` 底下）先確認，屬一次性人手判斷，唔可以喺冇明確資料來源之下
 * 喺 production parser 度自動判定（會屈估）。所以呢度老實答
 * `supported:false`，`set_visa` 呢類計劃暫時一律 0 項；如果 Postorder
 * 之後加返呢個標記，呢個 function 要補實作（唔喺呢度讀 boss_answers.py
 * ——嗰個檔案本身係 python、亦唔應該畀 production 依賴 dev-only 私有
 * 資料）。 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- 簽名保留 wb 參數，等 Postorder 之後加返簽證標記就有嘢讀
export function parsePostorderVisaStaff(_wb: ExcelJS.Workbook): PostorderVisaResult {
  return { supported: false, reason: POSTORDER_VISA_UNSUPPORTED_REASON };
}

/** 一次過解析成個 Postorder workbook，俾 upload route／guard-fix plan 共用
 * （避免各自 load 一次 ExcelJS workbook）。 */
export async function parsePostorderWorkbookBuffer(buffer: Buffer): Promise<PostorderParseResult> {
  const wb = await loadPostorderWorkbook(buffer);
  const missingSheets: string[] = [];
  if (!wb.getWorksheet(ROSTER_SHEET_NAME)) missingSheets.push(ROSTER_SHEET_NAME);
  if (!wb.getWorksheet(POSTORDER_SHEET_NAME)) missingSheets.push(POSTORDER_SHEET_NAME);
  return {
    longtermPosts: parsePostorderLongtermPostsFromWorkbook(wb),
    referralRows: parsePostorderReferralRowsFromWorkbook(wb),
    visa: parsePostorderVisaStaff(wb),
    missingSheets,
  };
}

// ---------------------------------------------------------------------------
// CSV 路徑（WP-POSTORDER-CSV）——Google Sheets「下載為 CSV」，Roster／
// PostOrder 兩個分頁各一份 CSV 文字，格位置邏輯同 xlsm 路徑一樣（共用
// `parsePostorderLongtermPostsFromGrid()`／
// `parsePostorderReferralRowsFromGrid()`），差異見檔頭註解。
// ---------------------------------------------------------------------------

/** Roster CSV（Google Sheets 匯出）→ 長工格解析，同
 * `parsePostorderLongtermPostsFromWorkbook()` 一樣嘅結果（呢部分冇公式
 * 依賴，CSV／xlsm 兩條路徑應該逐項相等）。 */
export function parsePostorderLongtermPostsFromCsvGrid(csvText: string): PostorderLongtermPostCell[] {
  return parsePostorderLongtermPostsFromGrid(gridFromCsvText(csvText));
}

/** PostOrder CSV（Google Sheets 匯出）→ 介紹費行解析——冇公式文字，
 * `rate`／`shifts`／`siteLabelsRaw`／`guardNamesRaw`／`formula` 老實答
 * null／空，`brokerLabelRaw`／`excelAmount`／`rowIndex` 照樣讀到，見
 * 檔頭註解。 */
export function parsePostorderReferralRowsFromCsvGrid(csvText: string): PostorderReferralRow[] {
  return parsePostorderReferralRowsFromGrid(gridFromCsvText(csvText), null);
}

export interface PostorderCsvSource {
  /** Roster 分頁匯出嘅 CSV 文字；null＝冇上載呢一份（`missingSheets` 會
   * 記低 `Roster`）。 */
  rosterCsv: string | null;
  /** PostOrder 分頁匯出嘅 CSV 文字；null＝冇上載呢一份（`missingSheets`
   * 會記低 `PostOrder`）。 */
  postorderCsv: string | null;
}

/** 兩份 CSV（Roster／PostOrder）→ 同 `parsePostorderWorkbookBuffer()`
 * 一樣形狀嘅 `PostorderParseResult`，等 upload route／guard-fix plan
 * 唔使分 xlsm／CSV 兩套邏輯處理結果。 */
export function parsePostorderFromCsv(source: PostorderCsvSource): PostorderParseResult {
  const missingSheets: string[] = [];
  if (!source.rosterCsv) missingSheets.push(ROSTER_SHEET_NAME);
  if (!source.postorderCsv) missingSheets.push(POSTORDER_SHEET_NAME);
  return {
    longtermPosts: source.rosterCsv ? parsePostorderLongtermPostsFromCsvGrid(source.rosterCsv) : [],
    referralRows: source.postorderCsv ? parsePostorderReferralRowsFromCsvGrid(source.postorderCsv) : [],
    visa: { supported: false, reason: POSTORDER_VISA_UNSUPPORTED_REASON },
    missingSheets,
  };
}

/** `postorder_uploads` 一行嘅原始 bytes——`rosterCsvBytes`／
 * `postorderCsvBytes` 有值就係 CSV 上載（優先用），冇就跌返用
 * `fileBytes`（xlsm）。同 Prisma 生成嘅 `PostorderUpload` 形狀相容，
 * 淨係揀呢個函數用得到嘅幾個欄位，方便測試起假資料。 */
export interface PostorderUploadBytesSource {
  fileBytes: Buffer | Uint8Array;
  rosterCsvBytes?: Buffer | Uint8Array | null;
  postorderCsvBytes?: Buffer | Uint8Array | null;
}

/** 統一入口——upload route／guard-fix plan／referral-fee rate sync 呢類
 * 要重新解析 `postorder_uploads` 一行嘅地方，一律用呢個函數，唔使自己
 * 判斷「呢份係 xlsm 定 CSV」（判斷邏輯集中喺呢度一個地方）。 */
export async function parsePostorderUploadRow(row: PostorderUploadBytesSource): Promise<PostorderParseResult> {
  if (row.rosterCsvBytes || row.postorderCsvBytes) {
    return parsePostorderFromCsv({
      rosterCsv: row.rosterCsvBytes ? Buffer.from(row.rosterCsvBytes).toString("utf-8") : null,
      postorderCsv: row.postorderCsvBytes ? Buffer.from(row.postorderCsvBytes).toString("utf-8") : null,
    });
  }
  return parsePostorderWorkbookBuffer(Buffer.from(row.fileBytes));
}

/** 上載嗰刻要存嘅摘要——淨係數目，冇姓名（鐵則）。 */
export function summarizePostorderParse(result: PostorderParseResult) {
  const siteCount = new Set(result.longtermPosts.map((p) => p.siteLabelRaw)).size;
  const cellCount = result.longtermPosts.reduce((acc, p) => acc + p.cellCount, 0);
  const referralTotal = result.referralRows.reduce((acc, r) => acc + (r.excelAmount ?? 0), 0);
  return {
    longterm_site_count: siteCount,
    longterm_post_pair_count: result.longtermPosts.length,
    longterm_cell_count: cellCount,
    referral_row_count: result.referralRows.length,
    referral_total_excel_amount: Math.round(referralTotal * 100) / 100,
    visa_supported: result.visa.supported,
    missing_sheets: result.missingSheets,
  };
}
