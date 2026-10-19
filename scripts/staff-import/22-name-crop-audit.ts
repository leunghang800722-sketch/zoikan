// TE-10：身份證中文名裁圖潛在切字自檢——對 package 所有有身份證頁嘅人，比較「OCR 中文名行字數」同「包內中文名字數」；console 只計數＋分佈，--out（data/ 下）列受影響 personKey＋docId。
//   npx tsx scripts/staff-import/22-name-crop-audit.ts --package … --person-fields … --extract … [--ocr-dir …] --out data/…/name-crop-audit.json
//   npx tsx scripts/staff-import/22-name-crop-audit.ts --dry     # 記憶體內合成 fixture，唔讀 data
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ArgError, resolveReportPath } from './lib/eval-ocr-core';
import { auditName, summarizeNameAudit, type NameAuditPerson, type NameAuditSummary } from './lib/name-crop-audit';
import { loadPeoplePages } from './lib/page-loader';
import type { OcrLine } from './lib/ocr';

export interface Args {
  package: string | null;
  personFields: string | null;
  extract: string | null;
  ocrDir: string | null;
  out: string | null;
  dry: boolean;
}
export function parseArgs(argv: readonly string[]): Args {
  const a: Args = { package: null, personFields: null, extract: null, ocrDir: null, out: null, dry: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = () => {
      const x = argv[++i];
      if (x === undefined) throw new ArgError(`${k} 缺少參數值`);
      return x;
    };
    if (k === '--package') a.package = v();
    else if (k === '--person-fields') a.personFields = v();
    else if (k === '--extract') a.extract = v();
    else if (k === '--ocr-dir') a.ocrDir = v();
    else if (k === '--out') a.out = v();
    else if (k === '--dry') a.dry = true;
    else throw new ArgError(`唔認得嘅參數 ${k}`);
  }
  return a;
}

const L = (t: string, x: number, y: number, w: number, h = 0.025): OcrLine => ({ t, c: 0.9, x, y, w, h });
const card = (zh: string, w: number): OcrLine[] => [L('香港永久性居民身份證', 0.12, 0.8, 0.34), L('HONG KONG PERMANENT IDENTITY CARD', 0.12, 0.77, 0.44, 0.02), L('TESTER, Alpha', 0.1, 0.7, 0.25), L(zh, 0.1, 0.66, w), L('出生日期 Date of Birth', 0.1, 0.6, 0.24, 0.02), L('15-01-1990', 0.14, 0.57, 0.16), L('簽發日期 Date of Issue', 0.1, 0.53, 0.22, 0.02), L('Z900001(2)', 0.44, 0.54, 0.12, 0.035)];
/** 合成 fixture：3 字名只讀到 2 字（缺 1）、4 字名讀到 2 字（缺 2）、5 字名讀到 2 字（缺 3）、正常、冇身份證頁、冇包內名 */
export function dryPersons(): NameAuditPerson[] {
  const pg = (docId: string, lines: OcrLine[]) => [{ docId, page: 1, lines }];
  return [
    { key: 'dry-1', nameZh: '測試甲', idPages: pg('d1', card('測試', 0.08)) },
    { key: 'dry-2', nameZh: '測試甲乙', idPages: pg('d2', card('測試', 0.08)) },
    { key: 'dry-3', nameZh: '測試甲乙丙', idPages: pg('d3', card('測試', 0.08)) },
    { key: 'dry-4', nameZh: '測試甲', idPages: pg('d4', card('測試甲', 0.12)) },
    { key: 'dry-5', nameZh: '測試甲', idPages: [] },
    { key: 'dry-6', nameZh: null, idPages: pg('d6', card('測試', 0.08)) },
  ];
}

export interface NameAuditResult {
  summary: NameAuditSummary;
  affected: { person_key: string; doc_ids: string[]; deficit: number }[];
}
export async function run(args: Args): Promise<NameAuditResult> {
  const people: NameAuditPerson[] = args.dry ? dryPersons() : (await loadPeoplePages(args, (kinds) => kinds.includes('id_card'))).map((x) => ({ key: x.person.key, nameZh: x.person.nameZh.value?.trim() || null, idPages: x.pages }));
  const rows = people.map(auditName);
  const byKey = new Map(people.map((p) => [p.key, p]));
  return {
    summary: summarizeNameAudit(rows),
    affected: rows.filter((r) => r.compared && r.deficit > 0).map((r) => ({ person_key: r.key, doc_ids: [...new Set(byKey.get(r.key)!.idPages.map((p) => p.docId))], deficit: r.deficit })),
  };
}

export async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  const outPath = args.out ? resolveReportPath(args.out, process.cwd()) : null;
  if (!args.dry && !outPath) throw new ArgError('需要 --out（必須喺 data/ 之下）');
  const r = await run(args);
  const s = r.summary;
  console.log(`[name-crop-audit] 人數 ${s.persons}｜有身份證頁 ${s.with_id_page}｜可比較（有包內中文名＋OCR 中文名行）${s.compared}`);
  console.log(`[name-crop-audit] OCR 中文名行字數少過包內字數（潛在切字）${s.short}｜少 1 字 ${s.deficit_1}｜少 2 字 ${s.deficit_2}｜少 3 字或以上 ${s.deficit_3plus}`);
  if (outPath) {
    await mkdir(path.dirname(outPath), { recursive: true });
    await writeFile(outPath, JSON.stringify({ version: 1, summary: s, affected: r.affected }, null, 2));
    console.log('[name-crop-audit] 已寫入 --out');
  }
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main(process.argv.slice(2)).then((c) => process.exit(c), (e) => {
    console.error(e instanceof ArgError ? `[name-crop-audit] ${e.message}` : `[name-crop-audit] error ${e instanceof Error ? e.name : typeof e}`);
    process.exit(1);
  });
}
