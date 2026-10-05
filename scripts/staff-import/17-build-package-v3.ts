// WP-STAFF-FIELDS 第二階段：v2 導入包（327 人）＋ person-fields-ext.json → import-package-v3.json（gitignored）。
// console 只印計數，唔印任何姓名／號碼。
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { buildPackageV3, type ExtPerson, type TypedSources, type V2Package } from './lib/package-v3';

const IN_V2 = path.join(process.cwd(), 'data/2026-10/staff-import/out/import-package.json');
const FIELDS = path.join(process.cwd(), 'data/2026-10/staff-fields');

async function main() {
  const v2 = JSON.parse(await fs.readFile(IN_V2, 'utf8')) as V2Package;
  const ext = JSON.parse(await fs.readFile(path.join(FIELDS, 'person-fields-ext.json'), 'utf8')) as ExtPerson[];
  let typed: TypedSources = {};
  try { typed = JSON.parse(await fs.readFile(path.join(FIELDS, 'typed-sources.json'), 'utf8')) as TypedSources; } catch { /* 容忍冇 */ }
  const { pkg, counts, report } = buildPackageV3(v2, ext, typed);
  // 未核實欄報告：只有內部 key＋欄位名＋reason，冇值
  await fs.writeFile(path.join(FIELDS, 'unverified-report.json'), JSON.stringify(report));
  const out = path.join(FIELDS, 'import-package-v3.json');
  await fs.writeFile(out, JSON.stringify(pkg));
  console.log(JSON.stringify(counts));
  console.log(`persons=${pkg.persons.length} unassignedBank=${pkg.unassignedBankAccounts?.length ?? 0} bytes=${(await fs.stat(out)).size}（非老闆上限 500 人：${pkg.persons.length <= 500 ? '符合' : '超出'}）`);
}
main();
