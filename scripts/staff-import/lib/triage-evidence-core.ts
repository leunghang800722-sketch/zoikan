// TE-1：分流題覆核證據裁圖——本機腳本核心（純函數＋JSZip，零 DB／零 API／零檔案 IO；IO 注入，方便 vitest 用合成 fixture 測）。
// 方案：docs/plans/triage-evidence-crops-plan.md（M7 同一條記錄出圖同 match；M8 身份證裁圖避開相片；§7 每欄來源優先順序）。
// 鐵則：欄位值／姓名／檔名／路徑唔入 console、唔入 zip entry 名（entry 名＝圖 sha256 前 32 位）。
import JSZip from 'jszip';
import { createHash } from 'node:crypto';
import { findHkidCandidates, hkidCheckDigitValid } from './hkid';
import { cardRegion, extractIdCard, isIdAnchorLine } from './extract';
import { cy, norm, type OcrLine } from './ocr';
import { isLabelLine, padAround } from './crop-pad';
import { locateAddressBox } from './crop-box';
import { locateFormAddressBox } from './form-address-crop';
import { locatePhoneBox, type Box } from './phone-crop';
import {
  FIELD_DOC_PRIORITY,
  MAX_IMAGE_BYTES,
  MAX_PER_FIELD,
  MAX_PER_PERSON,
  inspectImage,
  priorityOf,
  type DocKind,
  type EvidenceField,
} from '@/lib/triage/evidence-format';
import type { DocPage, PkgPerson } from './triage-reread-core';

export type { EvidenceField, DocKind };

// ---------------------------------------------------------------------------
// 1. 人 → 要出圖嘅欄
// ---------------------------------------------------------------------------
const IMAGE_MAX_EDGE = 800;
export { IMAGE_MAX_EDGE };

/**
 * 呢個人要出邊啲欄嘅圖：package 該欄 status=review（姓名／英文名／出生日期／電話／地址）；
 * 身份證號 review 或 missing（no_id_card／hkid_not_confirmed 題）。伺服器只收「仍有 open／skipped 題需要」嘅欄，其餘計 skipped_not_needed。
 */
export function evidenceFieldsOf(p: PkgPerson): EvidenceField[] {
  const out: EvidenceField[] = [];
  if (p.hkid.status === 'review' || p.hkid.status === 'missing') out.push('hkid');
  if (p.nameZh.status === 'review') out.push('name_zh');
  if (p.nameEn.status === 'review') out.push('name_en');
  if (p.dateOfBirth.status === 'review') out.push('dob');
  if (p.phone.status === 'review') out.push('phone');
  if (p.address.status === 'review') out.push('address');
  return out;
}

/** manifest match：同一條 package 記錄（身份證值＋工號），即係同一個人嘅文件→裁圖→match（M7）。 */
export function matchOfPerson(p: PkgPerson): { hkid: string | null; staff_numbers: string[] } {
  return { hkid: p.hkid.value?.trim() || null, staff_numbers: p.staffNumbers.map((n) => n.number) };
}

// ---------------------------------------------------------------------------
// 2. 來源優先順序（方案 §7）
// ---------------------------------------------------------------------------
export interface CropRequest {
  field: EvidenceField;
  docKind: DocKind;
  priority: 1 | 2;
  doc: DocPage;
}

/**
 * 每欄按 FIELD_DOC_PRIORITY 順序，列出該人手上有嘅來源文件（每欄 ≤2）。
 * 優先文件（身份證／住址證明）冇就自然退到入職表（priority 2）；兩個都有就兩張都出（優先排前）。
 */
export function planRequests(fields: readonly EvidenceField[], docs: readonly DocPage[]): CropRequest[] {
  const out: CropRequest[] = [];
  for (const field of fields) {
    let n = 0;
    for (const kind of FIELD_DOC_PRIORITY[field]) {
      const doc = docs.find((d) => d.type === kind);
      const priority = priorityOf(field, kind);
      if (!doc || !priority || n >= MAX_PER_FIELD) continue;
      out.push({ field, docKind: kind, priority, doc });
      n += 1;
    }
  }
  return out.slice(0, MAX_PER_PERSON);
}

// ---------------------------------------------------------------------------
// 3. 幾何
// ---------------------------------------------------------------------------
const bboxOf = (ls: readonly OcrLine[]): Box => ({ x0: Math.min(...ls.map((l) => l.x)), x1: Math.max(...ls.map((l) => l.x + l.w)), y0: Math.min(...ls.map((l) => l.y)), y1: Math.max(...ls.map((l) => l.y + l.h)) });
const avgH = (ls: readonly OcrLine[]) => ls.reduce((a, l) => a + l.h, 0) / ls.length;
export const intersects = (a: Box, b: Box): boolean => Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) > 1e-9 && Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) > 1e-9;
const valid = (b: Box | null): b is Box => !!b && b.x1 - b.x0 > 0.01 && b.y1 - b.y0 > 0.005;

export interface IdCardGeometry {
  /** 各欄裁圖範圍（Vision 正規化座標，原點左下）；定位唔到＝null */
  hkid: Box | null;
  name_zh: Box | null;
  name_en: Box | null;
  dob: Box | null;
  /** 由版面規則推出嘅相片區（卡右側、號碼行以上）；裁圖保證唔入呢個範圍 */
  photo: Box | null;
  /** 全部 null 嘅原因（冇 anchor 等） */
  reason?: 'no_card_anchor' | 'no_field_lines';
}

const CJK = /[\u4e00-\u9fff]/;
/** 相片區左緣＝卡面文字範圍由左起 62%（香港智能身份證：相片喺右上，號碼印喺相片正下方） */
const PHOTO_X_RATIO = 0.62;
/** 相片下緣高過右側最高文字行頂 0.002（讓號碼框頂可以包住字頂） */
const PHOTO_BOTTOM_GAP = 0.002;

/**
 * M8：身份證各欄裁圖——號碼區、中文姓名區、英文姓名區、出生日期區各自裁，並且避開相片區。
 * 真卡版面（2003／2018 版智能身份證）：相片喺右上，**號碼印喺相片正下方（右下）**，左邊係中英文姓名／出生日期／簽發日期。
 * 相片區由版面規則推（本機冇 AI 回傳 box）：卡面文字範圍（cardRegion 嘅 bbox）右側 38% 嘅直條、下緣＝右側最高文字行（通常係號碼行）頂；
 * 右側冇文字行（版面唔同）就保守當相片佔右側上方 55%。
 *  ① 每個框只由該欄自己嘅 OCR 行砌，並唔越過其他文字行（barriers）；
 *  ② 號碼框**只向下外擴**（向上最多 0.001，免得切入相片底），上緣另以相片下緣做 barrier；
 *  ③ 左邊欄位（姓名／出生日期）若同相片區垂直重疊，右緣以相片左緣做 barrier；
 *  ④ 冇身份證 anchor（認唔出卡面範圍）→ 一律唔裁，寧願冇圖，都唔好連相片一齊裁。
 */
export function locateIdCardBoxes(page: number, allLines: readonly OcrLine[]): IdCardGeometry {
  const empty: IdCardGeometry = { hkid: null, name_zh: null, name_en: null, dob: null, photo: null };
  const clean = allLines.filter((l) => l.t.trim());
  if (!clean.some((l) => isIdAnchorLine(l.t))) return { ...empty, reason: 'no_card_anchor' };
  const region = cardRegion(clean);
  const r = extractIdCard(page, clean);
  const anchor = clean.filter((l) => isIdAnchorLine(l.t))[0]!;
  const hkidLine = region
    .filter((l) => findHkidCandidates(l.t).some(hkidCheckDigitValid) && !/PERMIT|許可證編號/i.test(l.t))
    .sort((a, b) => Math.hypot(a.x - anchor.x, a.y - anchor.y) - Math.hypot(b.x - anchor.x, b.y - anchor.y))[0];
  const nl = r.nameLines ?? [];
  const zhLines = nl.filter((l) => CJK.test(l.t));
  const enLines = nl.filter((l) => !CJK.test(l.t));
  const dobLines = r.dobLines ?? [];
  if (!hkidLine && nl.length === 0 && dobLines.length === 0) return { ...empty, reason: 'no_field_lines' };

  // 相片區（版面規則）
  const C = bboxOf(region.length ? region : clean);
  const photoX0 = C.x0 + PHOTO_X_RATIO * (C.x1 - C.x0);
  const rightLines = region.filter((l) => l.x >= photoX0 - 0.01 && !isIdAnchorLine(l.t));
  const rightTop = rightLines.length ? Math.max(...rightLines.map((l) => l.y + l.h)) : null;
  const photoBottom = rightTop !== null ? rightTop + PHOTO_BOTTOM_GAP : C.y0 + 0.45 * (C.y1 - C.y0);
  const photo: Box = { x0: photoX0, x1: Math.min(1, C.x1 + 0.03), y0: photoBottom, y1: Math.min(1, C.y1 + 0.03) };

  const boxFor = (own: readonly OcrLine[], kind: 'number' | 'left'): Box | null => {
    if (own.length === 0) return null;
    const barriers = clean.filter((l) => !own.includes(l));
    const base = bboxOf(own);
    const b = padAround(base, avgH(own), barriers, { vertical: 0.8, horizontal: 0.4, min: 0.008 });
    if (kind === 'number') b.y1 = Math.min(b.y1, base.y1 + 0.001); // ② 只向下外擴，向上最多 0.001
    if (intersects(b, photo)) {
      if (kind === 'number') b.y1 = Math.min(b.y1, photo.y0 - 1e-6); // 相片下緣做 barrier
      else b.x1 = Math.min(b.x1, photo.x0 - 0.005); // ③ 相片左緣做右 barrier
    }
    return valid(b) && !intersects(b, photo) ? b : null;
  };
  return { hkid: boxFor(hkidLine ? [hkidLine] : [], 'number'), name_zh: boxFor(zhLines, 'left'), name_en: boxFor(enLines, 'left'), dob: boxFor(dobLines, 'left'), photo };
}

// ---- 入職表（冇相片）：電話／地址用現有幾何；姓名／身份證號／出生日期用 label 行（best effort，只作 priority 2） ----
const FORM_LABEL: Partial<Record<EvidenceField, RegExp>> = {
  name_zh: /中文姓名|姓名\s*[（(]?\s*中文|Name\s*[（(]?\s*Chinese/i,
  name_en: /英文姓名|English\s*Name|姓名\s*[（(]?\s*英文|Name\s*[（(]?\s*English/i,
  hkid: /香港身份證|身份證號|I\.?D\.?\s*Card\s*No|HKID/i,
  dob: /出生日期|Date\s*of\s*Birth/i,
};

/** 入職表欄位裁圖範圍；定位唔到＝null。 */
export function locateFormFieldBox(field: EvidenceField, lines: readonly OcrLine[]): Box | null {
  const ls = lines.filter((l) => l.t.trim());
  if (field === 'phone') return locatePhoneBox([...ls])?.box ?? null;
  if (field === 'address') return locateFormAddressBox([...ls])?.box ?? null;
  const re = FORM_LABEL[field];
  if (!re) return null;
  const lab = ls.filter((l) => re.test(norm(l.t)) && l.x < 0.5).sort((a, b) => cy(b) - cy(a))[0];
  if (!lab) return null;
  const barriers = ls.filter((l) => l !== lab && isLabelLine(l));
  const b = padAround({ x0: lab.x, x1: 0.99, y0: lab.y, y1: lab.y + lab.h }, lab.h, barriers, {});
  return valid(b) ? b : null;
}

/** 住址證明地址區：定位唔到（成頁）＝null——成頁含太多其他資料，唔出。 */
export function locateAddressProofBox(lines: readonly OcrLine[]): Box | null {
  const r = locateAddressBox([...lines]);
  return r.how === 'block' && valid(r.box) ? r.box : null;
}

/** 一個請求 → 裁圖範圍（null＝冇可靠幾何）。 */
export function boxForRequest(req: CropRequest, lines: readonly OcrLine[]): { box: Box | null; reason?: string } {
  if (req.docKind === 'id_card') {
    const g = locateIdCardBoxes(req.doc.page, lines);
    const b = g[req.field as 'hkid' | 'name_zh' | 'name_en' | 'dob'] ?? null;
    return b ? { box: b } : { box: null, reason: g.reason ?? 'id_field_not_located' };
  }
  if (req.docKind === 'address_proof') {
    const b = locateAddressProofBox(lines);
    return b ? { box: b } : { box: null, reason: 'address_block_not_located' };
  }
  if (req.docKind === 'onboarding_form') {
    const b = locateFormFieldBox(req.field, lines);
    return b ? { box: b } : { box: null, reason: 'form_label_not_located' };
  }
  return { box: null, reason: 'doc_kind_unsupported' };
}

// ---------------------------------------------------------------------------
// 4. 輸出圖片規格（ImageMagick 參數；縮至長邊 800px、JPEG q80 起、≤120 KB、剝 EXIF）
// ---------------------------------------------------------------------------
/** quality 梯級：由 80 起，超過 120 KB 就降；仍然超就先縮細再降。 */
export const JPEG_QUALITY_STEPS = [80, 70, 60, 50, 40] as const;
export const SHRINK_EDGES = [IMAGE_MAX_EDGE, 640, 480] as const;

/** 組出 magick 後半段參數（唔含輸入／輸出檔）：-strip 剝 EXIF／profile／comment；long edge ≤edge。 */
export function magickOutArgs(edge: number, quality: number): string[] {
  return ['-strip', '-resize', `${edge}x${edge}>`, '-colorspace', 'sRGB', '-sampling-factor', '4:2:0', '-quality', String(quality)];
}

// ---------------------------------------------------------------------------
// 5. zip／manifest
// ---------------------------------------------------------------------------
export interface EvidenceItem {
  bytes: Uint8Array;
  field: EvidenceField;
  docKind: DocKind;
  priority: 1 | 2;
  match: { hkid: string | null; staff_numbers: string[] };
}

export const ZIP_MAX_ENTRIES = 300;
export const ZIP_MAX_BYTES = 7 * 1024 * 1024;

export const entryNameOf = (bytes: Uint8Array): string => `${createHash('sha256').update(bytes).digest('hex').slice(0, 32)}.jpg`;

/** 檢查單張圖符合伺服器規格（≤120 KB、JPEG header、冇 EXIF）。 */
export const imageOk = (bytes: Uint8Array): boolean => bytes.byteLength > 0 && bytes.byteLength <= MAX_IMAGE_BYTES && inspectImage(bytes)?.mime === 'image/jpeg';

/** 分批：每 zip ≤300 張、≤7 MB（zip ≤8 MB 上限留餘地）；manifest 每個 item 帶 doc_kind＋priority＋match。 */
export async function buildEvidenceZips(items: readonly EvidenceItem[], opts: { maxEntries?: number; maxBytes?: number } = {}): Promise<{ zips: Uint8Array[]; items: number }> {
  const maxEntries = opts.maxEntries ?? ZIP_MAX_ENTRIES;
  const maxBytes = opts.maxBytes ?? ZIP_MAX_BYTES;
  const batches: EvidenceItem[][] = [];
  let cur: EvidenceItem[] = [];
  let bytes = 0;
  for (const it of items) {
    if (!imageOk(it.bytes)) continue;
    if (cur.length >= maxEntries || (cur.length > 0 && bytes + it.bytes.byteLength > maxBytes)) {
      batches.push(cur);
      cur = [];
      bytes = 0;
    }
    cur.push(it);
    bytes += it.bytes.byteLength;
  }
  if (cur.length) batches.push(cur);
  const zips: Uint8Array[] = [];
  for (const b of batches) {
    const z = new JSZip();
    const manifest = b.map((it) => {
      const file = entryNameOf(it.bytes);
      if (!z.file(file)) z.file(file, it.bytes);
      return { file, field: it.field, doc_kind: it.docKind, priority: it.priority, match: it.match };
    });
    z.file('manifest.json', JSON.stringify({ version: 1, items: manifest }));
    zips.push(await z.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }));
  }
  return { zips, items: batches.reduce((a, b) => a + b.length, 0) };
}
