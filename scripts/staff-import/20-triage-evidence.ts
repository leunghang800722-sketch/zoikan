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
import { createHash } from 'node:crypto';
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
  FORM_PHOTO_BOX,
  buildEvidenceZips,
  VERIFY_THRESHOLD,
  detectUprightRotation,
  capBox,
  clipToPhoto,
  NON_PII_FIELDS,
  PII_OVERFLOW_GROUPS,
  detectEmbeddedCards,
  findPrintedHkidLines,
  type EmbeddedSource,
  type PrintedSource,
  expectedValuesFor,
  findOverflow,
  lineHasOwnLabel,
  rotateLines,
  scoreAgainst,
  similarity,
  textUprightness,
  type EvidenceField,
  type OverflowHit,
  type Rotation,
  evidenceFieldsOf,
  magickOutArgs,
  matchOfPerson,
  planRequests,
  type CropRequest,
  type EvidenceItem,
} from './lib/triage-evidence-core';
import { inBox } from './lib/embedded-card';
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
  /** TE-1.7：唔做 Vision 驗證 */
  noVerify: boolean;
  /** TE-1.7：vision-ocr 執行檔（要支援 --fast）；預設由 vision-ocr.swift 編譯到 os.tmpdir */
  visionBin: string | null;
}

export function parseArgs(argv: readonly string[]): Args {
  const a: Args = { package: null, personFields: null, extract: null, index: null, docsDir: 'data/2026-09/staff-docs', ocrDir: null, existingCrops: [], out: null, dry: false, limit: null, onlyKey: null, concurrency: 2, noVerify: false, visionBin: null };
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
    else if (k === '--no-verify') a.noVerify = true;
    else if (k === '--vision-bin') a.visionBin = v();
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
  /** TE-1.7：Vision 驗證（冇＝唔驗證） */
  vision?: VisionRunner;
}

export type FinalizeResult =
  | { bytes: Uint8Array; score?: number }
  | { reason: 'photo_suspect' | 'image_spec_fail' | 'orientation_unknown'; score?: number }
  | { reason: 'value_mismatch'; score: number }
  | { reason: 'cell_overflow'; overflow: OverflowHit };

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

/** 整頁順時針轉 rot 度（結果按 png|rot 快取喺 cache）。 */
async function rotatedPage(png: string, rot: Rotation, tmp: string, cache?: Map<string, string>): Promise<string> {
  if (!rot) return png;
  const k = `${png}|${rot}`;
  let r = cache?.get(k);
  if (!r) {
    r = path.join(tmp, `r-${Math.random().toString(36).slice(2)}.png`);
    await sh(MAGICK, [png, '-rotate', String(rot), r]);
    cache?.set(k, r);
  }
  return r;
}

/** TE-2.1：入職表右上 25%×35% 要真係有相（灰階 <80% 嘅暗像素比例 ≥15%）先當相片格；否則唔排除。 */
export async function detectFormPhoto(png: string, rot: Rotation, tmp: string, cache?: Map<string, string>): Promise<Box | null> {
  const key = `formphoto|${png}|${rot}`;
  let v = cache?.get(key);
  if (v === undefined) {
    const page = await rotatedPage(png, rot, tmp, cache);
    const { w, h } = await sizeOf(page);
    const x = Math.round(FORM_PHOTO_BOX.x0 * w);
    const ch = Math.round((1 - FORM_PHOTO_BOX.y0) * h);
    const r = await sh(MAGICK, [page, '-crop', `${w - x}x${ch}+${x}+0`, '+repage', '-colorspace', 'Gray', '-threshold', '80%', '-format', '%[fx:1-mean]', 'info:']);
    v = Number(r.stdout.trim()) >= 0.15 ? '1' : '0';
    cache?.set(key, v);
  }
  return v === '1' ? FORM_PHOTO_BOX : null;
}

/** png（可選先順時針轉 rotate 度、再裁 box；可選邊緣帶檢查）→ 規格 JPEG（長邊 ≤800、-strip、≤120 KB）。 */
export async function finalizeChecked(png: string, box: Box | null, tmp: string, opts: { rotate?: Rotation; bandCheck?: boolean; rotatedCache?: Map<string, string>; verify?: VerifyHook } = {}): Promise<FinalizeResult> {
  const page = await rotatedPage(png, opts.rotate ?? 0, tmp, opts.rotatedCache);
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
  let score: number | undefined;
  if (opts.verify) {
    const v = await opts.verify(src);
    if (!v.ok) return v.reason === 'value_mismatch' ? { reason: 'value_mismatch', score: v.score } : { reason: v.reason };
    if (v.overflow) return { reason: 'cell_overflow', overflow: v.overflow };
    if (v.score !== null) score = v.score;
    if (v.rotate) {
      const rp = path.join(tmp, `v-${Math.random().toString(36).slice(2)}.png`);
      await sh(MAGICK, [src, '-rotate', String(v.rotate), rp]);
      src = rp;
    }
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
      if (bytes.byteLength <= MAX_IMAGE_BYTES) return { bytes, ...(score !== undefined ? { score } : {}) };
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
export async function cropRequest(req0: CropRequest, png: string, lines: OcrLine[], tmp: string, rotatedCache?: Map<string, string>, verify?: VerifyHook, opts: { assumeRot?: Rotation | null } = {}): Promise<(FinalizeResult | { reason: string }) & { capped?: boolean }> {
  let req = req0;
  const { w, h } = await sizeOf(png);
  const dims = (r: Rotation): [number, number] => (r === 90 || r === 270 ? [h, w] : [w, h]); // 轉正後 frame 嘅頁面像素
  // 嵌入式身份證／印刷號碼行：方向喺偵測時已經定（rot）；其餘按版面推算
  let rot: Rotation = req.embedded?.rot ?? req.printed?.rot ?? (('assumeRot' in opts ? opts.assumeRot : detectUprightRotation(req.docKind, lines)) ?? 0);
  let [W, H] = dims(rot);
  const formPhoto = req.docKind === 'onboarding_form' ? await detectFormPhoto(png, rot, tmp, rotatedCache) : FORM_PHOTO_BOX;
  let g = boxForRequest(req, rotateLines(lines, rot), W / H, formPhoto);
  if (!g.box && g.reason === 'no_card_anchor' && req.docKind === 'id_card' && !req.embedded) {
    // 導入分類為 id_card 但頁面其實係夾住細卡嘅牌照頁等（冇整頁標題 anchor）→ 試嵌入式偵測
    const det = detectEmbeddedCards(lines, w / h);
    if (det) {
      req = { ...req, embedded: { rot: det.rot, region: det.cards[0]!.box } };
      rot = det.rot;
      [W, H] = dims(rot);
      g = boxForRequest(req, rotateLines(lines, rot), W / H);
    }
  }
  if (!g.box) return { reason: g.reason ?? 'no_box' };
  let box = g.box;
  let capped = false;
  if (g.anchor) {
    // 硬性尺寸上限：喺最終輸出 frame 量度，唔依賴方向／版面推算
    const c = capBox(box, g.anchor, W, H);
    box = c.box;
    capped = c.capped;
    if (g.anchor.mode === 'id') {
      // S1：收窄之後再同相片範圍做相交檢查；夾唔走就跳過
      const clipped = clipToPhoto(box, g.anchor.photo, g.anchor.own);
      if (!clipped) return { reason: 'id_photo_overlap', capped };
      box = clipped;
    }
  }
  const label = g.anchor?.mode === 'form' ? g.anchor.own[0] : undefined;
  for (let attempt = 0; ; attempt++) {
    const r = await finalizeChecked(png, box, tmp, { rotate: rot, bandCheck: true, rotatedCache, ...(verify ? { verify } : {}) });
    if (!('reason' in r) || r.reason !== 'cell_overflow') return { ...r, capped };
    // 越界：右界收到關鍵詞左邊 → 再裁再驗；仍越界收下（上）界；再仍越界跳過 cell_overflow
    if (attempt >= 2) return { reason: 'cell_overflow', capped };
    const ov = r.overflow;
    // S3：非個人資料欄（電話、入職日期、牌照號）溢出到個人資料格——唔收界重裁，直接跳過（避免只有「保安員:view」嘅人見到相鄰個人資料）
    if (NON_PII_FIELDS.has(req.field) && ov.group !== undefined && PII_OVERFLOW_GROUPS.has(ov.group)) return { reason: 'cell_overflow_pii', capped };
    const bw = box.x1 - box.x0;
    const bh = box.y1 - box.y0;
    const next: Box = ov.side === 'right' ? { ...box, x1: box.x0 + ov.frac * bw - 0.002 } : ov.side === 'below' ? { ...box, y0: box.y1 - ov.frac * bh } : { ...box, y1: box.y1 - ov.frac * bh };
    const keepsLabel = !label || (next.x1 > label.x + label.w && next.y0 <= label.y + label.h * 0.5 && next.y1 >= label.y + label.h * 0.5);
    if (next.x1 - next.x0 < 0.01 || next.y1 - next.y0 < 0.005 || !keepsLabel) return { reason: 'cell_overflow', capped };
    box = next;
  }
}

// ---------------------------------------------------------------------------
// TE-1.7 Vision 驗證（本機、離線 Apple Vision；讀出嘅文字只喺記憶體比對，唔寫 log／檔案）
// ---------------------------------------------------------------------------
export interface VisionLine {
  t: string;
  c: number;
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface VisionPage {
  lines: VisionLine[];
}
/** 一次 call 讀多張圖（輸出次序同輸入一致）；fast＝.fast 級別（對方向敏感）。 */
export type VisionRunner = (paths: string[], fast: boolean) => Promise<VisionPage[]>;
export type VerifyOutcome = { ok: true; score: number | null; rotate: Rotation; overflow?: OverflowHit; /** 方向由 .fast 比較判到（true）定係冇證據（false） */ decisive?: boolean; /** 冇證據，沿用同頁其他欄判到嘅方向 */ followedPage?: boolean } | { ok: false; reason: 'value_mismatch'; score: number } | { ok: false; reason: 'orientation_unknown' };
export type VerifyHook = (cropPng: string) => Promise<VerifyOutcome>;

export function makeVisionRunner(bin: string): VisionRunner {
  return async (paths, fast) => {
    try {
      const r = await sh(bin, [...(fast ? ['--fast'] : []), ...paths], { maxBuffer: 64 * 1024 * 1024 });
      const pages = r.stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l) as { lines?: VisionLine[] });
      return paths.map((_, i) => ({ lines: pages[i]?.lines ?? [] }));
    } catch {
      return paths.map(() => ({ lines: [] }));
    }
  };
}

/** vision-ocr 執行檔：--vision-bin；否則將 vision-ocr.swift 編譯去 os.tmpdir（按源碼 hash 快取，要 swiftc）。冇＝null（自動 no-verify）。 */
export async function resolveVisionBin(explicit: string | null): Promise<string | null> {
  if (explicit) return existsSync(explicit) ? explicit : null;
  const src = path.join(path.dirname(fileURLToPath(import.meta.url)), 'vision-ocr.swift');
  const hash = createHash('sha256').update(await readFile(src)).digest('hex').slice(0, 8);
  const dir = path.join(os.tmpdir(), `te1-vision-${hash}`);
  const bin = path.join(dir, 'vision-ocr');
  if (existsSync(bin)) return bin;
  try {
    await mkdir(dir, { recursive: true });
    await sh('swiftc', ['-O', src, '-o', bin], { timeout: 300_000 });
    return bin;
  } catch {
    return null;
  }
}

const rotateFile = async (png: string, deg: Rotation, tmp: string): Promise<string> => {
  if (deg === 0) return png;
  const out = path.join(tmp, `vr-${deg}-${Math.random().toString(36).slice(2)}.png`);
  await sh(MAGICK, [png, '-rotate', String(deg), out]);
  return out;
};
const DICT_WORDS = /出生日期|English|Name|Phone|Address|香港/gi;
/** 冇預期值時 .fast 讀數嘅可讀程度：字母數字數＋字典詞命中×6（正向先讀得準，倒轉／側躺會亂碼）。 */
export function readabilityScore(t: string): number {
  return (t.match(/[0-9A-Za-z]/g) ?? []).length + 6 * (t.match(DICT_WORDS) ?? []).length;
}
const textOf = (p: VisionPage | undefined): string => (p?.lines ?? []).map((l) => l.t).join(' ');

/**
 * 驗證一張裁圖：
 *  ① .accurate 讀一次（對方向**不敏感**——實測 Vision 四個方向都讀到同一串字，所以唔能夠靠「四方向邊個最像」揀方向）→ 同預期值比相似度，低過門檻＝value_mismatch（裁錯欄／錯人／發票抬頭）；
 *  ② 方向：由行 box 縱橫比分「橫排（0°／180°）」同「側躺（90°／270°）」兩個候選；再用 .fast（對方向敏感：正向先讀得準）讀兩個候選，
 *     相似度明顯較高（≥0.5 且差 ≥0.2）者勝；分唔出：橫排當 0°（沿用版面推算嘅 prior），側躺＝orientation_unknown（跳過）。
 *     限制：中文姓名 .fast 讀唔準，180° 倒轉嘅純中文裁圖分唔出（只靠版面 prior）。
 * 冇預期值（例如身份證號 missing）＝無法驗證（score null，唔轉）。
 */
export async function verifyCrop(png: string, field: EvidenceField, expected: readonly string[], run: VisionRunner, tmp: string, opts: { checkOverflow?: boolean; pagePrior?: Rotation | null } = {}): Promise<VerifyOutcome> {
  // 冇預期值（TE-2：missing 欄照裁）：跳過相似度驗證（score null），方向（.fast 可讀字數）、越界檢查照做
  const noExp = expected.length === 0;
  // Vision 輸入：放大到高度 ≥200px（上限 4×）＋四邊留白 24px——細裁圖直接讀會漏字
  const { h } = await sizeOf(png);
  const scale = Math.min(4, Math.max(1, 200 / Math.max(1, h)));
  const vin = path.join(tmp, `vin-${Math.random().toString(36).slice(2)}.png`);
  await sh(MAGICK, [png, ...(scale > 1.01 ? ['-filter', 'Lanczos', '-resize', `${Math.round(scale * 100)}%`] : []), '-bordercolor', 'white', '-border', '24', vin]);
  const [acc] = await run([vin], false);
  const score = noExp ? null : similarity(field, textOf(acc), expected);
  if (score !== null && score < VERIFY_THRESHOLD[field]) return { ok: false, reason: 'value_mismatch', score };
  const vs = await sizeOf(vin);
  const sideways = textUprightness(acc?.lines ?? [], vs.w, vs.h) < 0;
  // 入職表：裁圖文字越界檢查（其他欄 label 關鍵詞）——座標由 Vision 輸入（放大＋留白）換返裁圖正規化
  const overflow = opts.checkOverflow ? findOverflow(field, (acc?.lines ?? []).map((l) => ({ t: l.t, x: (l.x * vs.w - 24) / (vs.w - 48), y: (l.y * vs.h - 24) / (vs.h - 48), w: (l.w * vs.w) / (vs.w - 48), h: (l.h * vs.h) / (vs.h - 48) })), (l) => lineHasOwnLabel(field, l.t) || scoreAgainst(field, l.t, expected[0] ?? '') >= 0.5 || similarity(field, l.t, expected) >= 0.5) : null;
  const ov0 = overflow ? { overflow } : {};
  if (noExp) {
    // TE-2.1 F：冇預期值——① 沿用同頁其他欄（有預期值）判到嘅方向；② 全頁冇就 .fast 讀四方向（可讀字元數＋字典詞命中）比較，差距明顯先決定；③ 否則維持版面 prior
    const pp0 = opts.pagePrior;
    if (pp0 !== undefined && pp0 !== null) return { ok: true, score: null, rotate: pp0, decisive: false, followedPage: true, ...ov0 };
    const dirs: Rotation[] = [0, 90, 180, 270];
    const f4 = await run(await Promise.all(dirs.map((d) => rotateFile(vin, d, tmp))), true);
    const sc4 = f4.map((p) => readabilityScore(textOf(p)));
    const order = sc4.map((v, i) => ({ v, i })).sort((x, y) => y.v - x.v);
    if (order[0]!.v >= 4 && order[0]!.v >= 1.5 * order[1]!.v + 2) return { ok: true, score: null, rotate: dirs[order[0]!.i]!, decisive: true, ...ov0 };
    if (!sideways) return { ok: true, score: null, rotate: 0, decisive: false, ...ov0 };
    return { ok: false, reason: 'orientation_unknown' };
  }
  const cands: Rotation[] = sideways ? [90, 270] : [0, 180];
  const files = await Promise.all(cands.map((d) => rotateFile(vin, d, tmp)));
  const fast = await run(files, true);
  const sc = fast.map((p) => similarity(field, textOf(p), expected));
  const [a, b] = [sc[0] ?? 0, sc[1] ?? 0];
  const decided = Math.max(a, b) >= 0.5 && Math.abs(a - b) >= 0.2;
  const ov = overflow ? { overflow } : {};
  if (decided) return { ok: true, score, rotate: cands[a >= b ? 0 : 1]!, decisive: true, ...ov };
  // S3：冇證據（例如純中文 .fast 讀唔準）→ 沿用同一頁其他欄判到嘅方向（同頁方向一致）；全頁冇任何欄判到就維持 prior（橫排當 0°、側躺 unknown）
  const pp = opts.pagePrior;
  if (pp !== undefined && pp !== null && cands.includes(pp)) return { ok: true, score, rotate: pp, decisive: false, followedPage: true, ...ov };
  if (!sideways) return { ok: true, score, rotate: 0, decisive: false, ...ov };
  return { ok: false, reason: 'orientation_unknown' };
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
  /** TE-1.7：Vision 驗證通過／冇預期值或冇 Vision 未驗證 */
  verified: number;
  unverified: number;
  /** TE-1.8：硬性尺寸上限收窄咗幾多張 */
  size_capped: number;
  /** TE-1.9：純中文等判唔到方向嘅欄，沿用同頁其他欄方向嘅張數 */
  page_orientation_followed: number;
  /** TE-2.1 G：做咗二階段局部 OCR（300dpi 切塊）嘅頁數 */
  second_stage_pages: number;
  /** TE-2.2：做咗頁面級方向判斷（判到方向）嘅頁數 */
  page_oriented_pages: number;
  /** TE-2.1 H：按欄嘅跳過原因分佈 */
  skipped_by_field: Record<string, Record<string, number>>;
  /** TE-1.8：value_mismatch 嘅最高相似度分佈（按欄；四格 0–0.2／0.2–0.4／0.4–0.6／0.6–0.7） */
  mismatch_hist: Record<string, [number, number, number, number]>;
  zips: number;
  zip_bytes: number;
}
export const emptyStats = (): Stats => ({ persons_total: 0, persons_with_fields: 0, persons_no_docs: 0, persons_failed: 0, requests_total: 0, from_existing: 0, live_cropped: 0, images_out: 0, by_field: {}, by_doc_priority: {}, skipped: {}, existing_ignored_entries: 0, verified: 0, unverified: 0, size_capped: 0, page_orientation_followed: 0, second_stage_pages: 0, page_oriented_pages: 0, skipped_by_field: {}, mismatch_hist: {}, zips: 0, zip_bytes: 0 });
const bump = (r: Record<string, number>, k: string) => {
  r[k] = (r[k] ?? 0) + 1;
};

const PAGE_DICT = /申請人|個人資料|姓名|電話|住址|日期|Name|Phone|Address|Date|Position/gi;
/** 字典詞命中權重高（亂碼都會有字母數字，淨計字數分唔開正倒）；可讀字元數只作輔助。 */
const pageScore = (t: string): number => 0.3 * (t.match(/[0-9A-Za-z]/g) ?? []).length + 20 * (t.match(PAGE_DICT) ?? []).length;

/**
 * TE-2.2：頁面級方向判斷（入職表頁、印刷行所在頁）。將（已按版面 prior 轉正嘅）整頁縮到 1000px 闊，Vision .fast 讀 0° 同 180°，
 * 比較字典詞命中（×20）＋可讀字元數（×0.3）；差距明顯（最高 ≥20 且 ≥1.5×另一個＋8）就回方向，否則 null。每頁只做一次（caller 快取）。
 */
export async function pageResidual(png: string, rot: Rotation, tmp: string, rotCache: Map<string, string> | undefined, run: VisionRunner): Promise<Rotation | null> {
  const page = await rotatedPage(png, rot, tmp, rotCache);
  const id = Math.random().toString(36).slice(2);
  const t0 = path.join(tmp, `po0-${id}.png`);
  const t180 = path.join(tmp, `po180-${id}.png`);
  await sh(MAGICK, [page, '-resize', '1000x', '-colorspace', 'Gray', t0]);
  await sh(MAGICK, [t0, '-rotate', '180', t180]);
  const [a, b] = await run([t0, t180], true);
  const [sa, sb] = [pageScore(textOf(a)), pageScore(textOf(b))];
  const hi = Math.max(sa, sb);
  const lo = Math.min(sa, sb);
  if (hi >= 20 && hi >= 1.5 * lo + 8) return sa >= sb ? 0 : 180;
  return null;
}

/**
 * TE-2.1 G：嵌入卡二階段局部 OCR。200dpi 整頁 OCR 讀唔到右下角細卡，就將該頁以 300dpi 渲染、切 2×2 四格＋中間一格
 * （格間 10% 重疊），各自跑 Vision .accurate，行座標映射返全頁（原點左下）。讀數只喺記憶體。
 */
export async function secondStageLines(doc: DocPage, deps: Deps, tmp: string): Promise<{ lines: OcrLine[]; aspect: number } | null> {
  if (!deps.vision) return null;
  const png = await deps.render(doc);
  if (!png) return null;
  try {
    const { w, h } = await sizeOf(png);
    const tiles: Box[] = [
      { x0: 0, x1: 0.55, y0: 0.45, y1: 1 },
      { x0: 0.45, x1: 1, y0: 0.45, y1: 1 },
      { x0: 0, x1: 0.55, y0: 0, y1: 0.55 },
      { x0: 0.45, x1: 1, y0: 0, y1: 0.55 },
      { x0: 0.25, x1: 0.75, y0: 0.25, y1: 0.75 },
    ];
    const files: string[] = [];
    for (const [i, t] of tiles.entries()) {
      const f = path.join(tmp, `s2-${i}-${Math.random().toString(36).slice(2)}.png`);
      await sh(MAGICK, [png, '-crop', `${Math.round((t.x1 - t.x0) * w)}x${Math.round((t.y1 - t.y0) * h)}+${Math.round(t.x0 * w)}+${Math.round((1 - t.y1) * h)}`, '+repage', f]);
      files.push(f);
    }
    const pages = await deps.vision(files, false);
    const lines: OcrLine[] = [];
    pages.forEach((pg, i) => {
      const t = tiles[i]!;
      for (const l of pg.lines) lines.push({ t: l.t, c: l.c, x: t.x0 + l.x * (t.x1 - t.x0), y: t.y0 + l.y * (t.y1 - t.y0), w: l.w * (t.x1 - t.x0), h: l.h * (t.y1 - t.y0) });
    });
    return { lines, aspect: w / h };
  } finally {
    await deps.cleanup(png);
  }
}

export interface PersonInput {
  person: PkgPerson;
  docs: DocPage[];
  /** 額外候選值／讀數（例如 person-fields 嘅 candidates），只用嚟驗證 */
  extra?: Partial<Record<EvidenceField, string[]>>;
  /** TE-2：呢個人所有文件嘅所有頁（唔理導入分類）——搵嵌入式身份證、印刷身份證號 */
  scanPages?: { docId: string; page: number }[];
}

const rank = (f: EvidenceField): number => (f === 'hire_date' ? 2 : f === 'name_zh' ? 1 : 0);

/**
 * S4：無預期值嘅 hkid 圖（printed／嵌入卡）加交叉一致性——該人有任何 confirmed 姓名（中或英）時，同一頁 OCR 行（二階段局部 OCR 讀數）
 * 要有相似姓名（中文字元重疊 ≥0.5／英文 token 覆蓋 ≥0.5）先出圖；冇 confirmed 姓名照出。只喺記憶體比對。
 */
export function crossNameOk(p: PkgPerson, pageLines: readonly OcrLine[]): boolean {
  const names: { field: EvidenceField; value: string }[] = [];
  if (p.nameZh.status === 'confirmed' && p.nameZh.value) names.push({ field: 'name_zh', value: p.nameZh.value });
  if (p.nameEn.status === 'confirmed' && p.nameEn.value) names.push({ field: 'name_en', value: p.nameEn.value });
  if (names.length === 0) return true;
  const text = pageLines.map((l) => l.t).join(' ');
  return names.some((n) => scoreAgainst(n.field, text, n.value) >= 0.5);
}

/** 掃描頁假設嘅頁面闊高比（A4 直向）；實際裁圖用真實像素尺寸 */
const SCAN_ASPECT = 210 / 297;

/** 核心：每人 → 請求 → 圖（現成優先；否則 OCR 幾何即時裁）→ items。純粹經 deps 做 IO。 */
export async function produceItems(people: readonly PersonInput[], deps: Deps, stats: Stats, opts: { concurrency?: number } = {}): Promise<EvidenceItem[]> {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'te1-'));
  const items: EvidenceItem[] = [];
  try {
    await runPool([...people], opts.concurrency ?? 1, async (pi) => {
      const fields = evidenceFieldsOf(pi.person);
      if (fields.length === 0) return;
      stats.persons_with_fields += 1;
      if (pi.docs.length === 0 && !(pi.scanPages?.length)) {
        stats.persons_no_docs += 1;
        return;
      }
      const match = matchOfPerson(pi.person);
      // name_zh（純中文，.fast 判唔準方向）排最後，先令其他欄有機會判到同頁方向
      // TE-2：一頁多文件——搵嵌入式身份證（冇整頁身份證副本時）同印刷身份證號行（任何頁，唔理導入分類）
      const needsId = fields.some((f) => f === 'hkid' || f === 'name_zh' || f === 'name_en' || f === 'dob');
      const hasClassicId = pi.docs.some((d) => d.type === 'id_card');
      const embedded: EmbeddedSource[] = [];
      const extraLines = new Map<string, OcrLine[]>(); // 二階段局部 OCR 嘅行（deps.lines 讀唔到嵌入卡）
      const printed: PrintedSource[] = [];
      if ((needsId && !hasClassicId) || fields.includes('hkid')) {
        for (const sp of pi.scanPages ?? []) {
          if (embedded.length > 0 && printed.length > 0) break;
          const doc: DocPage = { type: 'id_card', docId: sp.docId, page: sp.page };
          const lines = await deps.lines(doc).catch(() => null);
          if (!lines) continue;
          const det = detectEmbeddedCards(lines, SCAN_ASPECT);
          if (det && needsId && !hasClassicId && embedded.length === 0) embedded.push({ doc, rot: det.rot, region: det.cards[0]!.box });
          if (fields.includes('hkid') && printed.length === 0) {
            const inCard = (l: OcrLine) => !!det && det.cards.some((c) => inBox(c.box, rotateLines([l], det.rot)[0]!));
            for (const pr of findPrintedHkidLines(lines, SCAN_ASPECT, inCard)) printed.push({ doc, rot: pr.rot, line: pr.line });
          }
        }
      }
      // TE-2.1 G：hkid 未確認、冇整頁身份證、第一階段又搵唔到嵌入卡 → 對該人每個掃描頁做二階段局部 OCR（只對呢批人，控制成本）
      if (deps.vision && pi.person.hkid.status !== 'confirmed' && !hasClassicId && embedded.length === 0) {
        for (const sp of pi.scanPages ?? []) {
          if (embedded.length > 0) break;
          const doc: DocPage = { type: 'id_card', docId: sp.docId, page: sp.page };
          const s2 = await secondStageLines(doc, deps, tmp).catch(() => null);
          if (!s2) continue;
          stats.second_stage_pages += 1;
          const det = detectEmbeddedCards(s2.lines, s2.aspect);
          if (det) {
            embedded.push({ doc, rot: det.rot, region: det.cards[0]!.box });
            // 二階段嘅卡區行座標係局部 OCR 嘅——crop 流程要用同一批行（deps.lines 讀唔到卡）
            extraLines.set(`${doc.docId}|${doc.page}`, s2.lines);
          }
          if (printed.length === 0) {
            const inCard = (l: OcrLine) => !!det && det.cards.some((c) => inBox(c.box, rotateLines([l], det.rot)[0]!));
            for (const pr of findPrintedHkidLines(s2.lines, s2.aspect, inCard)) printed.push({ doc, rot: pr.rot, line: pr.line });
          }
        }
      }
      const reqs = [...planRequests(fields, pi.docs, { embedded, printed })].sort((x, y) => rank(x.field) - rank(y.field)); // 有預期值嘅欄先（記低同頁方向），name_zh（純中文判唔到方向）、hire_date（冇預期值）最後
      const pageCache = new Map<string, string | null>();
      const rotCache = new Map<string, string>();
      // S3：同一頁方向一致——有欄判到（decisive）就記低，純中文姓名等判唔到嘅欄跟返
      const pageRot = new Map<string, Rotation>();
      const pageOriented = new Set<string>();
      const hookFor = (req: CropRequest): VerifyHook | undefined => {
        if (!deps.vision) return undefined;
        const expected = expectedValuesFor(req.field, pi.person, pi.extra?.[req.field] ?? []);
        const key = `${req.doc.docId}|${req.doc.page}`;
        return async (png) => {
          const out = await verifyCrop(png, req.field, expected, deps.vision!, tmp, { checkOverflow: req.docKind === 'onboarding_form', pagePrior: pageRot.get(key) ?? null });
          if (out.ok && out.decisive) pageRot.set(key, out.rotate);
          if (out.ok && out.followedPage) stats.page_orientation_followed += 1;
          return out;
        };
      };
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
          let score: number | undefined;
          const ex = req.docKind === 'address_proof' ? deps.existing(req) : null; // M8：身份證一律即時裁；入職表（成行裁、含相片）亦一律即時單格裁；現成圖只用於住址證明
          if (ex) {
            const r = await finalizeChecked(ex, null, tmp, { bandCheck: true, ...(hookFor(req) ? { verify: hookFor(req)! } : {}) }).catch(() => ({ reason: 'image_spec_fail' as const }));
            if ('bytes' in r) {
              bytes = r.bytes;
              score = r.score;
              from = 'existing';
            } else skip = r.reason;
          }
          if (!bytes && !skip) {
            const lines = (req.embedded || req.printed ? extraLines.get(`${req.doc.docId}|${req.doc.page}`) : undefined) ?? (await deps.lines(req.doc));
            if (!lines) skip = 'no_ocr_lines';
            else {
              const crossBad = req.field === 'hkid' && (req.printed || req.embedded) && expectedValuesFor('hkid', pi.person, pi.extra?.hkid ?? []).length === 0 && !crossNameOk(pi.person, lines);
              const png = crossBad ? null : await getPage(req.doc);
              if (crossBad) skip = 'cross_name_mismatch';
              else if (!png) skip = 'render_fail';
              else {
                // TE-2.2：入職表頁／印刷行所在頁——頁面級方向（每頁一次），所有該頁裁圖沿用（無預期值嘅欄靠呢個）
                const pkey = `${req.doc.docId}|${req.doc.page}`;
                if (deps.vision && (req.docKind === 'onboarding_form' || req.printed) && !pageOriented.has(pkey)) {
                  pageOriented.add(pkey);
                  const prior = req.printed?.rot ?? detectUprightRotation(req.docKind, lines) ?? 0;
                  const res = await pageResidual(png, prior, tmp, rotCache, deps.vision).catch(() => null);
                  if (res !== null) {
                    pageRot.set(pkey, res);
                    stats.page_oriented_pages += 1;
                  }
                }
                const r = await cropRequest(req, png, lines, tmp, rotCache, hookFor(req)).catch(() => ({ reason: 'image_spec_fail' }) as { reason: string; capped?: boolean; score?: number });
                if (r.capped) stats.size_capped += 1;
                if ('bytes' in r) {
                  bytes = r.bytes;
                  score = (r as { score?: number }).score;
                } else {
                  skip = r.reason;
                  if (r.reason === 'value_mismatch' && typeof (r as { score?: number }).score === 'number') {
                    const sc = (r as { score: number }).score;
                    const hist = (stats.mismatch_hist[req.field] ??= [0, 0, 0, 0]);
                    hist[sc < 0.2 ? 0 : sc < 0.4 ? 1 : sc < 0.6 ? 2 : 3] += 1;
                  }
                }
                from = 'live';
              }
            }
          }
          if (!bytes) {
            bump(stats.skipped, skip ?? 'image_spec_fail');
            bump((stats.skipped_by_field[req.field] ??= {}), skip ?? 'image_spec_fail');
            continue;
          }
          if (score !== undefined) stats.verified += 1;
          else stats.unverified += 1;
          items.push({ bytes, field: req.field, docKind: req.docKind, priority: req.priority, match, ...(score !== undefined ? { verifyScore: score } : {}) });
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
  // 額外候選值／讀數：person-fields-ext 若帶 `fields.<欄>.value／candidates` 就一併當預期值（淨用嚟驗證）
  const normNo = (x: string) => x.normalize('NFKC').toUpperCase().replace(/\s+/g, '');
  type ExtFields = Record<string, { value?: string | null; candidates?: string[] }>;
  const extByNo = new Map<string, ExtFields[]>();
  for (const r of ext as (ExtRow & { fields?: ExtFields })[]) {
    if (!r.fields) continue;
    for (const no of [...(r.key ? [r.key] : []), ...(r.staffNos ?? [])]) extByNo.set(normNo(no), [...(extByNo.get(normNo(no)) ?? []), r.fields]);
  }
  const PKG_TO_EXT: Partial<Record<EvidenceField, string>> = { hkid: 'hkid', name_zh: 'nameZh', name_en: 'nameEn', dob: 'dateOfBirth', phone: 'phone', address: 'address' };
  const extraOf = (person: PkgPerson): PersonInput['extra'] => {
    const out: Partial<Record<EvidenceField, string[]>> = {};
    for (const f of Object.keys(PKG_TO_EXT) as EvidenceField[]) {
      const vals = person.staffNumbers.flatMap((n) => extByNo.get(normNo(n.number)) ?? []).flatMap((fl) => {
        const e = fl[PKG_TO_EXT[f]!];
        return e ? [...(e.value ? [e.value] : []), ...(e.candidates ?? [])] : [];
      });
      if (vals.length) out[f] = vals;
    }
    return out;
  };
  // TE-2：每個人所有文件嘅所有頁（除入職表頁）——搵嵌入式身份證／印刷身份證號（唔理導入分類）
  const scanPagesOf = (person: PkgPerson) =>
    docIdsForPerson(person, staffIdx).flatMap((docId) => (extractBy.get(docId)?.pages ?? []).filter((pg) => !pg.kinds.includes('application_form') && !pg.kinds.includes('blank')).map((pg) => ({ docId, page: pg.page })));
  return { people: persons.map((person) => ({ person, docs: pickDocPages(docIdsForPerson(person, staffIdx), extractBy), extra: extraOf(person), scanPages: scanPagesOf(person) })), deps, existingIgnored: ex.ignored, personsTotal };
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
    L('入職日期：', 0.08, 0.6, 0.11), L('可到職日期：', 0.4, 0.6, 0.13), L('2026-11-01', 0.54, 0.6, 0.12),
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

/**
 * 保安牌照頁（右下角貼住一張細身份證副本）——TE-2 嵌入式身份證 fixture。
 * 卡：號碼印喺相片正下方（右下）、左邊英文名／中文名／出生日期／簽發日期；卡區 x≈0.51–0.82、y≈0.10–0.24。
 */
export function syntheticPermitPageWithEmbeddedCard(): { lines: OcrLine[]; photo: Box } {
  const lines: OcrLine[] = [
    L('保安人員許可證 SECURITY PERSONNEL PERMIT', 0.08, 0.92, 0.6),
    L('許可證編號 PERMIT NO. S-123456-7', 0.08, 0.85, 0.4),
    L('屆滿日期 2028-03-01', 0.08, 0.8, 0.3),
    // 嵌入式身份證副本
    L('TESTER, Alpha', 0.53, 0.215, 0.14, 0.012),
    L('測試甲', 0.53, 0.2, 0.06, 0.012),
    L('出生日期 Date of Birth', 0.53, 0.185, 0.16, 0.012),
    L('15-01-1990', 0.55, 0.17, 0.1, 0.012),
    L('簽發日期 Date of Issue', 0.53, 0.15, 0.15, 0.012),
    L(HK_ID_VALID, 0.72, 0.12, 0.08, 0.016),
  ];
  return { lines, photo: { x0: 0.71, x1: 0.81, y0: 0.142, y1: 0.235 } };
}

/** 證書頁（QASRS）：印刷咗身份證號（整行，唔喺任何卡區內）。 */
export function syntheticCertificatePage(): OcrLine[] {
  return [L('QASRS 證書 CERTIFICATE', 0.1, 0.9, 0.4), L('姓名 NAME TESTER ALPHA', 0.1, 0.8, 0.4), L(HK_ID_VALID, 0.4, 0.6, 0.12, 0.02), L('2026-01-01', 0.4, 0.5, 0.1)];
}

interface DryDoc {
  doc: DocPage;
  /** deps.lines 回嘅 OCR 行（200dpi 整頁 OCR 讀到嘅） */
  lines: OcrLine[];
  photo?: Box;
  /** TE-2.1：頁面上有畫、但 200dpi 整頁 OCR 讀唔到嘅行（細卡）——只有二階段局部 OCR 先讀到 */
  hidden?: OcrLine[];
}
const lf = (value: string | null, status: 'confirmed' | 'review' | 'missing') => ({ value, status });
const dryPerson = (n: number, over: Partial<PkgPerson> = {}): PkgPerson => ({
  key: `dry-person-${n}`,
  hkid: lf(HK_ID_VALID, 'review'),
  nameZh: lf('測試甲', 'review'),
  nameEn: lf('TESTER ALPHA', 'review'),
  dateOfBirth: lf('1990-01-15', 'review'),
  phone: lf('90001110', 'review'),
  address: lf('火炭示範街99號虛構大廈15樓A室', 'review'),
  staffNumbers: [{ scheme: 'DRY', number: `DRY${n}` }],
  reasons: [],
  ...over,
});

export function dryFixture(): { people: PersonInput[]; docs: Map<string, DryDoc> } {
  const docs = new Map<string, DryDoc>();
  const add = (type: DocPage['type'], n: number, lines: OcrLine[], photo?: Box, hidden?: OcrLine[]): DocPage => {
    const doc: DocPage = { type, docId: `dry-doc-${n}-${type}`, page: 1 };
    docs.set(`${doc.docId}|1`, { doc, lines, ...(photo ? { photo } : {}), ...(hidden ? { hidden } : {}) });
    return doc;
  };
  const a = syntheticIdCardPage();
  const b = syntheticIdCardPage();
  // 認唔出卡面：冇標題 anchor、亦冇出生日期／簽發日期 label（連嵌入式偵測都認唔到）
  const noAnchor = syntheticIdCardPage(false);
  noAnchor.lines = noAnchor.lines.filter((l) => !/出生日期|簽發日期/.test(l.t));
  return {
    docs,
    people: [
      { person: dryPerson(1), docs: [add('id_card', 1, a.lines, a.photo), add('address_proof', 1, syntheticAddressProofPage()), add('onboarding_form', 1, syntheticFormPage(), SYNTHETIC_FORM_PHOTO)] }, // 三份文件齊
      { person: dryPerson(2), docs: [add('id_card', 2, b.lines, b.photo), add('onboarding_form', 2, syntheticFormPage(), SYNTHETIC_FORM_PHOTO)] }, // 冇住址證明 → 住址退入職表
      { person: dryPerson(3), docs: [add('onboarding_form', 3, syntheticFormPage(), SYNTHETIC_FORM_PHOTO)] }, // 冇證件 → 退入職表
      { person: dryPerson(4), docs: [] }, // 冇文件
      { person: dryPerson(5), docs: [add('id_card', 5, noAnchor.lines, noAnchor.photo), add('onboarding_form', 5, syntheticFormPage(), SYNTHETIC_FORM_PHOTO)] }, // 認唔出卡面 → 身份證欄唔裁（避免連相片一齊裁）
      // TE-2：全部欄 missing（導入流程分類漏咗）：入職表 1 頁；牌照頁右下角嵌身份證；證書頁印刷咗號碼
      (() => {
        const permit = syntheticPermitPageWithEmbeddedCard();
        const permitDoc = add('sia_permit' as DocPage['type'], 7, permit.lines, permit.photo);
        const certDoc = add('sia_permit' as DocPage['type'], 70, syntheticCertificatePage());
        const form = add('onboarding_form', 7, syntheticFormPage(), SYNTHETIC_FORM_PHOTO);
        return {
          person: dryPerson(7, { hkid: lf(null, 'missing'), nameZh: lf(null, 'missing'), nameEn: lf(null, 'missing'), dateOfBirth: lf(null, 'missing'), phone: lf(null, 'missing'), address: lf(null, 'missing') }),
          docs: [form],
          scanPages: [permitDoc, certDoc].map((d) => ({ docId: d.docId, page: d.page })),
        } as PersonInput;
      })(),
      // TE-2.1 G：hkid missing；牌照頁嘅細卡 200dpi 整頁 OCR 讀唔到（hidden），要二階段局部 OCR 先搵到
      (() => {
        const permit = syntheticPermitPageWithEmbeddedCard();
        const isCard = (l: OcrLine) => l.y < 0.25 && l.x > 0.5;
        const permitDoc = add('sia_permit' as DocPage['type'], 8, permit.lines.filter((l) => !isCard(l)), permit.photo, permit.lines.filter(isCard));
        return {
          person: dryPerson(8, { hkid: lf(null, 'missing'), nameZh: lf(null, 'missing'), nameEn: lf(null, 'missing'), dateOfBirth: lf(null, 'missing'), phone: lf(null, 'missing'), address: lf(null, 'missing') }),
          docs: [add('onboarding_form', 8, syntheticFormPage(), SYNTHETIC_FORM_PHOTO)],
          scanPages: [{ docId: permitDoc.docId, page: permitDoc.page }],
        } as PersonInput;
      })(),
      { person: dryPerson(6, { hkid: lf(HK_ID_VALID, 'confirmed'), nameZh: lf('測試甲', 'confirmed'), nameEn: lf('TESTER ALPHA', 'confirmed'), dateOfBirth: lf('1990-01-15', 'confirmed'), phone: lf('90001110', 'confirmed'), address: lf('舊地址', 'confirmed') }), docs: [] }, // 冇 review 欄
    ],
  };
}

/**
 * 用 ImageMagick 畫假頁：白底、文字行＝深灰細條（高度 40%，似字形比 OCR box 細）、相片區＝純紅（身份證）／深色格（入職表）。
 * rotateDeg＝將成頁順時針轉（模擬掃描時擺反：OCR 行座標要用 rotateLines 同步轉）。
 */
const FONT_LATIN = '/System/Library/Fonts/Supplemental/Arial.ttf';
const FONT_CJK = '/System/Library/Fonts/Hiragino Sans GB.ttc';
/** 本機有字體先畫真文字（Vision 驗證 fixture 用）；冇就畫細條 */
export const hasSyntheticFonts = existsSync(FONT_LATIN) && existsSync(FONT_CJK);

export async function drawSyntheticPage(d: DryDoc, out: string, size = { w: 2000, h: 2800 }, rotateDeg: Rotation = 0): Promise<void> {
  const args = ['-size', `${size.w}x${size.h}`, 'xc:white'];
  const rect = (b: Box, color: string) => ['-fill', color, '-draw', `rectangle ${Math.round(b.x0 * size.w)},${Math.round((1 - b.y1) * size.h)} ${Math.round(b.x1 * size.w)},${Math.round((1 - b.y0) * size.h)}`];
  if (d.photo) args.push(...rect(d.photo, d.doc.type === 'onboarding_form' ? 'rgb(40,30,30)' : 'rgb(255,0,0)'));
  for (const l of [...d.lines, ...(d.hidden ?? [])]) {
    if (!hasSyntheticFonts) {
      args.push(...rect({ x0: l.x, x1: l.x + l.w, y0: l.y + l.h * 0.3, y1: l.y + l.h * 0.7 }, 'rgb(60,60,60)'));
      continue;
    }
    const cjk = (l.t.match(/[\u3000-\u9fff\uff00-\uffef]/g) ?? []).length;
    const unit = cjk > 0 ? 1.0 : 0.6; // 每字約佔 pointsize 幾多
    const ps = Math.max(8, Math.min(l.h * size.h * 0.72, (l.w * size.w) / Math.max(1, l.t.length * unit)));
    args.push('-font', cjk > 0 ? FONT_CJK : FONT_LATIN, '-pointsize', String(Math.round(ps)), '-fill', 'rgb(30,30,30)', '-gravity', 'NorthWest', '-annotate', `+${Math.round(l.x * size.w)}+${Math.round((1 - (l.y + l.h)) * size.h + l.h * size.h * 0.1)}`, l.t);
  }
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
  // S2：先搵 Vision（讀檔之前）。真跑搵唔到＝停止（exit 1），除非明確 --no-verify；--dry 自動降級 warn。
  let vision: VisionRunner | undefined = injected?.deps.vision;
  if (!args.noVerify && !vision) {
    const bin = await resolveVisionBin(args.visionBin);
    if (bin) vision = makeVisionRunner(bin);
    else if (args.dry) console.warn('[triage-evidence] 搵唔到／編譯唔到 vision-ocr（要 swiftc）——--dry 自動 no-verify（唔驗證裁圖內容同方向）');
    else throw new ArgError('搵唔到／編譯唔到 vision-ocr（要 swiftc，或 --vision-bin 指定執行檔）——真跑唔可以靜靜哋唔驗證；確實要跳過驗證請明確加 --no-verify');
  }
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
  if (vision) deps = { ...deps, vision };
  const items = await produceItems(people, deps, stats, { concurrency: args.dry ? 1 : args.concurrency });
  const built = await buildEvidenceZips(items);
  stats.zips = built.zips.length;
  stats.zip_bytes = built.zips.reduce((a, z) => a + z.byteLength, 0);
  return { items, zips: built.zips, stats };
}

export const statsLines = (s: Stats): string[] => [
  `package 人數 ${s.persons_total}｜有 review 欄 ${s.persons_with_fields}｜冇文件 ${s.persons_no_docs}｜失敗 ${s.persons_failed}`,
  `請求 ${s.requests_total}｜現成裁圖 ${s.from_existing}｜即時裁 ${s.live_cropped}｜出圖 ${s.images_out}｜Vision 驗證 ${s.verified}／未驗證 ${s.unverified}｜zip ${s.zips}（${s.zip_bytes} bytes）`,
  `每欄：${JSON.stringify(s.by_field)}｜來源:優先：${JSON.stringify(s.by_doc_priority)}`,
  `跳過原因：${JSON.stringify(s.skipped)}｜忽略嘅現成裁圖清單項 ${s.existing_ignored_entries}｜硬性尺寸上限收窄 ${s.size_capped}｜沿用同頁方向 ${s.page_orientation_followed}`,
  `二階段局部 OCR 頁數 ${s.second_stage_pages}｜頁面級方向判到 ${s.page_oriented_pages}｜按欄跳過原因：${JSON.stringify(s.skipped_by_field)}`,
  `value_mismatch 最高相似度分佈（按欄；[0–0.2, 0.2–0.4, 0.4–0.6, 0.6–0.7]）：${JSON.stringify(s.mismatch_hist)}`,
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
