// 交叉核對用嘅比對正規化（純函數）。
import { editDistance } from './text';
import { normalizeHkAddress } from '@/lib/guards/ocr/hk-address';

export type Cmp = 'match' | 'mismatch' | 'no_reference';

export function normZh(s: string | null | undefined): string | null {
  if (!s) return null;
  const t = s.normalize('NFC').replace(/[\s()（）·．.,，、\-]/g, '');
  return /[一-鿿]/.test(t) ? t : null;
}

export function cmpZh(a: string | null, b: string | null): { r: Cmp; near: boolean } {
  const x = normZh(a);
  const y = normZh(b);
  if (!x || !y) return { r: 'no_reference', near: false };
  if (x === y) return { r: 'match', near: false };
  const near = Math.min(x.length, y.length) >= 3 && editDistance(x, y) <= 1;
  return { r: 'mismatch', near };
}

export function enTokens(s: string | null | undefined): string[] {
  return (s ?? '')
    .toUpperCase()
    .split(/[^A-Z]+/)
    .filter((t) => t.length >= 1);
}

/** 英文名：token 集合相等，或其中一邊係另一邊子集（卡面名可能斷行被截）。 */
export function cmpEn(a: string | null, b: string | null): Cmp {
  const x = enTokens(a);
  const y = enTokens(b);
  if (!x.length || !y.length) return 'no_reference';
  const sx = new Set(x);
  const sy = new Set(y);
  const aInB = x.every((t) => sy.has(t));
  const bInA = y.every((t) => sx.has(t));
  // 子集要至少 2 個 token（淨係姓都撞中太寬鬆）
  if ((aInB || bInA) && Math.min(sx.size, sy.size) >= 2) return 'match';
  return 'mismatch';
}

export function normTel(s: string | null | undefined): string | null {
  if (!s) return null;
  const d = s.replace(/\D/g, '');
  const t = d.length > 8 && d.startsWith('852') ? d.slice(3) : d;
  return /^\d{8}$/.test(t) ? t : null;
}

export function cmpTel(a: string | null, b: string | null): Cmp {
  const x = normTel(a);
  const y = normTel(b);
  if (!x || !y) return 'no_reference';
  return x === y ? 'match' : 'mismatch';
}

/** 解析各種手打日期：2000-01-02／2/1/2000（d/m/y）／2000/1/2／02.01.2000。 */
export function parseLooseDate(s: string | null | undefined): string | null {
  if (!s) return null;
  const t = s.trim();
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(t);
  let y: number, mo: number, d: number;
  if (m) {
    y = +m[1];
    mo = +m[2];
    d = +m[3];
  } else {
    m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/.exec(t);
    if (!m) return null;
    d = +m[1];
    mo = +m[2];
    y = +m[3];
  }
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function cmpDate(a: string | null, b: string | null): Cmp {
  const x = parseLooseDate(a);
  const y = parseLooseDate(b);
  if (!x || !y) return 'no_reference';
  return x === y ? 'match' : 'mismatch';
}

export function cmpHkid(a: string | null, b: string | null): Cmp {
  if (!a || !b) return 'no_reference';
  return a === b ? 'match' : 'mismatch';
}

// ---- 地址
const SYN: Record<string, string> = {
  HSE: 'HOUSE', EST: 'ESTATE', RM: 'ROOM', FT: 'FLAT', FLT: 'FLAT', BLK: 'BLOCK', ST: 'STREET', RD: 'ROAD', GDN: 'GARDEN',
  BLDG: 'BUILDING', MAN: 'MANSION', KLN: 'KOWLOON', CT: 'COURT', AVE: 'AVENUE',
};
const STOP_EN = new Set(['HK', 'HKSAR', 'HONG', 'KONG', 'NEW', 'TERRITORIES', 'NT', 'KOWLOON', 'NO', 'OF', 'AND', 'THE', 'F', 'FL', 'FLOOR', 'FLAT', 'ROOM', 'BLOCK', 'N', 'T']);
const STOP_ZH = new Set(['香', '港', '九', '龍', '新', '界', '室', '樓', '座', '號', '街', '道', '邨', '苑', '的', '之', '大', '廈', '屋', '花', '園']);

export interface AddrSig {
  script: 'en' | 'zh' | 'none';
  nums: string[];
  words: string[];
}

export function addrSig(s: string | null | undefined): AddrSig {
  // 手打地址常黏埋（16/FWang、Court22-26）——先喺 /F 後同字母→數字邊界加空格，兩邊一致處理
  const t = (s ?? '').normalize('NFC').toUpperCase().replace(/(\d)\s*\/\s*F(?=[A-Z])/g, '$1/F ').replace(/([A-Z])(?=\d)/g, '$1 ');
  const zh = (t.match(/[一-鿿]/g) ?? []).length;
  const en = (t.match(/[A-Z]/g) ?? []).length;
  const nums = (t.match(/\d+[A-Z]?/g) ?? []).map((x) => x.replace(/[A-Z]$/, (c) => (STOP_EN.has(c) ? '' : c)));
  if (zh === 0 && en === 0) return { script: 'none', nums, words: [] };
  if (zh >= en) {
    const words = [...new Set((t.match(/[一-鿿]/g) ?? []).filter((c) => !STOP_ZH.has(c)))];
    return { script: 'zh', nums, words };
  }
  const words = [
    ...new Set(
      (t.match(/[A-Z]+/g) ?? [])
        .map((w) => SYN[w] ?? w)
        .filter((w) => w.length >= 2 && !STOP_EN.has(w)),
    ),
  ];
  return { script: 'en', nums, words };
}

function jacc(a: string[], b: string[]): number {
  const sa = new Set(a);
  const sb = new Set(b);
  if (!sa.size && !sb.size) return 1;
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter++;
  return inter / (sa.size + sb.size - inter);
}

export function cmpAddress(a: string | null, b: string | null): Cmp | 'not_comparable' {
  if (!a || !b) return 'no_reference';
  let x = addrSig(a);
  let y = addrSig(b);
  if (x.script === 'none' || y.script === 'none' || x.script !== y.script) return 'not_comparable';
  // WP-OCR-2：中文地址用 hk-address canon（形近字歸一：邨／村、埗／步、涌／湧…；單位詞歸一）比對
  if (x.script === 'zh') {
    x = addrSig(normalizeHkAddress(a).canon);
    y = addrSig(normalizeHkAddress(b).canon);
  }
  const wj = jacc(x.words, y.words);
  const nj = x.nums.length && y.nums.length ? jacc(x.nums, y.nums) : 0.5;
  return wj >= 0.5 && nj >= 0.5 ? 'match' : 'mismatch';
}

export function fieldStatus(rs: (Cmp | 'not_comparable')[]): Cmp | 'mixed' {
  const real = rs.filter((r): r is Cmp => r === 'match' || r === 'mismatch');
  if (!real.length) return 'no_reference';
  const m = real.includes('match');
  const mm = real.includes('mismatch');
  if (m && mm) return 'mixed';
  return m ? 'match' : 'mismatch';
}
