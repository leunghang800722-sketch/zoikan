// TE-1：分流題覆核證據裁圖——本機腳本（規劃者用真檔跑；執行員只用 --dry 合成 fixture，唔讀 data、唔載 .env、唔打 API）。
//   npx tsx scripts/staff-import/20-triage-evidence.ts --package data/2026-10/staff-import/out/import-package.json \
//     --person-fields data/2026-10/staff-fields/person-fields-ext.json --extract data/2026-10/staff-import/out/extract.json \
//     --index data/2026-10/staff-import/index.json --out data/2026-10/triage-evidence/ [--docs-dir data/2026-09/staff-docs] \
//     [--existing-crops data/2026-10/staff-import/out/phone-crops.json,data/2026-10/staff-import/out/address-crops-new.json] [--ocr-dir <dir>] [--limit N] [--only-key K] [--concurrency 2]
//   npx tsx scripts/staff-import/20-triage-evidence.ts --dry [--out data/…/]      # 記憶體內合成 fixture（假證件版面，ImageMagick 即時畫），唔讀 data、唔打 API
// 對**所有**有 review 欄嘅人出圖（伺服器只收仍有 open／skipped 題需要嘅欄，其餘計 skipped_not_needed——所以唔使知道 session 要邊個）。
// 來源優先順序（老闆 2026-10-18，方案 §7）：身份證號／中英文姓名／出生日期＝身份證副本（priority 1）→ 入職表（priority 2）；住址＝住址證明 → 入職表；電話＝入職表。
// 兩個來源都有就兩張都出（每欄 ≤2，優先排前）；manifest 每張圖帶 doc_kind＋priority＋match（match 同圖由同一條 package 記錄產生，M7）。
// M8：身份證圖**一律即時裁**（號碼區、中文姓名區、英文姓名區、出生日期區各自裁，避開相片區）——現成 name-crops 唔保證冇相片，所以唔用；
//     --existing-crops 只認電話（phone*-crops.json）同住址證明（address-crops*.json）呢兩類（內容冇相片、本身係單欄裁圖）。
//     staff-fields/crops 嘅 form_personal 係成條個人資料帶（含其他欄），違反欄位級權限（M3），所以唔用。
// 輸出：縮至長邊 ≤800px、JPEG、-strip 剝 EXIF/APPn、≤120 KB；zip（entry 名＝圖 sha256 前 32 位）分批每 zip ≤300 張／≤7 MB。console 只計數。
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { hkidCheckDigitValid } from '@/lib/guards/identity';
import { MAX_IMAGE_BYTES } from '@/lib/triage/evidence-format';
import { ArgError, resolveReportPath, runPool } from './lib/eval-ocr-core';
import type { OcrLine, OcrPage } from './lib/ocr';
import type { Box } from './lib/phone-crop';
import {
  JPEG_QUALITY_STEPS,
  SHRINK_EDGES,
  boxForRequest,
  buildEvidenceZips,
  detectUprightRotation,
  rotateLines,
  type Rotation,
  evidenceFieldsOf,
  magickOutArgs,
  matchOfPerson,
  planRequests,
  type CropRequest,
  type EvidenceItem,
} from './lib/triage-evidence-core';
import { buildStaffNoIndex, docIdsForPerson, pickDocPages, type DocPage, type ExtRow, type ExtractRow, type PkgPerson } from './lib/triage-reread-core';
import { resolveSourcePage } from './19-triage-reread';

const sh = promisify(execFile);
const MAGICK = process.env.MAGICK_BIN ?? (existsSync('/opt/homebrew/bin/magick') ? '/opt/homebrew/bin/magick' : 'magick');
const PDFTOPPM = process.env.PDFTOPPM_BIN ?? (existsSync('/opt/homebrew/bin/pdftoppm') ? '/opt/homebrew/bin/pdftoppm' : 'pdftoppm');

export interface Args {
  package: string | null;
  personFields: string | null;
  extract: string | null;
  index: string | null;
  docsDir: string;
  ocrDir: string | null;
  existingCrops: string[];
  out: string | null;
  dry: boolean;
  limit: number | null;
  onlyKey: string | null;
  concurrency: number;
}

export function parseArgs(argv: readonly string[]): Args {
  const a: Args = { package: null, personFields: null, extract: null, index: null, docsDir: 'data/2026-09/staff-docs', ocrDir: null, existingCrops: [], out: null, dry: false, limit: null, onlyKey: null, concurrency: 2 };
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
    else if (k === '--ocr-dir') a.ocrDir = v();
    else if (k === '--existing-crops') a.existingCrops.push(...v().split(',').map((x) => x.trim()).filter(Boolean));
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

// ---------------------------------------------------------------------------
// 現成裁圖索引（只認電話／住址證明；M8 + M3）
// ---------------------------------------------------------------------------
export interface ExistingCropFile {
  /** json 檔 basename（決定欄位類別） */
  name: string;
  /** json 所在目錄嘅上一層＝entry.file 嘅相對根（同 05/08 腳本：path.join(OUT, file)） */
  base: string;
  entries: { docId: string; page: number; file: string }[];
}
export type ExistingIndex = Map<string, string>;

/** key＝`<field>|<docKind>|<docId>|<page>` → 絕對路徑。phone*-crops＝入職表電話；address-crops*＝住址證明地址；其他一律忽略。 */
export function buildExistingIndex(files: readonly ExistingCropFile[]): { index: ExistingIndex; ignored: number } {
  const index: ExistingIndex = new Map();
  let ignored = 0;
  for (const f of files) {
    const kind = /^address-crops[A-Za-z0-9-]*\.json$/.test(f.name) ? ({ field: 'address', doc: 'address_proof' } as const) : null; // 電話 crops 係成行裁（含下一行、相片），唔用
    if (!kind) {
      ignored += f.entries.length;
      continue;
    }
    for (const e of f.entries) {
      if (!e.docId || !Number.isInteger(e.page) || typeof e.file !== 'string') continue;
      const k = `${kind.field}|${kind.doc}|${e.docId}|${e.page}`;
      if (!index.has(k)) index.set(k, path.resolve(f.base, e.file));
    }
  }
  return { index, ignored };
}

// ---------------------------------------------------------------------------
// 依賴（IO）——真跑 / dry 各一套
// ---------------------------------------------------------------------------
export interface Deps {
  /** 該頁 OCR 行（定位唔到＝null） */
  lines(doc: DocPage): Promise<OcrLine[] | null>;
  /** 現成單欄裁圖 png（冇＝null） */
  existing(req: CropRequest): string | null;
  /** 渲染整頁 png（300dpi）→ 路徑；null＝渲染失敗 */
  render(doc: DocPage): Promise<string | null>;
  /** 清理 render 出嚟嘅暫存檔 */
  cleanup(png: string): Promise<void>;
}

export type FinalizeResult = { bytes: Uint8Array } | { reason: 'photo_suspect' | 'image_spec_fail' };

/** 暗像素門檻：灰階 <70% 當暗（相片頭髮／衣服／深色格；皮膚色較亮，白底印刷字線條比例低） */
const DARK_THRESHOLD = '70%';
const BAND = 0.15;
const BAND_LIMIT = 0.35;
const SHRINK = 0.2;

async function sizeOf(png: string): Promise<{ w: number; h: number }> {
  const id = await sh(MAGICK, ['identify', '-format', '%w %h', png]);
  const [w, h] = id.stdout.trim().split(' ').map(Number) as [number, number];
  return { w, h };
}

/** 四條 15% 邊緣帶（上／下／左／右）嘅暗像素比例。 */
export async function darkBandRatios(png: string): Promise<{ top: number; bottom: number; left: number; right: number }> {
  const { w, h } = await sizeOf(png);
  const bh = Math.max(1, Math.round(h * BAND));
  const bw = Math.max(1, Math.round(w * BAND));
  const ratio = async (cw: number, ch: number, x: number, y: number) => {
    const r = await sh(MAGICK, [png, '-crop', `${cw}x${ch}+${x}+${y}`, '+repage', '-colorspace', 'Gray', '-threshold', DARK_THRESHOLD, '-format', '%[fx:1-mean]', 'info:']);
    return Number(r.stdout.trim());
  };
  return { top: await ratio(w, bh, 0, 0), bottom: await ratio(w, bh, 0, h - bh), left: await ratio(bw, h, 0, 0), right: await ratio(bw, h, w - bw, 0) };
}

/**
 * 防線二（唔依賴版面假設）：任一邊緣帶暗比例 >35% 當疑似相片／深色格 → 向內收窄 20%（只由超標嗰邊收）再量，仍超標就跳過（photo_suspect）。
 * 回傳（可能收窄後）嘅 png 路徑；null＝跳過。
 */
async function bandGuard(png: string, tmp: string): Promise<string | null> {
  let cur = png;
  for (let round = 0; round < 2; round++) {
    const r = await darkBandRatios(cur);
    const bad = { top: r.top > BAND_LIMIT, bottom: r.bottom > BAND_LIMIT, left: r.left > BAND_LIMIT, right: r.right > BAND_LIMIT };
    if (!bad.top && !bad.bottom && !bad.left && !bad.right) return cur;
    if (round === 1) return null;
    const { w, h } = await sizeOf(cur);
    const dt = bad.top ? Math.round(h * SHRINK) : 0;
    const db = bad.bottom ? Math.round(h * SHRINK) : 0;
    const dl = bad.left ? Math.round(w * SHRINK) : 0;
    const dr = bad.right ? Math.round(w * SHRINK) : 0;
    const cw = w - dl - dr;
    const ch = h - dt - db;
    if (cw < 8 || ch < 4) return null;
    const next = path.join(tmp, `g-${Math.random().toString(36).slice(2)}.png`);
    await sh(MAGICK, [cur, '-crop', `${cw}x${ch}+${dl}+${dt}`, '+repage', next]);
    cur = next;
  }
  return null;
}

/** png（可選先順時針轉 rotate 度、再裁 box；可選邊緣帶檢查）→ 規格 JPEG（長邊 ≤800、-strip、≤120 KB）。 */
export async function finalizeChecked(png: string, box: Box | null, tmp: string, opts: { rotate?: Rotation; bandCheck?: boolean; rotatedCache?: Map<string, string> } = {}): Promise<FinalizeResult> {
  let page = png;
  if (opts.rotate) {
    const k = `${png}|${opts.rotate}`;
    let r = opts.rotatedCache?.get(k);
    if (!r) {
      r = path.join(tmp, `r-${Math.random().toString(36).slice(2)}.png`);
      await sh(MAGICK, [png, '-rotate', String(opts.rotate), r]);
      opts.rotatedCache?.set(k, r);
    }
    page = r;
  }
  let src = page;
  if (box) {
    const { w, h } = await sizeOf(page);
    const x = Math.max(0, Math.round(box.x0 * w));
    const y = Math.max(0, Math.round((1 - box.y1) * h));
    const cw = Math.min(w - x, Math.round((box.x1 - box.x0) * w));
    const ch = Math.min(h - y, Math.round((box.y1 - box.y0) * h));
    if (cw < 8 || ch < 4) return { reason: 'image_spec_fail' };
    src = path.join(tmp, `c-${Math.random().toString(36).slice(2)}.png`);
    await sh(MAGICK, [page, '-crop', `${cw}x${ch}+${x}+${y}`, '+repage', src]);
  }
  if (opts.bandCheck) {
    const g = await bandGuard(src, tmp);
    if (!g) return { reason: 'photo_suspect' };
    src = g;
  }
  for (const edge of SHRINK_EDGES) {
    for (const q of JPEG_QUALITY_STEPS) {
      const out = path.join(tmp, `o-${edge}-${q}-${Math.random().toString(36).slice(2)}.jpg`);
      await sh(MAGICK, [src, ...magickOutArgs(edge, q), out]);
      const bytes = new Uint8Array(await readFile(out));
      await rm(out, { force: true });
      if (bytes.byteLength <= MAX_IMAGE_BYTES) return { bytes };
    }
  }
  return { reason: 'image_spec_fail' };
}

/** 舊簽名（測試／簡單用途）：冇邊緣帶檢查。 */
export async function finalizeImage(png: string, box: Box | null, tmp: string): Promise<Uint8Array | null> {
  const r = await finalizeChecked(png, box, tmp);
  return 'bytes' in r ? r.bytes : null;
}

/** 身份證／入職表／住址證明一個欄：偵測方向 → 轉正 lines → 定位 → 轉正頁面 → 裁 → 邊緣帶檢查。回 bytes 或跳過原因。 */
export async function cropRequest(req: CropRequest, png: string, lines: OcrLine[], tmp: string, rotatedCache?: Map<string, string>): Promise<FinalizeResult | { reason: string }> {
  const rot: Rotation = detectUprightRotation(req.docKind, lines) ?? 0;
  const g = boxForRequest(req, rotateLines(lines, rot));
  if (!g.box) return { reason: g.reason ?? 'no_box' };
  return finalizeChecked(png, g.box, tmp, { rotate: rot, bandCheck: true, rotatedCache });
}

export interface Stats {
  persons_total: number;
  persons_with_fields: number;
  persons_no_docs: number;
  persons_failed: number;
  requests_total: number;
  from_existing: number;
  live_cropped: number;
  images_out: number;
  by_field: Record<string, number>;
  by_doc_priority: Record<string, number>;
  skipped: Record<string, number>;
  existing_ignored_entries: number;
  zips: number;
  zip_bytes: number;
}
export const emptyStats = (): Stats => ({ persons_total: 0, persons_with_fields: 0, persons_no_docs: 0, persons_failed: 0, requests_total: 0, from_existing: 0, live_cropped: 0, images_out: 0, by_field: {}, by_doc_priority: {}, skipped: {}, existing_ignored_entries: 0, zips: 0, zip_bytes: 0 });
const bump = (r: Record<string, number>, k: string) => {
  r[k] = (r[k] ?? 0) + 1;
};

export interface PersonInput {
  person: PkgPerson;
  docs: DocPage[];
}

/** 核心：每人 → 請求 → 圖（現成優先；否則 OCR 幾何即時裁）→ items。純粹經 deps 做 IO。 */
export async function produceItems(people: readonly PersonInput[], deps: Deps, stats: Stats, opts: { concurrency?: number } = {}): Promise<EvidenceItem[]> {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'te1-'));
  const items: EvidenceItem[] = [];
  try {
    await runPool([...people], opts.concurrency ?? 1, async (pi) => {
      const fields = evidenceFieldsOf(pi.person);
      if (fields.length === 0) return;
      stats.persons_with_fields += 1;
      if (pi.docs.length === 0) {
        stats.persons_no_docs += 1;
        return;
      }
      const match = matchOfPerson(pi.person);
      const reqs = planRequests(fields, pi.docs);
      const pageCache = new Map<string, string | null>();
      const rotCache = new Map<string, string>();
      const getPage = async (d: DocPage) => {
        const k = `${d.docId}|${d.page}`;
        if (!pageCache.has(k)) pageCache.set(k, await deps.render(d));
        return pageCache.get(k)!;
      };
      try {
        for (const req of reqs) {
          stats.requests_total += 1;
          let bytes: Uint8Array | null = null;
          let from: 'existing' | 'live' = 'live';
          let skip: string | null = null;
          const ex = req.docKind === 'address_proof' ? deps.existing(req) : null; // M8：身份證一律即時裁；入職表（成行裁、含相片）亦一律即時單格裁；現成圖只用於住址證明
          if (ex) {
            const r = await finalizeChecked(ex, null, tmp, { bandCheck: true }).catch(() => ({ reason: 'image_spec_fail' as const }));
            if ('bytes' in r) {
              bytes = r.bytes;
              from = 'existing';
            } else skip = r.reason;
          }
          if (!bytes && !skip) {
            const lines = await deps.lines(req.doc);
            if (!lines) skip = 'no_ocr_lines';
            else {
              const png = await getPage(req.doc);
              if (!png) skip = 'render_fail';
              else {
                const r = await cropRequest(req, png, lines, tmp, rotCache).catch(() => ({ reason: 'image_spec_fail' }));
                if ('bytes' in r) bytes = r.bytes;
                else skip = r.reason;
                from = 'live';
              }
            }
          }
          if (!bytes) {
            bump(stats.skipped, skip ?? 'image_spec_fail');
            continue;
          }
          items.push({ bytes, field: req.field, docKind: req.docKind, priority: req.priority, match });
          if (from === 'existing') stats.from_existing += 1;
          else stats.live_cropped += 1;
          bump(stats.by_field, req.field);
          bump(stats.by_doc_priority, `${req.docKind}:${req.priority}`);
        }
      } catch {
        stats.persons_failed += 1; // 錯誤內容唔印（可能帶路徑）
      } finally {
        for (const png of pageCache.values()) if (png) await deps.cleanup(png);
      }
    });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
  stats.images_out = items.length;
  return items;
}

// ---------------------------------------------------------------------------
// 真跑：載入 + 真 deps
// ---------------------------------------------------------------------------
interface Loaded {
  people: PersonInput[];
  deps: Deps;
  existingIgnored: number;
  personsTotal: number;
}

const J = async <T>(p: string) => JSON.parse(await readFile(path.resolve(p), 'utf-8')) as T;

async function loadLive(args: Args): Promise<Loaded> {
  for (const k of ['package', 'personFields', 'extract', 'index'] as const) if (!args[k]) throw new ArgError('需要 --package --person-fields --extract --index（或者 --dry）');
  const pkg = await J<{ persons: PkgPerson[] }>(args.package!);
  const ext = await J<ExtRow[]>(args.personFields!);
  const extract = await J<(ExtractRow & { rescuedRot?: number | null })[]>(args.extract!);
  const index = await J<{ docId: string; file: string }[]>(args.index!);
  const fileOf = new Map(index.map((m) => [m.docId, m.file]));
  const extractBy = new Map(extract.map((e) => [e.docId, e]));
  const staffIdx = buildStaffNoIndex(ext);
  const ocrDir = path.resolve(args.ocrDir ?? path.join(path.dirname(path.resolve(args.extract!)), 'ocr'));
  const ocr2Dir = path.join(path.dirname(ocrDir), 'ocr2');
  const existingFiles: ExistingCropFile[] = [];
  for (const f of args.existingCrops) {
    const raw = await J<Record<string, unknown>[]>(f).catch(() => [] as Record<string, unknown>[]);
    const entries = raw.flatMap((e) => (typeof e.docId === 'string' && typeof e.page === 'number' && typeof e.file === 'string' ? [{ docId: e.docId, page: e.page, file: e.file }] : []));
    existingFiles.push({ name: path.basename(f), base: path.resolve(path.dirname(path.resolve(f)), '..'), entries });
  }
  const ex = buildExistingIndex(existingFiles);

  const rotOf = (docId: string) => extractBy.get(docId)?.rescuedRot ?? null;
  const linesCache = new Map<string, OcrLine[] | null>();
  const deps: Deps = {
    async lines(d) {
      const k = `${d.docId}|${d.page}`;
      if (linesCache.has(k)) return linesCache.get(k)!;
      let out: OcrLine[] | null = null;
      try {
        const rot = rotOf(d.docId);
        if (rot !== null) {
          const rows = (await readFile(path.join(ocr2Dir, `${d.docId}.jsonl`), 'utf-8')).split('\n').filter(Boolean).map((l) => JSON.parse(l) as { page: number; rot: number; lines: OcrLine[] });
          out = rows.find((r) => r.page === d.page && r.rot === rot)?.lines ?? null;
        } else {
          const rows = (await readFile(path.join(ocrDir, `${d.docId}.jsonl`), 'utf-8')).split('\n').filter(Boolean).map((l) => JSON.parse(l) as OcrPage);
          out = rows.find((r) => r.page === d.page && !r.alt)?.lines ?? rows.find((r) => r.page === d.page)?.lines ?? null;
        }
      } catch {
        out = null;
      }
      linesCache.set(k, out);
      return out;
    },
    existing(req) {
      return ex.index.get(`${req.field}|${req.docKind}|${req.doc.docId}|${req.doc.page}`) ?? null;
    },
    async render(d) {
      const file = fileOf.get(d.docId);
      const src = file ? await resolveSourcePage(args.docsDir, file, d.page).catch(() => null) : null;
      if (!src) return null;
      const out = path.join(os.tmpdir(), `te1-page-${process.pid}-${Math.random().toString(36).slice(2)}.png`);
      try {
        if (/\.pdf$/i.test(src.abs)) {
          const base = out.replace(/\.png$/, '');
          await sh(PDFTOPPM, ['-r', '300', '-png', '-f', String(src.page), '-l', String(src.page), '-singlefile', src.abs, base]);
        } else await sh(MAGICK, [src.abs, '-auto-orient', out]);
        const rot = rotOf(d.docId);
        if (rot) await sh(MAGICK, [out, '-rotate', String(rot), out]); // 旋轉救援頁：OCR 座標係旋轉後嘅頁
        return out;
      } catch {
        await rm(out, { force: true });
        return null;
      }
    },
    async cleanup(png) {
      await rm(png, { force: true });
    },
  };

  let persons = pkg.persons;
  const personsTotal = persons.length;
  if (args.onlyKey) persons = persons.filter((p) => p.key === args.onlyKey);
  persons = persons.filter((p) => evidenceFieldsOf(p).length > 0);
  if (args.limit) persons = persons.slice(0, args.limit);
  return { people: persons.map((person) => ({ person, docs: pickDocPages(docIdsForPerson(person, staffIdx), extractBy) })), deps, existingIgnored: ex.ignored, personsTotal };
}

// ---------------------------------------------------------------------------
// --dry：合成 fixture（假名「測試甲」、假 HKID、記憶體內 OCR 行＋ImageMagick 即時畫嘅假證件頁）
// ---------------------------------------------------------------------------
const HK_ID_VALID = (() => {
  const base = 'Z900001';
  const c = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'A'].find((x) => hkidCheckDigitValid(`${base}${x}`))!;
  return `${base}(${c})`;
})();

const L = (t: string, x: number, y: number, w: number, h = 0.025): OcrLine => ({ t, c: 0.95, x, y, w, h });

/**
 * 假身份證頁 OCR 行——**真卡版面**（香港智能身份證）：相片右上、號碼喺相片正下方（右下）、左邊中英文姓名／出生日期／簽發日期。
 * 座標係 Vision 正規化（原點左下）。photoGap＝相片下緣高過號碼行頂幾多（預設 0.005；邊界測試用 0.003）。
 */
export function syntheticIdCardPage(withAnchor = true, photoGap = 0.005, opts: { longName?: boolean } = {}): { lines: OcrLine[]; photo: Box; hkidTop: number } {
  const lines: OcrLine[] = [
    ...(withAnchor ? [L('香港永久性居民身份證', 0.12, 0.8, 0.34), L('HONG KONG PERMANENT IDENTITY CARD', 0.12, 0.77, 0.44, 0.02)] : []),
    opts.longName ? L('TESTER-LONGFAMILYNAME, Alphabeta Gamma', 0.1, 0.7, 0.45) : L('TESTER, Alpha', 0.1, 0.7, 0.25),
    L('測試甲', 0.1, 0.66, 0.12),
    L('出生日期 Date of Birth', 0.1, 0.6, 0.24, 0.02),
    L('15-01-1990', 0.14, 0.57, 0.16),
    L('男 M', 0.32, 0.57, 0.05),
    L('簽發日期 Date of Issue', 0.1, 0.53, 0.22, 0.02),
    L(HK_ID_VALID, 0.44, 0.54, 0.12, 0.035),
  ];
  const hkidTop = 0.54 + 0.035;
  // 長英文名：名行橫跨相片 x 範圍，相片緊貼名行底（低 0.002）；一般：相片伸到卡頂
  const photo: Box = { x0: 0.4, x1: 0.56, y0: hkidTop + photoGap, y1: opts.longName ? 0.7 - 0.002 : 0.78 };
  return { lines, photo, hkidTop };
}

/** 入職表假頁：右上角貼相片（SYNTHETIC_FORM_PHOTO）；「香港身份證｜出生日期｜出生地點」三格並排；其餘欄各自一行。 */
export function syntheticFormPage(): OcrLine[] {
  return [
    L('職位申請表 EMPLOYMENT APPLICATION', 0.1, 0.92, 0.5),
    L('中文姓名：', 0.08, 0.8, 0.12), L('測試甲', 0.21, 0.8, 0.12), L('English Name:', 0.4, 0.8, 0.14), L('TESTER ALPHA', 0.55, 0.8, 0.16),
    L('香港身份證：', 0.08, 0.7, 0.12), L(HK_ID_VALID, 0.21, 0.7, 0.13), L('出生日期：', 0.4, 0.7, 0.11), L('15-01-1990', 0.52, 0.7, 0.13), L('出生地點：', 0.68, 0.7, 0.09), L('香港', 0.78, 0.6, 0.05),
    L('手提電話：', 0.08, 0.5, 0.11), L('90001110', 0.2, 0.5, 0.12), L('住所電話：', 0.45, 0.5, 0.11),
    L('住址：', 0.08, 0.42, 0.06), L('火炭示範街99號虛構大廈15樓A室', 0.15, 0.42, 0.4),
    L('通訊地址：', 0.08, 0.34, 0.1),
    L('緊急聯絡人', 0.08, 0.2, 0.12),
  ];
}

/** 假入職表相片格（深色大塊，位置喺 FORM_PHOTO_BOX 之內） */
export const SYNTHETIC_FORM_PHOTO: Box = { x0: 0.78, x1: 0.97, y0: 0.68, y1: 0.93 };

export function syntheticAddressProofPage(): OcrLine[] {
  return [L('水務署 付款通知書', 0.1, 0.9, 0.3), L('測試乙', 0.1, 0.7, 0.1), L('九龍火炭示範街99號', 0.1, 0.67, 0.3), L('虛構大廈15樓A室', 0.1, 0.64, 0.3), L('新界 香港', 0.1, 0.61, 0.2)];
}

interface DryDoc {
  doc: DocPage;
  lines: OcrLine[];
  photo?: Box;
}
const lf = (value: string | null, status: 'confirmed' | 'review' | 'missing') => ({ value, status });
const dryPerson = (n: number, over: Partial<PkgPerson> = {}): PkgPerson => ({
  key: `dry-person-${n}`,
  hkid: lf(HK_ID_VALID, 'review'),
  nameZh: lf('測試甲', 'review'),
  nameEn: lf('TESTER ALPHA', 'review'),
  dateOfBirth: lf('1990-01-15', 'review'),
  phone: lf('90001110', 'review'),
  address: lf('舊地址', 'review'),
  staffNumbers: [{ scheme: 'DRY', number: `DRY${n}` }],
  reasons: [],
  ...over,
});

export function dryFixture(): { people: PersonInput[]; docs: Map<string, DryDoc> } {
  const docs = new Map<string, DryDoc>();
  const add = (type: DocPage['type'], n: number, lines: OcrLine[], photo?: Box): DocPage => {
    const doc: DocPage = { type, docId: `dry-doc-${n}-${type}`, page: 1 };
    docs.set(`${doc.docId}|1`, { doc, lines, ...(photo ? { photo } : {}) });
    return doc;
  };
  const a = syntheticIdCardPage();
  const b = syntheticIdCardPage();
  const noAnchor = syntheticIdCardPage(false);
  return {
    docs,
    people: [
      { person: dryPerson(1), docs: [add('id_card', 1, a.lines, a.photo), add('address_proof', 1, syntheticAddressProofPage()), add('onboarding_form', 1, syntheticFormPage(), SYNTHETIC_FORM_PHOTO)] }, // 三份文件齊
      { person: dryPerson(2), docs: [add('id_card', 2, b.lines, b.photo), add('onboarding_form', 2, syntheticFormPage(), SYNTHETIC_FORM_PHOTO)] }, // 冇住址證明 → 住址退入職表
      { person: dryPerson(3), docs: [add('onboarding_form', 3, syntheticFormPage(), SYNTHETIC_FORM_PHOTO)] }, // 冇證件 → 退入職表
      { person: dryPerson(4), docs: [] }, // 冇文件
      { person: dryPerson(5), docs: [add('id_card', 5, noAnchor.lines, noAnchor.photo), add('onboarding_form', 5, syntheticFormPage(), SYNTHETIC_FORM_PHOTO)] }, // 認唔出卡面 → 身份證欄唔裁（避免連相片一齊裁）
      { person: dryPerson(6, { hkid: lf(HK_ID_VALID, 'confirmed'), nameZh: lf('測試甲', 'confirmed'), nameEn: lf('TESTER ALPHA', 'confirmed'), dateOfBirth: lf('1990-01-15', 'confirmed'), phone: lf('90001110', 'confirmed'), address: lf('舊地址', 'confirmed') }), docs: [] }, // 冇 review 欄
    ],
  };
}

/**
 * 用 ImageMagick 畫假頁：白底、文字行＝深灰細條（高度 40%，似字形比 OCR box 細）、相片區＝純紅（身份證）／深色格（入職表）。
 * rotateDeg＝將成頁順時針轉（模擬掃描時擺反：OCR 行座標要用 rotateLines 同步轉）。
 */
export async function drawSyntheticPage(d: DryDoc, out: string, size = { w: 1000, h: 1400 }, rotateDeg: Rotation = 0): Promise<void> {
  const args = ['-size', `${size.w}x${size.h}`, 'xc:white'];
  const rect = (b: Box, color: string) => ['-fill', color, '-draw', `rectangle ${Math.round(b.x0 * size.w)},${Math.round((1 - b.y1) * size.h)} ${Math.round(b.x1 * size.w)},${Math.round((1 - b.y0) * size.h)}`];
  if (d.photo) args.push(...rect(d.photo, d.doc.type === 'onboarding_form' ? 'rgb(40,30,30)' : 'rgb(255,0,0)'));
  for (const l of d.lines) args.push(...rect({ x0: l.x, x1: l.x + l.w, y0: l.y + l.h * 0.3, y1: l.y + l.h * 0.7 }, 'rgb(60,60,60)'));
  await sh(MAGICK, [...args, ...(rotateDeg ? ['-rotate', String(rotateDeg)] : []), out]);
}

function dryDeps(docs: Map<string, DryDoc>): Deps {
  return {
    async lines(d) {
      return docs.get(`${d.docId}|${d.page}`)?.lines ?? null;
    },
    existing: () => null,
    async render(d) {
      const dd = docs.get(`${d.docId}|${d.page}`);
      if (!dd) return null;
      const out = path.join(os.tmpdir(), `te1-dry-${process.pid}-${Math.random().toString(36).slice(2)}.png`);
      await drawSyntheticPage(dd, out);
      return out;
    },
    async cleanup(png) {
      await rm(png, { force: true });
    },
  };
}

// ---------------------------------------------------------------------------
// run / main
// ---------------------------------------------------------------------------
export interface RunResult {
  items: EvidenceItem[];
  zips: Uint8Array[];
  stats: Stats;
}

export async function run(args: Args, injected?: { people: PersonInput[]; deps: Deps }): Promise<RunResult> {
  const stats = emptyStats();
  let people: PersonInput[];
  let deps: Deps;
  if (injected) ({ people, deps } = injected);
  else if (args.dry) {
    const fx = dryFixture();
    people = fx.people;
    deps = dryDeps(fx.docs);
  } else {
    const l = await loadLive(args);
    people = l.people;
    deps = l.deps;
    stats.existing_ignored_entries = l.existingIgnored;
    stats.persons_total = l.personsTotal;
  }
  if (!stats.persons_total) stats.persons_total = people.length;
  const items = await produceItems(people, deps, stats, { concurrency: args.dry ? 1 : args.concurrency });
  const built = await buildEvidenceZips(items);
  stats.zips = built.zips.length;
  stats.zip_bytes = built.zips.reduce((a, z) => a + z.byteLength, 0);
  return { items, zips: built.zips, stats };
}

export const statsLines = (s: Stats): string[] => [
  `package 人數 ${s.persons_total}｜有 review 欄 ${s.persons_with_fields}｜冇文件 ${s.persons_no_docs}｜失敗 ${s.persons_failed}`,
  `請求 ${s.requests_total}｜現成裁圖 ${s.from_existing}｜即時裁 ${s.live_cropped}｜出圖 ${s.images_out}｜zip ${s.zips}（${s.zip_bytes} bytes）`,
  `每欄：${JSON.stringify(s.by_field)}｜來源:優先：${JSON.stringify(s.by_doc_priority)}`,
  `跳過原因：${JSON.stringify(s.skipped)}｜忽略嘅現成裁圖清單項 ${s.existing_ignored_entries}`,
];

export async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  const outDir = args.out ? resolveReportPath(args.out, process.cwd()) : null;
  if (!args.dry && !outDir) throw new ArgError('需要 --out（必須喺 data/ 之下）');
  console.log(`[triage-evidence] ${args.dry ? 'dry（合成 fixture）' : 'live'}`);
  const r = await run(args);
  for (const l of statsLines(r.stats)) console.log(`[triage-evidence] ${l}`);
  if (outDir) {
    await mkdir(outDir, { recursive: true });
    for (let i = 0; i < r.zips.length; i++) await writeFile(path.join(outDir, `triage-evidence-${String(i + 1).padStart(3, '0')}.zip`), r.zips[i]!);
    console.log(`[triage-evidence] 已寫入 ${r.zips.length} 個 zip`);
  }
  return r.stats.persons_failed > 0 ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main(process.argv.slice(2)).then(
    (c) => process.exit(c),
    (e) => {
      console.error(e instanceof ArgError ? `[triage-evidence] ${e.message}` : `[triage-evidence] error ${e instanceof Error ? e.name : typeof e}`);
      process.exit(1);
    },
  );
}
