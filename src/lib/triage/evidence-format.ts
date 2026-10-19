// TE-1：證據裁圖「格式／來源表」——純函數、零 DB 依賴（伺服器同本機腳本 scripts/staff-import/20-triage-evidence.ts 共用）。
//  - 欄位／文件類別／每欄來源優先順序（老闆 2026-10-18 補充，方案 §7）／張數與大小上限。
//  - 圖片 header 驗證（S4）：magic bytes、尺寸、剝走 EXIF／APPn／文字 chunk。
export const EVIDENCE_FIELDS = ["hkid", "name_zh", "name_en", "dob", "phone", "address", "permit_no", "hire_date", "page"] as const;
export type EvidenceField = (typeof EVIDENCE_FIELDS)[number];
export const DOC_KINDS = ["id_card", "onboarding_form", "address_proof", "sia_permit", "printed", "full_page"] as const;
export type DocKind = (typeof DOC_KINDS)[number];

/**
 * 每欄來源優先順序（方案 §7；TE-2：身份證號加「印刷」來源）：priority＝喺該欄清單入面嘅位置（1 起）。
 * 身份證號：身份證副本（含夾喺牌照頁等嘅嵌入式身份證）1 ＞ 牌照／證書印刷 2 ＞ 入職表手寫 3。
 */
export const FIELD_DOC_PRIORITY: Record<EvidenceField, readonly DocKind[]> = {
  hkid: ["id_card", "printed", "onboarding_form"],
  name_zh: ["id_card", "onboarding_form"],
  name_en: ["id_card", "onboarding_form"],
  dob: ["id_card", "onboarding_form"],
  address: ["address_proof", "onboarding_form"],
  phone: ["onboarding_form"],
  permit_no: ["sia_permit", "onboarding_form"],
  // TE-2：入職表「入職日期」（人事部格）同「可到職日期」兩格，同屬 onboarding_form（priority 1）；非敏感，權限跟「保安員:view」
  hire_date: ["onboarding_form"],
  // TE-7：整頁原稿暫存圖（抽取失敗人嘅例外；方案 §14）
  page: ["full_page"],
};
/** doc_kind 喺該欄嘅 priority（1／2／3）；唔屬該欄允許來源＝null。 */
export function priorityOf(field: EvidenceField, doc: DocKind): 1 | 2 | 3 | null {
  const i = FIELD_DOC_PRIORITY[field].indexOf(doc);
  return i === 0 ? 1 : i === 1 ? 2 : i === 2 ? 3 : null;
}
export const DOC_KIND_LABEL: Record<DocKind, string> = { id_card: "身份證副本", address_proof: "住址證明", onboarding_form: "入職表手寫", sia_permit: "牌照卡副本", printed: "牌照／證書印刷", full_page: "原稿頁" };

export const MAX_IMAGE_BYTES = 120 * 1024;
/** TE-2：每欄 ≤3（身份證副本／印刷／入職表手寫），每人 ≤18（原 2／12） */
export const MAX_PER_FIELD = 3;
export const MAX_PER_PERSON = 18;
/** TE-7：整頁原稿（field=page／doc_kind=full_page）——另計，每人 ≤8 頁；每張 ≤400 KB、長邊 ≤1600px（欄位裁圖仍 ≤120 KB／800px） */
export const MAX_PAGES_PER_PERSON = 8;
export const MAX_PAGE_IMAGE_BYTES = 400 * 1024;
export const MAX_PAGE_EDGE = 1600;
export const RETENTION_DAYS = 180;
export const SKIPPED_RETENTION_DAYS = 30;
export const ENC_VERSION = 1;

// ---------------------------------------------------------------------------
// 圖片 header 驗證（S4）：magic bytes、尺寸、剝走 EXIF／APPn／文字 chunk
// ---------------------------------------------------------------------------
export interface ImageInfo {
  mime: "image/jpeg" | "image/png";
  width: number;
  height: number;
}

/** 回 null＝唔合格（唔係 JPEG／PNG、太大、仲有 EXIF／APPn／comment／文字 chunk、讀唔到尺寸）。 */
/** 規格長邊上限（本機腳本縮至 800px）。 */
const MAX_EDGE = 800;

/** TE-7：整頁原稿用較闊規格（≤400 KB、長邊 ≤1600）；預設係欄位裁圖規格。 */
export function inspectImage(buf: Uint8Array, opts: { page?: boolean } = {}): ImageInfo | null {
  const maxBytes = opts.page ? MAX_PAGE_IMAGE_BYTES : MAX_IMAGE_BYTES;
  const maxEdge = opts.page ? MAX_PAGE_EDGE : MAX_EDGE;
  if (buf.length < 16 || buf.length > maxBytes) return null;
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return inspectJpeg(b, maxEdge);
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return inspectPng(b, maxEdge);
  return null;
}

function inspectJpeg(b: Buffer, MAX_EDGE: number): ImageInfo | null {
  let i = 2;
  let dims: { width: number; height: number } | null = null;
  while (i + 2 <= b.length) {
    if (b[i] !== 0xff) return null;
    const m = b[i + 1]!;
    if (m === 0xff) {
      i += 1;
      continue;
    }
    if (m === 0xd9) {
      // EOI：必須喺檔尾（EOI 後有尾巴＝可能夾帶資料 → 拒）
      return dims && i + 2 === b.length ? { mime: "image/jpeg", ...dims } : null;
    }
    if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x01 || m === 0x00) {
      i += 2;
      continue;
    }
    if (i + 4 > b.length) return null;
    const len = b.readUInt16BE(i + 2);
    if (len < 2 || i + 2 + len > b.length) return null;
    // APP1–APP15（EXIF／XMP／ICC／Adobe…）同 COM 一律唔收（SOF 前後都掃）；APP0（JFIF）准
    if ((m >= 0xe1 && m <= 0xef) || m === 0xfe) return null;
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      if (len < 8 || dims) return null;
      const height = b.readUInt16BE(i + 5);
      const width = b.readUInt16BE(i + 7);
      if (!(width > 0 && height > 0 && width <= MAX_EDGE && height <= MAX_EDGE)) return null;
      dims = { width, height };
    }
    i += 2 + len;
    if (m === 0xda) {
      // SOS 之後係 entropy-coded data：跳過直到下一個真 marker（0xFF 後面唔係 00／RSTn）
      while (i + 1 < b.length) {
        if (b[i] === 0xff && b[i + 1] !== 0x00 && !(b[i + 1]! >= 0xd0 && b[i + 1]! <= 0xd7) && b[i + 1] !== 0xff) break;
        i += 1;
      }
    }
  }
  return null;
}

function inspectPng(b: Buffer, MAX_EDGE: number): ImageInfo | null {
  let i = 8;
  let dims: { width: number; height: number } | null = null;
  while (i + 12 <= b.length) {
    const len = b.readUInt32BE(i);
    const type = b.toString("latin1", i + 4, i + 8);
    if (len > b.length) return null;
    if (type === "IHDR") {
      if (len !== 13) return null;
      dims = { width: b.readUInt32BE(i + 8), height: b.readUInt32BE(i + 12) };
    } else if (type === "eXIf" || type === "tEXt" || type === "iTXt" || type === "zTXt" || type === "iCCP") return null;
    else if (type === "IEND") break;
    i += 12 + len;
  }
  return dims && dims.width > 0 && dims.height > 0 && dims.width <= MAX_EDGE && dims.height <= MAX_EDGE ? { mime: "image/png", ...dims } : null;
}

