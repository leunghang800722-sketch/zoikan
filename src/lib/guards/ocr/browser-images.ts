// WP-GUARD-OCR §29.2(2)：瀏覽器端圖片處理（淨喺 client component 用）。
// - PDF 用 pdfjs-dist 喺瀏覽器轉圖（dynamic import，唔拖大其他頁嘅 bundle；唔上載 PDF）
// - 縮圖長邊 ≤1,600px JPEG；另切 2×2 重疊放大分格
// - 圖片只留喺瀏覽器記憶體（Blob／object URL）；儲存／離開頁面即 revoke
import { OCR_MAX_IMAGE_CHARS } from "./config";
import { FULL_MAX_EDGE, JPEG_LAST_QUALITY, JPEG_QUALITIES, SOURCE_MAX_EDGE, TILE_MAX_EDGE, scaledSize, tileRects } from "./image-plan";
import type { FieldCrop } from "./field-crops";

// WP-OCR-5：規格常數／分格座標／縮圖尺寸抽咗去 image-plan.ts（同 Node 評估腳本共用）；呢度保留 re-export 俾舊 import。
export { tileRects };

export interface PreparedImage {
  /** 全圖 data URL（長邊 ≤1,600、JPEG） */
  full: string;
  /** 2×2 重疊分格（TL,TR,BL,BR），已放大到可讀 */
  tiles: string[];
  /** 並排核對用嘅 object URL（要 revoke） */
  previewUrl: string;
  /** WP-OCR-3：2,400px 來源 canvas（欄位級裁圖用；只留記憶體，slot 被取代／移除即釋放） */
  source: HTMLCanvasElement;
}

function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

function drawScaled(src: CanvasImageSource, sx: number, sy: number, sw: number, sh: number, maxEdge: number): HTMLCanvasElement {
  const out = scaledSize(sw, sh, maxEdge);
  const c = makeCanvas(out.w, out.h);
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(src, sx, sy, sw, sh, 0, 0, c.width, c.height);
  return c;
}

/** canvas → JPEG data URL，過大就逐步降質素（保證 ≤ 單張上限）。 */
function toJpegDataUrl(c: HTMLCanvasElement): string {
  for (const q of JPEG_QUALITIES) {
    const url = c.toDataURL("image/jpeg", q);
    if (url.length <= OCR_MAX_IMAGE_CHARS) return url;
  }
  return c.toDataURL("image/jpeg", JPEG_LAST_QUALITY);
}

export async function prepareFromCanvas(source: HTMLCanvasElement): Promise<PreparedImage> {
  const fullCanvas = drawScaled(source, 0, 0, source.width, source.height, FULL_MAX_EDGE);
  const tiles = tileRects(source.width, source.height).map(([x, y, w, h]) => toJpegDataUrl(drawScaled(source, x, y, w, h, TILE_MAX_EDGE)));
  const blob = await new Promise<Blob>((resolve, reject) => fullCanvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob"))), "image/jpeg", 0.8));
  return { full: toJpegDataUrl(fullCanvas), tiles, previewUrl: URL.createObjectURL(blob), source };
}

/** WP-OCR-3：按 field-crops 計劃由來源 canvas 裁欄位級圖（矩形／輸出尺寸全部由純函數算好，呢度淨係畫）。 */
export function cropFieldsFromCanvas(source: HTMLCanvasElement, crops: readonly FieldCrop[]): string[] {
  return crops.map((c) => {
    const out = makeCanvas(c.out.w, c.out.h);
    const ctx = out.getContext("2d")!;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(source, c.rect.x, c.rect.y, c.rect.w, c.rect.h, 0, 0, out.width, out.height);
    return toJpegDataUrl(out);
  });
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
type PdfDoc = { numPages: number; getPage(n: number): Promise<PdfPage> };
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
  const task = pdfjs.getDocument({ data });
  const doc = (await task.promise) as unknown as PdfDoc;
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
    // 釋放 worker／記憶體；失敗唔影響用戶（只係清理）
    destroy: async () => {
      try {
        await task.destroy();
      } catch {
        /* ignore */
      }
    },
  };
}

export const isPdfFile = (f: File): boolean => f.type === "application/pdf" || /\.pdf$/i.test(f.name);
