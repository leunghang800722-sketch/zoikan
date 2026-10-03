// Stage A4：由身份證頁裁出生日期＋性別嗰行 → crops/dob/<docId>.png（docId＝身份證來源檔）。
// 定位唔到出生日期行就裁卡面下半。輸出 out/dob-crops.json（清單，無日期）。
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { DocExtract } from './lib/aggregate';
import { locateDobBox } from './lib/crop-box';
import type { DocCheck } from './lib/crosscheck';
import type { DocMeta } from './lib/doc-index';
import type { OcrPage } from './lib/ocr';
import { groupPersons } from './lib/persons';
import { toPixels } from './lib/phone-crop';
import { OUT, renderPage, run } from './lib/render';

async function main() {
  const index = new Map((JSON.parse(await fs.readFile(path.join(OUT, 'index.json'), 'utf8')) as DocMeta[]).map((m) => [m.docId, m]));
  const ex = JSON.parse(await fs.readFile(path.join(OUT, 'out/extract.json'), 'utf8')) as DocExtract[];
  const cc = new Map((JSON.parse(await fs.readFile(path.join(OUT, 'out/crosscheck.json'), 'utf8')) as DocCheck[]).map((c) => [c.docId, c]));
  const exMap = new Map(ex.map((e) => [e.docId, e]));
  const persons = groupPersons(ex, (d) => cc.get(d)?.grade ?? 'fail');
  await fs.mkdir(path.join(OUT, 'crops/dob'), { recursive: true });
  const list: { personKey: string; docId: string; page: number; how: string; file: string }[] = [];
  const skipped: { personKey: string; reason: string }[] = [];
  const hows: Record<string, number> = {};
  for (const p of persons) {
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
    const loc = locateDobBox(page, lines);
    const tmp = path.join(OUT, 'pages3', `${p.idDocId}-d.png`);
    if (!(await renderPage(m.file, page, tmp, 300, e.rescuedRot ?? 0))) {
      skipped.push({ personKey: p.key, reason: 'render_fail' });
      continue;
    }
    const id = await run('/opt/homebrew/bin/magick', ['identify', '-format', '%w %h', tmp]);
    const [w, h] = id.stdout.trim().split(' ').map(Number);
    const px = toPixels(loc.box, w, h);
    const file = `crops/dob/${p.idDocId}.png`;
    await run('/opt/homebrew/bin/magick', [tmp, '-crop', `${px.w}x${px.h}+${px.x}+${px.y}`, '+repage', path.join(OUT, file)]);
    await fs.rm(tmp, { force: true });
    list.push({ personKey: p.key, docId: p.idDocId, page, how: loc.how, file });
    hows[loc.how] = (hows[loc.how] ?? 0) + 1;
  }
  await fs.writeFile(path.join(OUT, 'out/dob-crops.json'), JSON.stringify(list, null, 1));
  await fs.writeFile(path.join(OUT, 'out/dob-skipped.json'), JSON.stringify(skipped, null, 1));
  console.log(`persons=${persons.length} cropped=${list.length} skipped=${skipped.length} how=${JSON.stringify(hows)}`);
}

main();
