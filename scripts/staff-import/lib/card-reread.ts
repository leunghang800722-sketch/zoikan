// TE-4：重讀腳本嘅「嵌入身份證副本」流程核心（純函數＋可注入 IO，方便 vitest 用合成 fixture 測）。
// 牌照頁等夾住一張細身份證副本（可能倒轉）：用 TE-2／2.1 嘅偵測（第一階段整頁 OCR 行；搵唔到再二階段 300dpi 分格局部 OCR、四方向）
// 搵卡區 → 轉正裁成一張獨立卡圖（≤1600px）→ 交真 OCR 管線（id_card two-stage，同整頁身份證一樣）。
// 另外收集「印刷」身份證號（證書／牌照頁行內、唔喺卡區內、checksum 通過）作佐證。
// 鐵則：卡圖只喺記憶體／系統暫存（用完即刪）；console 只計數，唔印值。
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { canonicalHkid, hkidCheckDigitValid } from './hkid';
import { createHash } from 'node:crypto';
import { normZh } from '@/lib/guards/import/text';
import { scanPageHkids } from './extract';
import { inBox, type Box } from './embedded-card';
import { detectEmbeddedCards, rotateLines, type Rotation } from './triage-evidence-core';
import type { OcrLine } from './ocr';
import type { RereadProposal } from './triage-reread-core';

const sh = promisify(execFile);
const MAGICK = process.env.MAGICK_BIN ?? (existsSync('/opt/homebrew/bin/magick') ? '/opt/homebrew/bin/magick' : 'magick');

/** 掃描頁假設嘅頁面闊高比（A4 直向；實際裁圖用真實像素） */
export const SCAN_ASPECT = 210 / 297;
/** 每個人最多掃幾多頁搵嵌入卡（控制 Vision 成本） */
export const MAX_SCAN_PAGES = 12;
/** 卡圖長邊上限（交 OCR 管線前） */
export const CARD_MAX_EDGE = 1600;

export interface CardPageRef {
  docId: string;
  page: number;
}
export interface CardSource extends CardPageRef {
  /** 要順時針轉幾多度頁面先令卡正向 */
  rot: Rotation;
  /** 轉正後 frame 嘅卡區（Vision 正規化、原點左下） */
  box: Box;
  stage: 'first' | 'second';
}
export interface CardDeps {
  /** 第一階段：整頁 OCR 行（讀唔到＝null） */
  lines(ref: CardPageRef): Promise<OcrLine[] | null>;
  /** 第二階段：300dpi 分格局部 OCR（冇 Vision＝唔提供） */
  secondStage?(ref: CardPageRef): Promise<{ lines: OcrLine[]; aspect: number } | null>;
}
export interface CardScan {
  card: CardSource | null;
  /** 印刷身份證號（canon、checksum 通過、唔喺卡區內；去重；未經混淆修正） */
  printed: string[];
  /** TE-4.1 S1：經 OCR 混淆修正先得嘅印刷號碼（只可令狀態變「唔一致」，唔可升 high） */
  printedFixed: string[];
  pagesScanned: number;
  secondStagePages: number;
}

/** 頁面所有行入面、唔喺卡區內嘅行（det＝null 就全部）。 */
export function linesOutsideCards(lines: readonly OcrLine[], det: { rot: Rotation; cards: { box: Box }[] } | null): OcrLine[] {
  if (!det) return [...lines];
  return lines.filter((l) => !det.cards.some((c) => inBox(c.box, rotateLines([l], det.rot)[0]!)));
}

const printedOf = (page: number, lines: readonly OcrLine[], det: { rot: Rotation; cards: { box: Box }[] } | null): { value: string; fixed: boolean }[] =>
  scanPageHkids(page, linesOutsideCards(lines, det))
    .map((f) => ({ value: canonicalHkid(f.value) ?? '', fixed: f.note === 'ocr_confusion_fixed' }))
    .filter((v) => !!v.value && hkidCheckDigitValid(v.value));

/**
 * 掃一個人嘅頁（任何導入分類）：第一階段全部頁先；搵唔到卡先逐頁二階段（只對呢批人）。印刷號碼兩個階段都收（去重）。
 * 回第一張搵到嘅卡（同一人多張卡只取第一張；其餘唔猜）。
 */
export async function scanForCard(pages: readonly CardPageRef[], deps: CardDeps, opts: { maxPages?: number } = {}): Promise<CardScan> {
  const list = pages.slice(0, opts.maxPages ?? MAX_SCAN_PAGES);
  const out: CardScan = { card: null, printed: [], printedFixed: [], pagesScanned: 0, secondStagePages: 0 };
  const addPrinted = (vals: { value: string; fixed: boolean }[]) => {
    for (const v of vals) {
      const bucket = v.fixed ? out.printedFixed : out.printed;
      if (!bucket.includes(v.value)) bucket.push(v.value);
    }
  };
  for (const ref of list) {
    const lines = await deps.lines(ref).catch(() => null);
    if (!lines) continue;
    out.pagesScanned += 1;
    const det = detectEmbeddedCards(lines, SCAN_ASPECT);
    if (det && !out.card) out.card = { ...ref, rot: det.rot, box: det.cards[0]!.box, stage: 'first' };
    addPrinted(printedOf(ref.page, lines, det));
  }
  if (!out.card && deps.secondStage) {
    for (const ref of list) {
      const s2 = await deps.secondStage(ref).catch(() => null);
      if (!s2) continue;
      out.secondStagePages += 1;
      const det = detectEmbeddedCards(s2.lines, s2.aspect);
      addPrinted(printedOf(ref.page, s2.lines, det));
      if (det) {
        out.card = { ...ref, rot: det.rot, box: det.cards[0]!.box, stage: 'second' };
        break;
      }
    }
  }
  return out;
}

/** 卡區邊界加 10% 邊距（卡區由號碼行推算，估算有少少偏差）；夾返 0–1。 */
export function padCardBox(b: Box, frac = 0.1): Box {
  const w = b.x1 - b.x0;
  const h = b.y1 - b.y0;
  return { x0: Math.max(0, b.x0 - w * frac), x1: Math.min(1, b.x1 + w * frac), y0: Math.max(0, b.y0 - h * frac), y1: Math.min(1, b.y1 + h * frac) };
}

/** 轉正後 frame 嘅卡區 → 像素裁切矩形（W×H＝轉正後頁面像素；原點左下 → 左上）。 */
export function cardRect(b: Box, W: number, H: number): { x: number; y: number; w: number; h: number } {
  const x = Math.max(0, Math.floor(b.x0 * W));
  const y = Math.max(0, Math.floor((1 - b.y1) * H));
  return { x, y, w: Math.max(1, Math.min(W - x, Math.round((b.x1 - b.x0) * W))), h: Math.max(1, Math.min(H - y, Math.round((b.y1 - b.y0) * H))) };
}

/**
 * 將整頁 png 轉正（rot）→ 裁卡區（加邊距）→ 縮到長邊 ≤1600 → 寫去 outPng（PNG）。回輸出尺寸。
 * 用 ImageMagick；caller 負責用完刪 outPng。
 */
export async function cropCardToPng(pagePng: string, rot: Rotation, box: Box, outPng: string): Promise<{ w: number; h: number }> {
  const id = await sh(MAGICK, [pagePng, ...(rot ? ['-rotate', String(rot)] : []), '-format', '%w %h', 'info:']);
  const [W, H] = id.stdout.trim().split(' ').map(Number) as [number, number];
  const r = cardRect(padCardBox(box), W, H);
  await sh(MAGICK, [pagePng, ...(rot ? ['-rotate', String(rot)] : []), '-crop', `${r.w}x${r.h}+${r.x}+${r.y}`, '+repage', '-resize', `${CARD_MAX_EDGE}x${CARD_MAX_EDGE}>`, outPng]);
  const o = await sh(MAGICK, [outPng, '-format', '%w %h', 'info:']);
  const [w, h] = o.stdout.trim().split(' ').map(Number) as [number, number];
  return { w, h };
}

// ---------------------------------------------------------------------------
// 印刷佐證：卡讀數 vs 印刷號碼
// ---------------------------------------------------------------------------
export type CardPrintedState = 'corroborated' | 'conflict' | 'no_printed';

/**
 * 卡讀到嘅 hkid 對照印刷號碼：
 *  - 未經混淆修正嘅印刷號有一個同卡一致 → corroborated（confidence 升 high）；
 *  - 有 checksum 通過嘅印刷號但冇一個（未修正）同卡一致 → conflict（全部該人嘅卡建議降 low＋printed_card_conflict，留人手）；
 *  - TE-4.1 S1：經混淆修正嘅印刷號（fixed）只可令狀態變 conflict（同卡唔同值），同卡一致都唔算佐證（唔升 high）；
 *  - 冇印刷號碼 → no_printed（卡自己為準，照自動答）。
 */
export function corroborate(cardHkid: string | null, printed: readonly string[], fixed: readonly string[] = []): CardPrintedState {
  const c = canonicalHkid(cardHkid ?? null);
  const valid = printed.filter((p) => hkidCheckDigitValid(p));
  if (valid.length > 0) return c && valid.includes(c) ? 'corroborated' : 'conflict';
  const fv = fixed.filter((p) => hkidCheckDigitValid(p));
  if (fv.length === 0) return 'no_printed';
  return c && fv.includes(c) ? 'no_printed' : 'conflict';
}

const EN_TITLES = /^(MR|MS|MRS|MISS)$/;
/** 英文名 token（NFKC 大寫、標點當空格、去稱謂）；surname＝逗號前嗰個 token（冇逗號＝null） */
function enParts(v: string): { toks: string[]; surname: string | null } {
  const t = v.normalize('NFKC').toUpperCase();
  const comma = t.indexOf(',');
  const clean = (x: string) => x.replace(/[^A-Z]+/g, ' ').trim().split(' ').filter((w) => w && !EN_TITLES.test(w));
  const toks = clean(t);
  const surname = comma > 0 ? (clean(t.slice(0, comma)).slice(-1)[0] ?? null) : null;
  return { toks, surname };
}
/** 若 t 等於 pool 內兩個 token 連寫（任何次序）就將呢兩個併成一個（TAIMAN ≈ TAI + MAN）。 */
function mergeConcat(pool: string[], t: string): string[] {
  for (let i = 0; i < pool.length; i++) for (let j = 0; j < pool.length; j++) if (i !== j && pool[i]! + pool[j]! === t) return pool.filter((_, k) => k !== i && k !== j).concat(t);
  return pool;
}
/**
 * TE-4.2 S2：放寬嘅英文名比對（只用嚟卡 vs 包內一致性，唔影響銀行配對用嘅 sameEnglishTokens）：
 * 接受縮寫（只比首字母，CHAN T M ≈ CHAN TAI MAN）同名字連寫（TAIMAN ≈ TAI MAN）；token 數要相同；姓氏要相同（有逗號就係逗號前嗰個，冇就至少一個 ≥2 字母嘅完整 token 相同）。
 */
export function looseEnglishNameMatch(a: string, b: string): boolean {
  const A = enParts(a);
  const B = enParts(b);
  let x = [...A.toks];
  let y = [...B.toks];
  if (x.length === 0 || y.length === 0) return false;
  for (const t of [...x]) if (!y.includes(t) && t.length > 2) y = mergeConcat(y, t);
  for (const t of [...y]) if (!x.includes(t) && t.length > 2) x = mergeConcat(x, t);
  if (x.length !== y.length || x.length < 2) return false;
  const exact: string[] = [];
  const rest = [...y];
  const left: string[] = [];
  for (const t of x) {
    const i = rest.indexOf(t);
    if (i >= 0) {
      rest.splice(i, 1);
      if (t.length >= 2) exact.push(t);
    } else left.push(t);
  }
  for (const t of left) {
    const i = rest.findIndex((u) => (t.length === 1 && u.startsWith(t)) || (u.length === 1 && t.startsWith(u)));
    if (i < 0) return false;
    rest.splice(i, 1);
  }
  const sn = A.surname ?? B.surname;
  return sn ? exact.includes(sn) : exact.length >= 1;
}

/**
 * TE-4.1／4.2：卡上讀到嘅姓名／出生日期 vs 包內已有資料（唔理 status、就算冇出建議；出生日期只比已確認）。
 *  - 中文名兩邊都有而且一致（normZh）→ 唔理英文名差異；中文名兩邊都有但唔同 → 唔一致；
 *  - 否則英文名用 looseEnglishNameMatch（縮寫／連寫／姓氏相同）；
 *  - 出生日期：包內已確認而卡上讀到唔同日 → 唔一致。
 */
export function cardNamesConflict(pkg: { nameZh?: string | null; nameEn?: string | null; dobConfirmed?: string | null }, card: { nameZh?: string | null; nameEn?: string | null; dob?: string | null }): boolean {
  const pz = pkg.nameZh?.trim();
  const pe = pkg.nameEn?.trim();
  if (card.dob && pkg.dobConfirmed && card.dob.trim() !== pkg.dobConfirmed.trim()) return true;
  if (card.nameZh && pz) {
    if (normZh(card.nameZh) !== normZh(pz)) return true;
    return false; // 中文名一致：唔理英文名差異
  }
  if (card.nameEn && pe && !looseEnglishNameMatch(card.nameEn, pe)) return true;
  return false;
}

/** 套用印刷佐證去呢個人嘅（來自嵌入卡）建議。回新建議陣列＋狀態。 */
export function applyCorroboration(proposals: readonly RereadProposal[], printed: readonly string[], fixed: readonly string[] = []): { proposals: RereadProposal[]; state: CardPrintedState | 'no_card_hkid' } {
  const hk = proposals.find((p) => p.field === 'hkid');
  if (!hk) return { proposals: proposals.map((p) => ({ ...p, flags: ['embedded_card'] as RereadProposal['flags'] })), state: 'no_card_hkid' };
  const state = corroborate(hk.value, printed, fixed);
  const flags: NonNullable<RereadProposal['flags']> = state === 'corroborated' ? ['embedded_card', 'printed_corroborated'] : state === 'conflict' ? ['embedded_card', 'printed_card_conflict'] : ['embedded_card'];
  return { proposals: proposals.map((p) => ({ ...p, confidence: state === 'conflict' ? 'low' : state === 'corroborated' ? 'high' : p.confidence, flags })), state };
}

/** TE-4.1：整人一致性不通過（卡姓名／cross／打字名單同包內唔一致）→ 該人所有卡建議降 low＋card_name_conflict。 */
export function markCardNameConflict(proposals: readonly RereadProposal[]): RereadProposal[] {
  return proposals.map((p) => ({ ...p, confidence: 'low', flags: [...new Set([...(p.flags ?? []), 'card_name_conflict' as const])] }));
}

/** 快取 key 用：卡區 box／rot／stage 嘅短 hash（改咗卡區就唔會誤中舊快取）。 */
export function cardKeyHash(e: { rot: number; box: Box; stage: string }): string {
  const r = (n: number) => n.toFixed(4);
  return createHash('sha256').update(`${e.rot}|${r(e.box.x0)}|${r(e.box.y0)}|${r(e.box.x1)}|${r(e.box.y1)}|${e.stage}`).digest('hex').slice(0, 8);
}

/** 冇卡、只有印刷號碼（唯一一個 checksum 通過）→ 標 review（low，唔自動答）嘅 hkid 建議。 */
export function printedOnlyProposal(personKey: string, printed: readonly string[], match: RereadProposal['match']): RereadProposal | null {
  const valid = [...new Set(printed.filter((p) => hkidCheckDigitValid(p)))];
  if (valid.length !== 1) return null;
  return { person_key: personKey, field: 'hkid', value: valid[0]!, basis: 'two_reads', doc: 'id_card', confidence: 'low', flags: ['printed_only'], match };
}

// ---------------------------------------------------------------------------
// TE-11.2：錯人卡防線——卡讀數（整頁身份證／嵌入卡）同入職表讀數分級（證件為準，但夾錯證件要攔）
// ---------------------------------------------------------------------------
export type FormGrade = 'agree' | 'minor' | 'minor_unproven' | 'conflict' | 'no_form';
export interface NameDob {
  nameZh?: string | null;
  nameEn?: string | null;
  dob?: string | null;
}

const hanOf = (s: string): string[] => [...s.normalize('NFKC')].filter((c) => /\p{Script=Han}/u.test(c));
/** 卡上中文字有幾多喺入職表中文名入面出現（0–1） */
export function zhOverlap(card: string, form: string): number {
  const c = hanOf(card);
  const f = new Set(hanOf(form));
  return c.length === 0 ? 0 : c.filter((x) => f.has(x)).length / c.length;
}
const enTokenSet = (s: string): string => [...(s.normalize('NFKC').toUpperCase().match(/[A-Z]+/g) ?? [])].sort().join(' ');

const enTokens = (s: string): string[] => s.normalize('NFKC').toUpperCase().match(/[A-Z]+/g) ?? [];

/**
 * 入職表差異分級（TE-11.3：兄弟姊妹證件夾錯防線）：
 *  - 出生日期兩邊都讀到而唔同 → conflict；入職表冇可比姓名 → no_form（要打字名單／印刷佐證）；
 *  - 中英文兩邊都可比：**兩樣都要過**先算輕微差異（中文字元重疊 ≥0.5；英文 looseEnglishNameMatch，或入職表 token 係卡 token 子集＝漏咗中間名）；任一唔過 → conflict；
 *  - 只得中文可比：完全相同 → agree；重疊 ≥0.5 但唔完全相同（例如差 1 字）→ 有硬證據（hard）先 minor（high），冇 → minor_unproven（medium 留人）；重疊 <0.5 → conflict；
 *  - 只得英文可比：完全相同 → agree；寬鬆一致／子集 → minor；否則 conflict。
 * hard＝入職表手寫 hkid（checksum 過）＝卡 hkid、印刷佐證一致、或打字名單按工號／電話對到而名單姓名＝卡姓名。
 */
export function gradeFormAgreement(card: NameDob, form: NameDob, hard = false): FormGrade {
  if (card.dob && form.dob && card.dob.trim() !== form.dob.trim()) return 'conflict';
  const zhCmp = !!card.nameZh && !!form.nameZh;
  const enCmp = !!card.nameEn && !!form.nameEn;
  if (!zhCmp && !enCmp) return 'no_form';
  const zhExact = zhCmp && normZh(card.nameZh!) === normZh(form.nameZh!);
  const zhOk = zhCmp && zhOverlap(card.nameZh!, form.nameZh!) >= 0.5;
  const enExact = enCmp && enTokenSet(card.nameEn!) === enTokenSet(form.nameEn!);
  const cardEn = new Set(enCmp ? enTokens(card.nameEn!) : []);
  const enSubset = enCmp && enTokens(form.nameEn!).length > 0 && enTokens(form.nameEn!).every((t) => cardEn.has(t)); // 入職表漏咗中間名
  const enOk = enCmp && (looseEnglishNameMatch(card.nameEn!, form.nameEn!) || enSubset);
  if (zhCmp && enCmp) {
    if (!zhOk || !enOk) return 'conflict';
    return zhExact && enExact ? 'agree' : 'minor';
  }
  if (zhCmp) return zhExact ? 'agree' : zhOk ? (hard ? 'minor' : 'minor_unproven') : 'conflict';
  return enExact ? 'agree' : enOk ? 'minor' : 'conflict';
}

/**
 * 套用分級去呢個人嘅「身份證卡」proposals（doc id_card、仲係 high 嘅）：
 *  minor → 維持 high＋form_differs；minor_unproven（中文差 1 字而冇硬證據）→ medium＋form_differs（留人）；conflict → medium＋form_conflict（留人）；
 *  no_form → 打字名單（按工號／電話對到、姓名同卡一致）或印刷佐證一致（printed_corroborated）先維持 high，否則 medium＋card_unverified（留人）；agree → 不變。
 */
export function applyFormGrade(proposals: readonly RereadProposal[], grade: FormGrade, listAgrees: boolean): RereadProposal[] {
  const addFlag = (p: RereadProposal, f: NonNullable<RereadProposal['flags']>[number]): RereadProposal => ({ ...p, flags: [...new Set([...(p.flags ?? []), f])] });
  return proposals.map((p) => {
    if (p.doc !== 'id_card' || p.confidence !== 'high') return p;
    if (grade === 'minor') return addFlag(p, 'form_differs');
    if (grade === 'minor_unproven') return { ...addFlag(p, 'form_differs'), confidence: 'medium' }; // 只得中文可比、差 1 字而冇硬證據 → 留人
    if (grade === 'conflict') return { ...addFlag(p, 'form_conflict'), confidence: 'medium' };
    if (grade === 'no_form' && !listAgrees && !(p.flags ?? []).includes('printed_corroborated')) return { ...addFlag(p, 'card_unverified'), confidence: 'medium' };
    return p;
  });
}
