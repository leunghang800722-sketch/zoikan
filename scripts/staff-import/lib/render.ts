// 共用：spawn、來源檔展開（本機 data/，無 PII 寫死）。
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export const ROOT = process.cwd();
export const SRC = path.join(ROOT, 'data/2026-09/staff-docs');
export const OUT = path.join(ROOT, 'data/2026-10/staff-import');
export const BIN = path.join(OUT, 'bin/vision-ocr');
export const PDFTOPPM = '/opt/homebrew/bin/pdftoppm';

export function run(cmd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { maxBuffer: undefined } as never);
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    p.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
    p.on('error', () => resolve({ code: -1, stdout, stderr: 'spawn error' }));
  });
}

export async function exists(p: string) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function sourceFiles(entry: string): Promise<string[]> {
  const full = path.join(SRC, entry);
  const st = await fs.stat(full);
  if (!st.isDirectory()) return [full];
  const inner = (await fs.readdir(full)).filter((f) => /\.(pdf|jpe?g)$/i.test(f)).sort();
  return inner.map((f) => path.join(full, f));
}


/** 渲染某個「人檔」嘅第 page 頁（OCR 頁碼）去 pngPath；rot 係順時針旋轉度數（旋轉救援頁）。 */
export async function renderPage(file: string, page: number, pngPath: string, dpi = 300, rot = 0): Promise<boolean> {
  const srcs = await sourceFiles(file);
  const dir = path.dirname(pngPath);
  await fs.mkdir(dir, { recursive: true });
  let img: string | null = null;
  const tmpBase = `${pngPath}.tmp`;
  if (srcs.length === 1 && /\.pdf$/i.test(srcs[0])) {
    const r = await run(PDFTOPPM, ['-r', String(dpi), '-png', '-f', String(page), '-l', String(page), '-singlefile', srcs[0], tmpBase]);
    if (r.code === 0) img = `${tmpBase}.png`;
  } else {
    const d = `${tmpBase}-d`;
    await fs.mkdir(d, { recursive: true });
    for (let k = 0; k < srcs.length; k++) {
      if (/\.pdf$/i.test(srcs[k])) await run(PDFTOPPM, ['-r', String(dpi), '-png', srcs[k], path.join(d, `f${k}`)]);
      else await fs.copyFile(srcs[k], path.join(d, `f${k}-1${path.extname(srcs[k])}`));
    }
    const all = (await fs.readdir(d)).filter((f) => /\.(png|jpe?g)$/i.test(f)).sort();
    if (all[page - 1]) img = path.join(d, all[page - 1]);
  }
  if (!img) return false;
  if (rot) await run('/usr/bin/sips', ['-s', 'format', 'png', '-r', String(rot), img, '--out', pngPath]);
  else await run('/usr/bin/sips', ['-s', 'format', 'png', img, '--out', pngPath]);
  await fs.rm(tmpBase + '.png', { force: true });
  await fs.rm(`${tmpBase}-d`, { recursive: true, force: true });
  return true;
}
