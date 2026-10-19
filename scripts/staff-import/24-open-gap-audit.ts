// TE-12：production 未答題差距自檢——對老闆匯出嘅未答題清單（只含 person_key、staff_numbers、kind、review_fields，無值）＋ package ＋ 重讀 proposals.json，逐題分類。console 只計數；--out（data/ 下）列 person_key＋題型＋分類＋原因碼。
//   npx tsx scripts/staff-import/24-open-gap-audit.ts --open-questions data/…/open-questions.json --package data/…/import-package.json --proposals data/…/proposals.json --out data/…/open-gap-audit.json
//   npx tsx scripts/staff-import/24-open-gap-audit.ts --dry
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ArgError, resolveReportPath } from './lib/eval-ocr-core';
import { auditOpenGap, summarizeGap, type GapRow, type GapSummary, type OpenQuestion } from './lib/open-gap-audit';
import type { PersonDiag, PkgPerson, RereadProposal } from './lib/triage-reread-core';

export interface Args {
  openQuestions: string | null;
  package: string | null;
  proposals: string | null;
  out: string | null;
  dry: boolean;
}
export function parseArgs(argv: readonly string[]): Args {
  const a: Args = { openQuestions: null, package: null, proposals: null, out: null, dry: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = () => {
      const x = argv[++i];
      if (x === undefined) throw new ArgError(`${k} 缺少參數值`);
      return x;
    };
    if (k === '--open-questions') a.openQuestions = v();
    else if (k === '--package') a.package = v();
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
const dg = (key: string, fields: PersonDiag['fields']): PersonDiag => ({ person_key: key, staff_numbers: [key], fields });
/** 合成 fixture（假名／假 HKID）：每個分類至少一題 */
export function dryData(): { questions: OpenQuestion[]; persons: PkgPerson[]; proposals: RereadProposal[]; diags: PersonDiag[] } {
  const q = (n: string, kind: string, review_fields?: string[]): OpenQuestion => ({ person_key: `srv-${n}`, staff_numbers: [n], kind, ...(review_fields ? { review_fields } : {}) });
  return {
    questions: [
      q('P1', 'name_not_confirmed'), // 卡為準 → 可自動答
      q('P2', 'name_not_confirmed'), // medium → 有建議但唔夠自動答
      q('P3', 'hkid_not_confirmed'), // 只有 nameEn 建議 → 欄唔對
      q('P4', 'name_not_confirmed'), // 冇建議：not_confirmed
      q('P5', 'field_review', ['address', 'phone']), // 冇建議：wrong_source／typed_list_disagrees
      q('P6', 'name_not_confirmed'), // 人冇文件
      q('P7', 'field_review', ['phone']), // 包內搵唔到（unmatched）
      q('P9', 'no_id_card'), // 題型唔處理
      q('P10', 'field_review', ['name_en', 'dob']), // field_review 全有建議 → 可自動答
    ].map((x) => (x.staff_numbers[0] === 'P7' ? { ...x, staff_numbers: ['NOPE7'], person_key: 'srv-nope7' } : x)),
    persons: [pp('P1', { nameZh: lf('測試乙', 'review') }), pp('P2', { nameZh: lf('測試乙', 'review') }), pp('P3', { hkid: lf('Z9000013', 'review') }), pp('P4', { nameZh: lf('測試乙', 'review') }), pp('P5'), pp('P6', { nameZh: lf('測試乙', 'review') }), pp('P10')],
    proposals: [pr('P1', 'nameZh', '測試甲'), pr('P2', 'nameZh', '測試甲', { confidence: 'medium', flags: ['form_conflict'] }), pr('P3', 'nameEn', 'TEST X'), pr('P10', 'nameEn', 'TEST X'), pr('P10', 'dateOfBirth', '1990-01-15')],
    diags: [dg('P4', { nameZh: { status: 'skipped', reason: 'not_confirmed' } }), dg('P5', { address: { status: 'skipped', reason: 'wrong_source' }, phone: { status: 'skipped', reason: 'typed_list_disagrees' } }), dg('P6', { nameZh: { status: 'skipped', reason: 'no_docs' } })],
  };
}

export interface GapResult {
  summary: GapSummary;
  rows: GapRow[];
}
export async function run(args: Args): Promise<GapResult> {
  let d: ReturnType<typeof dryData>;
  if (args.dry) d = dryData();
  else {
    if (!args.openQuestions || !args.package || !args.proposals) throw new ArgError('需要 --open-questions --package --proposals（或者 --dry）');
    const J = async <T>(p: string) => JSON.parse(await readFile(path.resolve(p), 'utf-8')) as T;
    const oq = await J<OpenQuestion[] | { questions: OpenQuestion[] }>(args.openQuestions);
    const pk = await J<{ persons: PkgPerson[] }>(args.package);
    const pf = await J<{ summary?: { persons?: PersonDiag[] }; proposals: RereadProposal[] }>(args.proposals);
    d = { questions: Array.isArray(oq) ? oq : oq.questions, persons: pk.persons, proposals: pf.proposals, diags: pf.summary?.persons ?? [] };
  }
  const rows = auditOpenGap(d.questions, d.persons, d.proposals, d.diags);
  return { summary: summarizeGap(rows), rows };
}

export async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  const outPath = args.out ? resolveReportPath(args.out, process.cwd()) : null;
  if (!args.dry && !outPath) throw new ArgError('需要 --out（必須喺 data/ 之下）');
  const r = await run(args);
  const s = r.summary;
  console.log(`[open-gap-audit] 未答題 ${s.questions_total}｜分類 ${JSON.stringify(s.by_category)}`);
  console.log(`[open-gap-audit] 按題型 ${JSON.stringify(s.by_kind)}｜冇建議原因 ${JSON.stringify(s.no_proposal_reasons)}`);
  if (outPath) {
    await mkdir(path.dirname(outPath), { recursive: true });
    await writeFile(outPath, JSON.stringify({ version: 1, summary: s, rows: r.rows }, null, 2));
    console.log('[open-gap-audit] 已寫入 --out');
  }
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main(process.argv.slice(2)).then((c) => process.exit(c), (e) => {
    console.error(e instanceof ArgError ? `[open-gap-audit] ${e.message}` : `[open-gap-audit] error ${e instanceof Error ? e.name : typeof e}`);
    process.exit(1);
  });
}
