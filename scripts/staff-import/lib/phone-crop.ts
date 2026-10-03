// 申請表電話欄定位（純函數）：用本機 OCR 已定位嘅 label 座標，計出要裁嘅範圍（Vision 正規化座標，原點左下）。
import { cy, norm, type OcrLine } from './ocr';

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
export type Template = 'A' | 'B';

const RE_MOBILE = /[手车半F千]?提[電範]?話|MOBILE/i;
const RE_CONTACT = /聯絡電話|Phone\s*No/i;

export function locatePhoneBox(lines: OcrLine[]): { template: Template; box: Box } | null {
  const ls = lines.filter((l) => l.t.trim());
  // 範本 A：「手提電話」同一行右邊填寫（呢行如果有緊急聯絡人字眼就唔係）
  const mob = ls.find((l) => RE_MOBILE.test(norm(l.t)) && !/緊急|僱主/.test(l.t));
  if (mob) {
    const y = cy(mob);
    return { template: 'A', box: clamp({ x0: mob.x - 0.01, x1: 0.99, y0: y - 0.018, y1: y + 0.016 }) };
  }
  // 範本 B：「聯絡電話 Phone No.」下一行填寫，左欄（唔跨去右邊「住所電話」）
  const labs = ls.filter((l) => RE_CONTACT.test(norm(l.t)) && l.x < 0.3);
  if (labs.length) {
    const top = Math.max(...labs.map((l) => cy(l)));
    const bottom = Math.min(...labs.map((l) => cy(l)));
    const x = Math.min(...labs.map((l) => l.x));
    return { template: 'B', box: clamp({ x0: x - 0.01, x1: x + 0.32, y0: bottom - 0.035, y1: top + 0.012 }) };
  }
  return null;
}

function clamp(b: Box): Box {
  return { x0: Math.max(0, b.x0), x1: Math.min(1, b.x1), y0: Math.max(0, b.y0), y1: Math.min(1, b.y1) };
}

/** 正規化 box → 像素 crop（左上原點）。 */
export function toPixels(b: Box, w: number, h: number) {
  return { x: Math.round(b.x0 * w), y: Math.round((1 - b.y1) * h), w: Math.round((b.x1 - b.x0) * w), h: Math.round((b.y1 - b.y0) * h) };
}
