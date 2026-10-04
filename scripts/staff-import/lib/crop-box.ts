// 視覺裁圖定位（純函數；Vision 正規化座標，原點左下）。
import { cardRegion, extractIdCard, findAddressBlock } from './extract';
import { cy, type OcrLine } from './ocr';
import type { Box } from './phone-crop';

const clamp = (b: Box): Box => ({ x0: Math.max(0, b.x0), x1: Math.min(1, b.x1), y0: Math.max(0, b.y0), y1: Math.min(1, b.y1) });

function bbox(ls: OcrLine[]): Box {
  return {
    x0: Math.min(...ls.map((l) => l.x)),
    x1: Math.max(...ls.map((l) => l.x + l.w)),
    y0: Math.min(...ls.map((l) => l.y)),
    y1: Math.max(...ls.map((l) => l.y + l.h)),
  };
}

/** 身份證姓名區（中文名＋英文名各段）；定位唔到就成張卡；再唔到就成頁。 */
export function locateNameBox(page: number, lines: OcrLine[]): { box: Box; how: 'name' | 'card' | 'page' } {
  const r = extractIdCard(page, lines);
  const nl = r.nameLines ?? [];
  if (nl.length) {
    const b = bbox(nl);
    return { box: clamp({ x0: b.x0 - 0.04, x1: b.x1 + 0.1, y0: b.y0 - 0.035, y1: b.y1 + 0.02 }), how: 'name' };
  }
  const region = cardRegion(lines.filter((l) => l.t.trim()));
  if (region.length && region.length < lines.length) {
    const b = bbox(region);
    return { box: clamp({ x0: b.x0 - 0.02, x1: b.x1 + 0.05, y0: b.y0 - 0.02, y1: b.y1 + 0.02 }), how: 'card' };
  }
  return { box: { x0: 0, x1: 1, y0: 0, y1: 1 }, how: 'page' };
}

/** 收件人 block（收件人名＋地址各行）；定位唔到就成頁。 */
export function locateAddressBox(lines: OcrLine[]): { box: Box; how: 'block' | 'page' } {
  const blk = findAddressBlock(lines);
  if (blk) {
    const ls = [...blk.lines, ...(blk.name ? [blk.name] : [])];
    const b = bbox(ls);
    const bottomExtra = 0.03; // 多留一行，睇下有冇斷尾
    void cy;
    return { box: clamp({ x0: b.x0 - 0.03, x1: b.x1 + 0.08, y0: b.y0 - bottomExtra, y1: b.y1 + 0.02 }), how: 'block' };
  }
  return { box: { x0: 0, x1: 1, y0: 0, y1: 1 }, how: 'page' };
}

/** 出生日期＋性別行（唔包 hkid、姓名）；定位唔到就裁卡面下半。 */
export function locateDobBox(page: number, lines: OcrLine[]): { box: Box; how: 'dob' | 'card_lower' | 'page_lower' } {
  const r = extractIdCard(page, lines);
  const dl = r.dobLines ?? [];
  if (dl.length) {
    const b = bbox(dl);
    return { box: clamp({ x0: b.x0 - 0.04, x1: b.x1 + 0.12, y0: b.y0 - 0.02, y1: b.y1 + 0.012 }), how: 'dob' };
  }
  const region = cardRegion(lines.filter((l) => l.t.trim()));
  if (region.length && region.length < lines.length) {
    const b = bbox(region);
    return { box: clamp({ x0: b.x0 - 0.02, x1: b.x1 + 0.05, y0: b.y0 - 0.02, y1: (b.y0 + b.y1) / 2 }), how: 'card_lower' };
  }
  return { box: { x0: 0, x1: 1, y0: 0, y1: 0.5 }, how: 'page_lower' };
}

/** 英文名補漏：整張卡（含較大邊界）；定位唔到就成頁。 */
export function locateWideBox(page: number, lines: OcrLine[]): { box: Box; how: 'card' | 'page' } {
  void page;
  const region = cardRegion(lines.filter((l) => l.t.trim()));
  if (region.length && region.length < lines.length) {
    const b = bbox(region);
    return { box: clamp({ x0: b.x0 - 0.08, x1: b.x1 + 0.1, y0: b.y0 - 0.08, y1: b.y1 + 0.08 }), how: 'card' };
  }
  return { box: { x0: 0, x1: 1, y0: 0, y1: 1 }, how: 'page' };
}

const HKID_LINE = /[A-Z]{1,2}\s?\d{6}\s?[(（]?\s?[0-9A]\s?[)）]?/;

/**
 * 姓名區第二套裁圖（Stage A7）：邊界同 locateNameBox 唔同（左右較緊、上下較闊），
 * 並且把裁圖下緣抬高到身份證號行之上、右緣唔過相片側，盡量唔裁到身份證號／相片。
 */
export function locateNameBoxB(page: number, lines: OcrLine[]): { box: Box; how: 'name' | 'card' | 'page' } {
  const r = extractIdCard(page, lines);
  const nl = r.nameLines ?? [];
  if (nl.length) {
    const b = bbox(nl);
    let box: Box = { x0: b.x0 - 0.02, x1: b.x1 + 0.05, y0: b.y0 - 0.055, y1: b.y1 + 0.035 };
    // 身份證號行（OCR 文字似 hkid）喺姓名下面而且落入裁圖 → 下緣抬到佢上面
    for (const l of lines) {
      if (!HKID_LINE.test(l.t.toUpperCase())) continue;
      const top = l.y + l.h;
      if (top <= b.y0 + 0.005 && top > box.y0) box = { ...box, y0: top + 0.002 };
    }
    return { box: clamp(box), how: 'name' };
  }
  const region = cardRegion(lines.filter((l) => l.t.trim()));
  if (region.length && region.length < lines.length) {
    const b = bbox(region);
    return { box: clamp({ x0: b.x0 - 0.03, x1: b.x1 + 0.03, y0: (b.y0 + b.y1) / 2 - 0.02, y1: b.y1 + 0.03 }), how: 'card' };
  }
  return { box: { x0: 0, x1: 1, y0: 0, y1: 1 }, how: 'page' };
}
