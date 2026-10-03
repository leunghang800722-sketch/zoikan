// OCR 行／頁型別＋版面小工具（純函數）。座標係 Vision 正規化（原點左下）。
export interface OcrLine {
  t: string;
  c: number;
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface OcrPage {
  page: number;
  lines: OcrLine[];
}

/** 全形 → 半形、統一空白，方便 regex。 */
export function norm(s: string): string {
  return s
    .replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/　/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function cy(l: OcrLine): number {
  return l.y + l.h / 2;
}

/** 由上而下、同行由左而右。 */
export function readingOrder(lines: OcrLine[]): OcrLine[] {
  return [...lines].sort((a, b) => cy(b) - cy(a) || a.x - b.x);
}

export interface Row {
  y: number;
  lines: OcrLine[];
  text: string;
}

/** 同一水平線（中心 y 差 < tol）嘅 OCR 行合成一 row。 */
export function toRows(lines: OcrLine[], tol = 0.007): Row[] {
  const sorted = [...lines].sort((a, b) => cy(b) - cy(a));
  const rows: Row[] = [];
  for (const l of sorted) {
    const last = rows[rows.length - 1];
    if (last && Math.abs(last.y - cy(l)) < tol) {
      last.lines.push(l);
    } else {
      rows.push({ y: cy(l), lines: [l], text: '' });
    }
  }
  for (const r of rows) {
    r.lines.sort((a, b) => a.x - b.x);
    r.text = r.lines.map((l) => l.t).join(' ');
  }
  return rows;
}

export function minConf(lines: OcrLine[]): number {
  return lines.length ? Math.min(...lines.map((l) => l.c)) : 0;
}
