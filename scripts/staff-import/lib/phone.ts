// 電話最終值決定（純函數）：老闆規定來源＝申請表；視覺逐張讀裁圖（clear）先算數。
import { normTel } from './compare';

export type Legible = 'clear' | 'unsure' | 'illegible';
export interface VisionRead {
  docId: string;
  page: number;
  digits: string | null;
  legible: Legible;
  reason?: string;
}
export type PhoneStatus = 'confirmed' | 'vision_only' | 'differs' | 'unresolved';

export interface PhoneFinal {
  value: string | null;
  status: PhoneStatus;
  by: string[]; // confirmed 嘅佐證：list／ocr
  ocr: string | null;
  reason: string | null;
  listValues: string[];
}

export function resolvePhone(
  vision: VisionRead[],
  ocrPhone: string | null,
  listTels: string[],
  hasCrop: boolean,
): PhoneFinal {
  const ocr = normTel(ocrPhone);
  const list = [...new Set(listTels.map((t) => normTel(t)).filter((x): x is string => !!x))];
  const clear = vision.find((v) => v.legible === 'clear' && normTel(v.digits));
  if (!clear) {
    const reason = !hasCrop ? 'no_label_or_form' : !vision.length ? 'not_read' : vision.some((v) => v.legible === 'unsure') ? 'unsure' : 'illegible';
    return { value: null, status: 'unresolved', by: [], ocr, reason, listValues: list };
  }
  const v = normTel(clear.digits)!;
  const by: string[] = [];
  if (list.includes(v)) by.push('list');
  if (ocr === v) by.push('ocr');
  if (by.length) return { value: v, status: 'confirmed', by, ocr, reason: null, listValues: list };
  if (list.length) return { value: v, status: 'differs', by, ocr, reason: 'phone_differs_from_list', listValues: list };
  return { value: v, status: 'vision_only', by, ocr, reason: null, listValues: list };
}
