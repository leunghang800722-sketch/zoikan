// WP-STAFF-FIELDS：用 OCR label 座標（Vision 正規化，原點左下）決定申請表／牌照頁／銀行頁嘅裁圖範圍。純函數，無 PII。
import { norm, type OcrLine } from './ocr';
import type { NBox } from './fields-render';

export type FormTemplate = 'wilson' | 'maxwell' | 'other';
export type CropKind = 'form_join' | 'form_personal' | 'form_emergency' | 'form_permits' | 'permit_card' | 'bank_page';

const RE = {
  maxwell: /在勤|MAXWELL|EMPLOYMENT APPLICATION/i,
  wilson: /WILSON|威信|職位申請表|Application Form/i,
  join: /(?<!可)到職日期|Date of Join|入職日期/i,
  bank: /銀行名稱|Name of Bank/i,
  permitNo: /許可證牌照號碼|Permit License No|許可證號碼/i,
  permitExp: /Permit Expiration|許可證屆滿日期|許可證屆滿/i,
  staffNo: /職員編號|Staff No/i,
  emergW: /兩位緊急聯絡人|Two Emergency|Emergency Contacts/i,
  emergM: /緊急事故聯絡人|緊急.{0,4}聯絡人/,
  otherPermits: /其他牌照|Other Permits/i,
  qasM: /QAS|QAIHT/i,
};
const t = (l: OcrLine) => norm(l.t);
const find = (ls: OcrLine[], re: RegExp, pred: (l: OcrLine) => boolean = () => true) => ls.find((l) => re.test(t(l)) && pred(l));
const box = (x0: number, y0: number, x1: number, y1: number): NBox => ({ x0, y0, x1, y1 });

export function detectTemplate(lines: OcrLine[]): FormTemplate {
  const txt = lines.map(t).join(' ');
  if (RE.maxwell.test(txt) && !/WILSON|威信/i.test(txt)) return 'maxwell';
  if (/緊急事故聯絡人|QAS ?\/ ?QAIHT/i.test(txt)) return 'maxwell';
  if (RE.wilson.test(txt)) return 'wilson';
  return 'other';
}

/** 申請表第 1 頁：回傳多個裁圖框（kind→box）。定位唔到嘅 kind 唔出（由 caller 記 reason）。 */
export function locateFormCrops(lines: OcrLine[], template: FormTemplate): { kind: CropKind; box: NBox; how: string }[] {
  const ls = lines.filter((l) => l.t.trim());
  const out: { kind: CropKind; box: NBox; how: string }[] = [];
  if (template === 'maxwell') {
    const em = find(ls, RE.emergM);
    const pm = find(ls, RE.permitNo);
    const top = em ? em.y + em.h + 0.012 : null;
    const bottom = pm ? pm.y - 0.012 : null;
    if (top !== null && bottom !== null && top > bottom) out.push({ kind: 'form_emergency', box: box(0.05, bottom - 0.012, 0.99, top + 0.012), how: 'maxwell_band' });
    else if (top !== null) out.push({ kind: 'form_emergency', box: box(0.05, top - 0.11, 0.99, top), how: 'maxwell_em_only' });
    return out;
  }
  // wilson / other
  const jn = find(ls, RE.join);
  if (jn) out.push({ kind: 'form_join', box: box(0.02, jn.y - 0.05, 0.99, jn.y + jn.h + 0.015), how: 'join_label' });
  const bk = find(ls, RE.bank);
  const pe = find(ls, RE.permitExp) ?? find(ls, RE.permitNo);
  if (pe) {
    const top = bk ? bk.y + bk.h + 0.012 : pe.y + pe.h + 0.07;
    out.push({ kind: 'form_personal', box: box(0.02, pe.y - 0.045, 0.99, top), how: bk ? 'bank_to_permit' : 'permit_only' });
  }
  return out;
}

/** 續頁（威信第 2 頁）：緊急聯絡人 ×2＋其他牌照。 */
export function locateContinuationCrops(lines: OcrLine[]): { kind: CropKind; box: NBox; how: string }[] {
  const ls = lines.filter((l) => l.t.trim());
  const out: { kind: CropKind; box: NBox; how: string }[] = [];
  const em = find(ls, RE.emergW);
  if (em) out.push({ kind: 'form_emergency', box: box(0.04, em.y - 0.125, 0.99, em.y + em.h + 0.012), how: 'two_emergency' });
  const op = find(ls, RE.otherPermits);
  if (op) out.push({ kind: 'form_permits', box: box(0.04, op.y - 0.17, 0.99, op.y + op.h + 0.01), how: 'other_permits' });
  return out;
}

export function isContinuation(lines: OcrLine[]): boolean {
  const txt = lines.map(t).join(' ');
  return RE.emergW.test(txt) || RE.otherPermits.test(txt);
}

/** 整頁／卡面 bbox（permit_card、bank_page 用）。 */
export function contentBox(lines: OcrLine[], pad = 0.02): NBox | null {
  const ls = lines.filter((l) => l.t.trim());
  if (!ls.length) return null;
  return box(
    Math.max(0, Math.min(...ls.map((l) => l.x)) - pad),
    Math.max(0, Math.min(...ls.map((l) => l.y)) - pad),
    Math.min(1, Math.max(...ls.map((l) => l.x + l.w)) + pad),
    Math.min(1, Math.max(...ls.map((l) => l.y + l.h)) + pad),
  );
}

/** 真正嘅牌照卡頁（有許可證編號 label 或 ≥2 個 yyyy-mm-dd 日期），唔係醫生報告／申請指引。 */
export function isPermitCard(lines: OcrLine[]): boolean {
  const txt = lines.map(t).join(' ');
  if (/PERMIT\s*NO|許可證編號/i.test(txt)) return true;
  return (txt.match(/\b20\d{2}-\d{2}-\d{2}\b/g) ?? []).length >= 2 && /Category|類別|from/i.test(txt);
}

export function hasLabel(lines: OcrLine[], key: keyof typeof RE): boolean {
  return lines.some((l) => RE[key].test(t(l)));
}
