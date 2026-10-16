// TR-1：舊分流題 OCR 重讀——本機腳本（規劃者用真檔 + 真 API 跑；執行員只用 --dry 合成 fixture）。
//   npx tsx scripts/staff-import/19-triage-reread.ts --package data/2026-10/staff-import/out/import-package.json \
//     --person-fields data/2026-10/staff-fields/person-fields-ext.json --extract data/2026-10/staff-import/out/extract.json \
//     --index data/2026-10/staff-import/index.json --out data/2026-10/triage-reread/proposals.json [--docs-dir data/2026-09/staff-docs] [--limit N] [--only-key K] [--concurrency 2]
//   npx tsx scripts/staff-import/19-triage-reread.ts --dry [--out data/…/proposals.json]   # fake client＋記憶體內合成 fixture，唔讀任何 data、唔打 API
// 對每個「有 ≥1 個 review 欄」嘅 person（package 該欄 status=review；nameZh／hkid 亦然）：經工號連去 person-fields-ext 嘅 docIds，
// 由 extract 揀身份證／住址證明／入職表各 1 頁，兩段式＋refs 流程讀，mergeDocFields 得最終欄，再按保守規則出「建議答案」。
// 輸出 --out（必須喺 data/ 之下）＝{version:1, generated_at, summary, proposals[]}；console 淨計數（唔印值、姓名、docId、路徑）。
// 上載 proposals.json 去 /triage 嘅「⋯ → 導入 OCR 重讀建議」（先 dry run 再套用）。
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OcrDocType } from '@/lib/guards/ocr/config';
import { getReadClients } from '@/lib/guards/ocr/clients';
import { ArgError, fakeClientsFor, resolveReportPath, runPool, type EvalCase, type PreparedImages } from './lib/eval-ocr-core';
import { prepareDocumentImages } from './lib/eval-ocr-images';
import {
  addOutcome,
  buildStaffNoIndex,
  docIdsForPerson,
  emptySummary,
  needsReread,
  pickDocPages,
  proposeFromPicks,
  readPerson,
  summaryLines,
  type DocPage,
  type ExtRow,
  type ExtractRow,
  type PkgPerson,
  type RereadDeps,
  type RereadProposal,
  type RereadSummary,
} from './lib/triage-reread-core';

export interface Args {
  package: string | null;
  personFields: string | null;
  extract: string | null;
  index: string | null;
  docsDir: string;
  out: string | null;
  dry: boolean;
  limit: number | null;
  onlyKey: string | null;
  concurrency: number;
}

export function parseArgs(argv: readonly string[]): Args {
  const a: Args = { package: null, personFields: null, extract: null, index: null, docsDir: 'data/2026-09/staff-docs', out: null, dry: false, limit: null, onlyKey: null, concurrency: 2 };
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
    else if (k === '--index') a.index = v();
    else if (k === '--docs-dir') a.docsDir = v();
    else if (k === '--out') a.out = v();
    else if (k === '--dry') a.dry = true;
    else if (k === '--only-key') a.onlyKey = v();
    else if (k === '--limit') {
      const x = v();
      if (!/^\d+$/.test(x) || Number(x) < 1) throw new ArgError('--limit 必須係正整數');
      a.limit = Number(x);
    } else if (k === '--concurrency') a.concurrency = Math.min(8, Math.max(1, Number.parseInt(v(), 10) || 2));
    else throw new ArgError(`唔認得嘅參數 ${k}`);
  }
  return a;
}

/** index.json 嘅 file（相對 docs-dir；單檔或資料夾）＋ OCR 頁碼 → 可交畀 prepareDocumentImages 嘅絕對路徑＋頁。唔支援嘅版面（資料夾內有 PDF 又多於一個檔）→ null。 */
export async function resolveSourcePage(docsDir: string, file: string, page: number): Promise<{ abs: string; page: number } | null> {
  const full = path.resolve(docsDir, file);
  const st = await stat(full).catch(() => null);
  if (!st) return null;
  if (!st.isDirectory()) return { abs: full, page: /\.pdf$/i.test(full) ? page : 1 };
  const inner = (await readdir(full)).filter((f) => /\.(pdf|jpe?g)$/i.test(f)).sort();
  if (inner.length === 1 && /\.pdf$/i.test(inner[0]!)) return { abs: path.join(full, inner[0]!), page };
  if (inner.length > 0 && inner.every((f) => !/\.pdf$/i.test(f))) {
    const f = inner[page - 1];
    return f ? { abs: path.join(full, f), page: 1 } : null;
  }
  return null;
}

// ---------- dry：記憶體內合成 fixture（假名／假 HKID／9000xxxx，無 PII） ----------
const IMG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';
const lf = (value: string | null, status: 'confirmed' | 'review' | 'missing') => ({ value, status });
interface DryPerson {
  p: PkgPerson;
  truth: EvalCase['truth'];
  fake?: EvalCase['fake'];
  docs: boolean;
}
export function dryFixture(): { persons: DryPerson[] } {
  const truth = (n: number): EvalCase['truth'] => ({ name_zh: '測試甲', name_en: 'TEST ALPHA', hkid: 'Z900001(2)', dob: '1990-01-15', sex: 'M', phone: `9000111${n}`, address: '新界火炭示範街99號虛構大廈15樓A室' });
  const base = (n: number, over: Partial<PkgPerson> = {}): PkgPerson => ({
    key: `dry-person-${n}`,
    hkid: lf('Z900001(2)', 'confirmed'),
    nameZh: lf('測試乙', 'review'),
    nameEn: lf('TEST ALPHA', 'review'),
    dateOfBirth: lf('1990-01-15', 'review'),
    phone: lf('90001110', 'review'),
    address: lf('舊地址', 'review'),
    staffNumbers: [{ scheme: 'DRY', number: `DRY${n}` }],
    reasons: [],
    ...over,
  });
  return {
    persons: [
      { p: base(1), truth: truth(1), docs: true }, // 全部欄兩讀一致 → 建議
      { p: base(2, { hkid: lf('Z900001(3)', 'review'), nameZh: lf('測試乙', 'review') }), truth: truth(2), docs: true, fake: { id_card: { a: { hkid: 'Z900001(3)' }, b: { hkid: 'Z900001(3)' } } } }, // check digit 錯 → invalid_format
      { p: base(3, { reasons: ['mismatch_nameZh'] }), truth: truth(3), docs: true }, // 打字名單唔一致 → 姓名唔建議
      { p: base(4), truth: truth(4), docs: false }, // 冇文件
      { p: base(5), truth: truth(5), docs: true, fake: { id_card: { a: { dob: '1990-01-15' }, b: { dob: '1991-02-03' } } } }, // 兩讀唔一致 → 唔建議（仲裁預設讀啱 → arbiter）
      { p: base(6, { nameZh: lf('測試乙', 'confirmed'), nameEn: lf('TEST ALPHA', 'confirmed'), dateOfBirth: lf('1990-01-15', 'confirmed'), phone: lf('90001116', 'confirmed'), address: lf('舊地址', 'confirmed') }), truth: truth(6), docs: true }, // 冇 review 欄 → 唔重讀
    ],
  };
}

function dryExtractRow(docId: string): ExtractRow {
  return { docId, address: { page: 2 }, pages: [{ page: 1, kinds: ['id_card'], primary: 'id_card' }, { page: 2, kinds: ['address_proof'], primary: 'address_proof' }, { page: 3, kinds: ['application_form'], primary: 'application_form' }] };
}

interface Inputs {
  persons: PkgPerson[];
  staffIdx: Map<string, string[]>;
  extractBy: Map<string, ExtractRow>;
  deps: RereadDeps;
}

async function loadInputs(args: Args): Promise<Inputs> {
  if (args.dry) {
    const fx = dryFixture();
    const byDoc = new Map<string, DryPerson>();
    const rows: ExtRow[] = [];
    const extractBy = new Map<string, ExtractRow>();
    for (const d of fx.persons) {
      if (!d.docs) continue;
      const docId = `dry-doc-${d.p.key}`;
      byDoc.set(docId, d);
      rows.push({ key: d.p.staffNumbers[0]!.number, docIds: [docId] });
      extractBy.set(docId, dryExtractRow(docId));
    }
    const deps: RereadDeps = {
      clientsFor: (type: OcrDocType) => {
        // dry：docId 唔經 clientsFor 傳入，所以每個人用 AsyncLocalStorage 太重——改由 prepare 記低「當前人」（concurrency 1 內順序執行）
        const cur = currentDry.get();
        return fakeClientsFor({ id: cur.p.key, docs: [{ type, image: 'x.png' }], truth: cur.truth, ...(cur.fake ? { fake: cur.fake } : {}) }, type);
      },
      prepare: async (d: DocPage): Promise<PreparedImages> => {
        currentDry.set(byDoc.get(d.docId)!);
        return { full: IMG, tiles: [IMG, IMG, IMG, IMG] };
      },
    };
    return { persons: fx.persons.map((d) => d.p), staffIdx: buildStaffNoIndex(rows), extractBy, deps };
  }
  for (const k of ['package', 'personFields', 'extract', 'index'] as const) if (!args[k]) throw new ArgError('需要 --package --person-fields --extract --index（或者 --dry）');
  const J = async <T>(p: string) => JSON.parse(await readFile(path.resolve(p), 'utf-8')) as T;
  const pkg = await J<{ persons: PkgPerson[] }>(args.package!);
  const ext = await J<ExtRow[]>(args.personFields!);
  const extract = await J<ExtractRow[]>(args.extract!);
  const index = await J<{ docId: string; file: string }[]>(args.index!);
  const fileOf = new Map(index.map((m) => [m.docId, m.file]));
  const clients = getReadClients();
  const deps: RereadDeps = {
    clientsFor: () => clients,
    prepare: async (d: DocPage) => {
      const file = fileOf.get(d.docId);
      const src = file ? await resolveSourcePage(args.docsDir, file, d.page) : null;
      if (!src) throw new Error('path_not_resolved');
      return prepareDocumentImages(src.abs, src.page);
    },
  };
  return { persons: pkg.persons, staffIdx: buildStaffNoIndex(ext), extractBy: new Map(extract.map((e) => [e.docId, e])), deps };
}

// dry 專用：記低「當前人」（dry 強制 concurrency 1，順序執行）
const currentDry = (() => {
  let cur: DryPerson | null = null;
  return { get: () => cur!, set: (d: DryPerson) => { cur = d; } };
})();

export interface RunResult {
  proposals: RereadProposal[];
  summary: RereadSummary;
}

export async function run(args: Args, now: Date = new Date()): Promise<RunResult> {
  const inp = await loadInputs(args);
  const summary = emptySummary(now);
  summary.persons_in_package = inp.persons.length;
  let todo = inp.persons.filter(needsReread);
  summary.persons_needing_reread = todo.length;
  if (args.onlyKey) todo = todo.filter((p) => p.key === args.onlyKey);
  if (args.limit) todo = todo.slice(0, args.limit);
  const proposals: RereadProposal[] = [];
  const concurrency = args.dry ? 1 : args.concurrency;
  await runPool(todo, concurrency, async (p, i) => {
    const docs = pickDocPages(docIdsForPerson(p, inp.staffIdx), inp.extractBy);
    if (docs.length === 0) {
      summary.persons_no_docs += 1;
      return;
    }
    let ok = false;
    for (let attempt = 0; attempt < 2 && !ok; attempt++) {
      try {
        const r = await readPerson(docs, { ...inp.deps, ...(args.dry ? { now: now } : {}) });
        const o = proposeFromPicks(p, r.picks, now);
        proposals.push(...o.proposals);
        addOutcome(summary, o);
        summary.ocr_calls += r.calls;
        summary.persons_processed += 1;
        ok = true;
      } catch {
        /* 重試 1 次；錯誤內容唔印（可能帶路徑） */
      }
    }
    if (!ok) summary.persons_failed += 1;
    console.log(`[triage-reread] ${i + 1}/${todo.length} ${ok ? 'ok' : 'failed'}`);
  });
  return { proposals, summary };
}

export async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  if (!args.dry) await import('dotenv/config'); // 真跑先載入 .env（key）；--dry 唔掂
  const outPath = args.out ? resolveReportPath(args.out, process.cwd()) : null;
  if (!args.dry && !outPath) throw new ArgError('需要 --out（必須喺 data/ 之下）');
  console.log(`[triage-reread] ${args.dry ? 'dry（fake client＋合成 fixture）' : 'live（真 client）'}｜concurrency ${args.dry ? 1 : args.concurrency}`);
  const { proposals, summary } = await run(args);
  for (const l of summaryLines(summary)) console.log(`[triage-reread] ${l}`);
  if (outPath) {
    await mkdir(path.dirname(outPath), { recursive: true });
    await writeFile(outPath, JSON.stringify({ version: 1, generated_at: summary.generated_at, summary, proposals }, null, 2));
    console.log('[triage-reread] 已寫入 --out');
  }
  return summary.persons_failed > 0 ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main(process.argv.slice(2)).then((c) => process.exit(c), (e) => {
    console.error(e instanceof ArgError ? `[triage-reread] ${e.message}` : `[triage-reread] error ${e instanceof Error ? e.name : typeof e}`);
    process.exit(1);
  });
}
