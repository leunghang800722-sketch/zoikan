// Stage B step 6：由 out/{extract,crosscheck}.json 產生導入包 → out/import-package.json
// （gitignored；含真資料，唔入 git）。伺服器 `POST /api/guards/import/preview|apply` 上載呢個檔。
//
// 格式 v2（逐欄狀態）：
//   { version: 2, generatedAt, persons: [{ key(sha1 of hkid), hkid/nameZh/nameEn/dateOfBirth/sex/phone/address:
//     {value,status}, staffNumbers:[{scheme,number}], rating, reasons[], conflicts[] }] }
//   status ∈ confirmed／review／missing。
//   - hkid：check digit 通過且冇 hkid 衝突 → confirmed；有值但衝突／check digit 唔過 → review；冇 → missing
//   - dateOfBirth、sex：有值 → confirmed（Opus 抽樣 0 錯）
//   - phone：03 嘅 phone_confirmed（視覺 clear 且同名單／OCR 一致）→ confirmed；其餘有值 → review
//   - nameZh／nameEn／address：暫時一律 review（Stage A3 補強後再改規則）；冇值 → missing
// 控制台只印數字，唔印任何姓名／號碼。
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { DocExtract } from './lib/aggregate';
import type { DocCheck } from './lib/crosscheck';
import { canonicalHkid } from './lib/hkid';
import { normTel } from './lib/compare';
import { mergeGroup, type MergeDoc } from './lib/merge';
import { groupPersons, type PlanInput } from './lib/match-plan';
import { hkidCheckDigitValid } from '@/lib/guards/identity';

const OUT = path.join(process.cwd(), 'data/2026-10/staff-import');

type Status = 'confirmed' | 'review' | 'missing';
interface F {
  value: string | null;
  status: Status;
}
const f = (value: string | null | undefined, status: Status): F => (value ? { value, status } : { value: null, status: 'missing' });

function splitStaffNo(raw: string): { scheme: string; number: string } | null {
  const n = raw.trim().toUpperCase().replace(/\s+/g, '');
  const m = n.match(/^([A-Z]{1,4})\d/);
  return m ? { scheme: m[1], number: n } : null;
}

async function main() {
  const ex = JSON.parse(await fs.readFile(path.join(OUT, 'out/extract.json'), 'utf8')) as (DocExtract & { staffNo: string | null })[];
  const cc = new Map((JSON.parse(await fs.readFile(path.join(OUT, 'out/crosscheck.json'), 'utf8')) as DocCheck[]).map((c) => [c.docId, c]));
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
  const mdocs = new Map<string, MergeDoc>(
    ex.map((e) => {
      const c = cc.get(e.docId)!;
      return [
        e.docId,
        {
          docId: e.docId,
          staffNo: e.staffNo,
          grade: c.grade,
          hkidConf: e.hkid?.conf ?? 0,
          id: { hkid: e.hkid ? canonicalHkid(e.hkid.value) : null, nameZh: e.nameZh?.value ?? null, nameEn: e.nameEn?.value ?? null, dob: e.dob?.value ?? null, sex: e.sex?.value ?? null },
          address: e.address ? { value: e.address.value, date: e.address.date ?? null, level: e.address.level } : null,
          phone: c.phoneFinal.value ? { value: c.phoneFinal.value, status: c.phoneFinal.status } : null,
        },
      ];
    }),
  );

  const persons = groupPersons(inputs).map((g) => {
    const m = mergeGroup(g.docIds.map((d) => mdocs.get(d)!));
    const idDoc = cc.get(m.idDocId);
    const idEx = exBy.get(m.idDocId);
    const hkid = canonicalHkid(m.hkid);
    const hkidOk = !!hkid && hkidCheckDigitValid(hkid) && !(idDoc?.reasons ?? []).some((r) => r === 'hkid_conflict_other_page' || r === 'id_hkid_multiple') && !(idEx?.flags ?? []).some((x) => x.startsWith('hkid_conflict'));
    // 電話：全部帶該號碼嘅檔都係 phone_confirmed，且淨得一個號碼 → confirmed
    const phoneNorm = normTel(m.phone);
    const phoneDocs = g.docIds.filter((d) => normTel(cc.get(d)?.phoneFinal.value) === phoneNorm && phoneNorm);
    const phoneConfirmed = !!phoneNorm && m.phones.length === 1 && phoneDocs.length > 0 && phoneDocs.every((d) => cc.get(d)?.phoneFinal.status === 'confirmed');
    const key = createHash('sha1').update(hkid ?? `doc:${g.primary.docId}`).digest('hex');
    const staffNumbers = [...new Set(m.staffNos)].map(splitStaffNo).filter((x): x is { scheme: string; number: string } => !!x);
    return {
      key,
      hkid: f(hkid, hkidOk ? 'confirmed' : 'review'),
      nameZh: f(m.nameZh, 'review'),
      nameEn: f(m.nameEn, 'review'),
      dateOfBirth: f(m.dob, 'confirmed'),
      sex: f(m.sex, 'confirmed'),
      phone: f(m.phone ?? m.phones[0] ?? null, phoneConfirmed ? 'confirmed' : 'review'),
      address: f(m.address, 'review'),
      staffNumbers,
      rating: g.primary.grade,
      reasons: [...new Set([...g.reasons, ...m.reasons, ...(idDoc?.reasons ?? []).filter((r) => !r.startsWith('ref_ambiguous')).slice(0, 12)])].slice(0, 40),
      conflicts: g.reasons.includes('group_name_differs') ? ['group_name_differs'] : [],
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
