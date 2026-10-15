// 申請表「地址」填寫欄定位（純函數；Vision 正規化座標，原點左下）。
// 兩款範本：A（Maxwell「住址：」同行填寫，下一行係「通訊地址」）；B（Wilson「地址 Address」下面填寫）。
import { cy, norm, type OcrLine } from './ocr';
import type { Box, Template } from './phone-crop';
import { isLabelLine, padAround, type PadSpec } from './crop-pad';

export type Variant = 'a' | 'b';

const RE_RES = /^[住生世佳售佳]\s*址|^[^通]{0,3}[住生世佳售]址[:：]/; // 住址（OCR 常誤讀成 生址／世址／佳址／售址；唔係「通訊地址」）
const RE_MAIL = /通訊地址/;
const RE_ADDR_B = /^地址[:：]?$|^Address\s*[:：]?$/i;
const RE_NOT = /僱主|電郵|Email|諮詢|學校/i;

/** 第二套（variant b）裁圖較闊：最少外擴多 0.012（同舊版 m 一致）。pad 參數可由 caller 覆蓋。 */
export function locateFormAddressBox(lines: OcrLine[], variant: Variant = 'a', pad: Partial<PadSpec> = {}): { template: Template; box: Box } | null {
  const ls = lines.filter((l) => l.t.trim());
  const barriers = ls.filter(isLabelLine);
  const pd: Partial<PadSpec> = { min: variant === 'b' ? 0.042 : 0.03, ...pad };
  // 範本 A
  const res = ls.find((l) => RE_RES.test(norm(l.t)) && !RE_MAIL.test(l.t) && !RE_NOT.test(l.t) && l.x < 0.3);
  if (res) {
    const y = cy(res);
    const mail = ls.find((l) => RE_MAIL.test(l.t) && cy(l) < y && cy(l) > y - 0.04);
    // 欄位格＝「住址」label 行；有「通訊地址」label 就一路延伸到佢上面（硬界線）
    const y0 = mail ? mail.y + mail.h + 0.002 : res.y;
    return { template: 'A', box: padAround({ x0: res.x, x1: 0.99, y0: Math.min(y0, res.y), y1: res.y + res.h }, res.h, barriers, pd) };
  }
  // 範本 A 後備：「住址」label 讀唔到，但「通訊地址」label 喺——住址欄就喺佢上面一行
  const mail0 = ls.find((l) => RE_MAIL.test(l.t) && l.x < 0.3);
  if (mail0) {
    const y0 = mail0.y + mail0.h + 0.002;
    return { template: 'A', box: padAround({ x0: mail0.x, x1: 0.99, y0, y1: y0 + 3 * mail0.h }, mail0.h, barriers, pd) };
  }
  // 範本 B：「地址：」與「Address：」兩行，填寫喺下面（唔跨到下一格「香港身份證」）
  const cn = ls.find((l) => RE_ADDR_B.test(norm(l.t)) && /地址/.test(l.t) && l.x < 0.3);
  const en = ls.find((l) => /^Address\s*[:：]?$/i.test(norm(l.t)) && l.x < 0.3 && !RE_NOT.test(l.t));
  const lab = cn ?? en;
  if (lab) {
    const topL = cn ?? lab;
    const botL = en ?? topL;
    return { template: 'B', box: padAround({ x0: lab.x, x1: 0.99, y0: botL.y - 3 * lab.h, y1: topL.y + topL.h }, lab.h, barriers, pd) };
  }
  // 範本 B 後備：「地址：」label 讀唔到，但「香港身份證：」label 喺——地址欄就喺佢上面
  const idl = ls.find((l) => /^[香晋雪]港身份證[:：;；]?$/.test(norm(l.t)) && l.x < 0.2);
  if (idl) {
    const y0 = idl.y + idl.h + 0.002;
    return { template: 'B', box: padAround({ x0: idl.x, x1: 0.99, y0, y1: y0 + 4 * idl.h }, idl.h, barriers, pd) };
  }
  return null;
}
