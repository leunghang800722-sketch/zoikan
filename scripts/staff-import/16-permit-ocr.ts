// WP-STAFF-FIELDS：對牌照卡裁圖（permit_card）放大＋四個方向重跑本機 Apple Vision → permit-ocr2.json（{id:{nos,to}}，可續跑）。
// 係「本機 OCR」獨立讀數嘅補強（整頁 OCR 對旋轉卡認唔到號碼）。log 只印計數。
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { FIELDS_OUT } from './lib/fields-render';
import { normDate, normPermitNo } from './lib/fields-ext';
import { BIN, run } from './lib/render';

const MAGICK = '/opt/homebrew/bin/magick';
const outPath = path.join(FIELDS_OUT, 'permit-ocr2.json');

async function one(id: string, file: string): Promise<{ nos: string[]; to: string[] }> {
  const tmp = path.join(FIELDS_OUT, 'tmp', `po-${id}`);
  await fs.mkdir(tmp, { recursive: true });
  const files: string[] = [];
  for (const rot of [0, 90, 180, 270]) {
    const f = path.join(tmp, `r${rot}.png`);
    await run(MAGICK, [path.join(FIELDS_OUT, file), '-rotate', String(rot), '-resize', '140%', f]);
    files.push(f);
  }
  const r = await run(BIN, files);
  const nos = new Set<string>();
  const to = new Set<string>();
  for (const line of r.stdout.split('\n').filter(Boolean)) {
    const o = JSON.parse(line) as { lines: { t: string }[] };
    const txt = o.lines.map((l) => l.t).join(' ');
    for (const m of txt.matchAll(/[A-Z]{1,2}\s*-?\s*\d{6}\s*-?\s*[0-9A]\s*-?\s*(?:\d{3})?/g)) { const n = normPermitNo(m[0]); if (n) nos.add(n); }
    for (const l of o.lines) { const m = /^\s*(20\d{2}[-.]\d{2}[-.]\d{2})\s*$/.exec(l.t); const d = m ? normDate(m[1]) : null; if (d) to.add(d); }
  }
  await fs.rm(tmp, { recursive: true, force: true });
  return { nos: [...nos], to: [...to] };
}

async function main() {
  const tasks = JSON.parse(await fs.readFile(path.join(FIELDS_OUT, 'read-tasks.json'), 'utf8')) as { id: string; file: string; spec: string }[];
  let done: Record<string, { nos: string[]; to: string[] }> = {};
  try { done = JSON.parse(await fs.readFile(outPath, 'utf8')); } catch { /* 新開 */ }
  const todo = tasks.filter((t) => t.spec === 'permit_card' && !done[t.id]);
  let i = 0;
  const worker = async () => {
    while (i < todo.length) {
      const t = todo[i++];
      done[t.id] = await one(t.id, t.file);
      if (i % 20 === 0) { await fs.writeFile(outPath, JSON.stringify(done)); console.log(`${i}/${todo.length}`); }
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  await fs.writeFile(outPath, JSON.stringify(done));
  console.log(`done=${Object.keys(done).length}`);
}
main();
