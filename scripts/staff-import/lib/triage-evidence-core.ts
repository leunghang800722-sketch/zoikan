// TE-1：分流題覆核證據裁圖——本機腳本核心（純函數＋JSZip，零 DB／零 API／零檔案 IO；IO 注入，方便 vitest 用合成 fixture 測）。
// 方案：docs/plans/triage-evidence-crops-plan.md（M7 同一條記錄出圖同 match；M8 身份證裁圖避開相片；§7 每欄來源優先順序）。
// 鐵則：欄位值／姓名／檔名／路徑唔入 console、唔入 zip entry 名（entry 名＝圖 sha256 前 32 位）。
import JSZip from 'jszip';
import { createHash } from 'node:crypto';
import { findHkidCandidates, hkidCheckDigitValid } from './hkid';
import { cardRegion, extractIdCard, isIdAnchorLine } from './extract';
import { cy, norm, type OcrLine } from './ocr';
import { padAround } from './crop-pad';
import { locateAddressBox } from './crop-box';
import type { Box } from './phone-crop';
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
  /** 由版面規則推出嘅相片區（卡右側、英文名行底邊以下、號碼行頂以上）；裁圖保證唔入呢個範圍 */
  photo: Box | null;
  /** 因為同相片區無法分開而跳過嘅欄（計 id_photo_overlap） */
  overlap?: ('hkid' | 'name_zh' | 'name_en' | 'dob')[];
  /** 全部 null 嘅原因（冇 anchor 等） */
  reason?: 'no_card_anchor' | 'no_field_lines';
}

const CJK = /[一-鿿]/;
/** 相片區左緣＝卡面文字範圍由左起 62%（香港智能身份證：相片喺右上，號碼印喺相片正下方） */
const PHOTO_X_RATIO = 0.62;
/** 相片下緣高過右側最高文字行頂 0.002（讓號碼框頂可以包住字頂） */
const PHOTO_BOTTOM_GAP = 0.002;
/** 相片頂＝英文名最高一行底邊再低 0.05×行高（咁名框最少仲有 0.05×行高 padding） */
const PHOTO_TOP_GAP = 0.05;
/** 印刷字 OCR box 已貼邊：垂直 padding ≤0.15×行高、左右 0.3×；號碼行右邊冇相片，右 0.6× */
const ID_PAD = { vertical: 0.15, horizontal: 0.3, min: 0.002 };

/**
 * M8：身份證各欄裁圖——號碼區、中文姓名區、英文姓名區、出生日期區各自裁，並且避開相片區。
 * 真卡版面（2003／2018 版智能身份證）：相片喺右上，**號碼印喺相片正下方（右下）**，左邊係中英文姓名／出生日期／簽發日期；
 * 長英文名可以橫跨相片 x 範圍，相片緊貼名行底。
 * 相片區由版面規則推（本機冇 AI 回傳 box）：x＝卡面文字範圍右側 38%；y 頂＝英文名最高一行嘅底邊（再低 0.05×行高）；y 底＝右側最高文字行（通常係號碼行）頂。
 * 右側冇文字行（版面唔同）就保守當相片佔右側上方 55%。所有欄位框一律同相片區「不相交」：
 *  ① 有重疊先收窄向下 padding 到相片頂以上（最少 0.05×行高）；② 仍重疊就收窄右緣到相片左緣；③ 仍重疊（或收窄後切到字）就跳過（id_photo_overlap）；
 *  ④ 號碼框只向下外擴（向上最多 0.001），上緣以相片下緣做 barrier；
 *  ⑤ 冇身份證 anchor（認唔出卡面範圍）→ 一律唔裁。
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
  const topEn = enLines.length ? [...enLines].sort((a, b) => b.y + b.h - (a.y + a.h))[0]! : null;
  const nameTop = topEn ? topEn.y - PHOTO_TOP_GAP * topEn.h : null;
  const photoTop = nameTop !== null && nameTop > photoBottom ? nameTop : Math.min(1, C.y1 + 0.03);
  const photo: Box = { x0: photoX0, x1: Math.min(1, C.x1 + 0.03), y0: photoBottom, y1: photoTop };

  const overlap: NonNullable<IdCardGeometry['overlap']> = [];
  const boxFor = (own: readonly OcrLine[], kind: 'number' | 'left', field: 'hkid' | 'name_zh' | 'name_en' | 'dob'): Box | null => {
    if (own.length === 0) return null;
    const barriers = clean.filter((l) => !own.includes(l));
    const base = bboxOf(own);
    const h = avgH(own);
    const b = padAround(base, h, barriers, kind === 'number' ? { ...ID_PAD, horizontal: 0.6 } : ID_PAD);
    if (kind === 'number') b.y1 = Math.min(b.y1, base.y1 + 0.001); // ④ 只向下外擴，向上最多 0.001
    if (intersects(b, photo)) {
      if (kind === 'number') b.y1 = Math.min(b.y1, photo.y0 - 1e-6); // 相片下緣做 barrier
      else if (base.y0 - PHOTO_TOP_GAP * h >= photo.y1 - 1e-9) b.y0 = Math.max(b.y0, photo.y1); // ① 收窄向下 padding（最少 0.05×行高）
      else b.x1 = Math.min(b.x1, photo.x0 - 0.005); // ② 相片左緣做右 barrier
    }
    if (intersects(b, photo)) b.x1 = Math.min(b.x1, photo.x0 - 0.005);
    // ③ 仍重疊、或者收窄後切到字本身 → 跳過
    const cutsText = b.x0 > base.x0 + 1e-9 || b.x1 < base.x1 - 1e-9 || b.y0 > base.y0 + 1e-9 || b.y1 < base.y1 - 1e-9;
    if (!valid(b) || intersects(b, photo) || cutsText) {
      overlap.push(field);
      return null;
    }
    return b;
  };
  const hk = boxFor(hkidLine ? [hkidLine] : [], 'number', 'hkid');
  const zh = boxFor(zhLines, 'left', 'name_zh');
  const en = boxFor(enLines, 'left', 'name_en');
  const dob = boxFor(dobLines, 'left', 'dob');
  return { hkid: hk, name_zh: zh, name_en: en, dob, photo, ...(overlap.length ? { overlap } : {}) };
}

// ---- 入職表：單格裁（label 包埋）；右上角貼相片，相片區推算＝右側 25%、頁頂 35% ----
/** 入職表相片格（右上角）：x ≥ 0.75、y ≥ 0.65（原點左下，即頁頂 35%） */
export const FORM_PHOTO_BOX: Box = { x0: 0.75, x1: 1, y0: 0.65, y1: 1 };

const FORM_VOCAB = /姓名|Name|出生|Birth|身份證|ID\s*Card|電話|Phone|Mobile|MOBILE|住址|地址|Address|通訊|關係|Relation|年齡|Age|性別|Sex|籍貫|婚姻|Email|電郵|職位|聯絡|緊急|到職|入職|Date|Place|地點|Tel|傳真|Fax|住所|僱主/i;
const isFormLabel = (l: OcrLine): boolean => {
  const t = norm(l.t);
  return t.length > 0 && t.length <= 40 && (t.match(/\d/g) ?? []).length <= 2 && (FORM_VOCAB.test(t) || /[:：]\s*$/.test(t));
};
const FORM_LABEL: Partial<Record<EvidenceField, { re: RegExp; not?: RegExp }>> = {
  name_zh: { re: /中文姓名|姓名/, not: /英文|English/i },
  name_en: { re: /英文姓名|English\s*Name/i },
  hkid: { re: /香港身份證|身份證|HKID|ID\s*Card/i },
  dob: { re: /出生日期|Date\s*of\s*Birth/i },
  phone: { re: /[手车半F千]?提[電範]?話|MOBILE|聯絡電話|Phone\s*No/i, not: /緊急|僱主|住所/ },
  address: { re: /^[住生世佳售]\s*址|[住生世佳售]址\s*[:：]|^地址\s*[:：]?$|^Address/i, not: /通訊|僱主|電郵|Email|諮詢|學校/i },
};
const sameRow = (a: OcrLine, b: OcrLine): boolean => Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) >= 0.5 * Math.min(a.h, b.h);

/**
 * 入職表欄位**單格**裁圖：左界＝該欄 label 行左邊（label 包埋）；右界＝同一行下一個 label 左邊（減細小間隙），冇就＝同行手寫字最右＋0.6×行高；
 * 上下界＝label／手寫字行各 ≤0.25×行高，並唔過上一行／下一行任何 label（padAround barrier）。唔係成行裁。
 * 相片格（右上角）：同相片區相交先夾右緣，仍相交就跳過（form_photo_overlap）。
 */
export function locateFormCell(field: EvidenceField, lines: readonly OcrLine[]): { box: Box | null; reason?: 'form_label_not_located' | 'form_photo_overlap' } {
  const spec = FORM_LABEL[field];
  if (!spec) return { box: null, reason: 'form_label_not_located' };
  const ls = lines.filter((l) => l.t.trim());
  const L = ls.filter((l) => isFormLabel(l) && spec.re.test(norm(l.t)) && !(spec.not && spec.not.test(norm(l.t)))).sort((a, b) => cy(b) - cy(a))[0];
  if (!L) return { box: null, reason: 'form_label_not_located' };
  const others = ls.filter((l) => l !== L);
  const labels = others.filter(isFormLabel);
  const next = labels.filter((l) => sameRow(l, L) && l.x >= L.x + L.w - 0.01).sort((a, b) => a.x - b.x)[0] ?? null;
  const inCell = (l: OcrLine) => l.x >= L.x + L.w - 0.02 && (!next || l.x + l.w <= next.x + 0.005);
  let values = others.filter((l) => !isFormLabel(l) && sameRow(l, L) && inCell(l));
  if (values.length === 0) {
    // 範本 B：填寫位喺 label 下面一行
    const below = others.filter((l) => !isFormLabel(l) && cy(l) < L.y && L.y - (l.y + l.h) < 2.5 * L.h && l.x >= L.x - 0.02 && (!next || l.x < next.x)).sort((a, b) => cy(b) - cy(a));
    if (below[0]) values = below.filter((l) => sameRow(l, below[0]!));
  }
  const members = [L, ...values];
  const left = L.x;
  const right = next ? next.x - 0.004 : values.length ? Math.max(...values.map((v) => v.x + v.w)) + 0.6 * L.h : L.x + L.w + 0.15;
  const base: Box = { x0: left, x1: Math.max(right, L.x + L.w), y0: Math.min(...members.map((m) => m.y)), y1: Math.max(...members.map((m) => m.y + m.h)) };
  const barriers = labels.filter((l) => !members.includes(l));
  const b = padAround(base, L.h, barriers, { vertical: 0.25, horizontal: 0, min: 0.001 });
  b.x0 = Math.max(b.x0, 0);
  b.x1 = next ? Math.min(b.x1, next.x - 0.004) : b.x1;
  if (intersects(b, FORM_PHOTO_BOX)) b.x1 = Math.min(b.x1, FORM_PHOTO_BOX.x0 - 0.003);
  if (!valid(b) || intersects(b, FORM_PHOTO_BOX) || b.x1 < L.x + L.w) return { box: null, reason: 'form_photo_overlap' };
  return { box: b };
}

/** 住址證明地址區：定位唔到（成頁）＝null——成頁含太多其他資料，唔出。 */
export function locateAddressProofBox(lines: readonly OcrLine[]): Box | null {
  const r = locateAddressBox([...lines]);
  return r.how === 'block' && valid(r.box) ? r.box : null;
}

/** 地址區 sanity：框內文字要含數字或「樓／室／座／F／FLAT」。 */
export function addressRegionLikely(box: Box, lines: readonly OcrLine[]): boolean {
  const text = lines.filter((l) => cy(l) >= box.y0 && cy(l) <= box.y1 && l.x + l.w / 2 >= box.x0 && l.x + l.w / 2 <= box.x1).map((l) => l.t).join(' ');
  return /\d|樓|室|座|\bF\b|FLAT|ROOM|RM\b/i.test(text);
}

/** 一個請求 → 裁圖範圍（null＝冇可靠幾何）。lines 必須已經係正向 frame（見 detectUprightRotation／rotateLines）。 */
export function boxForRequest(req: CropRequest, lines: readonly OcrLine[]): { box: Box | null; reason?: string } {
  if (req.docKind === 'id_card') {
    const f = req.field as 'hkid' | 'name_zh' | 'name_en' | 'dob';
    const g = locateIdCardBoxes(req.doc.page, lines);
    const b = g[f] ?? null;
    return b ? { box: b } : { box: null, reason: g.overlap?.includes(f) ? 'id_photo_overlap' : (g.reason ?? 'id_field_not_located') };
  }
  if (req.docKind === 'address_proof') {
    const b = locateAddressProofBox(lines);
    if (!b) return { box: null, reason: 'address_block_not_located' };
    return addressRegionLikely(b, lines) ? { box: b } : { box: null, reason: 'address_region_unlikely' };
  }
  if (req.docKind === 'onboarding_form') {
    const r = locateFormCell(req.field, lines);
    return r.box ? { box: r.box } : { box: null, reason: r.reason ?? 'form_label_not_located' };
  }
  return { box: null, reason: 'doc_kind_unsupported' };
}

// ---------------------------------------------------------------------------
// 3b. 頁面方向（轉頁）：由 OCR 行推要順時針轉幾多度先正向；再將行座標轉入正向 frame
// ---------------------------------------------------------------------------
export type Rotation = 0 | 90 | 180 | 270;

/** 將行座標隨整頁順時針轉 deg 度（Vision 正規化、原點左下；w／h 同樣互換）。 */
export function rotateLines(lines: readonly OcrLine[], deg: Rotation): OcrLine[] {
  if (deg === 0) return [...lines];
  return lines.map((l) => {
    if (deg === 90) return { ...l, x: l.y, y: 1 - l.x - l.w, w: l.h, h: l.w };
    if (deg === 180) return { ...l, x: 1 - l.x - l.w, y: 1 - l.y - l.h };
    return { ...l, x: 1 - l.y - l.h, y: l.x, w: l.h, h: l.w };
  });
}

const RE_DOB_LABEL = /出生日期|DATE\s*OF\s*BIRTH/i;
const RE_FORM_TITLE = /職位申請表|EMPLOYMENT\s*APPLICATION/i;
const RE_FORM_BELOW = /緊急聯絡人|手提電話|出生日期|中文姓名/;

/**
 * 推「要順時針轉幾多度頁面先正向」。OCR 行冇方向欄位，所以用版面順序＋行 box 縱橫比：
 *  - 縱橫比：長行（≥4 字）轉正後要大多數 w≥h（排除 90／270 側躺）；
 *  - id_card：標題 anchor 要喺出生日期 label 同號碼行之上，出生日期 label 喺號碼行之上而且偏左（真卡版面）；
 *  - onboarding_form：標題（職位申請表）要喺其他欄 label 之上；
 *  - address_proof：只有縱橫比（無可靠 180° 線索）→ 側躺時兩個候選就唔猜（null），正向回 0。
 * 唯一候選先回；候選有 0 就回 0；否則 null（唔轉）。
 */
export function detectUprightRotation(kind: DocKind, lines: readonly OcrLine[]): Rotation | null {
  const clean = lines.filter((l) => l.t.trim());
  if (clean.length < 3) return null;
  const cands: Rotation[] = [0, 90, 180, 270];
  const pass = (r: Rotation): boolean => {
    const t = rotateLines(clean, r);
    const long = t.filter((l) => norm(l.t).length >= 4);
    if (long.length >= 3 && long.filter((l) => l.w >= l.h).length / long.length < 0.6) return false;
    const up = (a: OcrLine, b: OcrLine) => a.y + a.h / 2 > b.y + b.h / 2;
    if (kind === 'id_card') {
      const idx = clean.map((l, i) => ({ l, i }));
      const pick = (f: (l: OcrLine) => boolean) => idx.find((x) => f(x.l));
      const A = pick((l) => isIdAnchorLine(l.t));
      const D = pick((l) => RE_DOB_LABEL.test(norm(l.t)));
      const K = pick((l) => findHkidCandidates(l.t).some(hkidCheckDigitValid) && !/PERMIT|許可證編號/i.test(l.t));
      const g = (x?: { i: number }) => (x ? t[x.i]! : null);
      const a = g(A);
      const d = g(D);
      const k = g(K);
      if (a && k && !up(a, k)) return false;
      if (a && d && !up(a, d)) return false;
      if (d && k && (!up(d, k) || d.x + d.w / 2 > k.x + k.w / 2)) return false;
    } else if (kind === 'onboarding_form') {
      const title = t.find((l) => RE_FORM_TITLE.test(norm(l.t)));
      const rest = t.filter((l) => RE_FORM_BELOW.test(norm(l.t)));
      if (title && rest.some((l) => !up(title, l))) return false;
    }
    return true;
  };
  const ok = cands.filter(pass);
  if (ok.length === 1) return ok[0]!;
  if (ok.includes(0)) return 0;
  return null;
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
