// WP-OCR-5：圖片規格（瀏覽器 browser-images 同 Node 評估腳本 eval-ocr 共用嘅純函數／常數）。
// 全圖長邊 ≤1,600px、2×2 重疊放大分格（佔邊長 0.6、長邊 ≤1,000px）、來源圖先縮到長邊 ≤2,400px；JPEG 質素逐步降到單張 data URL ≤ 上限。
// 零依賴（唔碰 DOM／canvas），所以 Node 端可以用任何縮圖工具按同一套規格出圖。
import { OCR_MAX_IMAGE_CHARS } from "./config";

export const FULL_MAX_EDGE = 1600;
export const TILE_MAX_EDGE = 1000;
/** 分格佔原圖邊長比例；2×2 之間重疊 = 2×0.6-1 = 20%。 */
const TILE_FRACTION = 0.6;
export const SOURCE_MAX_EDGE = 2400;
/** JPEG 質素梯級（0–1）；全部都超上限就用最後一級 */
export const JPEG_QUALITIES = [0.85, 0.75, 0.65, 0.5, 0.4] as const;
export const JPEG_LAST_QUALITY = 0.3;
export const JPEG_DATA_URL_PREFIX = "data:image/jpeg;base64,";

/** 分格座標（2×2 重疊）：回傳 TL,TR,BL,BR 嘅 [x,y,w,h]。純函數，方便測試。 */
export function tileRects(width: number, height: number, fraction = TILE_FRACTION): [number, number, number, number][] {
  const tw = Math.round(width * fraction);
  const th = Math.round(height * fraction);
  const xs = [0, width - tw];
  const ys = [0, height - th];
  const out: [number, number, number, number][] = [];
  for (const y of ys) for (const x of xs) out.push([x, y, tw, th]);
  return out;
}

/** 長邊縮到 maxEdge（唔放大）後嘅輸出尺寸（至少 1×1）。 */
export function scaledSize(sw: number, sh: number, maxEdge: number): { w: number; h: number } {
  const scale = Math.min(1, maxEdge / Math.max(sw, sh));
  return { w: Math.max(1, Math.round(sw * scale)), h: Math.max(1, Math.round(sh * scale)) };
}

export interface ImagePlan {
  full: { w: number; h: number };
  tiles: { rect: [number, number, number, number]; out: { w: number; h: number } }[];
}

/** 來源圖（已縮到 ≤2,400）尺寸 → 全圖同 4 格嘅輸出規格。 */
export function planDocumentImages(sourceW: number, sourceH: number): ImagePlan {
  return {
    full: scaledSize(sourceW, sourceH, FULL_MAX_EDGE),
    tiles: tileRects(sourceW, sourceH).map((rect) => ({ rect, out: scaledSize(rect[2], rect[3], TILE_MAX_EDGE) })),
  };
}

/** JPEG bytes → data URL 字元數（base64 長度＋前綴） */
const jpegDataUrlChars = (bytes: number): number => JPEG_DATA_URL_PREFIX.length + Math.ceil(bytes / 3) * 4;
export const jpegFitsLimit = (bytes: number): boolean => jpegDataUrlChars(bytes) <= OCR_MAX_IMAGE_CHARS;
