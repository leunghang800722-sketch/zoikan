// 申請表「地址」填寫欄定位（純函數；Vision 正規化座標，原點左下）。
// 兩款範本：A（Maxwell「住址：」同行填寫，下一行係「通訊地址」）；B（Wilson「地址 Address」下面填寫）。
import { cy, norm, type OcrLine } from './ocr';
import type { Box, Template } from './phone-crop';

export type Variant = 'a' | 'b';

const RE_RES = /^[住生世佳售佳]\s*址|^[^通]{0,3}[住生世佳售]址[:：]/; // 住址（OCR 常誤讀成 生址／世址／佳址／售址；唔係「通訊地址」）
const RE_MAIL = /通訊地址/;
const RE_ADDR_B = /^地址[:：]?$|^Address\s*[:：]?$/i;
const RE_NOT = /僱主|電郵|Email|諮詢|學校/i;

const clamp = (b: Box): Box => ({ x0: Math.max(0, b.x0), x1: Math.min(1, b.x1), y0: Math.max(0, b.y0), y1: Math.min(1, b.y1) });

export function locateFormAddressBox(lines: OcrLine[], variant: Variant = 'a'): { template: Template; box: Box } | null {
  const ls = lines.filter((l) => l.t.trim());
  const m = variant === 'b' ? 0.012 : 0;
  // 範本 A
  const res = ls.find((l) => RE_RES.test(norm(l.t)) && !RE_MAIL.test(l.t) && !RE_NOT.test(l.t) && l.x < 0.3);
  if (res) {
    const y = cy(res);
    const mail = ls.find((l) => RE_MAIL.test(l.t) && cy(l) < y && cy(l) > y - 0.04);
    const y0 = (mail ? cy(mail) + 0.004 : y - 0.018) - m;
    return { template: 'A', box: clamp({ x0: res.x - 0.01 - m, x1: 0.99, y0, y1: y + 0.022 + m }) };
  }
  // 範本 A 後備：「住址」label 讀唔到，但「通訊地址」label 喺——住址欄就喺佢上面一行
  const mail0 = ls.find((l) => RE_MAIL.test(l.t) && l.x < 0.3);
  if (mail0) {
    const y = cy(mail0);
    return { template: 'A', box: clamp({ x0: mail0.x - 0.01 - m, x1: 0.99, y0: y + 0.004 - m, y1: y + 0.036 + m }) };
  }
  // 範本 B：「地址：」與「Address：」兩行，填寫喺下面（唔跨到下一格「香港身份證」）
  const cn = ls.find((l) => RE_ADDR_B.test(norm(l.t)) && /地址/.test(l.t) && l.x < 0.3);
  const en = ls.find((l) => /^Address\s*[:：]?$/i.test(norm(l.t)) && l.x < 0.3 && !RE_NOT.test(l.t));
  const lab = cn ?? en;
  if (lab) {
    const top = cn ? cy(cn) : cy(lab);
    const bottom = en ? cy(en) : top;
    const idRow = ls.find((l) => /身份證|I\.?D\.?\s*Card/i.test(l.t) && cy(l) < bottom && l.x < 0.3);
    const y0 = Math.max(idRow ? cy(idRow) + 0.012 : 0, bottom - 0.04 - m);
    return { template: 'B', box: clamp({ x0: lab.x - 0.01 - m, x1: 0.99, y0, y1: top + 0.014 + m }) };
  }
  // 範本 B 後備：「地址：」label 讀唔到，但「香港身份證：」label 喺——地址欄就喺佢上面
  const idl = ls.find((l) => /^[香晋雪]港身份證[:：;；]?$/.test(norm(l.t)) && l.x < 0.2);
  if (idl) {
    const y = cy(idl);
    return { template: 'B', box: clamp({ x0: idl.x - 0.01 - m, x1: 0.99, y0: y + 0.012 - m, y1: y + 0.06 + m }) };
  }
  return null;
}
