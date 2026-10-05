// WP-GUARD-OCR §29：模型輸出嘅正規化＋格式驗證。純函數。
// 兩次獨立讀「正規化後逐字相同」＋格式驗證通過先 confirmed；其餘 review／missing。
import { canonicalHkid, formatHkid, hkidCheckDigitValid, normalizeTelHk } from "@/lib/guards/identity";
import type { OcrFieldKey } from "./config";

export type FieldStatus = "confirmed" | "review" | "missing";

/** 模型答「睇唔清」嘅各種寫法（含 null／空字串）。 */
export function isUnclear(raw: string | null | undefined): boolean {
  if (raw == null) return true;
  const s = raw.normalize("NFKC").trim().toLowerCase();
  return s === "" || s === "unclear" || s === "null" || s === "n/a" || s === "none" || s === "-" || s === "?" || /^[?？\s_.\-]+$/.test(s) || s.includes("unclear");
}

function cleanText(raw: string): string {
  // 去控制字元、折疊空白；唔做任何內容改寫
  return raw.normalize("NFKC").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
}

const MONTHS: Record<string, number> = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, SEPT: 9, OCT: 10, NOV: 11, DEC: 12 };

function validCalendar(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** 解析出生日期 → ISO（YYYY-MM-DD）；唔識或者曆法唔合 → null。香港慣例 DD-MM-YYYY。 */
export function parseDob(raw: string): string | null {
  const s = cleanText(raw).toUpperCase();
  let m = s.match(/^(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*日?$/);
  if (m) return validCalendar(+m[1]!, +m[2]!, +m[3]!) ? `${m[1]}-${pad(+m[2]!)}-${pad(+m[3]!)}` : null;
  m = s.match(/^(\d{1,2})\s*[-/.]\s*(\d{1,2})\s*[-/.]\s*(\d{4})$/);
  if (m) return validCalendar(+m[3]!, +m[2]!, +m[1]!) ? `${m[3]}-${pad(+m[2]!)}-${pad(+m[1]!)}` : null;
  m = s.match(/^(\d{1,2})[\s\-/.]*([A-Z]{3,4})[\s\-/.,]*(\d{4})$/);
  if (m && MONTHS[m[2]!]) return validCalendar(+m[3]!, MONTHS[m[2]!]!, +m[1]!) ? `${m[3]}-${pad(MONTHS[m[2]!]!)}-${pad(+m[1]!)}` : null;
  return null;
}

/** 出生年份合理範圍：現時 16–90 歲（保安員）。 */
export function dobPlausible(iso: string, now: Date = new Date()): boolean {
  const y = Number(iso.slice(0, 4));
  const age = now.getUTCFullYear() - y;
  return age >= 16 && age <= 90;
}

export interface Normalized {
  /** 比較用 canonical */
  canon: string;
  /** 顯示／填入表單用 */
  display: string;
  /** 格式驗證通過（hkid check digit、日期曆法＋年份、香港電話、含中文字…） */
  valid: boolean;
  /** valid=false 嘅原因碼（唔含值） */
  reason?: string;
}

export function normalizeField(key: OcrFieldKey, raw: string, now: Date = new Date()): Normalized {
  const t = cleanText(raw);
  switch (key) {
    case "hkid": {
      const c = canonicalHkid(t);
      if (!c) return { canon: t.toUpperCase().replace(/[\s()（）]/g, ""), display: t, valid: false, reason: "hkid_format" };
      return hkidCheckDigitValid(c) ? { canon: c, display: formatHkid(c), valid: true } : { canon: c, display: formatHkid(c), valid: false, reason: "hkid_check_digit" };
    }
    case "dob": {
      const iso = parseDob(t);
      if (!iso) return { canon: t.toUpperCase(), display: t, valid: false, reason: "dob_calendar" };
      return dobPlausible(iso, now) ? { canon: iso, display: iso, valid: true } : { canon: iso, display: iso, valid: false, reason: "dob_year_implausible" };
    }
    case "sex": {
      const u = t.toUpperCase();
      const s = u === "M" || u === "MALE" || t === "男" ? "M" : u === "F" || u === "FEMALE" || t === "女" ? "F" : null;
      return s ? { canon: s, display: s, valid: true } : { canon: u, display: t, valid: false, reason: "sex_format" };
    }
    case "phone": {
      const n = normalizeTelHk(t);
      if (!n) return { canon: t.replace(/\D/g, ""), display: t, valid: false, reason: "phone_format" };
      return /^[2-9]\d{7}$/.test(n) ? { canon: n, display: n, valid: true } : { canon: n, display: n, valid: false, reason: "phone_not_hk" };
    }
    case "name_zh": {
      const c = t.replace(/\s+/g, "");
      const hasCjk = /[㐀-鿿]/.test(c);
      const ok = hasCjk && c.length >= 2 && c.length <= 12 && !/[A-Za-z0-9]/.test(c);
      return { canon: c, display: c, valid: ok, ...(ok ? {} : { reason: "name_zh_format" }) };
    }
    case "name_en": {
      const c = t.toUpperCase().replace(/,/g, " ").replace(/\s+/g, " ").trim();
      const ok = /^[A-Z][A-Z'’.\- ]*[A-Z.]$/.test(c) && c.length >= 3 && c.length <= 80;
      return { canon: c, display: c, valid: ok, ...(ok ? {} : { reason: "name_en_format" }) };
    }
    case "address": {
      const canon = t.toUpperCase().replace(/[\s,，.。、;；:：\-－()（）]/g, "");
      const ok = canon.length >= 6 && canon.length <= 200;
      return { canon, display: t, valid: ok, ...(ok ? {} : { reason: "address_format" }) };
    }
  }
}

export interface FieldResult {
  status: FieldStatus;
  /** confirmed＝確認值；review＝預填（讀 A 優先）；missing＝"" */
  value: string;
  /** review：兩個讀數（去重）。confirmed／missing 為空 */
  candidates: string[];
  /** 原因碼（無值）：reads_differ｜one_read_unclear｜invalid_format 類｜unclear */
  reason?: string;
}

/** 兩個獨立讀數（原始字串或 unclear）→ 欄位結果。 */
export function reconcile(key: OcrFieldKey, a: string | null | undefined, b: string | null | undefined, now: Date = new Date()): FieldResult {
  const ua = isUnclear(a);
  const ub = isUnclear(b);
  if (ua && ub) return { status: "missing", value: "", candidates: [], reason: "unclear" };
  const na = ua ? null : normalizeField(key, a!, now);
  const nb = ub ? null : normalizeField(key, b!, now);
  if (na && nb) {
    if (na.canon === nb.canon) {
      if (na.valid) return { status: "confirmed", value: na.display, candidates: [] };
      return { status: "review", value: na.display, candidates: [na.display], reason: na.reason ?? "invalid_format" };
    }
    return { status: "review", value: na.display, candidates: [...new Set([na.display, nb.display])], reason: "reads_differ" };
  }
  const only = (na ?? nb)!;
  return { status: "review", value: only.display, candidates: [only.display], reason: "one_read_unclear" };
}
