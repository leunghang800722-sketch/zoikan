// 身份證號純函數（零依賴，可喺 client bundle 用）。identity.ts re-export，現有 import 唔變。

/** canonical key：大寫、去空白（含全形空白）、去半形／全形括號。唔係身份證格式就 null。
 * （搬自 src/lib/guard-fix/sources.ts，原處 re-export。） */
export function canonicalHkid(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.toUpperCase().replace(/[\s　]+/g, "").replace(/[()（）]/g, "");
  return /^[A-Z]{1,2}\d{6}[0-9A]$/.test(s) ? s : null;
}

/** q → 身份證搜尋 key：canonical 式正規化（大寫、去空白／全形空白、去半形／全形括號、全形英數轉半形）；長度 ≥4 先當 hkid 搜。 */
export function hkidSearchKey(q: string): string | null {
  const k = q
    .normalize("NFKC")
    .toUpperCase()
    .replace(/[\s　]+/g, "")
    .replace(/[()（）]/g, "");
  return /^[A-Z0-9]{4,}$/.test(k) ? k : null;
}

/** canonical → 顯示格式 `A123456(3)`。 */
export function formatHkid(canon: string): string {
  return `${canon.slice(0, -1)}(${canon.slice(-1)})`;
}

/** 香港身份證 check digit（mod 11）。單字母前綴當第一位係空格（值 36）。
 * 合法範例：`A123456(3)`（註：`A123456(7)` 嘅 check digit 係錯嘅）。接受 canonical 或帶括號寫法。 */
export function hkidCheckDigitValid(raw: string | null | undefined): boolean {
  const canon = canonicalHkid(raw);
  if (!canon) return false;
  const letters = canon.match(/^[A-Z]+/)![0];
  const digits = canon.slice(letters.length, -1);
  const check = canon.slice(-1);
  const val = (ch: string) => ch.charCodeAt(0) - 55; // A=10
  const first = letters.length === 2 ? val(letters[0]!) : 36;
  const second = val(letters[letters.length - 1]!);
  let sum = first * 9 + second * 8;
  for (let i = 0; i < 6; i++) sum += Number(digits[i]) * (7 - i);
  const checkVal = check === "A" ? 10 : Number(check);
  return (sum + checkVal) % 11 === 0;
}


export type HkidInputState = "empty" | "partial" | "bad_check" | "valid";

/**
 * TE-6：身份證號輸入框即時狀態。NFKC（全形英數／括號／空白）＋大寫＋去括號空白後：
 * 空＝empty；格式未齊（未成 1–2 字母＋6 數字＋檢查碼）＝partial；格式齊但 check digit 唔啱＝bad_check；合法＝valid（canon＝送出值）。
 */
export function hkidInputState(raw: string): { state: HkidInputState; canon: string | null } {
  const t = raw.normalize("NFKC");
  if (!t.trim()) return { state: "empty", canon: null };
  const canon = canonicalHkid(t);
  if (!canon) return { state: "partial", canon: null };
  return hkidCheckDigitValid(canon) ? { state: "valid", canon } : { state: "bad_check", canon };
}
