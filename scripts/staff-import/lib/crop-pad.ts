// WP-OCR-3：路徑 B 裁圖外擴（純函數；Vision 正規化座標，原點左下）。
// 外擴量按 label 行高 h 比例：上下 1.2×h、左右 0.6×h，最少 0.03（頁邊比例）；
// 並且唔越過下一個 label 行：上／下方嘅 label 行（整行，唔睇 x）、左／右同行嘅 label 都係硬界線。
// caller 可用 `pad` 參數覆蓋 vertical／horizontal／min（例如第二套較闊裁圖）。
import { cy, type OcrLine } from './ocr';
import type { Box } from './phone-crop';

export interface PadSpec {
  vertical: number;
  horizontal: number;
  min: number;
}
export const DEFAULT_PAD: PadSpec = { vertical: 1.2, horizontal: 0.6, min: 0.03 };
/** 同 label 行之間留嘅縫隙（頁邊比例） */
const GAP = 0.002;

/** 疑似「label 行」：有文字、數字唔多（≤2 個）、唔太長；手寫數字行（電話／身份證號）唔當 label。 */
export function isLabelLine(l: OcrLine): boolean {
  const t = l.t.trim();
  if (!t || t.length > 40) return false;
  const digits = (t.match(/\d/g) ?? []).length;
  return digits <= 2 && /[一-鿿A-Za-z]/.test(t);
}

/**
 * 將 `base`（欄位格本身：label 行加預期填寫範圍）外擴，再被 `barriers` 限制。
 * h＝label 行高。barriers 中心喺 base 垂直範圍內嘅（同行）唔影響上下限；左右只比對同行（垂直有重疊）而且完全喺 base 左／右邊嘅。
 */
export function padAround(base: Box, h: number, barriers: readonly OcrLine[], pad: Partial<PadSpec> = {}): Box {
  const p = { ...DEFAULT_PAD, ...pad };
  const dy = Math.max(p.vertical * h, p.min);
  const dx = Math.max(p.horizontal * h, p.min);
  let { x0, x1, y0, y1 } = { x0: base.x0 - dx, x1: base.x1 + dx, y0: base.y0 - dy, y1: base.y1 + dy };
  for (const l of barriers) {
    const c = cy(l);
    if (c > base.y1) y1 = Math.min(y1, Math.max(base.y1, l.y - GAP));
    else if (c < base.y0) y0 = Math.max(y0, Math.min(base.y0, l.y + l.h + GAP));
  }
  for (const l of barriers) {
    if (Math.min(l.y + l.h, base.y1) - Math.max(l.y, base.y0) <= 0) continue;
    if (l.x >= base.x1) x1 = Math.min(x1, Math.max(base.x1, l.x - GAP));
    else if (l.x + l.w <= base.x0) x0 = Math.max(x0, Math.min(base.x0, l.x + l.w + GAP));
  }
  return { x0: Math.max(0, x0), x1: Math.min(1, x1), y0: Math.max(0, y0), y1: Math.min(1, y1) };
}
