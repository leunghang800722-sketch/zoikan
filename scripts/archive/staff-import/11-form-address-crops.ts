// Stage A6：冇住址證明嘅人（address status=missing），喺申請表頁裁「地址」填寫欄。
//   crops/form-address/<docId>-p<page>.png（200dpi，第一讀數）
//   crops/form-address-b/<docId>-p<page>.png（300dpi、邊界唔同，獨立第二讀數用；第二讀由另一模型做，呢度唔讀）
// 輸出（淨路徑／docId，無地址）：out/form-address-crops.json、out/form-address-second-read-todo.json、out/form-address-nolabel.json
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { DocExtract } from '../../staff-import/lib/aggregate';
import type { DocMeta } from '../../staff-import/lib/doc-index';
import { locateFormAddressBox, type Variant } from '../../staff-import/lib/form-address-crop';
import type { OcrPage } from '../../staff-import/lib/ocr';
import { toPixels } from '../../staff-import/lib/phone-crop';
import { OUT, renderPage, run } from '../../staff-import/lib/render';

async function main() {
  const index = new Map((JSON.parse(await fs.readFile(path.join(OUT, 'index.json'), 'utf8')) as DocMeta[]).map((m) => [m.docId, m]));
  const ex = new Map((JSON.parse(await fs.readFile(path.join(OUT, 'out/extract.json'), 'utf8')) as DocExtract[]).map((e) => [e.docId, e]));
  const pf = JSON.parse(await fs.readFile(path.join(OUT, 'out/person-fields.json'), 'utf8')) as { key: string; docIds: string[]; fields: { address: { status: string } } }[];
  const scope = pf.filter((p) => p.fields.address.status === 'missing');
  await fs.mkdir(path.join(OUT, 'crops/form-address'), { recursive: true });
  await fs.mkdir(path.join(OUT, 'crops/form-address-b'), { recursive: true });
  await fs.mkdir(path.join(OUT, 'pages3'), { recursive: true });
  const crops: { personKey: string; docId: string; page: number; template: string; file: string; fileB: string }[] = [];
  const nolabel: { personKey: string; docId: string; page: number }[] = [];
  const noForm: string[] = [];
  let withForm = 0;
  for (const p of scope) {
    let any = false;
    for (const docId of p.docIds) {
      const e = ex.get(docId);
      const m = index.get(docId);
      if (!e || !m) continue;
      const formPages = e.pages.filter((x) => x.kinds.includes('application_form')).map((x) => x.page);
      if (!formPages.length) continue;
      any = true;
      const ocr = (await fs.readFile(path.join(OUT, 'ocr', `${docId}.jsonl`), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l) as OcrPage);
      for (const pg of formPages) {
        const lines = ocr.find((o) => o.page === pg)?.lines ?? [];
        const a = locateFormAddressBox(lines, 'a');
        if (!a) {
          nolabel.push({ personKey: p.key, docId, page: pg });
          continue;
        }
        const files: Record<string, string> = {};
        for (const v of ['a', 'b'] as Variant[]) {
          const dpi = v === 'a' ? 200 : 300;
          const dir = v === 'a' ? 'crops/form-address' : 'crops/form-address-b';
          const tmp = path.join(OUT, 'pages3', `${docId}-fa${pg}-${v}.png`);
          if (!(await renderPage(m.file, pg, tmp, dpi))) continue;
          const loc = locateFormAddressBox(lines, v)!;
          const id = await run('/opt/homebrew/bin/magick', ['identify', '-format', '%w %h', tmp]);
          const [w, h] = id.stdout.trim().split(' ').map(Number);
          const px = toPixels(loc.box, w, h);
          const file = `${dir}/${docId}-p${pg}.png`;
          await run('/opt/homebrew/bin/magick', [tmp, '-crop', `${px.w}x${px.h}+${px.x}+${px.y}`, '+repage', path.join(OUT, file)]);
          await fs.rm(tmp, { force: true });
          files[v] = file;
        }
        if (files.a && files.b) crops.push({ personKey: p.key, docId, page: pg, template: a.template, file: files.a, fileB: files.b });
      }
    }
    if (any) withForm++;
    else noForm.push(p.key);
  }
  await fs.writeFile(path.join(OUT, 'out/form-address-crops.json'), JSON.stringify(crops, null, 1));
  await fs.writeFile(path.join(OUT, 'out/form-address-nolabel.json'), JSON.stringify(nolabel, null, 1));
  await fs.writeFile(
    path.join(OUT, 'out/form-address-second-read-todo.json'),
    JSON.stringify(crops.map((c) => ({ docId: c.docId, page: c.page, path: c.fileB })), null, 1),
  );
  const byT: Record<string, number> = {};
  crops.forEach((c) => (byT[c.template] = (byT[c.template] ?? 0) + 1));
  console.log(`scope=${scope.length} withForm=${withForm} noForm=${noForm.length} cropped=${crops.length} nolabel=${nolabel.length} templates=${JSON.stringify(byT)}`);
}

main();
