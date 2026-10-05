// WP-STAFF-FIELDS：由 crops-manifest*.json 產生 read-tasks.json（要讀乜）同 second-read-queue.json（盲讀包，唔含任何讀數）。
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { FIELDS_OUT } from './lib/fields-render';
import { HANDWRITTEN, READ_FIELDS, specKey } from './lib/fields-spec';
import type { PersonCrops } from './13-fields-crops';

async function main() {
  const files = (await fs.readdir(FIELDS_OUT)).filter((f) => /^crops-manifest.*\.json$/.test(f));
  const all: PersonCrops[] = [];
  for (const f of files) all.push(...(JSON.parse(await fs.readFile(path.join(FIELDS_OUT, f), 'utf8')) as PersonCrops[]));
  all.sort((a, b) => a.idx - b.idx);
  const tasks: { id: string; person: number; file: string; spec: string; fields: string[]; handwritten: boolean }[] = [];
  for (const p of all) for (const c of p.crops) {
    const spec = specKey(c.kind, c.how);
    tasks.push({ id: c.id, person: p.idx, file: c.file, spec, fields: READ_FIELDS[spec], handwritten: HANDWRITTEN[spec] });
  }
  await fs.writeFile(path.join(FIELDS_OUT, 'read-tasks.json'), JSON.stringify(tasks));
  // 盲讀包：只含手寫裁圖；id／裁圖路徑／要讀欄；絕不含 first-read 內容
  const queue = tasks.filter((t) => t.handwritten).map((t) => ({ id: t.id, file: t.file, spec: t.spec, fields: t.fields }));
  await fs.writeFile(path.join(FIELDS_OUT, 'second-read-queue.json'), JSON.stringify(queue, null, 1));
  const bySpec: Record<string, number> = {};
  tasks.forEach((t) => (bySpec[t.spec] = (bySpec[t.spec] ?? 0) + 1));
  console.log(`persons=${all.length} tasks=${tasks.length} secondReadQueue=${queue.length} bySpec=${JSON.stringify(bySpec)}`);
}
main();
