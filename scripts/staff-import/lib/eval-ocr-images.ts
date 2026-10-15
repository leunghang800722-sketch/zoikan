// WP-OCR-5：評估腳本嘅 Node 端圖片處理——規格同瀏覽器 `browser-images` 一致（共用 `src/lib/guards/ocr/image-plan.ts`）：
// 來源圖先縮到長邊 ≤2,400px → 全圖長邊 ≤1,600px、2×2 重疊放大分格（0.6 邊長、長邊 ≤1,000px）→ JPEG 質素梯級直至單張 data URL ≤ 上限。
// 縮圖用 ImageMagick（同 staff-import 其他腳本一致，`/opt/homebrew/bin/magick`，可用 MAGICK_BIN 覆蓋）；PDF 用 pdftoppm 逐頁出 PNG。
// 全程 stdin／stdout 傳 buffer，圖片只喺記憶體（PDF 例外：pdftoppm 要寫一個暫存 PNG，放系統暫存資料夾，用完即刪）。
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JPEG_DATA_URL_PREFIX, JPEG_LAST_QUALITY, JPEG_QUALITIES, SOURCE_MAX_EDGE, jpegFitsLimit, planDocumentImages } from '@/lib/guards/ocr/image-plan';

const magickBin = () => process.env.MAGICK_BIN || '/opt/homebrew/bin/magick';
const PDFTOPPM = process.env.PDFTOPPM_BIN || '/opt/homebrew/bin/pdftoppm';

function runBuf(cmd: string, args: string[], stdin?: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'ignore'] });
    const chunks: Buffer[] = [];
    p.stdout.on('data', (d: Buffer) => chunks.push(d));
    p.on('error', () => reject(new Error('image_tool_missing')));
    p.on('close', (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error('image_tool_failed'))));
    p.stdin.on('error', () => undefined);
    p.stdin.end(stdin);
  });
}

/** PNG IHDR → 寬高（唔使再 spawn identify） */
export function pngSize(buf: Buffer): { w: number; h: number } {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not_png');
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

async function pdfPagePng(abs: string, page: number): Promise<Buffer> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'eval-ocr-'));
  try {
    await runBuf(PDFTOPPM, ['-f', String(page), '-l', String(page), '-scale-to', String(SOURCE_MAX_EDGE), '-png', '-singlefile', abs, path.join(dir, 'p')]);
    return await readFile(path.join(dir, 'p.png'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** 讀來源（圖片或 PDF 頁）→ 長邊 ≤2,400 嘅白底 PNG buffer。 */
export async function loadSourcePng(abs: string, page = 1): Promise<Buffer> {
  if (!path.isAbsolute(abs)) throw new Error('path_not_absolute');
  const input = /\.pdf$/i.test(abs) ? await pdfPagePng(abs, page) : null;
  const src = input ? 'png:-' : `${abs}[0]`;
  return runBuf(magickBin(), [src, '-auto-orient', '-background', 'white', '-alpha', 'remove', '-alpha', 'off', '-resize', `${SOURCE_MAX_EDGE}x${SOURCE_MAX_EDGE}>`, 'png:-'], input ?? undefined);
}

async function toJpegDataUrl(png: Buffer, pre: string[], outW: number, outH: number): Promise<string> {
  let last: Buffer | null = null;
  for (const q of [...JPEG_QUALITIES, JPEG_LAST_QUALITY]) {
    last = await runBuf(magickBin(), ['png:-', ...pre, '-resize', `${outW}x${outH}!`, '-strip', '-quality', String(Math.round(q * 100)), 'jpg:-'], png);
    if (jpegFitsLimit(last.length)) break;
  }
  return JPEG_DATA_URL_PREFIX + last!.toString('base64');
}

export interface PreparedDoc {
  full: string;
  tiles: string[];
}

/** 同瀏覽器一樣嘅輸出：1,600px 全圖＋4 張放大格。 */
export async function prepareDocumentImages(abs: string, page = 1): Promise<PreparedDoc> {
  const png = await loadSourcePng(abs, page);
  const { w, h } = pngSize(png);
  const plan = planDocumentImages(w, h);
  const full = await toJpegDataUrl(png, [], plan.full.w, plan.full.h);
  const tiles: string[] = [];
  for (const t of plan.tiles) {
    const [x, y, tw, th] = t.rect;
    tiles.push(await toJpegDataUrl(png, ['-crop', `${tw}x${th}+${x}+${y}`, '+repage'], t.out.w, t.out.h));
  }
  return { full, tiles };
}
