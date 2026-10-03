// Stage A3：由身份證頁裁出姓名區 → crops/name/<docId>.png（--wide：nameEn missing 嘅人裁成張卡 → crops/name2/）（docId＝該人嘅身份證來源檔）。
// 輸出 out/${wide ? 'name2' : 'name'}-crops.json（清單，無姓名）。之後由人手（視覺）逐張讀 → out/name-vision.json。
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { DocExtract } from './lib/aggregate';
import { locateNameBox, locateWideBox } from './lib/crop-box';
import type { DocCheck } from './lib/crosscheck';
import type { DocMeta } from './lib/doc-index';
import type { OcrPage } from './lib/ocr';
import { toPixels } from './lib/phone-crop';
import { groupPersons } from './lib/persons';
import { OUT, renderPage, run } from './lib/render';

async function main() {
  const wide = process.argv.includes('--wide'); // 英文名 missing 嘅人：裁成張卡（或成頁）重讀
  const needWide = new Set<string>();
  if (wide) {
    const pf = JSON.parse(await fs.readFile(path.join(OUT, 'out/person-fields.json'), 'utf8')) as { key: string; fields: { nameEn: { status: string } } }[];
    pf.filter((x) => x.fields.nameEn.status === 'missing').forEach((x) => needWide.add(x.key));
  }
  const index = new Map((JSON.parse(await fs.readFile(path.join(OUT, 'index.json'), 'utf8')) as DocMeta[]).map((m) => [m.docId, m]));
  const ex = JSON.parse(await fs.readFile(path.join(OUT, 'out/extract.json'), 'utf8')) as DocExtract[];
  const cc = new Map((JSON.parse(await fs.readFile(path.join(OUT, 'out/crosscheck.json'), 'utf8')) as DocCheck[]).map((c) => [c.docId, c]));
  const exMap = new Map(ex.map((e) => [e.docId, e]));
  const persons = groupPersons(ex, (d) => cc.get(d)?.grade ?? 'fail');
  await fs.mkdir(path.join(OUT, wide ? 'crops/name2' : 'crops/name'), { recursive: true });
  const list: { personKey: string; docId: string; page: number; how: string; file: string }[] = [];
  const skipped: { personKey: string; reason: string }[] = [];
  const hows: Record<string, number> = {};
  for (const p of persons) {
    if (wide && !needWide.has(p.key)) continue;
    if (!p.idDocId) {
      skipped.push({ personKey: p.key, reason: 'no_id_doc' });
      continue;
    }
    const e = exMap.get(p.idDocId)!;
    const m = index.get(p.idDocId)!;
    const page = e.hkid!.page;
    let lines: OcrPage['lines'] | undefined;
    if (e.rescuedRot !== null) {
      const rows = (await fs.readFile(path.join(OUT, 'ocr2', `${p.idDocId}.jsonl`), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l) as { page: number; rot: number; lines: OcrPage['lines'] });
      lines = rows.find((r) => r.page === page && r.rot === e.rescuedRot)?.lines;
    } else {
      const rows = (await fs.readFile(path.join(OUT, 'ocr', `${p.idDocId}.jsonl`), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l) as OcrPage);
      lines = rows.find((r) => r.page === page)?.lines;
    }
    if (!lines) {
      skipped.push({ personKey: p.key, reason: 'no_lines' });
      continue;
    }
    const loc = wide ? locateWideBox(page, lines) : locateNameBox(page, lines);
    const tmp = path.join(OUT, 'pages3', `${p.idDocId}-n.png`);
    const ok = await renderPage(m.file, page, tmp, 300, e.rescuedRot ?? 0);
    if (!ok) {
      skipped.push({ personKey: p.key, reason: 'render_fail' });
      continue;
    }
    const id = await run('/opt/homebrew/bin/magick', ['identify', '-format', '%w %h', tmp]);
    const [w, h] = id.stdout.trim().split(' ').map(Number);
    const px = toPixels(loc.box, w, h);
    const file = `crops/${wide ? 'name2' : 'name'}/${p.idDocId}.png`;
    await run('/opt/homebrew/bin/magick', [tmp, '-crop', `${px.w}x${px.h}+${px.x}+${px.y}`, '+repage', ...(loc.how === 'page' || wide ? ['-resize', '1600x'] : []), path.join(OUT, file)]);
    await fs.rm(tmp, { force: true });
    list.push({ personKey: p.key, docId: p.idDocId, page, how: loc.how, file });
    hows[loc.how] = (hows[loc.how] ?? 0) + 1;
  }
  await fs.writeFile(path.join(OUT, `out/${wide ? 'name2' : 'name'}-crops.json`), JSON.stringify(list, null, 1));
  await fs.writeFile(path.join(OUT, `out/${wide ? 'name2' : 'name'}-skipped.json`), JSON.stringify(skipped, null, 1));
  console.log(`persons=${persons.length} cropped=${list.length} skipped=${skipped.length} how=${JSON.stringify(hows)}`);
}

main();
