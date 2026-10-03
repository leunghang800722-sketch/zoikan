// 身份證號：正規化＋check digit（純函數）。
// canonical 同 src/lib/guard-fix/sources.ts 一致（大寫、去空白、去括號）。

export function canonicalHkid(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.toUpperCase().replace(/\s+/g, '').replace(/[()（）]/g, '');
  return /^[A-Z]{1,2}\d{6}[0-9A]$/.test(s) ? s : null;
}

/** 香港身份證 check digit（mod 11）。單字母前綴當第一位係空格（值 36）。 */
export function hkidCheckDigitValid(canon: string | null | undefined): boolean {
  if (!canon || !/^[A-Z]{1,2}\d{6}[0-9A]$/.test(canon)) return false;
  const letters = canon.match(/^[A-Z]+/)![0];
  const digits = canon.slice(letters.length, -1);
  const check = canon.slice(-1);
  const val = (ch: string) => ch.charCodeAt(0) - 55; // A=10
  const first = letters.length === 2 ? val(letters[0]) : 36;
  const second = val(letters[letters.length - 1]);
  let sum = first * 9 + second * 8;
  for (let i = 0; i < 6; i++) sum += Number(digits[i]) * (7 - i);
  const checkVal = check === 'A' ? 10 : Number(check);
  return (sum + checkVal) % 11 === 0;
}

export function formatHkid(canon: string): string {
  return `${canon.slice(0, -1)}(${canon.slice(-1)})`;
}

const CONFUSABLE: Record<string, string> = { O: '0', Q: '0', D: '0', I: '1', L: '1', Z: '2', S: '5', B: '8', G: '6' };

/**
 * 由一行 OCR 文字搵身份證號候選（容忍括號／空格／OCR 常見數字字母混淆）。
 * 回傳 canonical（唔保證 check digit 啱，由 caller 驗）。
 */
export function findHkidCandidates(text: string): string[] {
  const t = text.toUpperCase().replace(/[（【\[{]/g, '(').replace(/[）】\]}]/g, ')');
  const out = new Set<string>();
  // 模式：1–2 字母＋6 位（容許空格／括號＋check digit）
  const re = /([A-Z]{1,2})[\s-]?([0-9OQDILZSBG]{6})\s*\(?\s*([0-9A])?\s*\)?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(t))) {
    if ((m[2].match(/\d/g) ?? []).length < 4) continue; // 防 OCR 英文字誤中
    const digits = m[2].replace(/[OQDILZSBG]/g, (c) => CONFUSABLE[c] ?? c);
    if (!/^\d{6}$/.test(digits)) continue;
    const check = m[3];
    if (!check) continue;
    const c = canonicalHkid(`${m[1]}${digits}${check}`);
    if (c) out.add(c);
  }
  // 單串 7 位（check digit 冇括號、連埋數字）：A1234563
  const re2 = /\b([A-Z]{1,2})(\d{7}|\d{6}A)\b/g;
  while ((m = re2.exec(t))) {
    const c = canonicalHkid(`${m[1]}${m[2]}`);
    if (c) out.add(c);
  }
  // OCR 將「(」讀成數字／字母：X123456<junk>7)——例如 A123456（3）→ A12345663）
  const re3 = /\b([A-Z]{1,2})(\d{6})[^\s]?\)?\s*([0-9A])\)?\s*$/g;
  while ((m = re3.exec(t.trim()))) {
    const c = canonicalHkid(`${m[1]}${m[2]}${m[3]}`);
    if (c) out.add(c);
  }
  return [...out];
}

/**
 * check digit 唔啱時，試單一位置嘅 OCR 常見混淆替換，剛好得一個啱先採用（否則 null）。
 */
export function repairHkid(canon: string): string | null {
  const pairs: Record<string, string[]> = {
    '0': ['8', '6', '9'], '1': ['7'], '2': ['7'], '3': ['8'], '5': ['6', '8'], '6': ['5', '8', '0'], '7': ['1'],
    '8': ['0', '6', '3', '9'], '9': ['8', '0', '4'], '4': ['9'], A: ['4'],
  };
  const hits = new Set<string>();
  for (let i = 0; i < canon.length; i++) {
    const subs = pairs[canon[i]] ?? [];
    if (/[A-Z]/.test(canon[i]) && i < canon.length - 1) continue;
    for (const s of subs) {
      const cand = canon.slice(0, i) + s + canon.slice(i + 1);
      if (hkidCheckDigitValid(cand)) hits.add(cand);
    }
  }
  return hits.size === 1 ? [...hits][0] : null;
}

const DIGIT_TO_LETTER: Record<string, string> = { '2': 'Z', '5': 'S', '8': 'B', '6': 'G', '0': 'O', '1': 'I', '4': 'A', '7': 'T' };

/**
 * 首字母被讀成數字（例 Z→2）：試將第一個字元換返字母，淨係接受 check digit 啱嘅結果。
 */
export function repairHkidLeadingLetter(text: string): string | null {
  const t = text.toUpperCase().replace(/[（【\[{]/g, '(').replace(/[）】\]}]/g, ')').replace(/\s+/g, '');
  const m = /^(\d)(\d{6})[^\d]?\(?([0-9A])\)?$/.exec(t);
  if (!m) return null;
  const l = DIGIT_TO_LETTER[m[1]];
  if (!l) return null;
  const c = canonicalHkid(`${l}${m[2]}${m[3]}`);
  return c && hkidCheckDigitValid(c) ? c : null;
}
