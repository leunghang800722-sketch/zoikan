// WP-STAFF-FIELDS：渲染單頁（本機 pdftoppm）＋裁圖。只印 docId／頁碼，唔印檔名。
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { DocMeta } from './doc-index';
import { OUT, PDFTOPPM, exists, run, sourceFiles } from './render';

export const FIELDS_OUT = path.join(process.cwd(), 'data/2026-10/staff-fields');
const MAGICK = '/opt/homebrew/bin/magick';

/** 渲染某檔第 pg 頁（1-based，同 ocr/*.jsonl 嘅 page 一致）→ FIELDS_OUT/pages/<docId>-p<pg>-<dpi>.png（有快取）。 */
export async function renderPage(m: DocMeta, pg: number, dpi = 300): Promise<string> {
  const out = path.join(FIELDS_OUT, 'pages', `${m.docId}-p${pg}-${dpi}.png`);
  if (await exists(out)) return out;
  await fs.mkdir(path.dirname(out), { recursive: true });
  const srcs = await sourceFiles(m.file);
  if (srcs.length === 1 && /\.pdf$/i.test(srcs[0])) {
    const base = out.replace(/\.png$/, '');
    await run(PDFTOPPM, ['-r', String(dpi), '-png', '-f', String(pg), '-l', String(pg), '-singlefile', srcs[0], base]);
    return out;
  }
  // 資料夾／JPEG：逐檔展開後揀第 pg 頁
  const tmp = path.join(FIELDS_OUT, 'tmp', m.docId);
  await fs.mkdir(tmp, { recursive: true });
  for (let k = 0; k < srcs.length; k++) {
    if (/\.pdf$/i.test(srcs[k])) await run(PDFTOPPM, ['-r', String(dpi), '-png', srcs[k], path.join(tmp, `f${String(k).padStart(2, '0')}`)]);
    else await fs.copyFile(srcs[k], path.join(tmp, `f${String(k).padStart(2, '0')}-1${path.extname(srcs[k])}`));
  }
  const all = (await fs.readdir(tmp)).filter((f) => /\.(png|jpe?g)$/i.test(f)).sort();
  await fs.copyFile(path.join(tmp, all[pg - 1]), out);
  await fs.rm(tmp, { recursive: true, force: true });
  return out;
}

export async function imageSize(img: string): Promise<{ w: number; h: number }> {
  const id = await run(MAGICK, ['identify', '-format', '%w %h', img]);
  const [w, h] = id.stdout.trim().split(' ').map(Number);
  return { w, h };
}

export interface NBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
const clamp = (b: NBox): NBox => ({ x0: Math.max(0, b.x0), x1: Math.min(1, b.x1), y0: Math.max(0, b.y0), y1: Math.min(1, b.y1) });

/** 正規化 box（原點左下）裁圖 → 相對 FIELDS_OUT 嘅路徑。 */
export async function cropBox(img: string, box: NBox, relOut: string, opts: { scale?: number } = {}): Promise<string> {
  const b = clamp(box);
  const { w, h } = await imageSize(img);
  const x = Math.round(b.x0 * w);
  const y = Math.round((1 - b.y1) * h);
  const cw = Math.max(8, Math.round((b.x1 - b.x0) * w));
  const ch = Math.max(8, Math.round((b.y1 - b.y0) * h));
  const full = path.join(FIELDS_OUT, relOut);
  await fs.mkdir(path.dirname(full), { recursive: true });
  const args = [img, '-crop', `${cw}x${ch}+${x}+${y}`, '+repage'];
  if (opts.scale) args.push('-resize', `${opts.scale}%`);
  await run(MAGICK, [...args, full]);
  return relOut;
}

export { OUT };
