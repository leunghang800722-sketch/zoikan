// WA-8 B：工卡辨識共用純函數——工號格式、容錯解析（JSON 優先；qwen-vl-ocr 等可能回純文字 → 正則抽取）。零 DB／零網絡。
const STAFF_NO_RE = /^(?:U\d{5}|MP\d{4}|MG\d{4}|MW\d{4})$/;
/** 文字內搵工號：容許空白／連字符，O→0、I/l→1（只喺數字位）。 */
const TOKEN_RE = /(?<![A-Za-z0-9])(U|MP|MG|MW)\s*[-:]?\s*([0-9OoIl]{4,5})(?![0-9A-Za-z])/gi;

type CardConfidence = "high" | "medium" | "low";
export interface CardRead {
  is_card: boolean;
  staff_no: string | null;
  name_zh: string | null;
  name_en: string | null;
  confidence: CardConfidence;
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
  return { is_card: o.is_card === false ? false : true, staff_no: staff, name_zh: str(o.name_zh), name_en: str(o.name_en), confidence: conf(o.confidence) };
}

/**
 * 容錯解析模型輸出 → 0..n 張卡。
 *  - JSON（可帶 ```json 圍欄）：{ is_card, cards:[…] } | { is_card, staff_no, … } | [ … ]
 *  - 非 JSON（純文字）：正則抽工號（可多個）＋姓名候選（只喺剛好一個工號時配對，否則不配）。
 * is_card=false 或搵唔到任何工號／姓名 → cards 空。
 */
export function parseCardText(text: string): { is_card: boolean; cards: CardRead[]; json: boolean } {
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
    return { is_card: isCard && reads.length > 0 ? true : isCard, cards: isCard ? reads : [], json: true };
  }
  const nos = extractStaffNos(t);
  const names = extractNameCandidates(t);
  // 純文字（OCR 專用模型照抄相內所有字）冇工號就唔當工卡：姓名候選太嘈（打卡機螢幕、告示都有中文字），唔靠佢開卡
  if (nos.length === 0) return { is_card: false, cards: [], json: false };
  return {
    is_card: true,
    cards: nos.map((no) => ({ is_card: true, staff_no: no, name_zh: nos.length === 1 ? (names[0] ?? null) : null, name_en: null, confidence: "medium" as const })),
    json: false,
  };
}
