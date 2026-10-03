// Stage A2：申請表頁用本機 OCR label 座標裁電話填寫欄 → crops/phone/<docId>-p<page>.png。
// label 定位唔到 → out/phone-nolabel.json。輸出 out/phone-crops.json（清單，無號碼）。
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { DocMeta } from './lib/doc-index';
import type { OcrPage } from './lib/ocr';
import { locatePhoneBox, toPixels } from './lib/phone-crop';
import { OUT, PDFTOPPM, run, sourceFiles } from './lib/render';

async function main() {
  const index = JSON.parse(await fs.readFile(path.join(OUT, 'index.json'), 'utf8')) as DocMeta[];
  const ex = JSON.parse(await fs.readFile(path.join(OUT, 'out/extract.json'), 'utf8')) as { docId: string; pages: { page: number; kinds: string[] }[] }[];
  const exMap = new Map(ex.map((e) => [e.docId, e]));
  await fs.mkdir(path.join(OUT, 'crops/phone'), { recursive: true });
  const crops: { docId: string; page: number; template: string; file: string }[] = [];
  const nolabel: { docId: string; page: number; reason: string }[] = [];
  const tmp = path.join(OUT, 'pages3');
  for (const m of index) {
    const e = exMap.get(m.docId);
    if (!e) continue;
    const formPages = e.pages.filter((p) => p.kinds.includes('application_form')).map((p) => p.page);
    if (!formPages.length) continue;
    const ocr = (await fs.readFile(path.join(OUT, 'ocr', `${m.docId}.jsonl`), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l) as OcrPage);
    const srcs = await sourceFiles(m.file);
    const single = srcs.length === 1 && /\.pdf$/i.test(srcs[0]);
    let all: string[] = [];
    if (!single) {
      const d = path.join(tmp, m.docId);
      await fs.mkdir(d, { recursive: true });
      for (let k = 0; k < srcs.length; k++) {
        if (/\.pdf$/i.test(srcs[k])) await run(PDFTOPPM, ['-r', '300', '-png', srcs[k], path.join(d, `f${k}`)]);
        else await fs.copyFile(srcs[k], path.join(d, `f${k}-1${path.extname(srcs[k])}`));
      }
      all = (await fs.readdir(d)).filter((f) => /\.(png|jpe?g)$/i.test(f)).sort().map((f) => path.join(d, f));
    }
    for (const pg of formPages) {
      const page = ocr.find((p) => p.page === pg);
      const loc = page ? locatePhoneBox(page.lines) : null;
      if (!loc) {
        nolabel.push({ docId: m.docId, page: pg, reason: 'label_not_located' });
        continue;
      }
      let img: string;
      if (single) {
        const base = path.join(tmp, `${m.docId}-p${pg}`);
        await fs.mkdir(tmp, { recursive: true });
        await run(PDFTOPPM, ['-r', '300', '-png', '-f', String(pg), '-l', String(pg), '-singlefile', srcs[0], base]);
        img = `${base}.png`;
      } else img = all[pg - 1];
      const id = await run('/opt/homebrew/bin/magick', ['identify', '-format', '%w %h', img]);
      const [w, h] = id.stdout.trim().split(' ').map(Number);
      const px = toPixels(loc.box, w, h);
      const file = `crops/phone/${m.docId}-p${pg}.png`;
      await run('/opt/homebrew/bin/magick', [img, '-crop', `${px.w}x${px.h}+${px.x}+${px.y}`, '+repage', path.join(OUT, file)]);
      crops.push({ docId: m.docId, page: pg, template: loc.template, file });
      await fs.rm(img, { force: true });
    }
    if (!single) await fs.rm(path.join(tmp, m.docId), { recursive: true, force: true });
  }
  await fs.writeFile(path.join(OUT, 'out/phone-crops.json'), JSON.stringify(crops, null, 1));
  await fs.writeFile(path.join(OUT, 'out/phone-nolabel.json'), JSON.stringify(nolabel, null, 1));
  const byT: Record<string, number> = {};
  crops.forEach((c) => (byT[c.template] = (byT[c.template] ?? 0) + 1));
  console.log(`form pages=${crops.length + nolabel.length} cropped=${crops.length} nolabel=${nolabel.length} templates=${JSON.stringify(byT)}`);
}

main();
