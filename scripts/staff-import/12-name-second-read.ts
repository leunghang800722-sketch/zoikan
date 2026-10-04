// Stage A7：姓名第二讀數——列出 person-fields.json 入面 nameZh／nameEn status=review 而第一視覺讀數 clear 嘅人，
// 為其身份證頁出第二套姓名區裁圖 crops/name-b/<docId>.png（300dpi，邊界同 07 唔同）。
// 輸出 out/name-second-read-todo.json（淨 docId／page／路徑，無姓名）。
// 注意：裁圖範圍未做到最小化（姓名裁圖大多連相片、部分連身份證號／出生日期一齊裁入），淨係本機用、data/ 已 gitignored，唔離開本機。
// 第二讀數由另一個模型盲讀 → out/name-vision-2.json（本 script 唔做第二讀、唔建該檔）。
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { DocExtract } from './lib/aggregate';
import { locateNameBoxB } from './lib/crop-box';
import type { DocMeta } from './lib/doc-index';
import type { OcrPage } from './lib/ocr';
import type { NameVision } from './lib/person-fields';
import { toPixels } from './lib/phone-crop';
import { OUT, renderPage, run } from './lib/render';

interface PF {
  key: string;
  idDocId: string | null;
  fields: { nameZh: { status: string }; nameEn: { status: string } };
}

async function main() {
  const readJson = async <T>(f: string): Promise<T[]> => JSON.parse(await fs.readFile(path.join(OUT, f), 'utf8').catch(() => '[]')) as T[];
  const people = await readJson<PF>('out/person-fields.json');
  // 第一視覺讀數（同 03-crosscheck 一樣：name-vision2 補漏 clear 蓋過）
  const vis = new Map((await readJson<NameVision>('out/name-vision.json')).map((v) => [v.docId, v]));
  for (const v of await readJson<NameVision>('out/name-vision2.json')) {
    if (v.legible !== 'clear') continue;
    const old = vis.get(v.docId);
    vis.set(v.docId, { docId: v.docId, zh: old?.legible === 'clear' && old.zh ? old.zh : v.zh, en: v.en ?? old?.en ?? null, legible: 'clear' });
  }
  const index = new Map((await readJson<DocMeta>('index.json')).map((m) => [m.docId, m]));
  const exMap = new Map((await readJson<DocExtract>('out/extract.json')).map((e) => [e.docId, e]));
  await fs.mkdir(path.join(OUT, 'crops/name-b'), { recursive: true });

  let zhReview = 0;
  let enReview = 0;
  const todo: { docId: string; page: number; file: string }[] = [];
  const skipped: Record<string, number> = {};
  const seen = new Set<string>();
  for (const p of people) {
    const zh = p.fields.nameZh.status === 'review';
    const en = p.fields.nameEn.status === 'review';
    if (!zh && !en) continue;
    const v = p.idDocId ? vis.get(p.idDocId) : undefined;
    if (!p.idDocId || !v || v.legible !== 'clear') continue;
    if (zh) zhReview++;
    if (en) enReview++;
    if (seen.has(p.idDocId)) continue;
    seen.add(p.idDocId);
    const e = exMap.get(p.idDocId);
    const m = index.get(p.idDocId);
    if (!e?.hkid || !m) {
      skipped.no_meta = (skipped.no_meta ?? 0) + 1;
      continue;
    }
    const page = e.hkid.page;
    let lines: OcrPage['lines'] | undefined;
    if (e.rescuedRot !== null) {
      const rows = (await fs.readFile(path.join(OUT, 'ocr2', `${p.idDocId}.jsonl`), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l) as { page: number; rot: number; lines: OcrPage['lines'] });
      lines = rows.find((r) => r.page === page && r.rot === e.rescuedRot)?.lines;
    } else {
      const rows = (await fs.readFile(path.join(OUT, 'ocr', `${p.idDocId}.jsonl`), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l) as OcrPage);
      lines = rows.find((r) => r.page === page)?.lines;
    }
    if (!lines) {
      skipped.no_lines = (skipped.no_lines ?? 0) + 1;
      continue;
    }
    const loc = locateNameBoxB(page, lines);
    const tmp = path.join(OUT, 'pages3', `${p.idDocId}-nb.png`);
    if (!(await renderPage(m.file, page, tmp, 300, e.rescuedRot ?? 0))) {
      skipped.render_fail = (skipped.render_fail ?? 0) + 1;
      continue;
    }
    const id = await run('/opt/homebrew/bin/magick', ['identify', '-format', '%w %h', tmp]);
    const [w, h] = id.stdout.trim().split(' ').map(Number);
    const px = toPixels(loc.box, w, h);
    const file = `crops/name-b/${p.idDocId}.png`;
    await run('/opt/homebrew/bin/magick', [tmp, '-crop', `${px.w}x${px.h}+${px.x}+${px.y}`, '+repage', ...(loc.how === 'page' ? ['-resize', '1600x'] : []), path.join(OUT, file)]);
    await fs.rm(tmp, { force: true });
    todo.push({ docId: p.idDocId, page, file });
  }
  await fs.writeFile(path.join(OUT, 'out/name-second-read-todo.json'), JSON.stringify(todo, null, 1));
  console.log(`nameZh review(first clear)=${zhReview} nameEn review(first clear)=${enReview} crops=${todo.length} skipped=${JSON.stringify(skipped)}`);
}

main();
