// Stage A step 3：抽取結果對 U Team／Maxwell／dev DB 交叉核對 → out/crosscheck.json。
// Console 淨印統計。
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { DocExtract } from './lib/aggregate';
import { buildIndex, crosscheck, FIELDS, type DocCheck, type Src } from './lib/crosscheck';
import type { DocMeta } from './lib/doc-index';
import { loadDb, loadMaxwell, loadUTeam } from './lib/refs';

const OUT = path.join(process.cwd(), 'data/2026-10/staff-import');
const U_TEAM = 'data/2026-09/msg-file/U Team - People template 20260824.xlsx';
const MAXWELL = 'data/2026-09/msg-file/Maxwell All Staff List (Front Line).xlsx';

const pct = (n: number, d: number) => (d ? `${((n / d) * 100).toFixed(1)}%` : 'n/a');

async function main() {
  const index = JSON.parse(await fs.readFile(path.join(OUT, 'index.json'), 'utf8')) as DocMeta[];
  const meta = new Map(index.map((m) => [m.docId, m]));
  const extracts = JSON.parse(await fs.readFile(path.join(OUT, 'out/extract.json'), 'utf8')) as (DocExtract & { staffNo: string | null })[];

  const [u, mx, db] = await Promise.all([
    loadUTeam(U_TEAM),
    loadMaxwell(MAXWELL),
    loadDb().catch(() => {
      console.log('WARN: dev DB 連唔到，跳過 db 參考');
      return [];
    }),
  ]);
  console.log(`refs: utem=${u.length} maxwell=${mx.length} db=${db.length}`);
  const idxs = { utem: buildIndex(u), maxwell: buildIndex(mx), db: buildIndex(db) } as Record<Src, ReturnType<typeof buildIndex>>;

  const checks: DocCheck[] = [];
  for (const ex of extracts) {
    const m = meta.get(ex.docId);
    const fnZh = m?.fileName && /[一-鿿]/.test(m.fileName) ? m.fileName.replace(/[^一-鿿]/g, '') : null;
    checks.push(crosscheck(ex, ex.staffNo, fnZh, idxs));
  }
  await fs.writeFile(path.join(OUT, 'out/crosscheck.json'), JSON.stringify(checks, null, 1));

  const N = checks.length;
  const grades: Record<string, number> = {};
  checks.forEach((c) => (grades[c.grade] = (grades[c.grade] ?? 0) + 1));
  console.log(`docs=${N} grades=${JSON.stringify(grades)}`);
  const stat: Record<string, unknown> = {};
  for (const f of FIELDS) {
    const st: Record<string, number> = {};
    checks.forEach((c) => (st[c.status[f]] = (st[c.status[f]] ?? 0) + 1));
    const m = st.match ?? 0;
    const mm = (st.mismatch ?? 0) + (st.mixed ?? 0);
    const perSrc: Record<string, string> = {};
    for (const s of ['utem', 'maxwell', 'db', 'file'] as const) {
      let a = 0;
      let b = 0;
      checks.forEach((c) => {
        const v = c.cmp[f][s];
        if (v === 'match') a++;
        else if (v === 'mismatch') b++;
      });
      if (a + b) perSrc[s] = `${a}/${a + b} (${pct(a, a + b)})`;
    }
    stat[f] = { ...st, agreeRate: pct(m, m + mm), perSrc };
    console.log(`xcheck ${f}: ${JSON.stringify(st)} agree=${pct(m, m + mm)} perSrc=${JSON.stringify(perSrc)}`);
  }
  const reason: Record<string, number> = {};
  checks.forEach((c) => c.reasons.forEach((r) => (reason[r] = (reason[r] ?? 0) + 1)));
  const top = Object.entries(reason).sort((a, b) => b[1] - a[1]);
  console.log('reasons top:', top.slice(0, 15).map(([k, v]) => `${k}=${v}`).join(', '));
  const basis: Record<string, number> = {};
  checks.forEach((c) => (['utem', 'maxwell', 'db'] as Src[]).forEach((s) => (basis[`${s}:${c.refs[s].basis}`] = (basis[`${s}:${c.refs[s].basis}`] ?? 0) + 1)));
  console.log('ref basis:', JSON.stringify(basis));
  await fs.writeFile(path.join(OUT, 'out/crosscheck-stats.json'), JSON.stringify({ N, grades, stat, reason, basis }, null, 1));
}

main();
