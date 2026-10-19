// TR-1：舊分流題 OCR 重讀——本機腳本（規劃者用真檔 + 真 API 跑；執行員只用 --dry 合成 fixture）。
//   npx tsx scripts/staff-import/19-triage-reread.ts --package data/2026-10/staff-import/out/import-package.json \
//     --person-fields data/2026-10/staff-fields/person-fields-ext.json --extract data/2026-10/staff-import/out/extract.json \
//     --index data/2026-10/staff-import/index.json --out data/2026-10/triage-reread/proposals.json [--docs-dir data/2026-09/staff-docs] [--limit N] [--only-key K] [--concurrency 2]
//     [--cache data/2026-10/triage-reread/cache/] [--no-cache]   # TR-2：每 docId＋doc type＋page 嘅讀數存 JSON（gitignored），再跑命中就唔打 API；--no-cache 強制重讀（並覆寫快取）
//   npx tsx scripts/staff-import/19-triage-reread.ts --dry [--out data/…/proposals.json]   # fake client＋記憶體內合成 fixture，唔讀任何 data、唔打 API
// 對每個「有 ≥1 個 review 欄」嘅 person（package 該欄 status=review；nameZh／hkid 亦然）：經工號連去 person-fields-ext 嘅 docIds，
// 由 extract 揀身份證／住址證明／入職表各 1 頁，兩段式＋refs 流程讀，mergeDocFields 得最終欄，再按保守規則出「建議答案」。
// 輸出 --out（必須喺 data/ 之下）＝{version:1, generated_at, summary, proposals[]}；console 淨計數（唔印值、姓名、docId、路徑）。
// 上載 proposals.json 去 /triage 嘅「⋯ → 導入 OCR 重讀建議」（先 dry run 再套用）。
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OcrDocType } from '@/lib/guards/ocr/config';
import { getReadClients } from '@/lib/guards/ocr/clients';
import type { DocumentReadResult } from '@/lib/guards/ocr/read';
import { ArgError, fakeClientsFor, resolveReportPath, runPool, type EvalCase, type PreparedImages } from './lib/eval-ocr-core';
import { prepareDocumentImages } from './lib/eval-ocr-images';
import { applyCorroboration, applyFormGrade, gradeFormAgreement, cardKeyHash, cardNamesConflict, cropCardToPng, markCardNameConflict, printedOnlyProposal, scanForCard, type CardDeps, type CardPageRef, type CardScan } from './lib/card-reread';
import { canonicalHkid, hkidCheckDigitValid } from './lib/hkid';
import { normalizeField } from '@/lib/guards/ocr/normalize';
import { normZh } from '@/lib/guards/import/text';
import { rotateLines } from './lib/triage-evidence-core';
import type { OcrLine, OcrPage } from './lib/ocr';
import {
  addOutcome,
  applyTypedListEvidence,
  diagnosePerson,
  buildStaffNoIndex,
  docIdsForPerson,
  emptySummary,
  OCR_PIPELINE_VERSION,
  needsReread,
  pickDocPages,
  proposeFromPicks,
  readPerson,
  summaryLines,
  type DocCache,
  type DocPage,
  type ExtRow,
  type ExtractRow,
  type PkgPerson,
  type RereadDeps,
  type RereadProposal,
  type RereadSummary,
} from './lib/triage-reread-core';

const sh = promisify(execFile);
const MAGICK = process.env.MAGICK_BIN ?? (existsSync('/opt/homebrew/bin/magick') ? '/opt/homebrew/bin/magick' : 'magick');
const PDFTOPPM = process.env.PDFTOPPM_BIN ?? (existsSync('/opt/homebrew/bin/pdftoppm') ? '/opt/homebrew/bin/pdftoppm' : 'pdftoppm');

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
  /** TR-2：讀數快取目錄（必須喺 data/ 之下） */
  cache: string | null;
  noCache: boolean;
  /** TE-4：只處理 hkid missing 嘅人 */
  onlyMissingHkid: boolean;
  /** TE-4：唔做嵌入身份證副本偵測 */
  noEmbedded: boolean;
  /** TE-4：導入 OCR 行目錄（預設 extract 同層 ocr／ocr2） */
  ocrDir: string | null;
  /** TE-11.2：導入 crosscheck.json（可選）——入職表冇姓名可比時，用打字名單（U Team／Maxwell／DB 按工號或電話對到）佐證卡上姓名 */
  crosscheck: string | null;
  /** TE-4：vision-ocr 執行檔（二階段局部 OCR；預設由 vision-ocr.swift 編譯） */
  visionBin: string | null;
}

export function parseArgs(argv: readonly string[]): Args {
  const a: Args = { package: null, personFields: null, extract: null, index: null, docsDir: 'data/2026-09/staff-docs', out: null, dry: false, limit: null, onlyKey: null, concurrency: 2, cache: null, noCache: false, onlyMissingHkid: false, noEmbedded: false, ocrDir: null, crosscheck: null, visionBin: null };
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
    else if (k === '--cache') a.cache = v();
    else if (k === '--no-cache') a.noCache = true;
    else if (k === '--only-missing-hkid') a.onlyMissingHkid = true;
    else if (k === '--no-embedded') a.noEmbedded = true;
    else if (k === '--ocr-dir') a.ocrDir = v();
    else if (k === '--crosscheck') a.crosscheck = v();
    else if (k === '--vision-bin') a.visionBin = v();
    else if (k === '--limit') {
      const x = v();
      if (!/^\d+$/.test(x) || Number(x) < 1) throw new ArgError('--limit 必須係正整數');
      a.limit = Number(x);
    } else if (k === '--concurrency') a.concurrency = Math.min(8, Math.max(1, Number.parseInt(v(), 10) || 2));
    else throw new ArgError(`唔認得嘅參數 ${k}`);
  }
  return a;
}

/** TR-2：檔案快取。key＝type＋docId＋page（淨字元）；寫入先落 tmp 再 rename；讀到壞檔當 miss。 */
export function fileDocCache(dir: string, noCache: boolean): DocCache {
  const fileOf = (d: DocPage) => path.join(dir, `${d.type}__${d.docId.replace(/[^A-Za-z0-9_-]/g, '_')}__p${d.page}${d.embedded ? `__emb${cardKeyHash(d.embedded)}` : ''}.json`);
  return {
    async get(d, refsHash) {
      if (noCache) return null;
      try {
        const j = JSON.parse(await readFile(fileOf(d), 'utf-8')) as { version?: string; docId?: string; refsHash?: string; result?: DocumentReadResult };
        return j.version === OCR_PIPELINE_VERSION && j.docId === d.docId && j.refsHash === refsHash && j.result && j.result.type === d.type ? j.result : null;
      } catch {
        return null;
      }
    },
    async set(d, r, refsHash) {
      await mkdir(dir, { recursive: true });
      const f = fileOf(d);
      const tmp = `${f}.tmp`;
      await writeFile(tmp, JSON.stringify({ version: OCR_PIPELINE_VERSION, docId: d.docId, refsHash, result: r }));
      await rename(tmp, f);
    },
  };
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
  /** TE-11.2：打字名單（按工號／電話）佐證呢個人卡上姓名 */
  listMatch?: boolean;
  /** TE-11.3：導入抽取嘅入職表英文名（aux.formNameEn） */
  formEn?: string;
  /** TE-4：呢個人有幾頁（page 由 1 起）；lines＝第一階段整頁 OCR 讀到嘅行；hidden＝只有二階段局部 OCR 先讀到嘅行；kinds＝導入分類 */
  pages?: { lines: OcrLine[]; hidden?: OcrLine[]; kinds: string[] }[];
}
const DRY_HKID = 'Z900001(2)';
const dl = (t: string, x: number, y: number, w: number, h = 0.025): OcrLine => ({ t, c: 0.95, x, y, w, h });
/** 牌照頁右下角貼住一張身份證副本（倒轉 180°：整頁行座標轉 180°）；hidden＝200dpi 整頁 OCR 讀唔到（只二階段先讀到） */
function dryPermitPage(opts: { inverted?: boolean; hidden?: boolean }): { lines: OcrLine[]; hidden?: OcrLine[]; kinds: string[] } {
  const head = [dl('保安人員許可證 SECURITY PERSONNEL PERMIT', 0.08, 0.92, 0.6), dl('許可證編號 PERMIT NO. S-123456-7', 0.08, 0.85, 0.4)];
  const card = [
    dl('TESTER, Alpha', 0.53, 0.215, 0.14, 0.012),
    dl('測試甲', 0.53, 0.2, 0.06, 0.012),
    dl('出生日期 Date of Birth', 0.53, 0.185, 0.16, 0.012),
    dl('15-01-1990', 0.55, 0.17, 0.1, 0.012),
    dl('簽發日期 Date of Issue', 0.53, 0.15, 0.15, 0.012),
    dl(DRY_HKID, 0.72, 0.12, 0.08, 0.016),
  ];
  const inv = (ls: OcrLine[]) => (opts.inverted ? rotateLines(ls, 180) : ls);
  return opts.hidden ? { lines: inv(head), hidden: inv(card), kinds: ['sia_permit'] } : { lines: inv([...head, ...card]), kinds: ['sia_permit'] };
}
const dryCertPage = (hkid: string): { lines: OcrLine[]; kinds: string[] } => ({ lines: [dl('QASRS 證書 CERTIFICATE', 0.1, 0.9, 0.4), dl('姓名 NAME TESTER ALPHA', 0.1, 0.8, 0.4), dl(hkid, 0.4, 0.6, 0.12, 0.02)], kinds: ['other'] });
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
  const dryCard = (n: number): PkgPerson => ({
    key: `dry-person-${n}`,
    hkid: lf(null, 'missing'),
    nameZh: lf(null, 'missing'),
    nameEn: lf(null, 'missing'),
    dateOfBirth: lf(null, 'missing'),
    phone: lf('90001110', 'confirmed'),
    address: lf('舊地址', 'confirmed'),
    staffNumbers: [{ scheme: 'DRY', number: `DRY${n}` }],
    reasons: [],
  });
  return {
    persons: [
      { p: base(1), truth: truth(1), docs: true }, // 全部欄兩讀一致 → 建議
      { p: base(2, { hkid: lf('Z900001(3)', 'review'), nameZh: lf('測試乙', 'review') }), truth: truth(2), docs: true, fake: { id_card: { a: { hkid: 'Z900001(3)' }, b: { hkid: 'Z900001(3)' } } } }, // check digit 錯 → invalid_format
      { p: base(3, { reasons: ['mismatch_nameZh'] }), truth: truth(3), docs: true, listMatch: true }, // 打字名單唔一致 → 姓名唔建議
      { p: base(4), truth: truth(4), docs: false }, // 冇文件
      { p: base(5), truth: truth(5), docs: true, fake: { id_card: { a: { dob: '1990-01-15' }, b: { dob: '1991-02-03' } } } }, // 兩讀唔一致 → 唔建議（仲裁預設讀啱 → arbiter）
      // TE-4：嵌入身份證副本（倒轉）＋印刷佐證
      { p: dryCard(7), truth: truth(7), docs: true, pages: [dryPermitPage({ inverted: true }), dryCertPage(DRY_HKID)] }, // 卡（第一階段）＋印刷一致 → high
      { p: dryCard(8), truth: truth(8), docs: true, pages: [dryPermitPage({ inverted: true, hidden: true })] }, // 卡只有二階段先讀到、冇印刷 → medium（自動答）
      { p: dryCard(9), truth: truth(9), docs: true, pages: [dryPermitPage({ inverted: true }), dryCertPage('A123456(3)')] }, // 印刷同卡唔一致 → low＋printed_card_conflict
      { p: { ...dryCard(11), nameZh: lf('完全不同嘅人', 'review') }, truth: truth(11), docs: true, pages: [dryPermitPage({ inverted: true })] }, // TE-4.1：卡姓名同包內姓名唔一致 → 全 low＋card_name_conflict
      { p: dryCard(10), truth: truth(10), docs: true, pages: [dryCertPage(DRY_HKID)] }, // 冇卡，只有印刷 → low（review）
      // TE-11.2：整頁身份證 vs 入職表分級
      { p: base(12), truth: truth(12), docs: true, fake: { onboarding_form: { a: { name_zh: '測試甲乙' }, b: { name_zh: '測試甲乙' } } } }, // 輕微差異 → high＋form_differs
      { p: base(13), truth: truth(13), docs: true, fake: { onboarding_form: { a: { name_zh: '完全唔同' }, b: { name_zh: '完全唔同' } } } }, // 完全唔相似（疑錯人卡）→ medium＋form_conflict
      { p: base(14), truth: truth(14), docs: true, fake: { onboarding_form: { a: { dob: '1991-02-03' }, b: { dob: '1991-02-03' } } } }, // 入職表出生日期唔同 → medium＋form_conflict
      { p: base(15), truth: truth(15), docs: true, fake: { onboarding_form: { a: { name_zh: null }, b: { name_zh: null } } } }, // 入職表冇名、冇名單佐證 → medium＋card_unverified
      { p: base(17), truth: truth(17), docs: true, fake: { onboarding_form: { a: { name_zh: '測試甲乙', hkid: null }, b: { name_zh: '測試甲乙', hkid: null } } } }, // 只得中文可比、差字而冇硬證據（form 冇 hkid）→ medium＋form_differs
      { p: base(18), truth: truth(18), docs: true, formEn: 'DIFFERENT PERSON', fake: { onboarding_form: { a: { name_zh: '測試乙' }, b: { name_zh: '測試乙' } } } }, // 兄弟姊妹：中文差 1 字、英文唔同 → conflict
      { p: base(19, { reasons: ['mismatch_nameZh'] }), truth: truth(19), docs: true, fake: { onboarding_form: { a: { hkid: null }, b: { hkid: null } } } }, // TE-12：打字名單唔一致、入職表冇 hkid（冇硬證據）→ 照出建議但降 medium＋typed_list_differs
      { p: base(20, { reasons: ['mismatch_nameZh'] }), truth: truth(20), docs: true }, // TE-12.1：整包配錯人——卡＋入職表 hkid 互相一致，但冇名單佐證 → medium 留人
      { p: base(16), truth: truth(16), docs: true, listMatch: true, fake: { onboarding_form: { a: { name_zh: null }, b: { name_zh: null } } } }, // 入職表冇名、名單一致 → high
      { p: base(6, { nameZh: lf('測試乙', 'confirmed'), nameEn: lf('TEST ALPHA', 'confirmed'), dateOfBirth: lf('1990-01-15', 'confirmed'), phone: lf('90001116', 'confirmed'), address: lf('舊地址', 'confirmed') }), truth: truth(6), docs: true }, // 冇 review 欄 → 唔重讀
    ],
  };
}

function dryExtractRow(docId: string, d?: DryPerson): ExtractRow {
  if (d?.formEn) return { docId, aux: { formNameEn: { value: d.formEn } }, address: { page: 2 }, pages: [{ page: 1, kinds: ['id_card'], primary: 'id_card' }, { page: 2, kinds: ['address_proof'], primary: 'address_proof' }, { page: 3, kinds: ['application_form'], primary: 'application_form' }] };
  if (d?.pages) return { docId, pages: d.pages.map((pg, i) => ({ page: i + 1, kinds: pg.kinds, primary: pg.kinds[0] })) };
  return { docId, address: { page: 2 }, pages: [{ page: 1, kinds: ['id_card'], primary: 'id_card' }, { page: 2, kinds: ['address_proof'], primary: 'address_proof' }, { page: 3, kinds: ['application_form'], primary: 'application_form' }] };
}

interface Inputs {
  persons: PkgPerson[];
  staffIdx: Map<string, string[]>;
  extractBy: Map<string, ExtractRow>;
  deps: RereadDeps;
  /** TE-4：嵌入身份證副本掃描（冇＝唔做） */
  card?: { scan(pages: readonly CardPageRef[]): Promise<CardScan> };
  /** TE-11.2：打字名單（按工號／電話對到）嘅姓名同卡上中文名一致（冇＝唔知＝false） */
  listAgree?: (docIds: readonly string[], cardNameZh: string | null) => boolean;
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
      extractBy.set(docId, dryExtractRow(docId, d));
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
    const pageOf = (ref: CardPageRef) => byDoc.get(ref.docId)?.pages?.[ref.page - 1];
    const cardDeps: CardDeps = {
      lines: async (ref) => pageOf(ref)?.lines ?? null,
      secondStage: async (ref) => {
        const pg = pageOf(ref);
        return pg ? { lines: [...pg.lines, ...(pg.hidden ?? [])], aspect: 210 / 297 } : null;
      },
    };
    const listAgree = (docIds: readonly string[]) => docIds.some((id) => !!byDoc.get(id)?.listMatch);
    return { persons: fx.persons.map((d) => d.p), staffIdx: buildStaffNoIndex(rows), extractBy, deps, listAgree, ...(args.noEmbedded ? {} : { card: { scan: (pages: readonly CardPageRef[]) => scanForCard(pages, cardDeps) } }) };
  }
  for (const k of ['package', 'personFields', 'extract', 'index'] as const) if (!args[k]) throw new ArgError('需要 --package --person-fields --extract --index（或者 --dry）');
  const J = async <T>(p: string) => JSON.parse(await readFile(path.resolve(p), 'utf-8')) as T;
  const pkg = await J<{ persons: PkgPerson[] }>(args.package!);
  const ext = await J<ExtRow[]>(args.personFields!);
  const extract = await J<ExtractRow[]>(args.extract!);
  const index = await J<{ docId: string; file: string }[]>(args.index!);
  const fileOf = new Map(index.map((m) => [m.docId, m.file]));
  const clients = getReadClients();
  const extractBy = new Map(extract.map((e) => [e.docId, e]));
  const rotOf = (docId: string) => extractBy.get(docId)?.rescuedRot ?? null;
  /** 渲染一頁（300dpi PNG，旋轉救援頁同 OCR 座標一致）→ 暫存路徑；caller 用完刪 */
  const renderPage = async (docId: string, page: number): Promise<string | null> => {
    const file = fileOf.get(docId);
    const src = file ? await resolveSourcePage(args.docsDir, file, page).catch(() => null) : null;
    if (!src) return null;
    const out = path.join(os.tmpdir(), `te4-page-${process.pid}-${Math.random().toString(36).slice(2)}.png`);
    try {
      if (/\.pdf$/i.test(src.abs)) await sh(PDFTOPPM, ['-r', '300', '-png', '-f', String(src.page), '-l', String(src.page), '-singlefile', src.abs, out.replace(/\.png$/, '')]);
      else await sh(MAGICK, [src.abs, '-auto-orient', out]);
      const rot = rotOf(docId);
      if (rot) await sh(MAGICK, [out, '-rotate', String(rot), out]);
      return out;
    } catch {
      await rm(out, { force: true });
      return null;
    }
  };
  const deps: RereadDeps = {
    clientsFor: () => clients,
    prepare: async (d: DocPage) => {
      if (d.embedded) {
        // TE-4：渲染該頁 → 卡區轉正裁出獨立卡圖（≤1600px）→ 同整頁身份證一樣交 two-stage 管線；暫存檔即刪
        const page = await renderPage(d.docId, d.page);
        if (!page) throw new Error('path_not_resolved');
        const card = path.join(os.tmpdir(), `te4-card-${process.pid}-${Math.random().toString(36).slice(2)}.png`);
        try {
          await cropCardToPng(page, d.embedded.rot, d.embedded.box, card);
          return await prepareDocumentImages(card, 1);
        } finally {
          await rm(page, { force: true });
          await rm(card, { force: true });
        }
      }
      const file = fileOf.get(d.docId);
      const src = file ? await resolveSourcePage(args.docsDir, file, d.page) : null;
      if (!src) throw new Error('path_not_resolved');
      return prepareDocumentImages(src.abs, src.page);
    },
  };
  let card: Inputs['card'];
  if (!args.noEmbedded) {
    const ocrDir = path.resolve(args.ocrDir ?? path.join(path.dirname(path.resolve(args.extract!)), 'ocr'));
    const ocr2Dir = path.join(path.dirname(ocrDir), 'ocr2');
    const linesCache = new Map<string, OcrLine[] | null>();
    const lines = async (ref: CardPageRef): Promise<OcrLine[] | null> => {
      const k = `${ref.docId}|${ref.page}`;
      if (linesCache.has(k)) return linesCache.get(k)!;
      let out: OcrLine[] | null = null;
      try {
        const rot = rotOf(ref.docId);
        if (rot !== null) {
          const rows = (await readFile(path.join(ocr2Dir, `${ref.docId}.jsonl`), 'utf-8')).split('\n').filter(Boolean).map((l) => JSON.parse(l) as { page: number; rot: number; lines: OcrLine[] });
          out = rows.find((r) => r.page === ref.page && r.rot === rot)?.lines ?? null;
        } else {
          const rows = (await readFile(path.join(ocrDir, `${ref.docId}.jsonl`), 'utf-8')).split('\n').filter(Boolean).map((l) => JSON.parse(l) as OcrPage);
          out = rows.find((r) => r.page === ref.page && !r.alt)?.lines ?? rows.find((r) => r.page === ref.page)?.lines ?? null;
        }
      } catch {
        out = null;
      }
      linesCache.set(k, out);
      return out;
    };
    // 二階段局部 OCR 要 Apple Vision（本機 swiftc 編譯）；冇＝只做第一階段
    const te = await import('./20-triage-evidence');
    const visionBin = await te.resolveVisionBin(args.visionBin);
    const vision = visionBin ? te.makeVisionRunner(visionBin) : undefined;
    const cardDeps: CardDeps = {
      lines,
      ...(vision
        ? {
            secondStage: async (ref: CardPageRef) => {
              const tmp = await mkdtemp(path.join(os.tmpdir(), 'te4-s2-'));
              try {
                return await te.secondStageLines({ type: 'id_card', docId: ref.docId, page: ref.page }, { vision, render: (d: DocPage) => renderPage(d.docId, d.page), cleanup: (f: string) => rm(f, { force: true }) } as unknown as Parameters<typeof te.secondStageLines>[1], tmp);
              } finally {
                await rm(tmp, { recursive: true, force: true });
              }
            },
          }
        : {}),
    };
    card = { scan: (pages) => scanForCard(pages, cardDeps) };
  }
  // TE-11.2：打字名單佐證（--crosscheck）：該文件喺 crosscheck 嘅 nameZh 同任何名單 match，而且導入抽取嘅中文名＝今次卡讀數
  let listAgree: Inputs['listAgree'];
  if (args.crosscheck) {
    const cc = await J<{ docId: string; cmp?: { nameZh?: Record<string, string> } }[]>(args.crosscheck);
    const ccBy = new Map(cc.map((c) => [c.docId, c]));
    listAgree = (docIds, cardZh) =>
      !!cardZh && docIds.some((d) => ['utem', 'maxwell', 'db'].some((s) => ccBy.get(d)?.cmp?.nameZh?.[s] === 'match') && normZh(extractBy.get(d)?.nameZh?.value ?? null) === normZh(cardZh));
  }
  return { persons: pkg.persons, staffIdx: buildStaffNoIndex(ext), extractBy, deps, ...(card ? { card } : {}), ...(listAgree ? { listAgree } : {}) };
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

/** TE-4：身份證欄（hkid／姓名／出生日期）仲未確認——可能要靠夾喺其他頁嘅嵌入身份證副本。 */
export const needsCard = (p: PkgPerson): boolean => p.hkid.status !== 'confirmed' || p.nameZh.status !== 'confirmed' || p.dateOfBirth.status !== 'confirmed';
const isHkidMissing = (p: PkgPerson): boolean => p.hkid.status === 'missing' || !p.hkid.value?.trim();

export async function run(args: Args, now: Date = new Date(), cacheOverride?: DocCache): Promise<RunResult> {
  const inp = await loadInputs(args);
  const summary = emptySummary(now);
  summary.persons_in_package = inp.persons.length;
  let todo = inp.persons.filter((p) => needsReread(p) || (!!inp.card && needsCard(p)));
  summary.persons_needing_reread = todo.length;
  if (args.onlyKey) todo = todo.filter((p) => p.key === args.onlyKey);
  if (args.onlyMissingHkid) todo = todo.filter(isHkidMissing);
  if (args.limit) todo = todo.slice(0, args.limit);
  const proposals: RereadProposal[] = [];
  const cacheDir = args.cache ? resolveReportPath(args.cache, process.cwd()) : null;
  const cache = cacheDir ? fileDocCache(cacheDir, args.noCache) : (cacheOverride ?? null);
  const concurrency = args.dry ? 1 : args.concurrency;
  await runPool(todo, concurrency, async (p, i) => {
    const docIds = docIdsForPerson(p, inp.staffIdx);
    let docs = pickDocPages(docIds, inp.extractBy);
    // TE-4：冇整頁身份證副本、身份證欄未確認 → 掃所有頁搵嵌入身份證副本（同埋印刷身份證號）
    let scan: CardScan | null = null;
    if (inp.card && !docs.some((d) => d.type === 'id_card') && needsCard(p)) {
      const pages: CardPageRef[] = docIds.flatMap((docId) => (inp.extractBy.get(docId)?.pages ?? []).filter((pg) => !pg.kinds.includes('application_form') && !pg.kinds.includes('blank')).map((pg) => ({ docId, page: pg.page })));
      try {
        scan = await inp.card.scan(pages);
      } catch {
        scan = null; // 掃描失敗當冇卡（錯誤內容唔印）
      }
      if (scan?.card) {
        summary.embedded_cards_found += 1;
        if (scan.card.stage === 'second') summary.embedded_second_stage_found += 1;
        const c = scan.card;
        docs = [{ type: 'id_card', docId: c.docId, page: c.page, embedded: { rot: c.rot, box: c.box, stage: c.stage } }, ...docs];
      }
      summary.second_stage_pages += scan?.secondStagePages ?? 0;
    }
    // 印刷身份證號佐證：掃描所得＋導入抽取已有嘅 printedHkid／permitHkid（TE-3 下次導入先有）
    const printed = [...(scan?.printed ?? [])];
    const printedFixed = [...(scan?.printedFixed ?? [])]; // TE-4.1 S1：經混淆修正先得嘅值只可令狀態變唔一致，唔可升 high
    for (const docId of docIds) {
      const aux = inp.extractBy.get(docId)?.aux;
      for (const f of [aux?.printedHkid, aux?.permitHkid]) {
        const c = canonicalHkid(f?.value ?? null);
        if (!c || !hkidCheckDigitValid(c)) continue;
        const bucket = (f as { note?: string }).note === 'ocr_confusion_fixed' ? printedFixed : printed;
        if (!bucket.includes(c)) bucket.push(c);
      }
    }
    const match = { hkid: p.hkid.value?.trim() || null, staff_numbers: p.staffNumbers.map((n) => n.number) };
    const printedOnly = (): RereadProposal | null => (isHkidMissing(p) ? printedOnlyProposal(p.key, printed, match) : null);
    if (docs.length === 0) {
      const po = printedOnly();
      if (po) {
        proposals.push(po);
        summary.persons_with_proposals += 1;
        summary.proposals_total += 1;
        summary.proposals_by_field.hkid = (summary.proposals_by_field.hkid ?? 0) + 1;
        summary.proposals_low_confidence += 1;
        summary.printed_only_review += 1;
      } else summary.persons_no_docs += 1;
      summary.persons.push(po ? diagnosePerson(p, { proposals: [po], skipped: {}, skippedByField: {}, skipDetail: {} }) : diagnosePerson(p, null, 'no_docs'));
      return;
    }
    let ok = false;
    for (let attempt = 0; attempt < 2 && !ok; attempt++) {
      try {
        const r = await readPerson(docs, { ...inp.deps, ...(args.dry ? { now: now } : {}), ...(cache ? { cache } : {}) });
        const hasCard = docs.some((d) => d.embedded);
        const o = proposeFromPicks(p, r.picks, now, { embedded: hasCard });
        if (hasCard) {
          // 卡讀數＋印刷佐證：一致 → high；唔一致 → low＋printed_card_conflict（留人手）；冇印刷 → 照自動答
          const cardFields = new Set(['hkid', 'nameZh', 'nameEn', 'dateOfBirth']);
          const cardProps = o.proposals.filter((x) => cardFields.has(x.field) && x.doc === 'id_card');
          const rest = o.proposals.filter((x) => !cardProps.includes(x));
          const c = applyCorroboration(cardProps, printed, printedFixed);
          if (c.state === 'corroborated') summary.card_printed_corroborated += 1;
          if (c.state === 'conflict') summary.card_printed_conflict += 1;
          let cardOut = c.proposals;
          // TE-4.1 M1：整人一致性——卡讀到嘅姓名同包內任何已有姓名比對（就算冇出建議）；卡欄喺入職表 cross／打字名單檢查唔一致；包內完全冇姓名先唔受姓名比對影響
          const cardRead = (k: 'name_zh' | 'name_en') => (r.picks[k]?.doc === 'id_card' ? r.picks[k]!.result.value : null);
          const crossBad = false; // TE-11.2：入職表差異改由 gradeFormAgreement 分級（輕微差異唔降級），唔再一律當錯人卡
          const typedBad = false; // TE-12：打字名單唔一致改為資訊旗標 typed_list_differs（硬證據才 high），唔再一律當錯人卡
          const dobCard = r.picks.dob?.doc === 'id_card' ? normalizeField('dob', r.picks.dob.result.value, now).canon : null;
          const dobPkg = p.dateOfBirth.status === 'confirmed' && p.dateOfBirth.value ? normalizeField('dob', p.dateOfBirth.value, now).canon : null;
          const nameBad = cardNamesConflict({ nameZh: p.nameZh.value, nameEn: p.nameEn.value, dobConfirmed: dobPkg }, { nameZh: cardRead('name_zh'), nameEn: cardRead('name_en'), dob: dobCard });
          if ((crossBad || typedBad || nameBad) && cardOut.length > 0) {
            cardOut = markCardNameConflict(cardOut);
            summary.card_name_conflict += 1;
          }
          o.proposals = [...cardOut, ...rest];
        } else if (!o.proposals.some((x) => x.field === 'hkid')) {
          const po = printedOnly();
          if (po) {
            o.proposals.push(po);
            summary.printed_only_review += 1;
          }
        }
        // TE-11.2：錯人卡防線——整頁身份證／嵌入卡兩條路徑都按入職表差異分級（minor→form_differs；conflict→medium＋form_conflict；入職表冇名要打字名單佐證）
        if (o.proposals.some((x) => x.doc === 'id_card' && x.confidence === 'high')) {
          const cardOf = (k: 'name_zh' | 'name_en') => (r.picks[k]?.doc === 'id_card' ? r.picks[k]!.result.value : null);
          const dobCanon = (x: string | null | undefined) => (x ? normalizeField('dob', x, now).canon : null);
          const auxEn = docIds.map((d) => inp.extractBy.get(d)?.aux?.formNameEn?.value).find(Boolean) ?? null;
          const listOk = !!inp.listAgree?.(docIds, cardOf('name_zh'));
          // 硬證據：入職表手寫 hkid（checksum 過）＝卡 hkid；印刷佐證一致；打字名單按工號／電話對到而名單姓名＝卡姓名
          const cardHk = canonicalHkid(r.picks.hkid?.doc === 'id_card' ? r.picks.hkid.result.value : null);
          const formHk = canonicalHkid(r.formReads.hkid ?? docIds.map((d) => inp.extractBy.get(d)?.aux?.formHkid?.value).find(Boolean) ?? null);
          const hard = (!!cardHk && !!formHk && cardHk === formHk && hkidCheckDigitValid(formHk)) || o.proposals.some((x) => x.flags?.includes('printed_corroborated')) || listOk;
          const grade = gradeFormAgreement(
            { nameZh: cardOf('name_zh'), nameEn: cardOf('name_en'), dob: r.picks.dob?.doc === 'id_card' ? dobCanon(r.picks.dob.result.value) : null },
            { nameZh: r.formReads.name_zh ?? null, nameEn: auxEn, dob: dobCanon(r.formReads.dob) },
            hard,
          );
          o.proposals = applyTypedListEvidence(applyFormGrade(o.proposals, grade, listOk), listOk) // TE-12.1：typed_list_differs 只認獨立於文件包嘅名單佐證（listOk）;
          if (grade === 'conflict') summary.form_conflict += 1;
          else if (o.proposals.some((x) => x.flags?.includes('card_unverified'))) summary.card_unverified += 1;
          else if (grade === 'minor_unproven') summary.form_unproven += 1;
          else if (grade === 'minor') summary.form_differs += 1;
        }
        summary.proposals_low_confidence += o.proposals.filter((x) => x.confidence === 'low').length;
        for (const x of o.proposals) if (x.flags?.includes('typed_list_differs')) {
          summary.typed_list_differs += 1;
          if (x.confidence !== 'high') summary.typed_list_differs_medium += 1;
        }
        summary.persons.push(diagnosePerson(p, o));
        proposals.push(...o.proposals);
        addOutcome(summary, o);
        summary.ocr_calls += r.calls;
        summary.cache_hits += r.cacheHits;
        summary.persons_processed += 1;
        ok = true;
      } catch {
        /* 重試 1 次；錯誤內容唔印（可能帶路徑） */
      }
    }
    if (!ok) {
      summary.persons_failed += 1;
      summary.persons.push(diagnosePerson(p, null, 'read_failed'));
    }
    console.log(`[triage-reread] ${i + 1}/${todo.length} ${ok ? 'ok' : 'failed'}`);
  });
  summary.persons.sort((a, b) => (a.person_key < b.person_key ? -1 : a.person_key > b.person_key ? 1 : 0));
  return { proposals, summary };
}

export async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  if (!args.dry) await import('dotenv/config'); // 真跑先載入 .env（key）；--dry 唔掂
  const outPath = args.out ? resolveReportPath(args.out, process.cwd()) : null;
  if (!args.dry && !outPath) throw new ArgError('需要 --out（必須喺 data/ 之下）');
  if (args.cache) resolveReportPath(args.cache, process.cwd()); // 早啲驗路徑
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
