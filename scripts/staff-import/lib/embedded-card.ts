// TE-2：一頁多文件——嵌入式身份證偵測（純函數，零 IO）。
// 例：保安牌照頁右下角貼住一張身份證副本。導入流程原本只按「整頁」分類，會漏咗嵌入卡；呢度用 OCR 行搵：
//  有符合 HKID 格式嘅整行（^[A-Z]{1,2}\s?\d{6}\s?\(?[0-9A]\)?$）＋附近（卡區內）有「出生日期／Date of Birth／簽發日期」label，
//  就由號碼行闊度估算卡闊（85.6×54mm 比例），推一個「卡區」。座標係 Vision 正規化（原點左下）。
import { norm, type OcrLine } from './ocr';

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
export interface CardRegion {
  /** 卡區（頁面正規化座標） */
  box: Box;
  /** 號碼行 */
  hkid: OcrLine;
  /** 卡區內嘅 label 行（出生日期／簽發日期） */
  labels: OcrLine[];
}

const HKID_LINE = /^[A-Z]{1,2}\s?\d{6}\s?\(?\s?[0-9A]\s?\)?$/;
/** 整行符合 HKID 格式（容許全形括號、前後空白）。 */
export const isHkidFormatLine = (t: string): boolean => HKID_LINE.test(norm(t).toUpperCase().replace(/[（]/g, '(').replace(/[）]/g, ')').trim());
const CARD_LABEL = /出生日期|Date\s*of\s*Birth|簽發日期|Date\s*of\s*Issue/i;

/** 號碼行闊度約佔卡闊嘅 1/3.8（真卡版面：號碼印喺右下，約四分一卡闊）；卡比例 85.6×54mm。 */
const NUM_TO_CARD_W = 3.8;
const CARD_RATIO = 85.6 / 54;

/**
 * 喺（已經正向嘅）頁面 OCR 行搵嵌入式身份證卡區。aspect＝頁寬／頁高（兩個方向長度唔同要換算）。
 * 號碼行假設印喺卡嘅右下（相片正下方）：卡區右緣＝號碼行右緣外 6% 卡闊、下緣＝號碼行底外 12% 卡高。
 */
export function findEmbeddedCards(lines: readonly OcrLine[], aspect = 1): CardRegion[] {
  const clean = lines.filter((l) => l.t.trim());
  const out: CardRegion[] = [];
  for (const h of clean) {
    if (!isHkidFormatLine(h.t)) continue;
    const cardWn = Math.min(1, (h.w * NUM_TO_CARD_W)); // 頁寬單位
    const cardHn = Math.min(1, (cardWn * aspect) / CARD_RATIO); // 頁高單位（卡高 = 卡闊 / 比例；闊度先換成頁高單位）
    const x1 = Math.min(1, h.x + h.w + 0.06 * cardWn);
    const x0 = Math.max(0, x1 - cardWn);
    const y0 = Math.max(0, h.y - 0.12 * cardHn);
    const y1 = Math.min(1, y0 + cardHn);
    const box: Box = { x0, y0, x1, y1 };
    const labels = clean.filter((l) => l !== h && CARD_LABEL.test(norm(l.t)) && l.x + l.w / 2 >= x0 && l.x + l.w / 2 <= x1 && l.y + l.h / 2 >= y0 && l.y + l.h / 2 <= y1);
    if (labels.length === 0) continue;
    if (out.some((c) => c.hkid === h)) continue;
    out.push({ box, hkid: h, labels });
  }
  return out;
}

export const inBox = (b: Box, l: OcrLine): boolean => l.x + l.w / 2 >= b.x0 && l.x + l.w / 2 <= b.x1 && l.y + l.h / 2 >= b.y0 && l.y + l.h / 2 <= b.y1;

/** 卡區內嘅 OCR 行（身份證抽取只對卡區行做）。 */
export const cardLines = (c: CardRegion, lines: readonly OcrLine[]): OcrLine[] => lines.filter((l) => l.t.trim() && inBox(c.box, l));
