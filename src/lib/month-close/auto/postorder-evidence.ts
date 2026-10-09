// WP-ONE-CLICK-AUTO（§31）：Postorder 總表嘅「價錢／歸屬證據」解析。
//
// 現有 `guard-fix/postorder.ts` 淨係抽長工崗位格同介紹費行；一鍵結算自動定價
// （§31.3 C）、新盤客戶名（A）、無結算雞頭歸屬（D）需要多三樣：
//   1. `PostOrder` 分頁每個崗位行嘅「上單價」「外判價」「更份」「時間」＋尾 token；
//   2. 「block」標題行（客戶群，例如卓弘 block 下面嘅物業尊豪坊）；
//   3. `Roster` 分頁逐日「雞頭名」（同崗位同日嘅雞頭）。
// 全部純函數（吃 grid），xlsm／CSV 兩條路徑共用同一套 grid 邏輯。Postorder 係
// 可選來源：冇上載就返 null，caller 靠歷史行得通。
//
// 鐵則：呢度解析出嚟嘅人名（崗位行尾段）只用嚟「排除逐人特價行」，唔會寫入
// 任何報告／分診／audit。
import type { PostorderUpload } from "@prisma/client";
import {
  AM_COLUMN,
  POSTORDER_SHEET_NAME,
  ROSTER_MIN_COLS,
  ROSTER_SHEET_NAME,
  detectRosterHeader,
  gridFromCsvText,
  gridFromWorksheet,
  gridNumber,
  gridText,
  loadPostorderWorkbook,
  type PostorderGrid,
} from "@/lib/guard-fix/postorder";
import { normalizeTimeRange } from "@/lib/roster-upload/time-range";
import { normalizeSiteKey, stripSiteSuffix } from "./site-match";

export type PostorderShiftLabel = "Day" | "Middle" | "Night";

export interface PostorderPriceRow {
  rowIndex: number;
  /** 最近一個「客戶群」標題行（淨係合資格嘅 block，見 `isClientGroupBlock()`）。 */
  clientGroup: string | null;
  /** col A 原文。 */
  clientLabel: string;
  /** col A 去咗尾 token 之後（盤名部分）。 */
  labelHead: string;
  /** col A 最尾一個以空白分隔嘅 token（可能係雞頭、安員姓名、區域代號…），冇就 null。 */
  trailingToken: string | null;
  propertyShort: string | null;
  shiftLabel: PostorderShiftLabel | null;
  /** 正規化 "HHMM-HHMM"；「1Hr OT」呢類時薪行為 null。 */
  timeSlot: string | null;
  hourly: boolean;
  clientPrice: number | null;
  payoutPrice: number | null;
  totalShift: number;
}

export interface PostorderEvidence {
  uploadId: string;
  fileName: string;
  priceRows: PostorderPriceRow[];
  /** key = `${normalizeSiteKey(物業名稱)}|${shiftLabel}|${YYYY-MM-DD}` → 雞頭名（去咗「(n) 」前綴；「長工」另計）。 */
  dayBrokers: Map<string, Set<string>>;
  hasRoster: boolean;
}

const PRICE_HEADERS = { client: "客戶名稱", prop: "物業名稱", shift: "更份", clientPrice: "上單價", payout: "外判價", time: "時間", total: "Total Shift" };
const SPECIAL_ROW_RE = /現金糧|月薪|佣金|糧\+|Claim|雞頭費|補錢|Training|Admin Charge/i;
const SUB_BLOCK_RE = /^\d+\s*hrs?\b/i;

function numCell(grid: PostorderGrid, r: number, c: number): number | null {
  const v = gridNumber(grid, r, c);
  return v === null ? null : v;
}

function shiftLabelOf(raw: string | null): PostorderShiftLabel | null {
  if (!raw) return null;
  const t = raw.trim().toLowerCase();
  if (t === "day") return "Day";
  if (t === "night") return "Night";
  if (t === "middle") return "Middle";
  return null;
}

/** 客戶群標題：唔含數字／斜線／括號（排除「XX 12hrs (D/S)」「XX 27000/M」呢類盤＋更份標題），
 * 而且下面最少兩個唔同盤名（由 caller 驗證）。 */
export function isClientGroupBlock(label: string): boolean {
  return !/[\d/()（）]/.test(label);
}

function splitTrailing(label: string): { head: string; token: string | null } {
  const parts = label.normalize("NFKC").trim().split(/\s+/);
  if (parts.length < 2) return { head: parts.join(" "), token: null };
  return { head: parts.slice(0, -1).join(" "), token: parts[parts.length - 1]! };
}

export function parsePostorderPriceRows(grid: PostorderGrid): PostorderPriceRow[] {
  const rowCount = grid.length - 1;
  let headerRow = -1;
  const col = { client: 1, prop: 3, shift: 4, clientPrice: 5, payout: 6, time: 7, total: AM_COLUMN };
  for (let r = 1; r <= Math.min(rowCount, 20); r++) {
    const row = grid[r];
    if (!row) continue;
    if (row.some((t) => t === PRICE_HEADERS.prop) && row.some((t) => t === PRICE_HEADERS.payout) && row.some((t) => t === PRICE_HEADERS.clientPrice)) {
      headerRow = r;
      for (let c = 1; c < row.length; c++) {
        const t = row[c];
        if (t === PRICE_HEADERS.client) col.client = c;
        else if (t === PRICE_HEADERS.prop) col.prop = c;
        else if (t === PRICE_HEADERS.shift) col.shift = c;
        else if (t === PRICE_HEADERS.clientPrice) col.clientPrice = c;
        else if (t === PRICE_HEADERS.payout) col.payout = c;
        else if (t === PRICE_HEADERS.time) col.time = c;
        else if (t === PRICE_HEADERS.total) col.total = c;
      }
      break;
    }
  }
  if (headerRow < 0) return [];

  // 先掃出 block 標題（col A 有字、其餘價錢／更份欄全空）。
  type Raw = { r: number; block: string | null };
  const rows: Raw[] = [];
  let currentBlock: string | null = null;
  const blockHeads = new Map<string, Set<string>>();
  const out: PostorderPriceRow[] = [];
  for (let r = headerRow + 1; r <= rowCount; r++) {
    const a = gridText(grid, r, col.client);
    const prop = gridText(grid, r, col.prop);
    const shift = gridText(grid, r, col.shift);
    const cp = gridText(grid, r, col.clientPrice);
    const po = gridText(grid, r, col.payout);
    if (a && !prop && !shift && !cp && !po) {
      if (!SUB_BLOCK_RE.test(a)) currentBlock = a;
      continue;
    }
    if (!a) continue;
    rows.push({ r, block: currentBlock });
  }
  for (const { r, block } of rows) {
    const a = gridText(grid, r, col.client)!;
    const prop = gridText(grid, r, col.prop);
    const shift = shiftLabelOf(gridText(grid, r, col.shift));
    const timeText = gridText(grid, r, col.time);
    const hourly = !!timeText && /hr/i.test(timeText);
    const { head, token } = splitTrailing(a);
    const clientPrice = numCell(grid, r, col.clientPrice);
    const payoutPrice = numCell(grid, r, col.payout);
    if (SPECIAL_ROW_RE.test(a) || (prop !== null && SPECIAL_ROW_RE.test(prop))) continue;
    if (clientPrice === null && payoutPrice === null) continue;
    const totalShift = numCell(grid, r, col.total) ?? 0;
    out.push({
      rowIndex: r,
      clientGroup: block,
      clientLabel: a,
      labelHead: head,
      trailingToken: token,
      propertyShort: prop,
      shiftLabel: shift,
      timeSlot: hourly ? null : normalizeTimeRange(timeText),
      hourly,
      clientPrice,
      payoutPrice,
      totalShift,
    });
    if (block) {
      const set = blockHeads.get(block) ?? new Set<string>();
      set.add(normalizeSiteKey(head));
      blockHeads.set(block, set);
    }
  }
  // 客戶群：block 要合資格（無數字／斜線／括號）而且下面 ≥2 個唔同盤名。
  // 標題同自己下面某個盤名一樣（例如「機場Cdf」block 下面第一個盤就係機場Cdf）＝盤自己嘅標題，唔係客戶群。
  const eligible = new Set([...blockHeads.entries()].filter(([b, heads]) => isClientGroupBlock(b) && heads.size >= 2 && !heads.has(normalizeSiteKey(b))).map(([b]) => b));
  for (const row of out) if (row.clientGroup && !eligible.has(row.clientGroup)) row.clientGroup = null;
  return out;
}

const BROKER_LABEL_PREFIX_RE = /^\(\s*\d+\s*\)\s*/;

/** Roster 分頁逐日「雞頭名」：同崗位（物業名稱＋更份）同日嘅雞頭集合。 */
export function parsePostorderDayBrokers(grid: PostorderGrid, month: Date): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const header = detectRosterHeader(grid);
  if (!header || header.brokerCols.length === 0) return out;
  const y = month.getUTCFullYear();
  const m = month.getUTCMonth();
  const rowCount = grid.length - 1;
  // 更份欄：喺表頭同一行搵「更份」，搵唔到用 col 4（真樣本位置）。
  let shiftCol = 4;
  const headerRow = grid[header.headerRow];
  if (headerRow) for (let c = 1; c < headerRow.length; c++) if (headerRow[c] === "更份") shiftCol = c;
  let lastProp: string | null = null;
  for (let r = header.headerRow + 1; r <= rowCount; r++) {
    const propRaw = gridText(grid, r, header.propCol);
    if (propRaw !== null) lastProp = propRaw;
    const prop = propRaw ?? lastProp;
    const shift = shiftLabelOf(gridText(grid, r, shiftCol));
    if (!prop || !shift) continue;
    for (let i = 0; i < header.brokerCols.length; i++) {
      const raw = gridText(grid, r, header.brokerCols[i]!);
      if (!raw) continue;
      const day = i + 1;
      if (day > 31) break;
      const label = raw.replace(BROKER_LABEL_PREFIX_RE, "").trim();
      if (!label) continue;
      const date = new Date(Date.UTC(y, m, day));
      if (date.getUTCMonth() !== m) continue;
      const key = `${normalizeSiteKey(prop)}|${shift}|${date.toISOString().slice(0, 10)}`;
      const set = out.get(key) ?? new Set<string>();
      set.add(label);
      out.set(key, set);
    }
  }
  return out;
}

/** 由 `postorder_uploads` 一行讀出證據。xlsm 路徑要載入成個 workbook（同現有 guard-fix 一樣）；
 * CSV 路徑（PostOrder／Roster 分頁各一份）直接讀文字。冇可讀嘅 PostOrder 分頁就 priceRows 空。 */
export async function loadPostorderEvidence(
  row: Pick<PostorderUpload, "id" | "fileName" | "fileBytes" | "rosterCsvBytes" | "postorderCsvBytes">,
  month: Date,
): Promise<PostorderEvidence> {
  const text = (b: Uint8Array | Buffer | null | undefined) => (b ? Buffer.from(b).toString("utf-8") : null);
  const poCsv = text(row.postorderCsvBytes);
  const rosterCsv = text(row.rosterCsvBytes);
  if (poCsv || rosterCsv) {
    const priceRows = poCsv ? parsePostorderPriceRows(gridFromCsvText(poCsv)) : [];
    const dayBrokers = rosterCsv ? parsePostorderDayBrokers(gridFromCsvText(rosterCsv), month) : new Map<string, Set<string>>();
    return { uploadId: row.id, fileName: row.fileName, priceRows, dayBrokers, hasRoster: !!rosterCsv };
  }
  const wb = await loadPostorderWorkbook(Buffer.from(row.fileBytes));
  const po = wb.getWorksheet(POSTORDER_SHEET_NAME);
  const ro = wb.getWorksheet(ROSTER_SHEET_NAME);
  const priceRows = po ? parsePostorderPriceRows(gridFromWorksheet(po, AM_COLUMN)) : [];
  const dayBrokers = ro ? parsePostorderDayBrokers(gridFromWorksheet(ro, ROSTER_MIN_COLS), month) : new Map<string, Set<string>>();
  return { uploadId: row.id, fileName: row.fileName, priceRows, dayBrokers, hasRoster: !!ro };
}

// ---------------------------------------------------------------------------
// 配對輔助
// ---------------------------------------------------------------------------
export interface BrokerLite {
  id: string;
  code: string;
  name: string;
  kind: string;
  aliases: string[];
}

/** token／雞頭名 → 雞頭（code、name、aliases 正規化後完全相等，唯一先算）。 */
export function matchBrokerLabel(label: string | null, brokers: readonly BrokerLite[]): BrokerLite | null {
  if (!label) return null;
  const k = label.normalize("NFKC").trim().toLowerCase();
  if (!k) return null;
  const hits = brokers.filter((b) => [b.code, b.name, ...b.aliases].some((x) => x.normalize("NFKC").trim().toLowerCase() === k));
  return hits.length === 1 ? hits[0]! : null;
}

/** 崗位行嘅「身份類別」：雞頭專屬（尾 token 係雞頭）／泛用（冇 token 或者 token 係盤名一部分）／
 * 逐人（尾段 2–4 個中文字，唔係雞頭）／其他（IC、區域代號…）。 */
export function classifyPriceRow(row: PostorderPriceRow, brokers: readonly BrokerLite[]): { kind: "broker" | "generic" | "person" | "other"; broker: BrokerLite | null } {
  if (!row.trailingToken) return { kind: "generic", broker: null };
  const b = matchBrokerLabel(row.trailingToken, brokers);
  if (b) return { kind: "broker", broker: b };
  if (/^[一-鿿]{2,4}$/.test(row.trailingToken)) {
    // 尾 token 係盤名一部分（例如「淺水灣道11號」冇空白唔會去到呢度）——同 propertyShort 一樣就當泛用。
    if (row.propertyShort && normalizeSiteKey(row.propertyShort) === normalizeSiteKey(row.trailingToken)) return { kind: "generic", broker: null };
    return { kind: "person", broker: null };
  }
  if (row.propertyShort && normalizeSiteKey(row.propertyShort) === normalizeSiteKey(row.trailingToken)) return { kind: "generic", broker: null };
  return { kind: "other", broker: null };
}

export { gridText };

// ---------------------------------------------------------------------------
// 盤 ↔ Postorder 崗位行
// ---------------------------------------------------------------------------
function siteKeys(names: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const n of names) {
    const k = normalizeSiteKey(n);
    if (!k) continue;
    out.add(k);
    out.add(stripSiteSuffix(k));
  }
  return out;
}

/** 呢個盤（canonical＋aliases）喺 Postorder 對應嘅崗位行：整個 col A、盤名部分、
 * 盤名＋物業名稱、或者物業名稱本身（要係盤嘅 alias）正規化後等於盤名／別名。 */
export function rowsForSite(rows: readonly PostorderPriceRow[], names: readonly string[]): PostorderPriceRow[] {
  const keys = siteKeys(names);
  if (keys.size === 0) return [];
  return rows.filter((r) => {
    const cands = [r.clientLabel, r.labelHead, r.propertyShort ? `${r.labelHead} ${r.propertyShort}` : "", r.propertyShort ?? ""].filter(Boolean);
    return cands.some((c) => {
      const k = normalizeSiteKey(c);
      return k !== "" && (keys.has(k) || keys.has(stripSiteSuffix(k)));
    });
  });
}
