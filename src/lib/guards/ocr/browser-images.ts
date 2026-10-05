// WP-GUARD-OCR §29.2(2)：瀏覽器端圖片處理（淨喺 client component 用）。
// - PDF 用 pdfjs-dist 喺瀏覽器轉圖（dynamic import，唔拖大其他頁嘅 bundle；唔上載 PDF）
// - 縮圖長邊 ≤1,600px JPEG；另切 2×2 重疊放大分格
// - 圖片只留喺瀏覽器記憶體（Blob／object URL）；儲存／離開頁面即 revoke
import { OCR_MAX_IMAGE_CHARS } from "./config";

export const FULL_MAX_EDGE = 1600;
export const TILE_MAX_EDGE = 1000;
/** 分格佔原圖邊長比例；2×2 之間重疊 = 2×0.6-1 = 20%。 */
export const TILE_FRACTION = 0.6;
const SOURCE_MAX_EDGE = 2400;

export interface PreparedImage {
  /** 全圖 data URL（長邊 ≤1,600、JPEG） */
  full: string;
  /** 2×2 重疊分格（TL,TR,BL,BR），已放大到可讀 */
  tiles: string[];
  /** 並排核對用嘅 object URL（要 revoke） */
  previewUrl: string;
}

function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

function drawScaled(src: CanvasImageSource, sx: number, sy: number, sw: number, sh: number, maxEdge: number): HTMLCanvasElement {
  const scale = Math.min(1, maxEdge / Math.max(sw, sh));
  const c = makeCanvas(sw * scale, sh * scale);
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(src, sx, sy, sw, sh, 0, 0, c.width, c.height);
  return c;
}

/** canvas → JPEG data URL，過大就逐步降質素（保證 ≤ 單張上限）。 */
export function toJpegDataUrl(c: HTMLCanvasElement): string {
  for (const q of [0.85, 0.75, 0.65, 0.5, 0.4]) {
    const url = c.toDataURL("image/jpeg", q);
    if (url.length <= OCR_MAX_IMAGE_CHARS) return url;
  }
  return c.toDataURL("image/jpeg", 0.3);
}

export function canvasSize(c: { width: number; height: number }): { w: number; h: number } {
  return { w: c.width, h: c.height };
}

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

export async function prepareFromCanvas(source: HTMLCanvasElement): Promise<PreparedImage> {
  const fullCanvas = drawScaled(source, 0, 0, source.width, source.height, FULL_MAX_EDGE);
  const tiles = tileRects(source.width, source.height).map(([x, y, w, h]) => toJpegDataUrl(drawScaled(source, x, y, w, h, TILE_MAX_EDGE)));
  const blob = await new Promise<Blob>((resolve, reject) => fullCanvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob"))), "image/jpeg", 0.8));
  return { full: toJpegDataUrl(fullCanvas), tiles, previewUrl: URL.createObjectURL(blob) };
}

export async function canvasFromImageFile(file: File): Promise<HTMLCanvasElement> {
  const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
  try {
    return drawScaled(bmp, 0, 0, bmp.width, bmp.height, SOURCE_MAX_EDGE);
  } finally {
    bmp.close();
  }
}

// --- PDF（pdfjs-dist，dynamic import）---
type PdfDoc = { numPages: number; getPage(n: number): Promise<PdfPage>; destroy(): Promise<void> };
type PdfPage = { getViewport(o: { scale: number }): { width: number; height: number }; render(o: { canvasContext: CanvasRenderingContext2D; viewport: unknown; canvas?: HTMLCanvasElement }): { promise: Promise<void> } };

export interface PdfHandle {
  pages: number;
  render(pageNo: number): Promise<HTMLCanvasElement>;
  destroy(): Promise<void>;
}

export async function openPdf(file: File): Promise<PdfHandle> {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
  const data = new Uint8Array(await file.arrayBuffer());
  const doc = (await pdfjs.getDocument({ data }).promise) as unknown as PdfDoc;
  return {
    pages: doc.numPages,
    async render(pageNo: number) {
      const page = await doc.getPage(pageNo);
      const base = page.getViewport({ scale: 1 });
      const scale = SOURCE_MAX_EDGE / Math.max(base.width, base.height);
      const viewport = page.getViewport({ scale });
      const c = makeCanvas(viewport.width, viewport.height);
      const ctx = c.getContext("2d")!;
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, c.width, c.height);
      await page.render({ canvasContext: ctx, viewport, canvas: c }).promise;
      return c;
    },
    destroy: () => doc.destroy(),
  };
}

export const isPdfFile = (f: File): boolean => f.type === "application/pdf" || /\.pdf$/i.test(f.name);
