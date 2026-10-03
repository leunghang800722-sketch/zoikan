// Stage A step 3：抽取結果對 U Team／Maxwell／dev DB 交叉核對 → out/crosscheck.json。
// Console 淨印統計。
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { DocExtract } from './lib/aggregate';
import { buildIndex, crosscheck, FIELDS, type DocCheck, type Src } from './lib/crosscheck';
import type { DocMeta } from './lib/doc-index';
import type { VisionRead } from './lib/phone';
import { groupPersons } from './lib/persons';
import { resolvePerson, type AddrVision, type DobVision, type NameVision, type PersonDocIn, type PersonFields } from './lib/person-fields';
import { loadDb, loadMaxwell, loadUTeam, type RefRow } from './lib/refs';

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

  let vision: VisionRead[] = [];
  try {
    vision = JSON.parse(await fs.readFile(path.join(OUT, 'out/phone-vision.json'), 'utf8')) as VisionRead[];
  } catch {
    console.log('WARN: 冇 phone-vision.json，電話全部 unresolved');
  }
  const crops = JSON.parse(await fs.readFile(path.join(OUT, 'out/phone-crops.json'), 'utf8').catch(() => '[]')) as { docId: string }[];
  const cropDocs = new Set(crops.map((c) => c.docId));
  const checks: DocCheck[] = [];
  for (const ex of extracts) {
    const m = meta.get(ex.docId);
    const fnZh = m?.fileName && /[一-鿿]/.test(m.fileName) ? m.fileName.replace(/[^一-鿿]/g, '') : null;
    checks.push(crosscheck(ex, ex.staffNo, fnZh, idxs, { vision: vision.filter((v) => v.docId === ex.docId), hasCrop: cropDocs.has(ex.docId) }));
  }
  await fs.writeFile(path.join(OUT, 'out/crosscheck.json'), JSON.stringify(checks, null, 1));

  // ---- 逐人逐欄 status（confirmed／review／missing）
  const readJson = async <T>(f: string): Promise<T[]> => JSON.parse(await fs.readFile(path.join(OUT, f), 'utf8').catch(() => '[]')) as T[];
  const nameVision = new Map((await readJson<NameVision>('out/name-vision.json')).map((v) => [v.docId, v]));
  // 英文名補漏：英文名 missing 嘅人用較大範圍重讀（name-vision2），clear 先覆蓋缺嘅欄
  for (const v of await readJson<NameVision>('out/name-vision2.json')) {
    const old = nameVision.get(v.docId);
    if (v.legible !== 'clear') continue;
    nameVision.set(v.docId, { docId: v.docId, zh: old?.legible === 'clear' && old.zh ? old.zh : v.zh, en: v.en ?? old?.en ?? null, legible: 'clear' });
  }
  const dobVision = new Map((await readJson<DobVision>('out/dob-vision.json')).map((v) => [v.docId, v]));
  const addrVision = new Map((await readJson<AddrVision>('out/address-vision.json')).map((v) => [v.docId, v]));
  const refById = new Map<string, RefRow>([...u, ...mx, ...db].map((r) => [r.ref, r]));
  const checkMap = new Map(checks.map((c) => [c.docId, c]));
  const exMap = new Map(extracts.map((e) => [e.docId, e]));
  const fnZhOf = (docId: string) => {
    const m = meta.get(docId);
    return m?.fileName && /[\u4e00-\u9fff]/.test(m.fileName) ? m.fileName.replace(/[^\u4e00-\u9fff]/g, '') : null;
  };
  const groups = groupPersons(extracts, (d) => checkMap.get(d)!.grade);
  const peopleOut: { key: string; docIds: string[]; idDocId: string | null; addressDocId: string | null; fields: PersonFields }[] = [];
  for (const g of groups) {
    const docs: PersonDocIn[] = g.docIds.map((id) => {
      const c = checkMap.get(id)!;
      const rows = (['utem', 'maxwell', 'db'] as Src[]).map((s) => (c.refs[s].ref ? refById.get(c.refs[s].ref!) : undefined)).filter((r): r is RefRow => !!r);
      return {
        docId: id,
        ex: exMap.get(id)!,
        fileNameZh: fnZhOf(id),
        phone: c.phoneFinal,
        listZh: rows.map((r) => r.nameZh).filter((x): x is string => !!x),
        listEn: rows.map((r) => r.nameEn).filter((x): x is string => !!x),
        listTels: rows.flatMap((r) => r.tels),
        listDob: rows.map((r) => r.dob).filter((x): x is string => !!x),
      };
    });
    const fields = resolvePerson({
      key: g.key,
      docs,
      idDocId: g.idDocId,
      addressDocId: g.addressDocId,
      nameVision: g.idDocId ? nameVision.get(g.idDocId) ?? null : null,
      addrVision: g.addressDocId ? addrVision.get(g.addressDocId) ?? null : (g.docIds.map((d) => addrVision.get(d)).find((x) => !!x) ?? null),
      dobVision: g.idDocId ? dobVision.get(g.idDocId) ?? null : null,
    });
    peopleOut.push({ key: g.key, docIds: g.docIds, idDocId: g.idDocId, addressDocId: g.addressDocId, fields });
  }
  await fs.writeFile(path.join(OUT, 'out/person-fields.json'), JSON.stringify(peopleOut, null, 1));
  const fieldStat: Record<string, Record<string, number>> = {};
  const fieldReasons: Record<string, number> = {};
  for (const pp of peopleOut) {
    for (const [f, v] of Object.entries(pp.fields)) {
      (fieldStat[f] ??= {})[v.status] = (fieldStat[f][v.status] ?? 0) + 1;
      v.reasons.forEach((r) => (fieldReasons[`${f}:${r}`] = (fieldReasons[`${f}:${r}`] ?? 0) + 1));
    }
  }
  console.log(`persons=${peopleOut.length}`);
  for (const [f, st] of Object.entries(fieldStat)) console.log(`person-field ${f}: ${JSON.stringify(st)} confirmed=${pct(st.confirmed ?? 0, peopleOut.length)}`);
  console.log('field reasons top:', Object.entries(fieldReasons).sort((a, b) => b[1] - a[1]).slice(0, 14).map(([k, v]) => `${k}=${v}`).join(', '));
  await fs.writeFile(path.join(OUT, 'out/person-field-stats.json'), JSON.stringify({ persons: peopleOut.length, fieldStat, fieldReasons }, null, 1));

  // hkid 仍然搵唔到／有衝突
  const unresolved = extracts
    .filter((e) => !e.hkid || !e.hkidValid || e.flags.some((f) => f.startsWith('hkid_conflict')))
    .map((e) => ({ docId: e.docId, reason: !e.hkid ? (e.flags.includes('no_id_page') ? 'no_id_page' : 'hkid_not_extracted') : !e.hkidValid ? 'check_digit_fail' : 'hkid_conflict_other_page' }));
  await fs.writeFile(path.join(OUT, 'out/hkid-unresolved.json'), JSON.stringify(unresolved, null, 1));
  const unrCount: Record<string, number> = {};
  unresolved.forEach((u) => (unrCount[u.reason] = (unrCount[u.reason] ?? 0) + 1));
  console.log(`hkid unresolved: ${unresolved.length} ${JSON.stringify(unrCount)}`);
  const pstat: Record<string, number> = {};
  checks.forEach((c) => (pstat[c.phoneFinal.status] = (pstat[c.phoneFinal.status] ?? 0) + 1));
  console.log(`phone final: ${JSON.stringify(pstat)}`);
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
