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
import ExcelJS from "exceljs";

const ROSTER_SHEET_NAME = "Roster";
const POSTORDER_SHEET_NAME = "PostOrder";
const AM_COLUMN = 39; // "Total Shift"（COUNTA(H:AL)嘅計算結果）
const DAYS_IN_GRID = 31; // 更表格位固定 31 日（大月留位；細月尾幾組全空，唔影響）

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
  /** 每更費率（由公式 `=<rate>*...` 讀出，讀唔到就 null）。 */
  rate: number | null;
  /** 呢行公式引用嗰批「AM」欄（更數）加埋嘅總更數。 */
  shifts: number;
  /** Excel 自己算低嘅快取金額（col F 嘅 formula result）——用嚟做總額
   * 核對（8 月：21 行加埋 = 60,520，同外判價欄一致，唔使再乘一次）。 */
  excelAmount: number | null;
  /** 呢行公式引用嗰啲員工行嘅「客戶名稱」去人名字句（去重，見
   * `PostorderLongtermPostCell.siteLabelRaw` 同款註解）。 */
  siteLabelsRaw: string[];
  /** 呢行公式引用嗰啲員工行嘅「物業名稱」短代號原文（去重）——
   * `siteLabelsRaw` 對唔中嗰陣嘅 fallback。 */
  siteLabelsFallbackRaw: string[];
  /** 呢行公式引用嗰啲員工行嘅人名原文（由 col A 尾段中文字截出，去重）。 */
  guardNamesRaw: string[];
  /** 原始公式文字（audit 用）。 */
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

/** 數值 cell（或者 formula 嘅快取 result）讀做 number，唔係數就 null。 */
function cellNumber(row: ExcelJS.Row, col1based: number): number | null {
  const v: unknown = row.getCell(col1based).value;
  if (typeof v === "number") return v;
  if (v && typeof v === "object" && "result" in (v as Record<string, unknown>)) {
    const r = (v as { result: unknown }).result;
    return typeof r === "number" ? r : null;
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

export async function loadPostorderWorkbook(buffer: Buffer): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  return wb;
}

/** Roster sheet 逐格「(8) 長工」——見檔頭註解。淨係計「備註」子欄有人
 * 名嗰啲格（冇人名就冧唔到係邊個，保守唔計入，會令 1,293 目標數
 * 稍為偏低，但唔會屈估一個人名）。 */
export function parsePostorderLongtermPostsFromWorkbook(wb: ExcelJS.Workbook): PostorderLongtermPostCell[] {
  const ws = wb.getWorksheet(ROSTER_SHEET_NAME);
  if (!ws) return [];
  const agg = new Map<string, PostorderLongtermPostCell>();
  const rowCount = ws.rowCount;
  for (let r = 8; r <= rowCount; r++) {
    const row = ws.getRow(r);
    const prop = cellText(row, 3); // 「物業名稱」（短代號，例：CP5／數碼／柴廠）
    const client = cellText(row, 1); // 「客戶名稱」（完整字句，例：數碼港 CP5 李文豪）
    if (!prop) continue;
    for (let k = 0; k < DAYS_IN_GRID; k++) {
      const brokerCol = 9 + 7 * k;
      const noteCol = 10 + 7 * k;
      const brokerRaw = cellText(row, brokerCol);
      if (!brokerRaw || !brokerRaw.includes("長工")) continue;
      const noteRaw = cellText(row, noteCol);
      if (!noteRaw) continue; // 保守：冇備註人名就唔計呢格
      // 「客戶名稱」通常係「盤名全稱 + 人名」（例：「數碼港 CP5 李文豪」
      // 去到「李文豪」——去咗人名尾段之後嘅盤名全稱比「物業名稱」嗰個短
      // 代號更多機會撞中 sites.canonical_name/aliases（`matchSite()`
      // 淨係做完全相等，唔准估）；撞唔到就跌返用短代號。
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

/** PostOrder sheet「長工雞頭費 (雞頭)」行——見檔頭註解。 */
export function parsePostorderReferralRowsFromWorkbook(wb: ExcelJS.Workbook): PostorderReferralRow[] {
  const ws = wb.getWorksheet(POSTORDER_SHEET_NAME);
  if (!ws) return [];
  const out: PostorderReferralRow[] = [];
  const rowCount = ws.rowCount;
  for (let r = 1; r <= rowCount; r++) {
    const row = ws.getRow(r);
    const a = cellText(row, 1);
    if (!a || !a.includes("雞頭費")) continue;
    const formula = cellFormula(row, 6);
    const excelAmount = cellNumber(row, 6);
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
      const refRow = ws.getRow(rr);
      const amVal = cellNumber(refRow, AM_COLUMN);
      if (typeof amVal === "number") shifts += amVal;
      const refClient = cellText(refRow, 1);
      const nm = trailingChineseName(refClient);
      if (nm) nameSet.add(nm);
      const stripped = refClient && nm && refClient.endsWith(nm) ? refClient.slice(0, refClient.length - nm.length).trim() : null;
      const refProp = cellText(refRow, 3);
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
  return {
    supported: false,
    reason:
      "Postorder 總表冇顯式「簽證形式長工」標記（冇獨立分頁／專屬欄位）——" +
      "呢批人 8 月靠老闆人手核對確認，屬一次性業務判斷，未有可重複嘅資料來源可以" +
      "喺 production parser 自動判定，set_visa 暫時一律 0 項",
  };
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
