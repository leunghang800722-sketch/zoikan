// TE-1：分流題覆核證據裁圖——本機腳本核心（純函數＋JSZip，零 DB／零 API／零檔案 IO；IO 注入，方便 vitest 用合成 fixture 測）。
// 方案：docs/plans/triage-evidence-crops-plan.md（M7 同一條記錄出圖同 match；M8 身份證裁圖避開相片；§7 每欄來源優先順序）。
// 鐵則：欄位值／姓名／檔名／路徑唔入 console、唔入 zip entry 名（entry 名＝圖 sha256 前 32 位）。
import JSZip from 'jszip';
import { createHash } from 'node:crypto';
import { findHkidCandidates, hkidCheckDigitValid, scanHkidHits, selectPrintedHits } from './hkid';
import { cardRegion, extractIdCard, isIdAnchorLine } from './extract';
import { cy, norm, readingOrder, type OcrLine } from './ocr';
import { padAround } from './crop-pad';
import { locateAddressBox } from './crop-box';
import type { Box } from './phone-crop';
import { findEmbeddedCards, inBox, isHkidFormatLine, type CardRegion } from './embedded-card';
import {
  FIELD_DOC_PRIORITY,
  MAX_IMAGE_BYTES,
  MAX_PAGE_EDGE,
  MAX_PAGE_IMAGE_BYTES,
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
 * 呢個人要出邊啲欄嘅圖（TE-2）：**所有非 confirmed 欄**（review／missing／absent 都算）＋入職日期（人事部格，一律出）。
 * 原則：題目仲 open、需要嗰個欄，就按 label／版面位置裁出嚟俾人睇，唔理 OCR 讀到讀唔到值。
 * 伺服器只收「仍有 open／skipped 題需要」嘅欄，其餘計 skipped_not_needed——所以寧多勿少。
 */
export function evidenceFieldsOf(p: PkgPerson): EvidenceField[] {
  const out: EvidenceField[] = [];
  const need = (f?: { status?: string } | null) => !f || f.status !== 'confirmed';
  if (need(p.hkid)) out.push('hkid');
  if (need(p.nameZh)) out.push('name_zh');
  if (need(p.nameEn)) out.push('name_en');
  if (need(p.dateOfBirth)) out.push('dob');
  if (need(p.phone)) out.push('phone');
  if (need(p.address)) out.push('address');
  out.push('hire_date');
  return out;
}

/** manifest match：同一條 package 記錄（身份證值＋工號），即係同一個人嘅文件→裁圖→match（M7）。 */
export function matchOfPerson(p: PkgPerson, prodKey?: string | null): { hkid: string | null; staff_numbers: string[]; package_key?: string; prod_person_key?: string } {
  const m = { hkid: p.hkid.value?.trim() || null, staff_numbers: p.staffNumbers.map((n) => n.number) };
  // TE-7：全無身份證號／工號（抽取失敗）——用包內 key 配對（server 用同一函數推 personKey）；TE-7.2：加 production 現有 key（--person-key-map 對照表）
  if (!m.hkid && m.staff_numbers.length === 0 && p.key) return { ...m, package_key: p.key, ...(prodKey ? { prod_person_key: prodKey } : {}) };
  return m;
}

/** TE-7：抽取失敗人＝評級 fail，或者六個身份欄全部冇值（冇工號亦當失敗）。整頁原稿暫存圖淨係對呢批人。 */
export function isFailedPerson(p: PkgPerson): boolean {
  const empty = [p.hkid, p.nameZh, p.nameEn, p.dateOfBirth, p.phone, p.address].every((f) => !f?.value?.trim());
  return p.rating === 'fail' || (empty && p.staffNumbers.length === 0);
}

// ---------------------------------------------------------------------------
// 2. 來源優先順序（方案 §7）
// ---------------------------------------------------------------------------
export interface CropRequest {
  field: EvidenceField;
  docKind: DocKind;
  priority: 1 | 2 | 3;
  doc: DocPage;
  /** 同一欄喺入職表有幾個 label 位置時（hire_date：0＝入職日期、1＝可到職日期） */
  variant?: number;
  /** TE-2 嵌入式身份證：rot＝要順時針轉幾多度頁面先令卡正向；region＝轉正後 frame 嘅卡區 */
  embedded?: { rot: Rotation; region: Box };
  /** TE-2 印刷身份證號行：rot 同上；line＝轉正後 frame 嘅 OCR 行 */
  printed?: { rot: Rotation; line: OcrLine };
}

/** 一頁一個「嵌入式身份證」來源／「印刷號碼行」來源（produceItems 掃描所有頁後砌）。 */
export interface EmbeddedSource {
  doc: DocPage;
  rot: Rotation;
  region: Box;
}
export interface PrintedSource {
  doc: DocPage;
  rot: Rotation;
  line: OcrLine;
}

/** 入職表每欄 label 位置數（hire_date 兩格）。 */
const FORM_VARIANTS: Partial<Record<EvidenceField, number>> = { hire_date: 2 };

/**
 * 每欄按 FIELD_DOC_PRIORITY 順序，列出該人手上有嘅來源（每欄 ≤MAX_PER_FIELD）：
 *  - id_card：整頁身份證副本；冇就用嵌入式身份證（牌照頁等夾住嘅卡）；
 *  - printed：牌照／證書印刷嘅號碼行（淨 hkid）；
 *  - 其餘：該類文件頁。priority＝該欄清單位置（身份證副本 1 ＞ 印刷 2 ＞ 入職表手寫 3）。
 */
export function planRequests(fields: readonly EvidenceField[], docs: readonly DocPage[], extra: { embedded?: readonly EmbeddedSource[]; printed?: readonly PrintedSource[] } = {}): CropRequest[] {
  const out: CropRequest[] = [];
  for (const field of fields) {
    let n = 0;
    for (const kind of FIELD_DOC_PRIORITY[field]) {
      const priority = priorityOf(field, kind);
      if (!priority) continue;
      const push = (r: Omit<CropRequest, 'field' | 'docKind' | 'priority'>) => {
        if (n >= MAX_PER_FIELD) return;
        out.push({ field, docKind: kind, priority, ...r });
        n += 1;
      };
      if (kind === 'printed') {
        // TE-8：同一個（一致）號碼可以出最多 2 張唔同行作佐證（label 行優先，受每欄上限約束）
        for (const pr of (extra.printed ?? []).slice(0, 2)) push({ doc: pr.doc, printed: { rot: pr.rot, line: pr.line } });
        continue;
      }
      const doc = docs.find((d) => d.type === kind);
      if (doc) {
        for (let v = 0; v < (FORM_VARIANTS[field] ?? 1); v++) push({ doc, ...(FORM_VARIANTS[field] ? { variant: v } : {}) });
      } else if (kind === 'id_card') {
        const em = extra.embedded?.[0];
        if (em) push({ doc: em.doc, embedded: { rot: em.rot, region: em.region } });
      }
    }
  }
  return out.slice(0, MAX_PER_PERSON);
}

// ---------------------------------------------------------------------------
// 3. 幾何
// ---------------------------------------------------------------------------
const bboxOf = (ls: readonly OcrLine[]): Box => ({ x0: Math.min(...ls.map((l) => l.x)), x1: Math.max(...ls.map((l) => l.x + l.w)), y0: Math.min(...ls.map((l) => l.y)), y1: Math.max(...ls.map((l) => l.y + l.h)) });
export const intersects = (a: Box, b: Box): boolean => Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) > 1e-9 && Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) > 1e-9;
const xOverlap = (a: Box, l: OcrLine): boolean => Math.min(a.x1, l.x + l.w) - Math.max(a.x0, l.x) > 1e-9;
const valid = (b: Box | null): b is Box => !!b && b.x1 - b.x0 > 0.01 && b.y1 - b.y0 > 0.005;

export interface IdCardGeometry {
  /** 各欄裁圖範圍（Vision 正規化座標，原點左下）；定位唔到＝null */
  hkid: Box | null;
  name_zh: Box | null;
  name_en: Box | null;
  dob: Box | null;
  /** 由版面規則推出嘅相片區（卡右側、英文名行底邊以下、號碼行頂以上）；裁圖保證唔入呢個範圍 */
  photo: Box | null;
  /** 每欄自己嘅 OCR 行（硬性尺寸上限用） */
  own?: Partial<Record<'hkid' | 'name_zh' | 'name_en' | 'dob', OcrLine[]>>;
  /** 因為同相片區無法分開而跳過嘅欄（計 id_photo_overlap） */
  overlap?: ('hkid' | 'name_zh' | 'name_en' | 'dob')[];
  /** 全部 null 嘅原因（冇 anchor 等） */
  reason?: 'no_card_anchor' | 'no_field_lines';
}

const CJK = /[一-鿿]/;
/** 相片區左緣＝卡面文字範圍由左起 62%（香港智能身份證：相片喺右上，號碼印喺相片正下方） */
const PHOTO_X_RATIO = 0.62;
/** 相片下緣高過右側最高文字行頂 0.002（讓號碼框頂可以包住字頂） */
const PHOTO_BOTTOM_GAP = 0.0015;
/** 相片頂＝英文名最高一行底邊再低 0.05×行高（咁名框最少仲有 0.05×行高 padding） */
const PHOTO_TOP_GAP = 0.05;
/** 垂直 padding 0.3×行高（TE-1.7：0.15 太緊，有號碼上半截被切）、左右 0.3×；號碼行右邊冇相片，右 0.6×；相片 barrier 照舊 */
const ID_PAD = { vertical: 0.3, horizontal: 0.3, min: 0.002 };

/**
 * M8：身份證各欄裁圖——號碼區、中文姓名區、英文姓名區、出生日期區各自裁，並且避開相片區。
 * 真卡版面（2003／2018 版智能身份證）：相片喺右上，**號碼印喺相片正下方（右下）**，左邊係中英文姓名／出生日期／簽發日期；
 * 長英文名可以橫跨相片 x 範圍，相片緊貼名行底。
 * 相片區由版面規則推（本機冇 AI 回傳 box）：x＝卡面文字範圍右側 38%；y 頂＝英文名最高一行嘅底邊（再低 0.05×行高）；y 底＝右側最高文字行（通常係號碼行）頂。
 * 右側冇文字行（版面唔同）就保守當相片佔右側上方 55%。所有欄位框一律同相片區「不相交」：
 *  ① 有重疊先收窄向下 padding 到相片頂以上（最少 0.05×行高）；② 仍重疊就收窄右緣到相片左緣；③ 仍重疊（或收窄後切到字）就跳過（id_photo_overlap）；
 *  ④ 號碼框向上外擴 0.3×行高，但上緣以相片下緣做 barrier；
 *  ⑤ 冇身份證 anchor（認唔出卡面範圍）→ 一律唔裁。
 */
export function locateIdCardBoxes(page: number, allLines: readonly OcrLine[], aspect = 1, cardBox?: Box): IdCardGeometry {
  const empty: IdCardGeometry = { hkid: null, name_zh: null, name_en: null, dob: null, photo: null };
  // 嵌入式卡（TE-2）：只用卡區內嘅行，卡區 box 當卡面範圍（唔需要標題 anchor）
  const clean = allLines.filter((l) => l.t.trim() && (!cardBox || inBox(cardBox, l)));
  if (!cardBox && !clean.some((l) => isIdAnchorLine(l.t))) return { ...empty, reason: 'no_card_anchor' };
  const region = cardBox ? clean : cardRegion(clean);
  const r = extractIdCard(page, clean);
  const anchor = clean.filter((l) => isIdAnchorLine(l.t))[0] ?? { x: cardBox?.x0 ?? 0, y: cardBox?.y1 ?? 1 };
  const hkidLine = region
    .filter((l) => (findHkidCandidates(l.t).some(hkidCheckDigitValid) || (!!cardBox && isHkidFormatLine(l.t))) && !/PERMIT|許可證編號/i.test(l.t))
    .sort((a, b) => Math.hypot(a.x - anchor.x, a.y - anchor.y) - Math.hypot(b.x - anchor.x, b.y - anchor.y))[0];
  const nl = r.nameLines ?? [];
  const zhLines = nl.filter((l) => CJK.test(l.t));
  const enLines = nl.filter((l) => !CJK.test(l.t));
  const dobLines = r.dobLines ?? [];
  if (!hkidLine && nl.length === 0 && dobLines.length === 0) return { ...empty, reason: 'no_field_lines' };

  // 相片區（版面規則）
  const C = cardBox ?? bboxOf(region.length ? region : clean);
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
    const base = bboxOf(own);
    // 行厚度（TE-1.8）：側躺行嘅 box 長邊係字串長度，唔可以當行高——用 min(h, w×頁闊高比)
    const h = own.reduce((a, l) => a + Math.min(l.h, l.w * aspect), 0) / own.length;
    // barrier＝水平上有重疊嘅其他行（唔同欄、唔同 x 範圍嘅行唔應該限制垂直 padding——例如右下號碼行唔受左邊出生日期行影響）
    const barriers = clean.filter((l) => !own.includes(l) && xOverlap({ x0: base.x0 - 0.6 * h, x1: base.x1 + 0.6 * h, y0: 0, y1: 1 }, l));
    const b = padAround(base, h, barriers, kind === 'number' ? { ...ID_PAD, horizontal: 0.6 } : ID_PAD);
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
  return { hkid: hk, name_zh: zh, name_en: en, dob, photo, own: { hkid: hkidLine ? [hkidLine] : [], name_zh: zhLines, name_en: enLines, dob: dobLines }, ...(overlap.length ? { overlap } : {}) };
}

// ---- 入職表：單格裁（label 包埋）；右上角貼相片，相片區推算＝右側 25%、頁頂 35% ----
/** 入職表相片格（右上角）：x ≥ 0.75、y ≥ 0.65（原點左下，即頁頂 35%） */
export const FORM_PHOTO_BOX: Box = { x0: 0.75, x1: 1, y0: 0.65, y1: 1 };

const FORM_VOCAB = /姓名|Name|出生|Birth|身份證|ID\s*Card|電話|Phone|Mobile|MOBILE|住址|地址|Address|通訊|關係|Relation|年齡|Age|性別|Sex|籍貫|婚姻|國籍|Email|電郵|職位|聯絡|緊急|到職|入職|人職|可到職|Date|Place|地點|Tel|傳真|Fax|住所|僱主/i;
const isFormLabel = (l: OcrLine): boolean => {
  const t = norm(l.t);
  return t.length > 0 && t.length <= 40 && (t.match(/\d/g) ?? []).length <= 2 && (FORM_VOCAB.test(t) || /[:：]\s*$/.test(t));
};
/** 緊急聯絡人／擔保人／見證人／僱主欄嘅「姓名」「電話」唔係申請人本人 */
/** 緊急聯絡人／擔保人／見證人／僱主／諮詢人／介紹人／配偶欄（中英文）——嘅「姓名」「電話」唔係申請人本人。 */
const OTHER_PERSON = /聯絡人|緊急|擔保|見證|僱主|諮詢人|介紹人|配偶|Emergency|Contact\s*Person|Guarantor|Witness|Employer|Referee|Reference|Spouse/i;
const FORM_LABEL: Partial<Record<EvidenceField, { re: RegExp; not?: RegExp }>> = {
  name_zh: { re: /中文姓名|姓名/, not: new RegExp(`英文|English|${OTHER_PERSON.source}`, 'i') },
  // TE-2.2：單獨「Name：」（冇「English」字）都當英文姓名 label（範本 B 嘅翻譯行 / 英文版本）
  name_en: { re: /英文姓名|English\s*Name|^Name\s*[:：]?$/i, not: OTHER_PERSON },
  hkid: { re: /香港身份證|身份證|HKID|ID\s*Card/i },
  dob: { re: /出生日期|Date\s*of\s*Birth/i },
  phone: { re: /[手车半F千]?提[電範]?話|MOBILE|聯絡電話|Phone\s*No/i, not: new RegExp(`住所|${OTHER_PERSON.source}`, 'i') },
  address: { re: /^[住生世佳售]\s*址|[住生世佳售]址\s*[:：]|^地址\s*[:：]?$|^Address/i, not: new RegExp(`通訊|電郵|Email|諮詢|學校|${OTHER_PERSON.source}`, 'i') },
};
/** 同一欄喺入職表有多個 label 位置（hire_date：0＝入職日期〔人事部格；OCR 或誤讀「人職」〕、1＝可到職日期） */
const FORM_LABEL_VARIANTS: Partial<Record<EvidenceField, { re: RegExp; not?: RegExp }[]>> = {
  hire_date: [{ re: /[入人]職日期|[入人]職\s*日期/, not: /可到職/ }, { re: /可到職日期|可到職/ }],
};
const sameRow = (a: OcrLine, b: OcrLine): boolean => Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) >= 0.5 * Math.min(a.h, b.h);

// ---- TE-2.1：merged OCR line 關鍵詞定位 ----
/** 入職表 label 關鍵詞（長詞先；後面可跟冒號）。用嚟將成行併埋嘅 OCR line 切返做 label／值 virtual 行。 */
/** CJK 詞容許字與字之間有空格（OCR 常見「入 職日期」）。 */
const spaced = (w: string): string => (/[一-鿿]/.test(w) && !w.includes('\\') && !w.includes('[') ? [...w].join('\\s?') : w);
const LABEL_WORDS = [
  '香港身份證號碼', '香港身份證', '身份證號碼', '身份證', 'H\\.?\\s?K\\.?\\s*I\\.?\\s?D\\.?\\s*Card\\s*No\\.?', 'ID\\s*Card\\s*No\\.?',
  '出生日期', 'Date\\s*of\\s*Birth', 'Birthday', '出生地點', 'Place\\s*of\\s*Birth',
  'English\\s*Name', '英文姓名', '中文姓名', '姓\\s?名',
  '許可證屆滿日期', '許可證號碼', '許可證', '屆滿日期',
  '可到職日期', '[入人]\\s?職\\s?日\\s?期',
  '手提電話', '聯絡電話', '住所電話', 'Phone\\s*No\\.?', 'Mobile', '電話',
  '通訊地址', '住址', '地址', 'Address',
  '國籍', 'Nationality', '籍貫', '婚姻狀況', '性別',
];
const LABEL_TOKEN = new RegExp('(' + LABEL_WORDS.map(spaced).join('|') + ')\\s*[:：]?', 'gi');
/** 全形→半形（1:1，唔改長度，字元偏移先對得返）。 */
const fold = (t: string): string => t.replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/　/g, ' ');
/** 字元寬度權重：CJK／全形 1，其他 0.55。 */
const cw = (c: string): number => (/[　-鿿＀-￯]/.test(c) ? 1 : 0.55);
/** 第 idx 個字元之前嘅累計寬度 / 全寬。 */
function widthFrac(t: string, idx: number): number {
  const chars = [...t];
  const total = chars.reduce((a, c) => a + cw(c), 0) || 1;
  return chars.slice(0, idx).reduce((a, c) => a + cw(c), 0) / total;
}
type SegLine = OcrLine & { endX?: number };

/**
 * 將含 label 關鍵詞嘅 OCR line 按關鍵詞偏移切成 label／值 virtual 行（x、w 按字元寬度比例推算）。
 * 例：一條 39 字 `香港身份證號碼：Z900001(2) 出生日期： 15-01-1990 出生地點：` →
 *    [香港身份證號碼：][Z900001(2)][出生日期：][15-01-1990][出生地點：]。最後一個冇值嘅 label 帶 `endX`＝原 line 行尾。
 * 淨係一個 label 佔成行嘅 line 原樣返回。
 */
export function splitMergedLines(lines: readonly OcrLine[]): SegLine[] {
  const out: SegLine[] = [];
  for (const l of lines) {
    const t = fold(l.t);
    const ms = [...t.matchAll(LABEL_TOKEN)];
    if (ms.length === 0 || (ms.length === 1 && ms[0]!.index === 0 && ms[0]![0].trim().length === t.trim().length)) {
      out.push(l);
      continue;
    }
    const seg = (start: number, end: number): SegLine | null => {
      const text = l.t.slice(start, end).trim();
      if (!text) return null;
      const f0 = widthFrac(t, start);
      const f1 = widthFrac(t, end);
      return { ...l, t: text, x: l.x + f0 * l.w, w: Math.max(0.002, (f1 - f0) * l.w) };
    };
    const pieces: SegLine[] = [];
    let cursor = 0;
    for (const [mi, m] of ms.entries()) {
      const i = m.index!;
      // 第一個 label 前面嘅描述字如果係「聯絡人／緊急／擔保／見證／僱主」呢類（例如「遇有緊急事故聯絡人」＋姓名）屬於 label 本身，唔切開（否則負向詞判斷失效）；
      // 其他前綴（例如「申請職位 Position Apply ……」＋可到職日期）切開，唔好令成行變 label
      const prefixIsLabelText = mi === 0 && i > 0 && !/\d/.test(t.slice(0, i)) && OTHER_PERSON.test(t.slice(0, i));
      const pre = prefixIsLabelText ? null : seg(cursor, i);
      if (pre) pieces.push(pre);
      const lab = seg(prefixIsLabelText ? 0 : i, i + m[0].length);
      if (lab) pieces.push(lab);
      cursor = i + m[0].length;
    }
    const tail = seg(cursor, t.length);
    if (tail) pieces.push(tail);
    // 最後一個 label 後面冇值 → 右界＝原 line 行尾
    const last = pieces[pieces.length - 1];
    if (last && isFormLabel(last)) last.endX = l.x + l.w;
    out.push(...pieces);
  }
  return out;
}

/** 範本 B：中文 label 下一行係佢嘅英文翻譯（H.K. I.D. Card No.／Phone No.／Birthday／Address）→ 合併成一個 label block。 */
const TRANSLATION_LABEL: Partial<Record<EvidenceField, { re: RegExp; not?: RegExp }>> = {
  hkid: { re: /H\.?\s?K\.?\s*I\.?\s?D\.?\s*Card|ID\s*Card|HKID|Card/i },
  phone: { re: /Phone|Mobile|Tel/i },
  dob: { re: /Birth|Date/i },
  address: { re: /Address/i },
  // TE-2.2：「中文姓名:」下一行「Name (Chinese):」／「Chinese Name」；「英文姓名:」下一行「Name (English):」／「English Name」——互相唔當翻譯行（否則兩個欄會合併）
  name_zh: { re: /Name|Chinese/i, not: /English/i },
  name_en: { re: /Name|English/i, not: /Chinese/i },
};
/** a 同 b 嘅水平重疊佔較窄者闊度嘅比例。 */
const xOverlapFrac = (a: OcrLine, b: OcrLine): number => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) / Math.max(1e-6, Math.min(a.w, b.w));

/**
 * 申請人個人資料段落範圍（姓名 label 只喺呢度搵）：由「申請人個人資料／Personal Particulars」標題到「過去 3 年受僱記錄／諮詢人資料」標題之間；
 * 搵唔到標題就取頁頂 50%。回判斷函數（label 行是否喺段落內）。
 */
function inPersonalSection(ls: readonly OcrLine[]): { inSection: (l: OcrLine) => boolean; inTop40: (l: OcrLine) => boolean } {
  const head = ls.filter((l) => /申請人個人資料|Personal\s*Particulars/i.test(l.t)).sort((a, b) => cy(b) - cy(a))[0];
  if (!head) return { inSection: (l) => cy(l) >= 0.5, inTop40: (l) => cy(l) >= 0.8 }; // 頁頂 50% 嘅頂 40%
  const end = ls.filter((l) => cy(l) < cy(head) && /過去\s*[3三]\s*年|受僱記錄|諮詢人資料|Employment\s*Record/i.test(l.t)).sort((a, b) => cy(b) - cy(a))[0];
  const bottom = end ? cy(end) : 0;
  return { inSection: (l) => cy(l) < cy(head) && (!end || cy(l) > cy(end)), inTop40: (l) => cy(l) >= cy(head) - 0.4 * (cy(head) - bottom) };
}
/** 表頭樣式嘅「姓 名」（姓同名中間有空格，或者同行有地址／電話／關係 label）唔算本人姓名欄。 */
function isTableHeaderName(l: OcrLine, ls: readonly OcrLine[]): boolean {
  if (/^姓\s+名$/.test(norm(l.t).trim()) || /^姓\s+名\s*[:：]?$/.test(l.t.trim())) return true;
  return ls.some((o) => o !== l && sameRow(o, l) && /地址|電話|關係|Relation|Address|Tel|Phone/i.test(o.t));
}

/**
 * 入職表欄位**單格**裁圖（TE-1.7：barrier 用「任何 OCR 行」，唔只係認到嘅 label）。
 *  - 同行格（「住址：值」「香港身份證：值｜出生日期：值｜…」）：值＝label 右邊同行連續（間距 ≤3×行高）而且唔係 label 樣式嘅行；
 *    右界＝值之後**同行右邊最近嘅任何 OCR 行**左邊（冇就值最右＋0.6×行高）；
 *  - 大格範本（label 自成一行、值喺下面幾行，例如「地址」）：取 label 下方直到下一個 label 樣式行（含「：」或在詞表）為止嘅所有行；
 *    水平範圍＝label 同呢啲行 box 聯集左右各 0.6×行高；
 *  - 上下界＝格內行各 ≤0.25×行高，唔過上方／下方、水平重疊嘅**任何** OCR 行（padAround barrier）；
 *  - 地址值多行（續行同值左邊對齊、緊貼下一行）亦算同一格；
 *  - 姓名／電話 label 含「聯絡人／緊急／擔保／見證／僱主」唔當本人欄。
 * 相片格（右上角）：同相片區相交先夾右緣，仍相交跳過（form_photo_overlap）。
 */
export function locateFormCell(field: EvidenceField, lines: readonly OcrLine[], variant = 0, photoBox: Box | null = FORM_PHOTO_BOX): { box: Box | null; label?: OcrLine; reason?: 'form_label_not_located' | 'form_photo_overlap' } {
  const spec = FORM_LABEL_VARIANTS[field]?.[variant] ?? FORM_LABEL[field];
  if (!spec) return { box: null, reason: 'form_label_not_located' };
  const ls = splitMergedLines(lines.filter((l) => l.t.trim()));
  const isName = field === 'name_zh' || field === 'name_en';
  const sec = isName ? inPersonalSection(ls) : null;
  /** 單獨「Name：」（冇 English／中文）：同行或上一行冇任何其他人物詞，而且喺個人資料段落頂部 40% 先接受（避免揀中緊急聯絡人表頭） */
  const standaloneOk = (l: OcrLine): boolean => {
    if (!/^Name\s*[:：]?$/i.test(norm(l.t).trim())) return true;
    if (!sec?.inTop40(l)) return false;
    return !ls.some((o) => o !== l && OTHER_PERSON.test(o.t) && (sameRow(o, l) || (cy(o) > cy(l) && cy(o) - cy(l) < 2.2 * l.h)));
  };
  const L0 = ls
    .filter((l) => isFormLabel(l) && spec.re.test(norm(l.t)) && !(spec.not && spec.not.test(norm(l.t))) && (!sec || sec.inSection(l)) && !(isName && isTableHeaderName(l, ls)) && (field !== 'name_en' || standaloneOk(l)))
    .sort((a, b) => cy(b) - cy(a))[0] as SegLine | undefined;
  if (!L0) return { box: null, reason: 'form_label_not_located' };
  // 範本 B：中文 label 下一行係英文翻譯 → 合併成 label block（高度＝block；cap 以 block 計）
  // 範本 B：中文 label 下一行係英文翻譯（規則：以英文字母開頭、含 Name／Phone／Address／Birth／Card／Date 之一、x 範圍重疊 ≥50%、垂直距離 ≤1.2×行高）→ 合併成 label block
  const tr = TRANSLATION_LABEL[field];
  const L2 = tr && /[\u4e00-\u9fff]/.test(L0.t)
    ? ls
        .filter((l) => l !== L0 && /^[A-Za-z]/.test(norm(l.t).trim()) && !/[\u4e00-\u9fff]/.test(l.t) && tr.re.test(l.t) && !(tr.not && tr.not.test(l.t)) && xOverlapFrac(l, L0) >= 0.5 && cy(l) < L0.y && L0.y - (l.y + l.h) < 1.2 * L0.h)
        .sort((a, b) => cy(b) - cy(a))[0]
    : undefined;
  const L: SegLine = L2 ? { ...L0, x: Math.min(L0.x, L2.x), w: Math.max(L0.w, L2.w), y: L2.y, h: L0.y + L0.h - L2.y } : L0;
  const others = ls.filter((l) => l !== L0 && l !== L2);

  // 同行右邊嘅行（由左到右）
  const rowRight = others.filter((l) => sameRow(l, L) && l.x >= L.x + L.w - 0.01).sort((a, b) => a.x - b.x);
  const values: OcrLine[] = [];
  let prevRight = L.x + L.w;
  for (const l of rowRight) {
    if (isFormLabel(l) || (field !== 'name_zh' && field !== 'name_en' && l.x - prevRight > 3 * L.h)) break; // 姓名欄：值可以離 label 好遠／分幾段，取到下一個 label／行尾
    values.push(l);
    prevRight = l.x + l.w;
  }
  const stopper = rowRight.find((l) => !values.includes(l)) ?? null; // 值之後同行右邊最近嘅任何 OCR 行
  let members: OcrLine[] = [L, ...values];
  let x0 = L.x;
  let x1: number;

  if (values.length === 0 && !stopper) {
    // 大格範本：label 下方直到下一個 label 樣式行
    const below = others.filter((l) => cy(l) < L.y && !sameRow(l, L)).sort((a, b) => cy(b) - cy(a));
    const block: OcrLine[] = [];
    let prevBottom = L.y;
    for (const l of below) {
      if (isFormLabel(l) || prevBottom - (l.y + l.h) > 2.5 * L.h) break;
      block.push(l);
      prevBottom = l.y;
    }
    if (block.length > 0) {
      members = [L, ...block];
      x0 = Math.min(...members.map((m) => m.x)) - 0.6 * L.h;
      x1 = Math.max(...members.map((m) => m.x + m.w)) + 0.6 * L.h;
    } else x1 = L.endX !== undefined ? Math.max(L.x + L.w, L.endX) + 0.8 * L.h : L.x + L.w + 0.15;
  } else {
    x1 = stopper ? stopper.x - 0.004 : values.length ? Math.max(...values.map((v) => v.x + v.w)) + 0.6 * L.h : (L.endX !== undefined ? Math.max(L.x + L.w, L.endX) + 0.8 * L.h : L.x + L.w + 0.15);
    if (field === 'address' && values.length > 0) {
      // 值多行：續行同首個值左邊對齊、緊貼，而且唔係 label 樣式
      let last = values[0]!;
      for (;;) {
        const cont = others.filter((l) => !members.includes(l) && !isFormLabel(l) && Math.abs(l.x - values[0]!.x) < 0.03 && cy(l) < last.y && last.y - (l.y + l.h) < 0.8 * L.h).sort((a, b) => cy(b) - cy(a))[0];
        if (!cont) break;
        members = [...members, cont];
        x1 = Math.max(x1, cont.x + cont.w + 0.6 * L.h);
        last = cont;
      }
    }
  }
  x0 = Math.max(0, x0);
  x1 = Math.min(1, Math.max(x1, L.x + L.w));
  const base: Box = { x0, x1, y0: Math.min(...members.map((m) => m.y)), y1: Math.max(...members.map((m) => m.y + m.h)) };
  // 上下界：唔過水平重疊嘅任何 OCR 行（格內成員除外）
  const barriers = others.filter((l) => !members.includes(l) && xOverlap(base, l));
  const b = padAround(base, L.h, barriers, { vertical: 0.25, horizontal: 0, min: 0.001 });
  b.x0 = x0;
  b.x1 = x1;
  if (photoBox && intersects(b, photoBox)) b.x1 = Math.min(b.x1, photoBox.x0 - 0.003);
  if (!valid(b) || (photoBox && intersects(b, photoBox)) || b.x1 < L.x + L.w) return { box: null, reason: 'form_photo_overlap' };
  return { box: b, label: L };
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

/** 硬性尺寸上限用：呢個欄嘅「自己行」同模式 */
export interface CapAnchor {
  own: readonly OcrLine[];
  mode: 'id' | 'form';
  /** id 模式：版面規則推出嘅相片區（capBox 收窄後再檢查用） */
  photo?: Box | null;
}

/**
 * S1（TE-1.9）：capBox 收窄之後再同相片範圍做相交檢查。仍相交先夾一次（號碼框 y 上限＝相片下緣；其他欄右緣＝相片左緣），
 * 夾完仍相交、或者夾走咗字本身（行 bbox 唔再被包住）→ null（呼叫者跳過，計 id_photo_overlap）。
 */
export function clipToPhoto(box: Box, photo: Box | null | undefined, own: readonly OcrLine[]): Box | null {
  if (!photo || !intersects(box, photo)) return box;
  const base = bboxOf(own);
  const b = { ...box };
  const isNumber = base.x0 + (base.x1 - base.x0) / 2 >= photo.x0; // 行喺相片 x 範圍之內（右下號碼）→ 只可以靠 y 夾
  if (isNumber) b.y1 = Math.min(b.y1, photo.y0 - 1e-6);
  else b.x1 = Math.min(b.x1, photo.x0 - 0.005);
  const cuts = own.length > 0 && (b.x0 > base.x0 + 1e-9 || b.x1 < base.x1 - 1e-9 || b.y0 > base.y0 + 1e-9 || b.y1 < base.y1 - 1e-9);
  return !valid(b) || intersects(b, photo) || cuts ? null : b;
}

/** 一個請求 → 裁圖範圍（null＝冇可靠幾何）。lines 必須已經係正向 frame（見 detectUprightRotation／rotateLines）。aspect＝頁寬／頁高。 */
export function boxForRequest(req: CropRequest, lines: readonly OcrLine[], aspect = 1, formPhoto: Box | null = FORM_PHOTO_BOX): { box: Box | null; reason?: string; anchor?: CapAnchor } {
  if (req.printed) {
    // 印刷號碼行（牌照／證書）：裁該行，小 padding（垂直 0.3×、左右 0.5× 行厚）
    const ln = req.printed.line;
    const t = Math.min(ln.h, ln.w * aspect);
    const b: Box = { x0: Math.max(0, ln.x - (0.5 * t) / aspect), x1: Math.min(1, ln.x + ln.w + (0.5 * t) / aspect), y0: Math.max(0, ln.y - 0.3 * t), y1: Math.min(1, ln.y + ln.h + 0.3 * t) };
    return { box: b, anchor: { own: [ln], mode: 'id' } };
  }
  if (req.docKind === 'id_card') {
    const f = req.field as 'hkid' | 'name_zh' | 'name_en' | 'dob';
    const g = locateIdCardBoxes(req.doc.page, lines, aspect, req.embedded?.region);
    const b = g[f] ?? null;
    return b ? { box: b, anchor: { own: g.own?.[f] ?? [], mode: 'id', photo: g.photo } } : { box: null, reason: g.overlap?.includes(f) ? 'id_photo_overlap' : (g.reason ?? 'id_field_not_located') };
  }
  if (req.docKind === 'address_proof') {
    const b = locateAddressProofBox(lines);
    if (!b) return { box: null, reason: 'address_block_not_located' };
    return addressRegionLikely(b, lines) ? { box: b } : { box: null, reason: 'address_region_unlikely' };
  }
  if (req.docKind === 'onboarding_form') {
    const r = locateFormCell(req.field, lines, req.variant ?? 0, formPhoto);
    if (!r.box) return { box: null, reason: r.reason ?? 'form_label_not_located' };
    const single = req.field !== 'address';
    return { box: r.box, ...(single && r.label ? { anchor: { own: [r.label], mode: 'form' as const } } : {}) };
  }
  return { box: null, reason: 'doc_kind_unsupported' };
}

/**
 * 硬性尺寸上限（TE-1.8；唔依賴方向／版面推算嘅最後防線）。喺輸出 frame、按實際像素量度（W×H＝該 frame 頁面像素）：
 *  - id：厚度方向（橫排＝高；側躺＝闊）≤max(1.8×行厚, 自己行 bbox 厚度＋0.6×行厚)；長度方向 ≤自己行 bbox 長度＋1.2×行厚；
 *    超出就收窄到行 bbox ± 0.3×行厚（唔係跳過）；
 *  - form（單行欄）：厚度方向 ≤2.2×label 行厚；超出就收窄到 label 行 ± 0.25×行厚（長度方向照舊）。
 * 回 { box, capped }。
 */
export function capBox(box: Box, a: CapAnchor, W: number, H: number): { box: Box; capped: boolean } {
  if (a.own.length === 0) return { box, capped: false };
  const base = bboxOf(a.own);
  const pxW = (n: number) => n * W;
  const pxH = (n: number) => n * H;
  const horizontal = a.own.reduce((s, l) => s + pxW(l.w) - pxH(l.h), 0) >= 0;
  const t = a.own.reduce((s, l) => s + Math.min(pxW(l.w), pxH(l.h)), 0) / a.own.length; // 行厚（px）
  const bw = pxW(base.x1 - base.x0);
  const bh = pxH(base.y1 - base.y0);
  const cw = pxW(box.x1 - box.x0);
  const ch = pxH(box.y1 - box.y0);
  const thickC = horizontal ? ch : cw;
  const lenC = horizontal ? cw : ch;
  const thickB = horizontal ? bh : bw;
  const lenB = horizontal ? bw : bh;
  const maxThick = a.mode === 'id' ? Math.max(1.8 * t, thickB + 0.6 * t) : 2.2 * t;
  const maxLen = a.mode === 'id' ? lenB + 1.2 * t : Infinity;
  if (thickC <= maxThick + 0.5 && lenC <= maxLen + 0.5) return { box, capped: false };
  const padX = (px: number) => px / W;
  const padY = (px: number) => px / H;
  if (a.mode === 'id') {
    const p = 0.3 * t;
    return { box: { x0: Math.max(0, base.x0 - padX(p)), x1: Math.min(1, base.x1 + padX(p)), y0: Math.max(0, base.y0 - padY(p)), y1: Math.min(1, base.y1 + padY(p)) }, capped: true };
  }
  const p = 0.25 * t;
  // form：只收窄厚度方向
  return horizontal
    ? { box: { ...box, y0: Math.max(0, base.y0 - padY(p)), y1: Math.min(1, base.y1 + padY(p)) }, capped: true }
    : { box: { ...box, x0: Math.max(0, base.x0 - padX(p)), x1: Math.min(1, base.x1 + padX(p)) }, capped: true };
}

// ---------------------------------------------------------------------------
// 3a'. 入職表裁圖越界檢查（TE-1.8）：Vision 讀到裁圖入面有「其他欄 label 關鍵詞」
// ---------------------------------------------------------------------------
/** 關鍵詞（label 別名一組）；每組係一個「欄」。 */
const OVERFLOW_GROUPS: { id: string; re: RegExp }[] = [
  { id: 'dob', re: /出生日期|Date\s*of\s*Birth/i },
  { id: 'pob', re: /出生地點|Place\s*of\s*Birth/i },
  { id: 'name_en', re: /English\s*Name|英文姓名/i },
  { id: 'name_zh', re: /中文姓名/i },
  { id: 'hkid', re: /身份證/i },
  { id: 'phone', re: /電話|Mobile|Phone/i },
  { id: 'address', re: /住址|地址|Address/i },
  { id: 'nationality', re: /國籍|Nationality/i },
  { id: 'origin', re: /籍貫/i },
  { id: 'marital', re: /婚姻|Marital/i },
  // TE-2.2：入職日期格遇到牌照／申請職位欄（非個人資料，但唔應該成行）
  { id: 'permit', re: /許可證|屆滿|Permit/i },
  { id: 'position', re: /申請職位|Position/i },
];
/** 呢條 Vision line 係咪含自己欄 label（同行判斷用） */
export function lineHasOwnLabel(field: EvidenceField, t: string): boolean {
  const own = new Set(OWN_GROUPS[field] ?? []);
  return OVERFLOW_GROUPS.some((g) => own.has(g.id) && g.re.test(t)) || (field === 'name_zh' && /姓名/.test(t) && !/英文|English/i.test(t));
}

/** 自己欄嘅關鍵詞組（排除）；name_zh 亦包含泛稱「姓名」。 */
const OWN_GROUPS: Partial<Record<EvidenceField, string[]>> = { dob: ['dob'], name_en: ['name_en'], name_zh: ['name_zh'], hkid: ['hkid'], phone: ['phone'], address: ['address'] };

/** S3：非個人資料欄（電話、入職日期、牌照號）——只有「保安員:view」權限都睇得到，所以唔可以經裁圖見到相鄰嘅個人資料格。 */
export const NON_PII_FIELDS: ReadonlySet<EvidenceField> = new Set<EvidenceField>(['phone', 'hire_date', 'permit_no']);
/** 溢出關鍵詞組入面屬個人資料嘅（除電話外全部：身份證、出生日期／地點、姓名、住址、國籍、籍貫、婚姻）。 */
export const PII_OVERFLOW_GROUPS: ReadonlySet<string> = new Set(['dob', 'pob', 'name_en', 'name_zh', 'hkid', 'address', 'nationality', 'origin', 'marital']);

export interface VisionBoxLine {
  t: string;
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface OverflowHit {
  /** right＝同一行右邊溢出（右界收到關鍵詞左邊）；below／above＝上下行溢出 */
  side: 'right' | 'below' | 'above';
  /** right：關鍵詞左緣喺裁圖闊度嘅比例（由左）；below：關鍵詞頂緣喺裁圖高度嘅比例（由上）；above：關鍵詞底緣比例（由上） */
  frac: number;
  /** 溢出嘅關鍵詞屬邊個欄組（OVERFLOW_GROUPS.id）——S3：非個人資料欄溢出到個人資料欄就唔重裁，直接跳過 */
  group?: string;
}

/** 字串內第 idx 個字元嘅水平位置比例（CJK 全寬 1、其餘 0.55）。 */
function charFrac(t: string, idx: number): number {
  const wt = (c: string) => (/[　-鿿＀-￯]/.test(c) ? 1 : 0.55);
  const chars = [...t];
  const total = chars.reduce((a, c) => a + wt(c), 0) || 1;
  return chars.slice(0, idx).reduce((a, c) => a + wt(c), 0) / total;
}

/**
 * 喺裁圖 Vision 讀數（正規化於裁圖，原點左下；已扣走放大／留白）搵「其他欄 label 關鍵詞」。
 * 同行（含自己欄 label 或預期值嗰行；成行合併成一條 line 時用字元比例估關鍵詞位置）→ right；其他行 → below／above。
 * ownRow(line)：呢條 line 係咪自己欄嗰行。
 */
export function findOverflow(field: EvidenceField, lines: readonly VisionBoxLine[], ownRow: (l: VisionBoxLine) => boolean): OverflowHit | null {
  const own = new Set(OWN_GROUPS[field] ?? []);
  const ownRegex = OVERFLOW_GROUPS.filter((g) => own.has(g.id)).map((g) => g.re);
  // 自己欄嗰行嘅垂直帶：標記為 ownRow 嘅行；冇就當裁圖正中一行
  const ownLines = lines.filter(ownRow);
  const band = ownLines.length ? { y0: Math.min(...ownLines.map((l) => l.y)), y1: Math.max(...ownLines.map((l) => l.y + l.h)) } : { y0: 0.35, y1: 0.65 };
  const bandH = Math.max(1e-6, band.y1 - band.y0);
  const hits: (OverflowHit & { dist: number })[] = [];
  for (const l of lines) {
    const t = l.t;
    const cyL = l.y + l.h / 2;
    const inBand = ownRow(l) || (cyL >= band.y0 - 0.5 * bandH && cyL <= band.y1 + 0.5 * bandH);
    for (const g of OVERFLOW_GROUPS) {
      if (own.has(g.id)) continue;
      const m = g.re.exec(t);
      if (!m) continue;
      if (ownRegex.some((re) => re.test(m[0]))) continue;
      if (inBand) {
        const f = l.x + charFrac(t, m.index) * l.w;
        if (f > 0.02) hits.push({ side: 'right', frac: f, dist: f, group: g.id });
      } else if (cyL < band.y0) hits.push({ side: 'below', frac: 1 - (l.y + l.h), dist: 1 - cyL, group: g.id });
      else hits.push({ side: 'above', frac: 1 - l.y, dist: cyL, group: g.id });
    }
  }
  if (hits.length === 0) return null;
  // 先處理同行右溢出（最靠左嗰個），再上下
  const right = hits.filter((h) => h.side === 'right').sort((a, b) => a.dist - b.dist)[0];
  if (right) return { side: right.side, frac: right.frac, ...(right.group ? { group: right.group } : {}) };
  const other = hits.sort((a, b) => b.dist - a.dist)[0]!;
  return { side: other.side, frac: other.frac, ...(other.group ? { group: other.group } : {}) };
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
// 3b'. TE-2 一頁多文件：嵌入式身份證／印刷號碼行偵測（任何頁、唔理導入分類）
// ---------------------------------------------------------------------------
/**
 * 喺一頁 OCR 行搵嵌入式身份證卡區：試 0／90／180／270，揀第一個搵到卡區嘅方向。
 * 回 { rot, cards }：cards 嘅座標已經喺轉正後 frame（rot＝要順時針轉幾多度頁面先令卡正向）。aspect＝頁寬／頁高（轉前）。
 */
export function detectEmbeddedCards(lines: readonly OcrLine[], aspect = 1): { rot: Rotation; cards: CardRegion[]; lines: OcrLine[] } | null {
  for (const rot of [0, 90, 180, 270] as const) {
    const tl = rotateLines(lines, rot);
    const cards = findEmbeddedCards(tl, rot === 90 || rot === 270 ? 1 / aspect : aspect);
    if (cards.length > 0) return { rot, cards, lines: tl };
  }
  return null;
}

/**
 * 印刷嘅身份證號（牌照頁／證書頁）：唔喺任何卡區內（inCard 判斷，傳入原 frame 嘅行）、而且唔係真身份證頁（有標題 anchor）。
 * TE-8：token 有邊界（QATW1026240 內嘅 TW102624(0) 唔算）；每頁淨出有身份證 label 嘅候選，冇 label 先退到有括號 check digit 嘅候選；
 * 裁圖範圍由 label 起到號碼尾（有 label 時；label 喺上一行就兩行聯合），等覆核人見到上下文。
 * 回轉正後 frame 嘅行：橫排（實際闊≥高）rot 0；側躺 rot 90（之後 Vision .fast 再判 0／180）；value＝canonical 號碼（跨頁一致性檢查用）。
 */
export function findPrintedHkidLines(lines: readonly OcrLine[], aspect: number, inCard: (l: OcrLine) => boolean = () => false): { rot: Rotation; line: OcrLine; value: string; labelled: boolean }[] {
  if (lines.some((l) => isIdAnchorLine(l.t))) return [];
  const rows = readingOrder(lines.filter((l) => l.t.trim()));
  const hits = scanHkidHits(rows.map((l) => l.t), (t) => /PERMIT\s*NO|許可證編號/i.test(t)).filter((h) => !inCard(rows[h.line]!));
  const out: { rot: Rotation; line: OcrLine; value: string; labelled: boolean }[] = [];
  const frac = (l: OcrLine, a: number, b: number): [number, number] => {
    const len = Math.max(1, l.t.normalize('NFKC').length);
    return [l.x + (l.w * Math.max(0, a - 0.5)) / len, l.x + (l.w * Math.min(len, b + 0.5)) / len];
  };
  for (const h of selectPrintedHits(hits)) {
    const l = rows[h.line]!;
    const horizontal = l.w * aspect >= l.h;
    const rot: Rotation = horizontal ? 0 : 90;
    let src: OcrLine = l;
    const lab = h.labelLine !== null && h.labelLine !== h.line ? rows[h.labelLine]! : null;
    if (horizontal) {
      const [nx0, nx1] = frac(l, h.labelled && !lab && h.labelStart !== null ? h.labelStart : h.start, h.end);
      if (lab) {
        const [lx0] = frac(lab, h.labelStart ?? 0, lab.t.normalize('NFKC').length);
        const x0 = Math.min(lx0, nx0);
        const x1 = Math.max(lab.x + lab.w, nx1);
        const y0 = Math.min(lab.y, l.y);
        const y1 = Math.max(lab.y + lab.h, l.y + l.h);
        src = { ...l, t: `${lab.t} ${l.t}`, x: x0, w: x1 - x0, y: y0, h: y1 - y0 };
      } else src = { ...l, x: nx0, w: nx1 - nx0 }; // 側躺行文字方向未定，唔裁 x 範圍
    } else if (lab) {
      const y0 = Math.min(lab.y, l.y);
      const y1 = Math.max(lab.y + lab.h, l.y + l.h);
      const x0 = Math.min(lab.x, l.x);
      const x1 = Math.max(lab.x + lab.w, l.x + l.w);
      src = { ...l, t: `${lab.t} ${l.t}`, x: x0, w: x1 - x0, y: y0, h: y1 - y0 };
    }
    out.push({ rot, line: rotateLines([src], rot)[0]!, value: h.value, labelled: h.labelled });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 3c. 裁圖內容驗證（Vision 讀數 vs 預期值）——純函數；讀出嘅文字只喺記憶體比對，唔寫 log／檔案
// ---------------------------------------------------------------------------
/** 通過門檻（按 --dry fixture 調過）：號碼／電話／日期 ≥0.7、姓名 ≥0.5、地址 ≥0.4 */
export const VERIFY_THRESHOLD: Record<EvidenceField, number> = { hire_date: 0.7, hkid: 0.7, phone: 0.7, dob: 0.7, permit_no: 0.7, name_zh: 0.5, name_en: 0.5, address: 0.4, page: 0 };

const alnum = (s: string): string => s.normalize('NFKC').toUpperCase().replace(/[^0-9A-Z]/g, '');
const cjkChars = (s: string): string[] => [...s.normalize('NFKC')].filter((c) => /[一-鿿]/.test(c));

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n]!;
}

/** exp 喺 text 內最相似視窗嘅相似度 0–1（1−編輯距離/長度；視窗長度 L−1..L+1）。 */
export function bestWindowSimilarity(exp: string, text: string): number {
  if (!exp) return 0;
  if (!text) return 0;
  if (text.length <= exp.length + 1) return Math.max(0, 1 - levenshtein(exp, text) / Math.max(exp.length, text.length));
  let best = 0;
  for (let len = Math.max(1, exp.length - 1); len <= exp.length + 1; len++) {
    for (let i = 0; i + len <= text.length; i++) {
      best = Math.max(best, 1 - levenshtein(exp, text.slice(i, i + len)) / exp.length);
      if (best >= 1) return 1;
    }
  }
  return Math.max(0, best);
}

/** 最長公共子序列長度 / exp 長度。 */
export function lcsRatio(exp: string, text: string): number {
  if (!exp || !text) return 0;
  let prev = new Array<number>(text.length + 1).fill(0);
  for (let i = 1; i <= exp.length; i++) {
    const cur = [0];
    for (let j = 1; j <= text.length; j++) cur[j] = exp[i - 1] === text[j - 1] ? prev[j - 1]! + 1 : Math.max(prev[j]!, cur[j - 1]!);
    prev = cur;
  }
  return prev[text.length]! / exp.length;
}

/** 預期值變體：出生日期 ISO（YYYY-MM-DD）→ 另加卡面印法 DDMMYYYY。 */
function variantsOf(field: EvidenceField, v: string): string[] {
  const t = v.trim();
  if (field === 'dob') {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
    return m ? [`${m[1]}${m[2]}${m[3]}`, `${m[3]}${m[2]}${m[1]}`] : [alnum(t)];
  }
  return [t];
}

/** 一個讀出嘅文字同一個預期值嘅相似度 0–1。 */
export function scoreAgainst(field: EvidenceField, read: string, expected: string): number {
  if (field === 'name_zh') {
    const e = cjkChars(expected);
    if (e.length === 0) return 0;
    const r = new Set(cjkChars(read));
    return e.filter((c) => r.has(c)).length / e.length;
  }
  if (field === 'name_en') {
    const tokens = expected.normalize('NFKC').toUpperCase().split(/[^A-Z]+/).filter((t) => t.length >= 2);
    if (tokens.length === 0) return 0;
    const letters = read.normalize('NFKC').toUpperCase().replace(/[^A-Z]/g, '');
    // 每個 token 要近乎吻合（≥0.75）先算命中——短 token（2–3 字母）喺長字串入面太易湊中，唔畀部分分數
    return tokens.filter((t) => bestWindowSimilarity(t, letters) >= 0.75).length / tokens.length;
  }
  if (field === 'address') return lcsRatio(alnumCjk(expected), alnumCjk(read));
  // hkid／phone／dob／permit_no：alnum 視窗比對
  const text = alnum(read);
  return Math.max(0, ...variantsOf(field, expected).map((v) => bestWindowSimilarity(field === 'dob' ? v : alnum(v), text)));
}
const alnumCjk = (s: string): string => s.normalize('NFKC').toUpperCase().replace(/[^0-9A-Z一-鿿]/g, '');

/** 讀出文字同所有預期值（package 該欄值＋候選讀數）嘅最高相似度。 */
export function similarity(field: EvidenceField, read: string, expected: readonly string[]): number {
  return Math.max(0, ...expected.filter((e) => e.trim()).map((e) => scoreAgainst(field, read, e)));
}

const PKG_KEY: Partial<Record<EvidenceField, keyof Pick<PkgPerson, 'hkid' | 'nameZh' | 'nameEn' | 'dateOfBirth' | 'phone' | 'address'>>> = { hkid: 'hkid', name_zh: 'nameZh', name_en: 'nameEn', dob: 'dateOfBirth', phone: 'phone', address: 'address' };

/**
 * 預期值＝package 該人該欄嘅值，加 person-fields 等來源可選嘅候選值／讀數（`candidates`）。
 * 冇任何預期值（例如身份證號 missing）→ 空陣列＝無法驗證。
 */
export function expectedValuesFor(field: EvidenceField, p: PkgPerson, extraCandidates: readonly string[] = []): string[] {
  const k = PKG_KEY[field];
  if (!k) return [];
  const v = p[k] as { value: string | null; candidates?: string[] };
  return [...new Set([...(v.value ? [v.value] : []), ...(v.candidates ?? []), ...extraCandidates].map((x) => x.trim()).filter(Boolean))];
}

/** 裁圖內文字行嘅「正向程度」（w／h 係 Vision 正規化，要乘圖寬高先比較）：行 box 實際寬≥高 嘅字數減 寬<高 嘅字數（>0＝橫排：0°／180°；<0＝側躺：90°／270°）。 */
export function textUprightness(lines: readonly { t: string; w: number; h: number }[], imgW = 1, imgH = 1): number {
  return lines.reduce((a, l) => a + norm(l.t).length * (l.w * imgW >= l.h * imgH ? 1 : -1), 0);
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
  priority: 1 | 2 | 3;
  match: { hkid: string | null; staff_numbers: string[]; package_key?: string; prod_person_key?: string };
  /** TE-7：整頁原稿頁碼（field=page） */
  pageNo?: number;
  /** Vision 驗證相似度 0–1（淨數字；冇驗證＝undefined） */
  verifyScore?: number;
}

export const ZIP_MAX_ENTRIES = 300;
export const ZIP_MAX_BYTES = 7 * 1024 * 1024;

export const entryNameOf = (bytes: Uint8Array): string => `${createHash('sha256').update(bytes).digest('hex').slice(0, 32)}.jpg`;

/** 檢查單張圖符合伺服器規格（≤120 KB、JPEG header、冇 EXIF）。 */
export const imageOk = (bytes: Uint8Array, page = false): boolean => bytes.byteLength > 0 && bytes.byteLength <= (page ? MAX_PAGE_IMAGE_BYTES : MAX_IMAGE_BYTES) && inspectImage(bytes, { page })?.mime === 'image/jpeg';

/** TE-7：整頁原稿 JPEG（長邊 ≤1600、-strip、≤400 KB；質素梯級下調）。回 null＝壓唔到。 */
export const PAGE_JPEG_QUALITY_STEPS = [75, 65, 55, 45, 35] as const;
export function pageMagickArgs(quality: number): string[] {
  return ['-strip', '-resize', `${MAX_PAGE_EDGE}x${MAX_PAGE_EDGE}>`, '-colorspace', 'sRGB', '-sampling-factor', '4:2:0', '-quality', String(quality)];
}

/** TE-7：manifest.people 一條（來源檔案線索 doc_ref；file_name 係 Drive 檔名，可能含人名） */
export interface PersonDocRef {
  match: { hkid: string | null; staff_numbers: string[]; package_key?: string; prod_person_key?: string };
  doc_ref: { file_name: string; page_count: number; pages_by_kind: Record<string, number> };
}

/** 分批：每 zip ≤300 張、≤7 MB（zip ≤8 MB 上限留餘地）；manifest 每個 item 帶 doc_kind＋priority＋match。 */
export async function buildEvidenceZips(items: readonly EvidenceItem[], opts: { maxEntries?: number; maxBytes?: number; docRefs?: readonly PersonDocRef[] } = {}): Promise<{ zips: Uint8Array[]; items: number }> {
  const maxEntries = opts.maxEntries ?? ZIP_MAX_ENTRIES;
  const maxBytes = opts.maxBytes ?? ZIP_MAX_BYTES;
  const batches: EvidenceItem[][] = [];
  let cur: EvidenceItem[] = [];
  let bytes = 0;
  for (const it of items) {
    if (!imageOk(it.bytes, it.field === 'page')) continue;
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
  // 來源檔案線索（每人一條）：放入「帶有該人圖」嘅每個 zip（TE-7.2：唔好淨係第一個 zip——只上載部分 zip 都要寫到 doc_ref）；冇圖嘅人放第一個 zip
  if (batches.length === 0 && (opts.docRefs?.length ?? 0) > 0) batches.push([]);
  const idOf = (m: PersonDocRef['match']): string => `${m.hkid ?? ''}|${[...m.staff_numbers].sort().join(',')}|${m.package_key ?? ''}`;
  const withItems = new Set(items.map((it) => idOf(it.match)));
  for (const [bi, b] of batches.entries()) {
    const z = new JSZip();
    const manifest = b.map((it) => {
      const file = entryNameOf(it.bytes);
      if (!z.file(file)) z.file(file, it.bytes);
      return { file, field: it.field, doc_kind: it.docKind, priority: it.priority, ...(it.pageNo !== undefined ? { page_no: it.pageNo } : {}), match: it.match, ...(it.verifyScore !== undefined ? { verify_score: Math.round(it.verifyScore * 1000) / 1000 } : {}) };
    });
    z.file('manifest.json', JSON.stringify({ version: 1, items: manifest, ...(() => {
      const here = new Set(b.map((it) => idOf(it.match)));
      const people = (opts.docRefs ?? []).filter((d) => here.has(idOf(d.match)) || (bi === 0 && !withItems.has(idOf(d.match))));
      return people.length > 0 ? { people } : {};
    })() }));
    zips.push(await z.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }));
  }
  return { zips, items: batches.reduce((a, b) => a + b.length, 0) };
}
