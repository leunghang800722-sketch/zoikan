// TE-1：證據裁圖「格式／來源表」——純函數、零 DB 依賴（伺服器同本機腳本 scripts/staff-import/20-triage-evidence.ts 共用）。
//  - 欄位／文件類別／每欄來源優先順序（老闆 2026-10-18 補充，方案 §7）／張數與大小上限。
//  - 圖片 header 驗證（S4）：magic bytes、尺寸、剝走 EXIF／APPn／文字 chunk。
export const EVIDENCE_FIELDS = ["hkid", "name_zh", "name_en", "dob", "phone", "address", "permit_no"] as const;
export type EvidenceField = (typeof EVIDENCE_FIELDS)[number];
export const DOC_KINDS = ["id_card", "onboarding_form", "address_proof", "sia_permit"] as const;
export type DocKind = (typeof DOC_KINDS)[number];

/** 每欄來源優先順序（方案 §7）：index 0＝優先來源（priority 1），index 1＝退而求其次（priority 2）。 */
export const FIELD_DOC_PRIORITY: Record<EvidenceField, readonly DocKind[]> = {
  hkid: ["id_card", "onboarding_form"],
  name_zh: ["id_card", "onboarding_form"],
  name_en: ["id_card", "onboarding_form"],
  dob: ["id_card", "onboarding_form"],
  address: ["address_proof", "onboarding_form"],
  phone: ["onboarding_form"],
  permit_no: ["sia_permit", "onboarding_form"],
};
/** doc_kind 喺該欄嘅 priority（1／2）；唔屬該欄允許來源＝null。 */
export function priorityOf(field: EvidenceField, doc: DocKind): 1 | 2 | null {
  const i = FIELD_DOC_PRIORITY[field].indexOf(doc);
  return i === 0 ? 1 : i === 1 ? 2 : null;
}
export const DOC_KIND_LABEL: Record<DocKind, string> = { id_card: "身份證副本", address_proof: "住址證明", onboarding_form: "入職表手寫", sia_permit: "牌照卡副本" };

export const MAX_IMAGE_BYTES = 120 * 1024;
export const MAX_PER_FIELD = 2;
export const MAX_PER_PERSON = 12;
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
export function inspectImage(buf: Uint8Array): ImageInfo | null {
  if (buf.length < 16 || buf.length > MAX_IMAGE_BYTES) return null;
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return inspectJpeg(b);
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return inspectPng(b);
  return null;
}

function inspectJpeg(b: Buffer): ImageInfo | null {
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return null;
    const m = b[i + 1]!;
    if (m === 0xff) {
      i += 1;
      continue;
    }
    if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x01) {
      i += 2;
      continue;
    }
    if (m === 0xd9) return null; // EOI 先於 SOF
    const len = b.readUInt16BE(i + 2);
    if (len < 2 || i + 2 + len > b.length) return null;
    // APP1–APP15（EXIF／XMP／ICC／Adobe…）同 COM 一律唔收；APP0（JFIF）准
    if ((m >= 0xe1 && m <= 0xef) || m === 0xfe) return null;
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      if (len < 8) return null;
      const height = b.readUInt16BE(i + 5);
      const width = b.readUInt16BE(i + 7);
      return width > 0 && height > 0 && width <= 4000 && height <= 4000 ? { mime: "image/jpeg", width, height } : null;
    }
    i += 2 + len;
  }
  return null;
}

function inspectPng(b: Buffer): ImageInfo | null {
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
  return dims && dims.width > 0 && dims.height > 0 && dims.width <= 4000 && dims.height <= 4000 ? { mime: "image/png", ...dims } : null;
}

