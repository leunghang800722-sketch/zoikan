// Stage A step 1：逐檔分頁（pdftoppm -r 200）→ 本機 Vision OCR → ocr/<docId>.jsonl。
// 可斷點續跑（已有 ocr/<docId>.jsonl 就跳過）。Console 淨印統計＋docId。
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parseDocFileName, type DocMeta } from './lib/doc-index';

const ROOT = process.cwd();
const SRC = path.join(ROOT, 'data/2026-09/staff-docs');
const OUT = path.join(ROOT, 'data/2026-10/staff-import');
const BIN = path.join(OUT, 'bin/vision-ocr');
const PDFTOPPM = '/opt/homebrew/bin/pdftoppm';
const CONCURRENCY = Number(process.env.OCR_CONCURRENCY ?? 3);

function run(cmd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
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

async function exists(p: string) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** 一個「人」可以係單一檔，亦可以係一個資料夾（入面有幾個 PDF／JPEG，順檔名合併）。 */
async function sourceFiles(entry: string): Promise<string[]> {
  const full = path.join(SRC, entry);
  const st = await fs.stat(full);
  if (!st.isDirectory()) return [full];
  const inner = (await fs.readdir(full)).filter((f) => /\.(pdf|jpe?g)$/i.test(f)).sort();
  return inner.map((f) => path.join(full, f));
}

async function processDoc(meta: DocMeta): Promise<{ pages: number; ok: boolean }> {
  const outFile = path.join(OUT, 'ocr', `${meta.docId}.jsonl`);
  const pageDir = path.join(OUT, 'pages', meta.docId);
  await fs.mkdir(pageDir, { recursive: true });
  const srcs = await sourceFiles(meta.file);
  let images: string[] = [];
  for (let k = 0; k < srcs.length; k++) {
    const src = srcs[k];
    if (/\.pdf$/i.test(src)) {
      const r = await run(PDFTOPPM, ['-r', '200', '-png', src, path.join(pageDir, `f${k}`)]);
      if (r.code !== 0) return { pages: 0, ok: false };
    } else {
      await fs.copyFile(src, path.join(pageDir, `f${k}-1${path.extname(src)}`));
    }
  }
  images = (await fs.readdir(pageDir)).filter((f) => /\.(png|jpe?g)$/i.test(f)).sort().map((f) => path.join(pageDir, f));
  const lines: string[] = [];
  const CH = 12;
  for (let i = 0; i < images.length; i += CH) {
    const batch = images.slice(i, i + CH);
    const r = await run(BIN, batch);
    if (r.code !== 0) return { pages: images.length, ok: false };
    const rows = r.stdout.split('\n').filter(Boolean);
    if (rows.length !== batch.length) return { pages: images.length, ok: false };
    rows.forEach((row, j) => {
      const o = JSON.parse(row) as { lines: unknown[]; error?: string };
      lines.push(JSON.stringify({ page: i + j + 1, lines: o.lines, error: o.error ?? null }));
    });
  }
  const tmp = `${outFile}.tmp`;
  await fs.writeFile(tmp, lines.join('\n') + '\n');
  await fs.rename(tmp, outFile);
  await fs.rm(pageDir, { recursive: true, force: true });
  return { pages: images.length, ok: true };
}

async function main() {
  await fs.mkdir(path.join(OUT, 'ocr'), { recursive: true });
  await fs.mkdir(path.join(OUT, 'pages'), { recursive: true });
  // 頂層：pdf／jpeg 檔，加上資料夾（一個資料夾＝一個人）
  const files: string[] = [];
  for (const e of (await fs.readdir(SRC, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.isDirectory() || /\.(pdf|jpe?g)$/i.test(e.name)) files.push(e.name);
  }
  const metas = files.map(parseDocFileName);
  await fs.writeFile(path.join(OUT, 'index.json'), JSON.stringify(metas, null, 1));
  const todo: DocMeta[] = [];
  let skipped = 0;
  for (const m of metas) {
    if (await exists(path.join(OUT, 'ocr', `${m.docId}.jsonl`))) skipped++;
    else todo.push(m);
  }
  console.log(`files=${metas.length} nonConforming=${metas.filter((m) => !m.conforming).length} skipped=${skipped} todo=${todo.length}`);
  let done = 0;
  let pages = 0;
  const failed: string[] = [];
  let next = 0;
  const t0 = Date.now();
  async function worker() {
    while (next < todo.length) {
      const m = todo[next++];
      const r = await processDoc(m);
      pages += r.pages;
      if (!r.ok) failed.push(m.docId);
      done++;
      if (done % 10 === 0) console.log(`done=${done}/${todo.length} pages=${pages} failed=${failed.length} elapsed=${Math.round((Date.now() - t0) / 1000)}s`);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  console.log(`FINISHED done=${done} pages=${pages} failed=${failed.length} ${failed.join(',')}`);
}

main();
