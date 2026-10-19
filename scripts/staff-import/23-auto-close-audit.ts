// TE-11：自動關閉自檢——對 package＋重讀 proposals（19-triage-reread 輸出），統計按「證件為準」規則（B）可自動關閉嘅題數（按題型）。console 只計數；--out（data/ 下）列 personKey＋題型。
//   npx tsx scripts/staff-import/23-auto-close-audit.ts --package data/…/import-package.json --proposals data/…/proposals.json --out data/…/auto-close-audit.json
//   npx tsx scripts/staff-import/23-auto-close-audit.ts --dry
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ArgError, resolveReportPath } from './lib/eval-ocr-core';
import { auditAutoClose, summarizeAutoClose, type AutoCloseRow, type AutoCloseSummary } from './lib/auto-close-audit';
import type { PkgPerson, RereadProposal } from './lib/triage-reread-core';

export interface Args {
  package: string | null;
  proposals: string | null;
  out: string | null;
  dry: boolean;
}
export function parseArgs(argv: readonly string[]): Args {
  const a: Args = { package: null, proposals: null, out: null, dry: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = () => {
      const x = argv[++i];
      if (x === undefined) throw new ArgError(`${k} 缺少參數值`);
      return x;
    };
    if (k === '--package') a.package = v();
    else if (k === '--proposals') a.proposals = v();
    else if (k === '--out') a.out = v();
    else if (k === '--dry') a.dry = true;
    else throw new ArgError(`唔認得嘅參數 ${k}`);
  }
  return a;
}

const lf = (value: string | null, status: 'confirmed' | 'review' | 'missing') => ({ value, status });
const pp = (key: string, over: Partial<PkgPerson> = {}): PkgPerson => ({ key, hkid: lf('Z9000012', 'confirmed'), nameZh: lf('測試甲', 'confirmed'), nameEn: lf('TEST', 'confirmed'), dateOfBirth: lf('1990-01-15', 'confirmed'), phone: lf('90001110', 'confirmed'), address: lf('地址', 'confirmed'), staffNumbers: [{ number: key }], ...over });
const pr = (key: string, field: RereadProposal['field'], value: string, over: Partial<RereadProposal> = {}): RereadProposal => ({ person_key: key, field, value, basis: 'two_reads', doc: 'id_card', confidence: 'high', match: { hkid: null, staff_numbers: [key] }, ...over });
/** 合成 fixture（假名／假 HKID）：卡讀數同包內一致、卡為準修正（high）、medium 留人、hkid 卡為準、field_review 全有建議／缺一個 */
export function dryData(): { persons: PkgPerson[]; proposals: RereadProposal[] } {
  return {
    persons: [
      pp('P1', { nameZh: lf('測試乙', 'review') }),
      pp('P2', { nameZh: lf('測試乙', 'review') }),
      pp('P3', { nameZh: lf('測試乙', 'review') }),
      pp('P4', { hkid: lf('Z9000013', 'review') }),
      pp('P5', { nameEn: lf('X', 'review'), dateOfBirth: lf('1990-01-16', 'review') }),
      pp('P6', { nameEn: lf('X', 'review'), dateOfBirth: lf('1990-01-16', 'review') }),
      pp('P7', { nameZh: lf('測試乙', 'review') }),
      pp('P8', { nameZh: lf('測試乙', 'review') }),
      pp('P9', { nameZh: lf('測試乙', 'review') }),
      pp('P10', { nameZh: lf('測試乙', 'review') }),
    ],
    proposals: [
      pr('P1', 'nameZh', '測試乙'), // 同包內一致 → use_package
      pr('P2', 'nameZh', '測試甲'), // 卡為準（high）→ enter_name
      pr('P3', 'nameZh', '測試甲', { confidence: 'medium' }), // medium → 留人
      pr('P4', 'hkid', 'Z9000012'), // 卡為準 → enter_hkid
      pr('P5', 'nameEn', 'TEST ALPHA'),
      pr('P5', 'dateOfBirth', '1990-01-15'),
      pr('P6', 'nameEn', 'TEST ALPHA'), // 缺 dob 建議 → 唔關閉
      pr('P7', 'nameZh', '測試甲', { flags: ['form_differs'] }), // TE-11.1：入職表唔一致只係資訊 → 卡為準自動答
      pr('P8', 'nameZh', '測試甲', { confidence: 'low', flags: ['embedded_card', 'printed_card_conflict'] }), // 印刷同卡唔一致 → 留人
      pr('P9', 'nameZh', '測試甲', { confidence: 'medium', flags: ['form_conflict'] }), // 入職表完全唔相似（疑錯人卡）→ 降級留人（S1 計數）
      pr('P10', 'nameZh', '測試甲', { confidence: 'medium', flags: ['form_differs'] }), // 中文差 1 字而冇硬證據 → 留人（TE-11.3 計數）
    ],
  };
}

export interface AutoCloseResult {
  summary: AutoCloseSummary;
  rows: AutoCloseRow[];
}
export async function run(args: Args): Promise<AutoCloseResult> {
  let persons: PkgPerson[];
  let proposals: RereadProposal[];
  if (args.dry) ({ persons, proposals } = dryData());
  else {
    if (!args.package || !args.proposals) throw new ArgError('需要 --package --proposals（或者 --dry）');
    const J = async <T>(p: string) => JSON.parse(await readFile(path.resolve(p), 'utf-8')) as T;
    persons = (await J<{ persons: PkgPerson[] }>(args.package)).persons;
    proposals = (await J<{ proposals: RereadProposal[] }>(args.proposals)).proposals;
  }
  const rows = auditAutoClose(persons, proposals);
  return { summary: summarizeAutoClose(rows), rows };
}

export async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  const outPath = args.out ? resolveReportPath(args.out, process.cwd()) : null;
  if (!args.dry && !outPath) throw new ArgError('需要 --out（必須喺 data/ 之下）');
  const r = await run(args);
  const s = r.summary;
  console.log(`[auto-close-audit] 有題嘅人 ${s.persons_with_questions}｜題數 ${s.questions_total}（${JSON.stringify(s.questions)}）`);
  console.log(`[auto-close-audit] 按證件為準規則可自動關閉 ${s.closable_total}（${JSON.stringify(s.closable)}）｜其中靠「卡為準修正」${s.closable_via_card_truth}｜靠卡修正但入職表完全唔相似而留人 ${s.blocked_by_form_conflict}｜中文差 1 字而冇硬證據留人 ${s.blocked_by_unproven}`);
  if (outPath) {
    await mkdir(path.dirname(outPath), { recursive: true });
    await writeFile(outPath, JSON.stringify({ version: 1, summary: s, rows: r.rows }, null, 2));
    console.log('[auto-close-audit] 已寫入 --out');
  }
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main(process.argv.slice(2)).then((c) => process.exit(c), (e) => {
    console.error(e instanceof ArgError ? `[auto-close-audit] ${e.message}` : `[auto-close-audit] error ${e instanceof Error ? e.name : typeof e}`);
    process.exit(1);
  });
}
