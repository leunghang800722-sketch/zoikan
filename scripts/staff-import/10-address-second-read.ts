// Stage A5：列出「address 現時 confirmed 但冇本機 OCR 地址同視覺讀數一致」嘅裁圖 → out/address-second-read-todo.json
// （淨含 docId／page／裁圖路徑，唔含地址值）。之後由人手盲讀 → out/address-vision-2.json。
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { DocExtract } from './lib/aggregate';
import { normAddr } from './lib/person-fields';
import { OUT } from './lib/render';

interface PF {
  docIds: string[];
  addressDocId: string | null;
  fields: { address: { status: string; value: string | null } };
}

async function main() {
  const people = JSON.parse(await fs.readFile(path.join(OUT, 'out/person-fields.json'), 'utf8')) as PF[];
  const ex = new Map((JSON.parse(await fs.readFile(path.join(OUT, 'out/extract.json'), 'utf8')) as DocExtract[]).map((e) => [e.docId, e]));
  const vis = new Map((JSON.parse(await fs.readFile(path.join(OUT, 'out/address-vision.json'), 'utf8')) as { docId: string; page: number }[]).map((v) => [v.docId, v]));
  const todo: { docId: string; page: number; file: string }[] = [];
  let confirmed = 0;
  for (const p of people) {
    const a = p.fields.address;
    if (a.status !== 'confirmed') continue;
    confirmed++;
    const locals = p.docIds.map((d) => ex.get(d)?.address?.value).filter((x): x is string => !!x);
    if (locals.some((l) => normAddr(l) === normAddr(a.value))) continue;
    const docId = p.addressDocId && vis.has(p.addressDocId) ? p.addressDocId : p.docIds.find((d) => vis.has(d));
    const v = docId ? vis.get(docId) : undefined;
    if (!docId || !v) continue;
    todo.push({ docId, page: v.page, file: `crops/address/${docId}-p${v.page}.png` });
  }
  await fs.writeFile(path.join(OUT, 'out/address-second-read-todo.json'), JSON.stringify(todo, null, 1));
  console.log(`address confirmed=${confirmed} todo=${todo.length}`);
}

main();
