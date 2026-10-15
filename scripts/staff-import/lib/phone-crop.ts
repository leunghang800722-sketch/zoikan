// 申請表電話欄定位（純函數）：用本機 OCR 已定位嘅 label 座標，計出要裁嘅範圍（Vision 正規化座標，原點左下）。
import { cy, norm, type OcrLine } from './ocr';
import { isLabelLine, padAround, type PadSpec } from './crop-pad';

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
export type Template = 'A' | 'B';

const RE_MOBILE = /[手车半F千]?提[電範]?話|MOBILE/i;
const RE_CONTACT = /聯絡電話|Phone\s*No/i;

export function locatePhoneBox(lines: OcrLine[], pad: Partial<PadSpec> = {}): { template: Template; box: Box } | null {
  const ls = lines.filter((l) => l.t.trim());
  const barriers = ls.filter(isLabelLine);
  // 範本 A：「手提電話」同一行右邊填寫（呢行如果有緊急聯絡人字眼就唔係）
  const mob = ls.find((l) => RE_MOBILE.test(norm(l.t)) && !/緊急|僱主/.test(l.t));
  if (mob) {
    // 欄位格＝「手提電話」label 行；外擴按行高比例，唔越過上／下一個 label 行（WP-OCR-3）
    void cy;
    return { template: 'A', box: padAround({ x0: mob.x, x1: 0.99, y0: mob.y, y1: mob.y + mob.h }, mob.h, barriers, pad) };
  }
  // 範本 B：「聯絡電話 Phone No.」下一行填寫，左欄（唔跨去右邊「住所電話」）
  const labs = ls.filter((l) => RE_CONTACT.test(norm(l.t)) && l.x < 0.3);
  if (labs.length) {
    const top = Math.max(...labs.map((l) => l.y + l.h));
    const bottom = Math.min(...labs.map((l) => l.y));
    const h = Math.max(...labs.map((l) => l.h));
    const x = Math.min(...labs.map((l) => l.x));
    // 欄位格＝label 行加下面兩行高嘅填寫位；右邊唔過同行嘅其他 label（例如「住所電話」）
    return { template: 'B', box: padAround({ x0: x, x1: x + 0.32, y0: bottom - 2 * h, y1: top }, h, barriers, pad) };
  }
  return null;
}

/** 正規化 box → 像素 crop（左上原點）。 */
export function toPixels(b: Box, w: number, h: number) {
  return { x: Math.round(b.x0 * w), y: Math.round((1 - b.y1) * h), w: Math.round((b.x1 - b.x0) * w), h: Math.round((b.y1 - b.y0) * h) };
}
