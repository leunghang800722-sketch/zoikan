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
import { sameEnglishTokens } from '@/lib/triage/generators/guard-import';
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

/** TE-4.1：卡上讀到嘅姓名 vs 包內任何已有姓名（唔理 status、就算冇出建議）。 */
export function cardNamesConflict(pkg: { nameZh?: string | null; nameEn?: string | null }, card: { nameZh?: string | null; nameEn?: string | null }): boolean {
  const pz = pkg.nameZh?.trim();
  const pe = pkg.nameEn?.trim();
  if (card.nameZh && pz && normZh(card.nameZh) !== normZh(pz)) return true;
  if (card.nameEn && pe && !sameEnglishTokens(card.nameEn, pe)) return true;
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
