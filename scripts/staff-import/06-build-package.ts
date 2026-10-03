// Stage B step 6：由 A3 嘅 out/person-fields.json（逐人逐欄最終 value／status）＋ extract／crosscheck
// 產生導入包 → out/import-package.json（gitignored；含真資料，唔入 git）。
// 伺服器 `POST /api/guards/import/preview|apply` 上載呢個檔。
//
// 格式 v2（逐欄狀態）：
//   { version: 2, generatedAt, persons: [{ key(隨機 uuid，每次 build 新生成，唔由 hkid 推導),
//     hkid/nameZh/nameEn/dateOfBirth/sex/phone/address: {value,status}, staffNumbers:[{scheme,number}],
//     rating, reasons[], conflicts[] }] }
//   - 7 個欄位嘅 value／status **直接用** person-fields.json（A3 規則，見 lib/person-fields.ts），本 script 唔再自己判斷；
//   - staffNumbers／rating／reasons／conflicts 由 extract／crosscheck／groupPersons 嚟。
// 控制台只印數字，唔印任何姓名／號碼。
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DocExtract } from './lib/aggregate';
import type { DocCheck } from './lib/crosscheck';
import { canonicalHkid } from './lib/hkid';
import { groupPersons, type PlanInput } from './lib/match-plan';

const OUT = path.join(process.cwd(), 'data/2026-10/staff-import');

type Status = 'confirmed' | 'review' | 'missing';
interface F {
  value: string | null;
  status: Status;
}
interface PersonFieldsRow {
  key: string;
  docIds: string[];
  fields: Record<'hkid' | 'nameZh' | 'nameEn' | 'dob' | 'sex' | 'phone' | 'address', { status: Status; value: string | null; candidates: string[]; reasons: string[] }>;
}
const f = (x: { status: Status; value: string | null }): F => (x.value && x.status !== 'missing' ? { value: x.value, status: x.status } : { value: null, status: 'missing' });
const RANK = { auto_ok: 0, review: 1, fail: 2 } as const;

function splitStaffNo(raw: string): { scheme: string; number: string } | null {
  const n = raw.trim().toUpperCase().replace(/\s+/g, '');
  const m = n.match(/^([A-Z]{1,4})\d/);
  return m ? { scheme: m[1], number: n } : null;
}

async function main() {
  const ex = JSON.parse(await fs.readFile(path.join(OUT, 'out/extract.json'), 'utf8')) as (DocExtract & { staffNo: string | null })[];
  const cc = new Map((JSON.parse(await fs.readFile(path.join(OUT, 'out/crosscheck.json'), 'utf8')) as DocCheck[]).map((c) => [c.docId, c]));
  const pf = JSON.parse(await fs.readFile(path.join(OUT, 'out/person-fields.json'), 'utf8')) as PersonFieldsRow[];
  const exBy = new Map(ex.map((e) => [e.docId, e]));
  const inputs: PlanInput[] = ex.map((e) => {
    const c = cc.get(e.docId)!;
    return {
      docId: e.docId,
      staffNos: e.staffNo ? [e.staffNo] : [],
      hkid: e.hkid ? canonicalHkid(e.hkid.value) : null,
      hkidValid: e.hkidValid,
      nameZh: e.nameZh?.value ?? null,
      phone: e.phone?.value ?? null,
      grade: c.grade,
      gradeReasons: c.reasons,
    };
  });
  const groupByDoc = new Map<string, ReturnType<typeof groupPersons>[number]>();
  for (const g of groupPersons(inputs)) for (const d of g.docIds) groupByDoc.set(d, g);

  const persons = pf.map((row) => {
    const grades = row.docIds.map((d) => cc.get(d)?.grade ?? 'fail');
    const rating = grades.sort((a, b) => RANK[a] - RANK[b])[0] ?? 'fail';
    const staffNumbers = [...new Set(row.docIds.map((d) => exBy.get(d)?.staffNo).filter((x): x is string => !!x))]
      .map(splitStaffNo)
      .filter((x): x is { scheme: string; number: string } => !!x);
    const groupReasons = [...new Set(row.docIds.flatMap((d) => groupByDoc.get(d)?.reasons ?? []))];
    const reasons = [
      ...new Set([
        ...Object.values(row.fields).flatMap((x) => x.reasons),
        ...row.docIds.flatMap((d) => (cc.get(d)?.reasons ?? []).filter((r) => !r.startsWith('ref_ambiguous'))),
        ...groupReasons,
      ]),
    ].slice(0, 40);
    return {
      key: randomUUID(),
      hkid: f(row.fields.hkid),
      nameZh: f(row.fields.nameZh),
      nameEn: f(row.fields.nameEn),
      dateOfBirth: f(row.fields.dob),
      sex: f(row.fields.sex),
      phone: f(row.fields.phone),
      address: f(row.fields.address),
      staffNumbers,
      rating,
      reasons,
      conflicts: groupReasons.includes('group_name_differs') ? ['group_name_differs'] : [],
    };
  });

  const pkg = { version: 2, generatedAt: new Date().toISOString(), persons };
  await fs.writeFile(path.join(OUT, 'out/import-package.json'), JSON.stringify(pkg));

  const stat: Record<string, Record<string, number>> = {};
  for (const p of persons) for (const k of ['hkid', 'nameZh', 'nameEn', 'dateOfBirth', 'sex', 'phone', 'address'] as const) {
    stat[k] ??= { confirmed: 0, review: 0, missing: 0 };
    stat[k][p[k].status] += 1;
  }
  console.log(`package: persons=${persons.length} docs=${inputs.length} version=2`);
  console.log(`field status: ${JSON.stringify(stat)}`);
  console.log(`rating: ${JSON.stringify(persons.reduce<Record<string, number>>((a, p) => ((a[p.rating] = (a[p.rating] ?? 0) + 1), a), {}))}`);
}

main();
