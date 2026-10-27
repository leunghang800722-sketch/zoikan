// WA-8 B：工卡辨識共用純函數——工號格式、容錯解析（JSON 優先；qwen-vl-ocr 等可能回純文字 → 正則抽取）。零 DB／零網絡。
const STAFF_NO_RE = /^(?:U\d{5}|MP\d{4}|MG\d{4}|MW\d{4})$/;
/** 文字內搵工號：容許空白／連字符，O→0、I/l→1（只喺數字位）。 */
const TOKEN_RE = /(?<![A-Za-z0-9])(U|MP|MG|MW)\s*[-:]?\s*([0-9OoIl]{4,5})(?![0-9A-Za-z])/gi;

type CardConfidence = "high" | "medium" | "low";

/** WA-9：相片文件類型（真相：數碼港打卡紙／簽到表／app 截圖冇工號、只有姓名；值勤記錄表多人多行）。 */
export const DOC_TYPES = ["work_card", "punch_card", "signin_sheet", "attendance_sheet", "app_screenshot", "other"] as const;
export type DocType = (typeof DOC_TYPES)[number];
export function normDocType(v: unknown): DocType | null {
  return typeof v === "string" && (DOC_TYPES as readonly string[]).includes(v) ? (v as DocType) : null;
}

/** "8:05"／"0805"／"08.05"／"08:05:33" → "HH:MM"（合法 00:00–23:59）；否則 null。 */
export function normTime(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.normalize("NFKC").trim();
  const m = /^(\d{1,2})\s*[:：.]\s*(\d{2})(?:\s*[:：.]\s*\d{2})?$/.exec(s) ?? /^(\d{2})(\d{2})$/.exec(s);
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  return h <= 23 && mi <= 59 ? `${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}` : null;
}

/** WA-9：值勤／出勤記錄表一行（staff_no_raw＝相上原樣，可能係 U 格式、Wilson 純數字編號或手寫 L13xxxx／413xxxx）。 */
export interface SheetRow {
  row: number | null;
  /** YYYY-MM-DD（模型按今日年份補全）；睇唔到＝null */
  date: string | null;
  name_zh: string | null;
  staff_no_raw: string | null;
  time_on: string | null;
  time_off: string | null;
  confidence: CardConfidence;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
function toRow(o: Record<string, unknown>): SheetRow | null {
  const name = str(o.name_zh);
  const raw = str(o.staff_no_raw, 20);
  if (!name && !raw) return null;
  const d = str(o.date, 12);
  return {
    row: typeof o.row === "number" && Number.isFinite(o.row) ? Math.trunc(o.row) : null,
    date: d && ISO_DATE.test(d) && !Number.isNaN(Date.parse(d)) ? d : null,
    name_zh: name,
    staff_no_raw: raw,
    time_on: normTime(o.time_on),
    time_off: normTime(o.time_off),
    confidence: conf(o.confidence),
  };
}

export interface CardRead {
  is_card: boolean;
  staff_no: string | null;
  name_zh: string | null;
  name_en: string | null;
  confidence: CardConfidence;
  /** WA-9：相入面讀到嘅時間（打卡紙／app 截圖／簽到表當日行）；HH:MM */
  time_on?: string | null;
  time_off?: string | null;
}

/** WA-8.2：兩個工號「相似」＝同前綴同長度而且只差 ≤2 位數字（多數係同一張卡嘅誤讀）。 */
export function similarStaffNos(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length !== b.length || a.replace(/\d/g, "") !== b.replace(/\d/g, "")) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
  return d <= 2;
}

/** WA-8.2：候選工號 ≥2 個而且當中有兩個互不相似（唔係差 ≤2 位）→ 相入面可能有多過一張工卡。 */
export function hasDistinctCandidates(nos: readonly string[]): boolean {
  const u = [...new Set(nos.flatMap((n) => { const x = normStaffNo(n); return x ? [x] : []; }))];
  for (let i = 0; i < u.length; i++) for (let j = i + 1; j < u.length; j++) if (!similarStaffNos(u[i]!, u[j]!)) return true;
  return false;
}

/** 正規化工號：大寫、去空白；格式合法回字串，否則 null。 */
export function normStaffNo(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.normalize("NFKC").toUpperCase().replace(/[\s\-:]/g, "");
  return STAFF_NO_RE.test(s) ? s : null;
}

/** 由任意文字抽出所有合法工號（去重、保持出現次序）。 */
export function extractStaffNos(text: string): string[] {
  const out: string[] = [];
  for (const m of text.normalize("NFKC").matchAll(TOKEN_RE)) {
    const digits = m[2]!.replace(/[Oo]/g, "0").replace(/[Il]/g, "1");
    const no = normStaffNo(`${m[1]!.toUpperCase()}${digits}`);
    if (no && !out.includes(no)) out.push(no);
  }
  return out;
}

const NAME_STOP = /公司|保安|服務|員工|有限|工作證|職員|姓名|編號|部門|職位|日期|電話|簽名|禁止|轉讓|如拾獲|請交回|拾獲|security|limited/i;
/** 由 OCR 純文字抽中文姓名候選（2–4 字、非停用詞）。 */
export function extractNameCandidates(text: string): string[] {
  const out: string[] = [];
  for (const m of text.normalize("NFKC").matchAll(/[一-鿿]{2,4}/g)) {
    if (!NAME_STOP.test(m[0]) && !out.includes(m[0])) out.push(m[0]);
  }
  return out;
}

const str = (v: unknown, max = 80): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
const conf = (v: unknown): CardConfidence => (v === "high" || v === "medium" || v === "low" ? v : "medium");

function toRead(o: Record<string, unknown>): CardRead {
  const staff = normStaffNo(str(o.staff_no, 20));
  return { is_card: o.is_card === false ? false : true, staff_no: staff, name_zh: str(o.name_zh), name_en: str(o.name_en), confidence: conf(o.confidence), time_on: normTime(o.time_on), time_off: normTime(o.time_off) };
}

/**
 * 容錯解析模型輸出 → 0..n 張卡。
 *  - JSON（可帶 ```json 圍欄）：{ is_card, cards:[…] } | { is_card, staff_no, … } | [ … ]
 *  - 非 JSON（純文字）：正則抽工號（可多個）＋姓名候選（只喺剛好一個工號時配對，否則不配）。
 * is_card=false 或搵唔到任何工號／姓名 → cards 空。
 */
export function parseCardText(text: string): { is_card: boolean; cards: CardRead[]; json: boolean; doc_type: DocType | null; rows: SheetRow[] } {
  const t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(t);
  } catch {
    parsed = undefined;
  }
  if (parsed !== undefined && parsed !== null && typeof parsed === "object") {
    const root = Array.isArray(parsed) ? { cards: parsed } : (parsed as Record<string, unknown>);
    const arr = Array.isArray(root.cards) ? (root.cards as unknown[]).filter((x): x is Record<string, unknown> => !!x && typeof x === "object") : [root];
    const reads = arr.map(toRead).filter((r) => r.staff_no || r.name_zh || r.name_en);
    const isCard = root.is_card === false ? false : reads.length > 0 || root.is_card === true;
    const rows = Array.isArray(root.rows) ? (root.rows as unknown[]).slice(0, 40).flatMap((x) => (x && typeof x === "object" ? [toRow(x as Record<string, unknown>)] : [])).filter((r): r is SheetRow => r !== null) : [];
    const docType = normDocType(root.doc_type);
    // 值勤表：逐行抽取；cards 留空（行才係記錄）
    if (rows.length > 0 && (docType === "attendance_sheet" || reads.length === 0)) return { is_card: true, cards: [], json: true, doc_type: docType ?? "attendance_sheet", rows };
    return { is_card: isCard && reads.length > 0 ? true : isCard, cards: isCard ? reads : [], json: true, doc_type: docType, rows: [] };
  }
  const nos = extractStaffNos(t);
  const names = extractNameCandidates(t);
  // 純文字（OCR 專用模型照抄相內所有字）冇工號就唔當工卡：姓名候選太嘈（打卡機螢幕、告示都有中文字），唔靠佢開卡
  if (nos.length === 0) return { is_card: false, cards: [], json: false, doc_type: null, rows: [] };
  return {
    is_card: true,
    cards: nos.map((no) => ({ is_card: true, staff_no: no, name_zh: nos.length === 1 ? (names[0] ?? null) : null, name_en: null, confidence: "medium" as const })),
    json: false,
    doc_type: null,
    rows: [],
  };
}
