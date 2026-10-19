// TE-8：printed HKID 全庫自檢——對 package 所有人（非身份證頁 OCR 行）跑新舊規則，輸出只有計數＋受影響 personKey／docId（唔印號碼值、姓名）。
//   npx tsx scripts/staff-import/21-printed-audit.ts --package data/2026-10/staff-import/out/import-package.json \
//     --person-fields data/2026-10/staff-fields/person-fields-ext.json --extract data/2026-10/staff-import/out/extract.json \
//     [--ocr-dir data/2026-10/staff-import/ocr] --out data/…/printed-audit.json [--person-key-map map.json]
//   npx tsx scripts/staff-import/21-printed-audit.ts --dry     # 記憶體內合成 fixture，唔讀 data
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ArgError, resolveReportPath } from './lib/eval-ocr-core';
import { hkidCheckDigitValid } from './lib/hkid';
import { auditOne, isAffected, summarizeAudit, type AuditPerson, type AuditRow, type AuditSummary } from './lib/printed-audit';
import { buildStaffNoIndex, docIdsForPerson, type ExtRow, type ExtractRow, type PkgPerson } from './lib/triage-reread-core';
import type { OcrLine, OcrPage } from './lib/ocr';

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

const L = (t: string, x: number, y: number, w = 0.5): OcrLine => ({ t, c: 0.9, x, y, w, h: 0.02 });
/** 合成 fixture：序號巧合 checksum（舊規則中、新規則唔中）、兩行 label 同值、兩個唔同 label 號碼、純序號、一般 label。 */
export function dryPersons(): AuditPerson[] {
  const serial = (() => {
    const c = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'A'].find((d) => hkidCheckDigitValid(`TW102624${d}`))!;
    return `QATW102624${c}`;
  })();
  const pg = (docId: string, lines: OcrLine[]) => ({ docId, page: 1, lines });
  return [
    { key: 'dry-1', pages: [pg('d1', [L(`：${serial}`, 0.4, 0.89), L('身份證號碼：A123456（3）', 0.1, 0.62), L('I.D. Card No: A123456（3）', 0.1, 0.45)])] }, // 老闆個案：新規則揀 label 行
    { key: 'dry-2', pages: [pg('d2', [L(`：${serial}`, 0.4, 0.89)])] }, // 純序號：舊中、新冇
    { key: 'dry-3', pages: [pg('d3a', [L('身份證號碼：A123456（3）', 0.1, 0.5)]), pg('d3b', [L('身份證號碼：Z900001（2）', 0.1, 0.5)])] }, // 多值衝突
    { key: 'dry-4', pages: [pg('d4', [L('身份證號碼：A123456（3）', 0.1, 0.5)])] }, // 兩邊一致
    { key: 'dry-5', pages: [pg('d5', [L('CERTIFICATE', 0.1, 0.9)])] }, // 冇
  ];
}

async function loadLive(args: Args): Promise<AuditPerson[]> {
  for (const k of ['package', 'personFields', 'extract'] as const) if (!args[k]) throw new ArgError('需要 --package --person-fields --extract（或者 --dry）');
  const J = async <T>(p: string) => JSON.parse(await readFile(path.resolve(p), 'utf-8')) as T;
  const pkg = await J<{ persons: PkgPerson[] }>(args.package!);
  const ext = await J<ExtRow[]>(args.personFields!);
  const extract = await J<ExtractRow[]>(args.extract!);
  const extractBy = new Map(extract.map((e) => [e.docId, e]));
  const idx = buildStaffNoIndex(ext);
  const ocrDir = path.resolve(args.ocrDir ?? path.join(path.dirname(path.resolve(args.extract!)), 'ocr'));
  const ocr2Dir = path.join(path.dirname(ocrDir), 'ocr2');
  const linesOf = async (docId: string, page: number): Promise<OcrLine[] | null> => {
    try {
      const rot = extractBy.get(docId)?.rescuedRot ?? null;
      if (rot !== null) {
        const rows = (await readFile(path.join(ocr2Dir, `${docId}.jsonl`), 'utf-8')).split('\n').filter(Boolean).map((l) => JSON.parse(l) as { page: number; rot: number; lines: OcrLine[] });
        return rows.find((r) => r.page === page && r.rot === rot)?.lines ?? null;
      }
      const rows = (await readFile(path.join(ocrDir, `${docId}.jsonl`), 'utf-8')).split('\n').filter(Boolean).map((l) => JSON.parse(l) as OcrPage);
      return rows.find((r) => r.page === page && !r.alt)?.lines ?? null;
    } catch {
      return null;
    }
  };
  const out: AuditPerson[] = [];
  for (const p of pkg.persons) {
    const pages: AuditPerson['pages'] = [];
    for (const docId of docIdsForPerson(p, idx)) {
      for (const pg of extractBy.get(docId)?.pages ?? []) {
        if (pg.kinds.includes('id_card') || pg.kinds.includes('blank')) continue; // 非身份證頁
        const lines = await linesOf(docId, pg.page);
        if (lines) pages.push({ docId, page: pg.page, lines });
      }
    }
    out.push({ key: p.key, pages });
  }
  return out;
}

export interface AuditResult {
  summary: AuditSummary;
  affected: { person_key: string; doc_ids: string[]; reasons: string[] }[];
}
export async function run(args: Args): Promise<AuditResult> {
  const people = args.dry ? dryPersons() : await loadLive(args);
  const rows: AuditRow[] = people.map(auditOne);
  const affected = rows.filter(isAffected).map((r) => ({ person_key: r.key, doc_ids: r.docIds, reasons: [...(r.oldEmbedded ? ['old_embedded'] : []), ...(r.changed ? ['changed'] : []), ...(r.multi ? ['multi_conflict'] : [])] }));
  return { summary: summarizeAudit(rows), affected };
}

export async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  const outPath = args.out ? resolveReportPath(args.out, process.cwd()) : null;
  if (!args.dry && !outPath) throw new ArgError('需要 --out（必須喺 data/ 之下）');
  const r = await run(args);
  const s = r.summary;
  console.log(`[printed-audit] 人數 ${s.persons}｜舊規則有候選 ${s.old_found}｜舊規則候選嵌喺長 token ${s.old_embedded}｜舊規則候選冇 label ${s.old_no_label}`);
  console.log(`[printed-audit] 新規則有候選 ${s.new_found}（來自 label 行 ${s.new_labelled}）｜多值衝突 ${s.multi_conflict}｜新舊選擇唔同 ${s.changed}｜受影響 ${r.affected.length}`);
  if (outPath) {
    await mkdir(path.dirname(outPath), { recursive: true });
    await writeFile(outPath, JSON.stringify({ version: 1, summary: s, affected: r.affected }, null, 2));
    console.log('[printed-audit] 已寫入 --out');
  }
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main(process.argv.slice(2)).then((c) => process.exit(c), (e) => {
    console.error(e instanceof ArgError ? `[printed-audit] ${e.message}` : `[printed-audit] error ${e instanceof Error ? e.name : typeof e}`);
    process.exit(1);
  });
}
