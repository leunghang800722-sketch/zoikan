// WP-POSTORDER-ROBUST（老闆 2026-09-27 緊急）：正式站操作員真實
// Google Sheets「下載為 CSV」樣本證實：Roster CSV 表頭實際喺第 8 行
// （第 1 行合併日期大標題、第 7 行 Total 行帶引號千分位數字，成隻月份
// 有幾多行前置標題行會隨總表版本飄，唔可以硬編碼「表頭喺第 7 行、
// 資料由第 8 行起」）；同埋 8 月呢份總表 236 個「客戶名稱」／「物業
// 名稱」欄好可能係垂直合併儲存格（Excel/Google Sheets 畫面顯示成一個
// 盤跨幾行），CSV 匯出淨係喺合併範圍最頂一格有值，之後幾行呢兩欄會係
// 空白——舊版 `parsePostorderLongtermPostsFromGrid()` 見到 `!prop` 就
// `continue`，一整個盤淨係第一行（通常仲要係冇雞頭資料嘅「總計」行）
// 攞到值，之後成批帶「(8) 長工」嘅真正更表行全部因為呢兩欄空白而漏
// 咗——呢個先係老闆話「1,295 格／56 組合 → 0」嘅根本原因（唔係欄
// 位置錯，實測欄位置 col1/3/9/10 呢類 9+7k 公式對真樣本仍然啱）。
// 修法：
//   1. 表頭唔再假設行號——`detectRosterHeader()` 喺頭 20 行搵一行同時
//      有「客戶名稱」／「物業名稱」文字，再喺嗰行搵晒逐個「雞頭名」
//      子欄嘅位置（唔靠日期格式，日期格式好多變、亦唔影響格位置判斷）
//      推 `dayBlockWidth`／`firstDayCol`，搵唔到就老實答 `parseError`，
//      唔會靜靜輸出 0。
//   2. 表頭下一行起，逐行對「物業名稱」／「客戶名稱」呢兩欄做「向下
//      補值」（forward-fill，同 Excel/Sheets 合併儲存格 CSV 匯出之後
//      淨係最頂一格有值嘅慣例做法一致）——呢兩欄淨係讀值，唔會屈估
//      任何雞頭／人名，純粹補返「呢一行屬於邊個盤」呢個資訊。
//   3. 文字比對一律用 `normalizeText()`（NFKC）——全形／半形括號同
//      空格（「(8) 長工」／「（8）長工」／「(8)長工」）、BOM、CRLF 都
//      要認得。
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
//
// WP-POSTORDER-PAIRS-CSV（老闆 2026-09-27 緊急）：正式站操作員只可以
// 傳文字檔——Google Sheets 匯出完整 Roster 分頁（2,996 行、760KB）
// 持續 503，而且 AI 轉錄成隻 63KB CSV 會令格位錯位。所以加第三條、
// 極精簡嘅路徑：`longterm-pairs.csv`（`site_label,site_short,
// guard_name,cell_count` 四欄，一行一個 (盤,人) 組合，約 60 行、
// ~3KB，人手／AI 都可以準確轉錄）取代整份 Roster CSV——
// `parseLongtermPairsCsv()` 直接讀呢四欄，唔使再靠 `detectRosterHeader()`
// 喺成個 grid 度搵表頭／逐格掃「(8) 長工」。`postorder_csv`（介紹費行）
// 依然可選：冇上載就同「CSV 路徑冇 PostOrder」一樣，`referralRows` 空
// array、`missingSheets` 記低 `PostOrder`。
//
// WP-POSTORDER-PO-PAIRS（老闆 2026-09-27 再緊急）：連 `longterm-
// pairs.csv`（第三條路徑，上面）操作員都傳唔到——正式站個工具連 3KB
// 嘅精簡 CSV 都上載唔到（同 Roster CSV 一樣嘅上載瓶頸），但正式站
// **已經有**一份完整、冇截短嘅 `PostOrder.csv`（815 行，`data/2026-09/
// postorder-csv/PostOrder.csv` 係同一份樣本）。目標：單靠呢份
// PostOrder.csv（唔使 Roster／pairs 任何一份）都推到（盤,人）長工組合
// 出嚟。
//
// 實測（`data/2026-09/postorder-csv/PostOrder.csv`）：PostOrder 分頁
// 表頭第 7 行「客戶名稱,Customer Code,物業名稱,更份,上單價,外判價,
// 時間,1-8月,…,31-8月,Total Shift」；長工行嘅「客戶名稱」（col A）
// 尾段會夾埋人名（同 `trailingChineseName()` 截法一致），特徵：
//   (a) 「外判價」（col F）＝`#REF!`（連去外部長工 roster 檔，個公式
//       喺 Google Sheets 匯出 CSV 已經算唔到，剩低錯誤字面）——實測
//       58 行、56 組、Total Shift 合計 1,250；
//   (b) 罕見情況：「外判價」係一個數字（例如 545）但「客戶名稱」都係
//       「盤名 人名」形狀——呢種淨係喺呢個人已經係 DB 已知長工
//       （`employment_type` 開頭 `longterm_`）先當佢係自己崗位一更
//       （避免一般客戶盤名尾段啱啱好似人名嘅 false positive）；
//   (c) 「外判價」＝`#REF!` 但 Total Shift＝0（Roster 表其實有格）——
//       都要保留呢個 (盤,人) 組合（`cellCount:0`），唔會因為呢一行冧
//       唔到格數就成個組合漏晒。
// 規則：「客戶名稱」尾 token 係一個系統已知安員姓名（`guards.name_zh`
// 或 `name_aliases`，NFKC 正規化）**且**（外判價＝`#REF!` **或**
// 呢個安員 `employment_type` 已經係 `longterm_` 開頭）→ 呢一行就係
// 「呢個安員自己嘅崗位」。對比 Roster 真值 60 組／1,295 格，呢條規則
// 覆蓋到 59 組／1,294 格（只差 1 格 OT——太泛用嘅代號，同
// docs/api.md A. 段落講嘅 matchSite 剩低 2 格 OT 落差一致，向來留返
// 人手覆核，唔會屈估）。
//
// `derivePostorderLongtermPostsFromPostorderGrid()`／
// `derivePostorderLongtermPostsFromPostorderCsv()` 依然係**純函數**
// ——`knownNames`／`longtermEmploymentNames` 呢兩個 name set 由 caller
// （`plan.ts` `buildGuardFixPlan()`）由 DB `guards` 表建，呢個檔冇任何
// DB 依賴、冇硬編碼真名。合併策略（「Roster/pairs 路徑有嘅 pairs 優先，
// 再 union PostOrder 推出嘅 pairs，同一 (盤,人) cell_count 取大」）喺
// `plan.ts` `mergeLongtermPostCells()` 做，唔喺呢個檔。
import ExcelJS from "exceljs";
import { parse as parseCsvSync } from "csv-parse/sync";

export const ROSTER_SHEET_NAME = "Roster";
export const POSTORDER_SHEET_NAME = "PostOrder";
export const AM_COLUMN = 39; // "Total Shift"（COUNTA(H:AL)嘅計算結果）
const DAYS_IN_GRID = 31; // 更表格位固定 31 日（大月留位；細月尾幾組全空，唔影響）
export const ROSTER_MIN_COLS = 10 + 7 * DAYS_IN_GRID; // 逐日 7 欄，最後一組嘅備註欄

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
  /** Roster 表頭偵測結果（`null`＝搵唔到 sheet，或者搵咗都搵唔到表頭）
   * ——診斷用，upload route 存入 `parseSummary` 俾操作員睇。 */
  rosterHeaderRow: number | null;
  /** 逐日 block 闊度（正常 7：日期／雞頭名／備註／其他／救更價／
   * Unbilled／Paid）——搵唔到就 `null`。 */
  rosterDayBlockWidth: number | null;
  /** 第一個逐日 block 嘅日期欄（1-based col）——搵唔到就 `null`。 */
  rosterFirstDayCol: number | null;
  /** 表頭偵測唔到就喺度講明原因（唔會靜靜輸出 0）；有 sheet 又搵到表頭
   * 就係 `null`。 */
  rosterParseError: string | null;
  /** WP-POSTORDER-PO-PAIRS：PostOrder 分頁 CSV 原文（冇上載就 `null`）
   * ——`plan.ts` 用嚟 call `derivePostorderLongtermPostsFromPostorderCsv()`
   * 補推(盤,人)組合（要 DB 安員名先做到，呢個檔本身唔存 DB 依賴，所以
   * 淨係留低原文俾識 DB 嗰邊用）。xlsm 路徑冇獨立 CSV 原文，一律
   * `null`（呢個功能專門解正式站「淨係傳到 PostOrder.csv」嗰個場景）。 */
  postorderCsvText: string | null;
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
      return normalizeText(s);
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
  return normalizeText(String(v));
}

/** 文字容忍（WP-POSTORDER-ROBUST）：NFKC 令全形／半形括號同空格睇齊
 * （「（8）長工」／「(8) 長工」／「(8)長工」NFKC 之後括號同空格一致，
 * 淨係差喺有冇空格，`.includes("長工")` 唔受影響），再 trim。xlsm／CSV
 * 兩條路徑起 grid 嗰陣都行呢個 helper，令格值比較（表頭字眼、「長工」
 * 標記、「雞頭費」）唔使自己度全形半形。 */
function normalizeText(s: string): string | null {
  const t = s.normalize("NFKC").trim();
  return t === "" ? null : t;
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
export type PostorderGrid = (string | null)[][];

export function gridText(grid: PostorderGrid, r: number, c: number): string | null {
  return grid[r]?.[c] ?? null;
}

const NUMBER_RE = /^-?\d+(\.\d+)?$/;

export function gridNumber(grid: PostorderGrid, r: number, c: number): number | null {
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
export function gridFromWorksheet(ws: ExcelJS.Worksheet, minCols: number): PostorderGrid {
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
export function gridFromCsvText(csvText: string): PostorderGrid {
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
      gridRow.push(normalizeText(cell ?? ""));
    }
    grid.push(gridRow);
  }
  return grid;
}

// ---------------------------------------------------------------------------
// 對 grid 操作嘅共用解析邏輯——xlsm／CSV 兩條路徑喺讀成 grid 之後
// 就係用返同一套嘢，格位置判斷唔會兩份代碼飄開。
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Roster 表頭偵測（WP-POSTORDER-ROBUST）——唔再假設「表頭喺第 7 行、
// 資料由第 8 行起」，喺頭幾行搵表頭文字自己推行號／欄位置。
// ---------------------------------------------------------------------------
const HEADER_SEARCH_ROWS = 15; // 表頭理應喺呢個範圍內（真樣本：第 8 行）

export interface RosterHeader {
  headerRow: number;
  clientCol: number; // 「客戶名稱」
  propCol: number; // 「物業名稱」
  /** 逐日 block 嘅「雞頭名」子欄位置，升序排列；「備註」子欄固定喺
   * 隔籬（`brokerCol + 1`）——真樣本兩個 sheet 都係呢個相對位置。 */
  brokerCols: number[];
  /** 相鄰 block 嘅欄距（例如 7）——搵到 2 個或以上 block 先計得到，
   * 唔一致就揀出現次數最多嗰個（保守，唔畀單一格漏空拉歪個數）。 */
  dayBlockWidth: number | null;
}

/** 頭 `HEADER_SEARCH_ROWS` 行搵一行同時有「客戶名稱」／「物業名稱」
 * 文字嗰行做表頭，再喺嗰行搵晒每個「雞頭名」子欄嘅位置——搵唔到就
 * `null`，等上層老實答 parseError（唔會靜靜當 0）。 */
export function detectRosterHeader(grid: PostorderGrid): RosterHeader | null {
  const rowCount = grid.length - 1;
  const searchRows = Math.min(HEADER_SEARCH_ROWS, rowCount);
  for (let r = 1; r <= searchRows; r++) {
    const row = grid[r];
    if (!row) continue;
    let clientCol: number | null = null;
    let propCol: number | null = null;
    const brokerCols: number[] = [];
    for (let c = 1; c < row.length; c++) {
      const t = row[c];
      if (t === "客戶名稱") clientCol = c;
      else if (t === "物業名稱") propCol = c;
      else if (t === "雞頭名") brokerCols.push(c);
    }
    if (clientCol === null || propCol === null) continue;
    return { headerRow: r, clientCol, propCol, brokerCols, dayBlockWidth: modeDiff(brokerCols) };
  }
  return null;
}

/** 相鄰數值嘅眾數差距——用嚟由「雞頭名」欄位置推 block 闊度。 */
function modeDiff(cols: number[]): number | null {
  if (cols.length < 2) return null;
  const counts = new Map<number, number>();
  for (let i = 1; i < cols.length; i++) {
    const d = cols[i] - cols[i - 1];
    counts.set(d, (counts.get(d) ?? 0) + 1);
  }
  let best: number | null = null;
  let bestCount = 0;
  for (const [d, count] of counts) {
    if (count > bestCount) {
      best = d;
      bestCount = count;
    }
  }
  return best;
}

export interface RosterLongtermParseOutcome {
  cells: PostorderLongtermPostCell[];
  headerRow: number | null;
  dayBlockWidth: number | null;
  firstDayCol: number | null;
  parseError: string | null;
}

/** Roster grid 逐格「(8) 長工」——見檔頭註解。淨係計「備註」子欄有人
 * 名嗰啲格（冇人名就冧唔到係邊個，保守唔計入）；「物業名稱」／
 * 「客戶名稱」向下補值（合併儲存格 CSV 匯出之後淨係最頂一格有值嘅
 * 慣例做法），冇上一個值就當空白行跳過。 */
function parsePostorderLongtermPostsFromGridDetailed(grid: PostorderGrid): RosterLongtermParseOutcome {
  const header = detectRosterHeader(grid);
  if (!header) {
    return {
      cells: [],
      headerRow: null,
      dayBlockWidth: null,
      firstDayCol: null,
      parseError: "Roster 搵唔到表頭（要有「客戶名稱」／「物業名稱」欄）——請檢查係咪 Roster 分頁匯出嘅 CSV",
    };
  }
  if (header.brokerCols.length === 0) {
    return {
      cells: [],
      headerRow: header.headerRow,
      dayBlockWidth: null,
      firstDayCol: null,
      parseError: `Roster 表頭（第 ${header.headerRow} 行）搵唔到逐日「雞頭名」子欄——請檢查係咪 Roster 分頁匯出嘅 CSV`,
    };
  }

  const agg = new Map<string, PostorderLongtermPostCell>();
  const rowCount = grid.length - 1;
  let lastProp: string | null = null;
  let lastClient: string | null = null;
  for (let r = header.headerRow + 1; r <= rowCount; r++) {
    const propRaw = gridText(grid, r, header.propCol); // 「物業名稱」（短代號，例：CP5／數碼／柴廠）
    const clientRaw = gridText(grid, r, header.clientCol); // 「客戶名稱」（完整字句，例：數碼港 CP5 李文豪）
    if (propRaw !== null) lastProp = propRaw;
    if (clientRaw !== null) lastClient = clientRaw;
    const prop = propRaw ?? lastProp; // 向下補值——見上面函數註解
    const client = clientRaw ?? lastClient;
    if (!prop) continue;
    for (const brokerCol of header.brokerCols) {
      const noteCol = brokerCol + 1;
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
  return {
    cells: [...agg.values()],
    headerRow: header.headerRow,
    dayBlockWidth: header.dayBlockWidth,
    firstDayCol: header.brokerCols[0] - 1,
    parseError: null,
  };
}

/** 向下相容嘅簡化版本——淨係要格位陣列嗰啲呼叫方（現有測試／
 * `parsePostorderLongtermPostsFromWorkbook`／`...FromCsvGrid`）用呢個；
 * 要診斷資訊（`header_row`／`parse_error` 呢類）用
 * `parsePostorderLongtermPostsFromGridDetailed()`。 */
function parsePostorderLongtermPostsFromGrid(grid: PostorderGrid): PostorderLongtermPostCell[] {
  return parsePostorderLongtermPostsFromGridDetailed(grid).cells;
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

/** 同 `parsePostorderLongtermPostsFromWorkbook()`，但連表頭偵測診斷
 * （`header_row`／`day_block_width`／`first_day_col`／`parse_error`）一齊
 * 攞返——冇 Roster sheet 就 `null`（`missingSheets` 已經記低）。 */
function parsePostorderLongtermPostsFromWorkbookDetailed(wb: ExcelJS.Workbook): RosterLongtermParseOutcome | null {
  const ws = wb.getWorksheet(ROSTER_SHEET_NAME);
  if (!ws) return null;
  return parsePostorderLongtermPostsFromGridDetailed(gridFromWorksheet(ws, ROSTER_MIN_COLS));
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
  const roster = parsePostorderLongtermPostsFromWorkbookDetailed(wb);
  return {
    longtermPosts: roster?.cells ?? [],
    referralRows: parsePostorderReferralRowsFromWorkbook(wb),
    visa: parsePostorderVisaStaff(wb),
    missingSheets,
    rosterHeaderRow: roster?.headerRow ?? null,
    rosterDayBlockWidth: roster?.dayBlockWidth ?? null,
    rosterFirstDayCol: roster?.firstDayCol ?? null,
    rosterParseError: roster?.parseError ?? null,
    postorderCsvText: null, // xlsm 路徑冇獨立 CSV 原文
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

/** 同 `parsePostorderLongtermPostsFromCsvGrid()`，連表頭偵測診斷一齊
 * 攞返（見 `parsePostorderLongtermPostsFromWorkbookDetailed()` 同款）。 */
function parsePostorderLongtermPostsFromCsvGridDetailed(csvText: string): RosterLongtermParseOutcome {
  return parsePostorderLongtermPostsFromGridDetailed(gridFromCsvText(csvText));
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
  const roster = source.rosterCsv ? parsePostorderLongtermPostsFromCsvGridDetailed(source.rosterCsv) : null;
  return {
    longtermPosts: roster?.cells ?? [],
    referralRows: source.postorderCsv ? parsePostorderReferralRowsFromCsvGrid(source.postorderCsv) : [],
    visa: { supported: false, reason: POSTORDER_VISA_UNSUPPORTED_REASON },
    missingSheets,
    rosterHeaderRow: roster?.headerRow ?? null,
    rosterDayBlockWidth: roster?.dayBlockWidth ?? null,
    rosterFirstDayCol: roster?.firstDayCol ?? null,
    rosterParseError: roster?.parseError ?? null,
    postorderCsvText: source.postorderCsv,
  };
}

// ---------------------------------------------------------------------------
// 精簡長工組合 CSV 路徑（WP-POSTORDER-PAIRS-CSV）——見檔頭註解。表頭
// 固定四欄，冇 day-grid 要掃，一行就係一個 (盤,人) 組合嘅格數，人手／
// AI 都可以準確轉錄。
// ---------------------------------------------------------------------------

const LONGTERM_PAIRS_HEADER = ["site_label", "site_short", "guard_name", "cell_count"] as const;
const LONGTERM_PAIRS_CELL_COUNT_RE = /^\d+$/;

export interface LongtermPairsParseOutcome {
  cells: PostorderLongtermPostCell[];
  parseError: string | null;
}

/** `longterm-pairs.csv`（`site_label,site_short,guard_name,cell_count`）
 * → `PostorderLongtermPostCell[]`，同 Roster 路徑（`parsePostorderLongterm
 * PostsFromGrid()`）輸出結構一致：`siteLabelRaw`＝`site_label`，
 * `siteLabelFallbackRaw`＝`site_short`，`guardNameRaw`＝`guard_name`，
 * `cellCount`＝`cell_count`（要係非負整數）。表頭唔啱、缺欄、
 * `cell_count` 唔係整數都老實答 `parseError`，唔會估。BOM／CRLF／
 * 全形字符（NFKC）都經 `normalizeText()`／`csv-parse` 處理，同其他
 * CSV 路徑一致容忍度。 */
export function parseLongtermPairsCsv(text: string): LongtermPairsParseOutcome {
  // BOM／CRLF／CR 全部正規化先交俾 csv-parse（Windows Excel、Sheets 匯出各有唔同）
  const stripped = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  let rows: string[][];
  try {
    rows = parseCsvSync(stripped, {
      bom: true,
      relax_column_count: true,
      skip_empty_lines: true,
    }) as string[][];
  } catch (e) {
    return { cells: [], parseError: `longterm-pairs CSV 解析失敗：${e instanceof Error ? e.message : String(e)}` };
  }
  if (rows.length === 0) {
    return { cells: [], parseError: "longterm-pairs CSV 係空嘅" };
  }
  const header = rows[0].map((h) => (normalizeText(h) ?? "").toLowerCase());
  const headerOk = LONGTERM_PAIRS_HEADER.length === header.length && LONGTERM_PAIRS_HEADER.every((h, i) => header[i] === h);
  if (!headerOk) {
    return {
      cells: [],
      parseError: `longterm-pairs CSV 表頭要係「${LONGTERM_PAIRS_HEADER.join(",")}」（實際：「${rows[0].join(",")}」）`,
    };
  }

  const cells: PostorderLongtermPostCell[] = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const siteLabelRaw = normalizeText(row[0] ?? "");
    const siteShortRaw = normalizeText(row[1] ?? "");
    const guardNameRaw = normalizeText(row[2] ?? "");
    const cellCountRaw = normalizeText(row[3] ?? "");
    if (!siteLabelRaw || !guardNameRaw || !cellCountRaw) {
      return { cells: [], parseError: `longterm-pairs CSV 第 ${i + 1} 行缺欄（要有 site_label／guard_name／cell_count）` };
    }
    if (!LONGTERM_PAIRS_CELL_COUNT_RE.test(cellCountRaw)) {
      return { cells: [], parseError: `longterm-pairs CSV 第 ${i + 1} 行 cell_count「${cellCountRaw}」唔係非負整數` };
    }
    cells.push({
      siteLabelRaw,
      siteLabelFallbackRaw: siteShortRaw,
      guardNameRaw,
      cellCount: Number(cellCountRaw),
    });
  }
  return { cells, parseError: null };
}

export interface PostorderPairsCsvSource {
  /** `longterm-pairs.csv` 文字（必須有——冇呢份就唔會行呢條路徑，見
   * `parsePostorderUploadRow()`）。 */
  longtermPairsCsv: string;
  /** PostOrder 分頁 CSV（介紹費行）；null＝冇上載，`missingSheets` 記低
   * `PostOrder`，`referralRows` 空 array（同其他 CSV 路徑一致行為）。 */
  postorderCsv: string | null;
}

/** `longterm-pairs.csv`（＋可選 PostOrder CSV）→ 同 `parsePostorderFromCsv()`
 * 一樣形狀嘅 `PostorderParseResult`。冇 day-grid 表頭可偵測，
 * `rosterHeaderRow`／`rosterDayBlockWidth`／`rosterFirstDayCol` 一律
 * `null`；`rosterParseError` 帶 `parseLongtermPairsCsv()` 嘅結果。 */
export function parsePostorderFromPairsCsv(source: PostorderPairsCsvSource): PostorderParseResult {
  const outcome = parseLongtermPairsCsv(source.longtermPairsCsv);
  const missingSheets: string[] = [];
  if (!source.postorderCsv) missingSheets.push(POSTORDER_SHEET_NAME);
  return {
    longtermPosts: outcome.cells,
    referralRows: source.postorderCsv ? parsePostorderReferralRowsFromCsvGrid(source.postorderCsv) : [],
    visa: { supported: false, reason: POSTORDER_VISA_UNSUPPORTED_REASON },
    missingSheets,
    rosterHeaderRow: null,
    rosterDayBlockWidth: null,
    rosterFirstDayCol: null,
    rosterParseError: outcome.parseError,
    postorderCsvText: source.postorderCsv,
  };
}

// ---------------------------------------------------------------------------
// PostOrder-only 推長工組合（WP-POSTORDER-PO-PAIRS）——見檔頭註解。
// 純函數：`grid`（PostOrder 分頁）逐行掃，`knownNames`／
// `longtermEmploymentNames` 兩個 name set 由 caller（`plan.ts`）由 DB
// `guards` 表建（`name_zh`＋`name_aliases`，NFKC 正規化）。
// ---------------------------------------------------------------------------

/** PostOrder grid 逐行推「長工崗位 (盤,人)」組合——見檔頭 WP-POSTORDER-
 * PO-PAIRS 段落嘅規則：「客戶名稱」（col A）尾 token 係 `knownNames`
 * 入面一個名，且（「外判價」col F＝`#REF!`，或者呢個名喺
 * `longtermEmploymentNames`——即係 DB 已經係 `longterm_*` 嘅安員）先
 * 當呢一行係「呢個安員自己嘅崗位」。已經由
 * `parsePostorderReferralRowsFromGrid()` 處理嗰啲「長工雞頭費」行
 * （col A 含「雞頭費」）唔會喺呢度再計一次。
 *
 * `siteLabelRaw`＝「客戶名稱」剝走尾段人名之後 trim；`siteLabelFallbackRaw`
 * ＝「物業名稱」（col C）；`cellCount`＝「Total Shift」（col AM/39）——
 * 讀唔到／0 都保留呢個組合（唔會因為呢一行冧唔到格數就漏咗成個組合，
 * 見檔頭 (c) 個案）。同一個 (盤,人) 喺 grid 出現多過一行就加埋
 * cellCount（理論上 PostOrder 一個人一個盤一個月得一行，呢度純粹
 * 保守處理，唔假設）。 */
export function derivePostorderLongtermPostsFromPostorderGrid(
  grid: PostorderGrid,
  knownNames: Set<string>,
  longtermEmploymentNames: Set<string> = new Set(),
): PostorderLongtermPostCell[] {
  const agg = new Map<string, PostorderLongtermPostCell>();
  const rowCount = grid.length - 1;
  for (let r = 1; r <= rowCount; r++) {
    const clientRaw = gridText(grid, r, 1); // 「客戶名稱」
    if (!clientRaw) continue;
    if (clientRaw.includes("雞頭費")) continue; // 介紹費行由 parsePostorderReferralRowsFromGrid() 處理
    const guardNameRaw = trailingChineseName(clientRaw);
    if (!guardNameRaw || !knownNames.has(guardNameRaw)) continue; // 尾段唔係已知安員姓名——一般客戶／盤名，唔計
    const priceRaw = gridText(grid, r, 6); // 「外判價」
    const isRefPrice = priceRaw === "#REF!";
    if (!isRefPrice && !longtermEmploymentNames.has(guardNameRaw)) continue; // 兩個條件都唔中——保守唔計（避免 false positive）
    const siteLabelRaw = clientRaw.endsWith(guardNameRaw) ? clientRaw.slice(0, clientRaw.length - guardNameRaw.length).trim() : "";
    if (!siteLabelRaw) continue; // 剝晒淨番人名，冧唔到盤名——保守跳過，唔靠估
    const propRaw = gridText(grid, r, 3); // 「物業名稱」
    const cellCount = gridNumber(grid, r, AM_COLUMN) ?? 0;
    const key = `${siteLabelRaw}\u0000${guardNameRaw}`;
    const cur = agg.get(key);
    if (cur) {
      cur.cellCount += cellCount;
      if (!cur.siteLabelFallbackRaw && propRaw) cur.siteLabelFallbackRaw = propRaw;
    } else {
      agg.set(key, { siteLabelRaw, siteLabelFallbackRaw: propRaw, guardNameRaw, cellCount });
    }
  }
  return [...agg.values()];
}

/** 同 `derivePostorderLongtermPostsFromPostorderGrid()`，但直接食 PostOrder
 * 分頁 CSV 原文（`PostorderParseResult.postorderCsvText`）——`plan.ts`
 * 淨係接觸得到 CSV 原文，唔識 `PostorderGrid` 呢個內部型別，用呢個
 * wrapper 唔使匯出 grid 建構邏輯。 */
export function derivePostorderLongtermPostsFromPostorderCsv(
  postorderCsvText: string,
  knownNames: Set<string>,
  longtermEmploymentNames: Set<string> = new Set(),
): PostorderLongtermPostCell[] {
  return derivePostorderLongtermPostsFromPostorderGrid(gridFromCsvText(postorderCsvText), knownNames, longtermEmploymentNames);
}

/** `postorder_uploads` 一行嘅原始 bytes——`longtermPairsCsvBytes` 有值
 * 優先用（WP-POSTORDER-PAIRS-CSV，最精簡），再係`rosterCsvBytes`／
 * `postorderCsvBytes`（CSV 路徑），冇就跌返用 `fileBytes`（xlsm）。同
 * Prisma 生成嘅 `PostorderUpload` 形狀相容，淨係揀呢個函數用得到嘅
 * 幾個欄位，方便測試起假資料。 */
export interface PostorderUploadBytesSource {
  fileBytes: Buffer | Uint8Array;
  rosterCsvBytes?: Buffer | Uint8Array | null;
  postorderCsvBytes?: Buffer | Uint8Array | null;
  longtermPairsCsvBytes?: Buffer | Uint8Array | null;
}

/** 統一入口——upload route／guard-fix plan／referral-fee rate sync 呢類
 * 要重新解析 `postorder_uploads` 一行嘅地方，一律用呢個函數，唔使自己
 * 判斷「呢份係 xlsm／CSV／pairs-CSV 邊種」（判斷邏輯集中喺呢度一個
 * 地方）。 */
export async function parsePostorderUploadRow(row: PostorderUploadBytesSource): Promise<PostorderParseResult> {
  if (row.longtermPairsCsvBytes) {
    return parsePostorderFromPairsCsv({
      longtermPairsCsv: Buffer.from(row.longtermPairsCsvBytes).toString("utf-8"),
      postorderCsv: row.postorderCsvBytes ? Buffer.from(row.postorderCsvBytes).toString("utf-8") : null,
    });
  }
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
    // WP-POSTORDER-ROBUST：Roster 表頭偵測診斷——上載即刻俾操作員睇
    // 「解析器搵到表頭喺邊行」，唔使個個 case 都要 engineer 落場對數。
    roster_header_row: result.rosterHeaderRow,
    roster_day_block_width: result.rosterDayBlockWidth,
    roster_first_day_col: result.rosterFirstDayCol,
  };
}
