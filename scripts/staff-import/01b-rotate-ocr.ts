// Stage A2：對 hkid 缺／hkid 衝突嘅檔，逐頁 300dpi 重新渲染＋0/90/180/270 旋轉重新 OCR，
// 結果存 ocr2/<docId>.jsonl（每行一個「候選頁」{page, rot, lines}）。02 會將佢哋當額外頁一齊抽取。
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { DocMeta } from './lib/doc-index';
import { BIN, OUT, PDFTOPPM, run, sourceFiles } from './lib/render';

const CONC = Number(process.env.OCR_CONCURRENCY ?? 3);

async function processDoc(meta: DocMeta): Promise<number> {
  const outFile = path.join(OUT, 'ocr2', `${meta.docId}.jsonl`);
  const dir = path.join(OUT, 'pages2', meta.docId);
  await fs.mkdir(dir, { recursive: true });
  const srcs = await sourceFiles(meta.file);
  for (let k = 0; k < srcs.length; k++) {
    if (/\.pdf$/i.test(srcs[k])) await run(PDFTOPPM, ['-r', '300', '-png', srcs[k], path.join(dir, `f${k}`)]);
    else await fs.copyFile(srcs[k], path.join(dir, `f${k}-1${path.extname(srcs[k])}`));
  }
  const imgs = (await fs.readdir(dir)).filter((f) => /\.(png|jpe?g)$/i.test(f)).sort();
  const rows: string[] = [];
  for (let i = 0; i < imgs.length; i++) {
    const base = path.join(dir, imgs[i]);
    const variants: [number, string][] = [[0, base]];
    for (const rot of [90, 180, 270]) {
      const rp = path.join(dir, `r${rot}-${imgs[i].replace(/\.\w+$/, '')}.png`);
      await run('/usr/bin/sips', ['-s', 'format', 'png', '-r', String(rot), base, '--out', rp]);
      variants.push([rot, rp]);
    }
    const r = await run(BIN, variants.map((v) => v[1]));
    const out = r.stdout.split('\n').filter(Boolean);
    out.forEach((row, j) => {
      const o = JSON.parse(row) as { lines: unknown[] };
      rows.push(JSON.stringify({ page: i + 1, rot: variants[j][0], dpi: 300, lines: o.lines }));
    });
  }
  await fs.writeFile(`${outFile}.tmp`, rows.join('\n') + '\n');
  await fs.rename(`${outFile}.tmp`, outFile);
  await fs.rm(dir, { recursive: true, force: true });
  return imgs.length;
}

async function main() {
  await fs.mkdir(path.join(OUT, 'ocr2'), { recursive: true });
  const index = JSON.parse(await fs.readFile(path.join(OUT, 'index.json'), 'utf8')) as DocMeta[];
  const ex = JSON.parse(await fs.readFile(path.join(OUT, 'out/extract.json'), 'utf8')) as { docId: string; hkid: unknown; flags: string[] }[];
  const targets = new Set(ex.filter((e) => !e.hkid || e.flags.some((f) => f.startsWith('hkid_conflict'))).map((e) => e.docId));
  const todo: DocMeta[] = [];
  for (const m of index) {
    if (!targets.has(m.docId)) continue;
    try {
      await fs.access(path.join(OUT, 'ocr2', `${m.docId}.jsonl`));
    } catch {
      todo.push(m);
    }
  }
  console.log(`targets=${targets.size} todo=${todo.length}`);
  let next = 0;
  let pages = 0;
  await Promise.all(
    Array.from({ length: CONC }, async () => {
      while (next < todo.length) {
        const m = todo[next++];
        pages += await processDoc(m);
        if (next % 5 === 0) console.log(`done=${next}/${todo.length} pages=${pages}`);
      }
    }),
  );
  console.log(`FINISHED pages=${pages}`);
}

main();
