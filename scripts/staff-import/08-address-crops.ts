// Stage A3：由住址證明頁裁出收件人 block → crops/address/<docId>-p<page>.png。
// 輸出 out/address-crops-new.json（清單，無地址）。之後由人手（視覺）逐張讀 → out/address-vision.json。
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { DocExtract } from './lib/aggregate';
import { locateAddressBox } from './lib/crop-box';
import type { DocCheck } from './lib/crosscheck';
import type { DocMeta } from './lib/doc-index';
import type { OcrPage } from './lib/ocr';
import { toPixels } from './lib/phone-crop';
import { groupPersons } from './lib/persons';
import { OUT, renderPage, run } from './lib/render';

async function main() {
  // 增量：已有視覺讀數嘅 docId+page 唔再裁；另外補「已分類做住址證明頁但冇抽到 block」嘅整頁裁圖
  const done = new Set<string>(
    (JSON.parse(await fs.readFile(path.join(OUT, 'out/address-vision.json'), 'utf8').catch(() => '[]')) as { docId: string; page: number }[]).map((v) => `${v.docId}-p${v.page}`),
  );
  const index = new Map((JSON.parse(await fs.readFile(path.join(OUT, 'index.json'), 'utf8')) as DocMeta[]).map((m) => [m.docId, m]));
  const ex = JSON.parse(await fs.readFile(path.join(OUT, 'out/extract.json'), 'utf8')) as DocExtract[];
  const cc = new Map((JSON.parse(await fs.readFile(path.join(OUT, 'out/crosscheck.json'), 'utf8')) as DocCheck[]).map((c) => [c.docId, c]));
  const exMap = new Map(ex.map((e) => [e.docId, e]));
  const persons = groupPersons(ex, (d) => cc.get(d)?.grade ?? 'fail');
  await fs.mkdir(path.join(OUT, 'crops/address'), { recursive: true });
  const list: { personKey: string; docId: string; page: number; how: string; file: string }[] = [];
  const none: { personKey: string; reason: string }[] = [];
  const hows: Record<string, number> = {};
  for (const p of persons) {
    if (!p.addressDocId) {
      // 補漏：有住址證明頁但冇抽到地址 block → 整頁縮細裁圖俾視覺讀
      const cand = p.docIds
        .map((d) => ({ d, pg: exMap.get(d)!.pages.find((x) => x.kinds.includes('address_proof') && !exMap.get(d)!.address) }))
        .find((x) => x.pg);
      if (cand?.pg && !done.has(`${cand.d}-p${cand.pg.page}`)) {
        const m2 = index.get(cand.d)!;
        const tmp2 = path.join(OUT, 'pages3', `${cand.d}-a${cand.pg.page}.png`);
        if (await renderPage(m2.file, cand.pg.page, tmp2, 200)) {
          const file2 = `crops/address/${cand.d}-p${cand.pg.page}.png`;
          await run('/opt/homebrew/bin/magick', [tmp2, '-resize', '1500x', '-crop', '1500x1100+0+0', '+repage', path.join(OUT, file2)]);
          await fs.rm(tmp2, { force: true });
          list.push({ personKey: p.key, docId: cand.d, page: cand.pg.page, how: 'fullpage', file: file2 });
          hows.fullpage = (hows.fullpage ?? 0) + 1;
          continue;
        }
      }
      none.push({ personKey: p.key, reason: p.docIds.some((d) => exMap.get(d)!.flags.includes('address_declaration_only')) ? 'declaration_only' : 'no_address_page' });
      continue;
    }
    const e = exMap.get(p.addressDocId)!;
    const m = index.get(p.addressDocId)!;
    const page = e.address!.page;
    if (done.has(`${p.addressDocId}-p${page}`)) continue;
    const rows = (await fs.readFile(path.join(OUT, 'ocr', `${p.addressDocId}.jsonl`), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l) as OcrPage);
    const lines = rows.find((r) => r.page === page)?.lines ?? [];
    const loc = locateAddressBox(lines);
    const tmp = path.join(OUT, 'pages3', `${p.addressDocId}-a${page}.png`);
    if (!(await renderPage(m.file, page, tmp, 300))) {
      none.push({ personKey: p.key, reason: 'render_fail' });
      continue;
    }
    const id = await run('/opt/homebrew/bin/magick', ['identify', '-format', '%w %h', tmp]);
    const [w, h] = id.stdout.trim().split(' ').map(Number);
    const px = toPixels(loc.box, w, h);
    const file = `crops/address/${p.addressDocId}-p${page}.png`;
    await run('/opt/homebrew/bin/magick', [tmp, '-crop', `${px.w}x${px.h}+${px.x}+${px.y}`, '+repage', ...(loc.how === 'page' ? ['-resize', '1500x'] : []), path.join(OUT, file)]);
    await fs.rm(tmp, { force: true });
    list.push({ personKey: p.key, docId: p.addressDocId, page, how: loc.how, file });
    hows[loc.how] = (hows[loc.how] ?? 0) + 1;
  }
  await fs.writeFile(path.join(OUT, 'out/address-crops-new.json'), JSON.stringify(list, null, 1));
  await fs.writeFile(path.join(OUT, 'out/address-none.json'), JSON.stringify(none, null, 1));
  const nc: Record<string, number> = {};
  none.forEach((n) => (nc[n.reason] = (nc[n.reason] ?? 0) + 1));
  console.log(`persons=${persons.length} cropped=${list.length} none=${none.length} ${JSON.stringify(nc)} how=${JSON.stringify(hows)}`);
}

main();
