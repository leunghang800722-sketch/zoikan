// TE-1 測試共用：合成「欄位裁圖」bytes（只有合法 header 嘅最小 JPEG／PNG，唔含任何真實內容）同 zip 砌法。
import JSZip from "jszip";
import { createHash } from "node:crypto";

/** 最小 JPEG：SOI、APP0(JFIF)、可選 APP1(Exif)、SOF0(w,h)、SOS、seed bytes、EOI。 */
export function fakeJpeg(w = 320, h = 80, o: { seed?: number; exif?: boolean; pad?: number } = {}): Uint8Array {
  const b: number[] = [0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0];
  if (o.exif) b.push(0xff, 0xe1, 0, 8, 0x45, 0x78, 0x69, 0x66, 0, 0);
  b.push(0xff, 0xc0, 0, 11, 8, (h >> 8) & 255, h & 255, (w >> 8) & 255, w & 255, 1, 1, 0x11, 0);
  b.push(0xff, 0xda, 0, 8, 1, 1, 0, 0, 63, 0);
  const seed = o.seed ?? 0;
  for (let i = 0; i < 24; i++) b.push((seed * 31 + i * 7) & 0xff);
  for (let i = 0; i < (o.pad ?? 0); i++) b.push(i & 0x7f);
  b.push(0xff, 0xd9);
  return new Uint8Array(b);
}

const chunk = (type: string, data: Buffer) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  return Buffer.concat([len, Buffer.from(type, "latin1"), data, Buffer.alloc(4)]); // CRC 唔驗
};
export function fakePng(w = 200, h = 60, o: { seed?: number; exif?: boolean } = {}): Uint8Array {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const parts = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr)];
  if (o.exif) parts.push(chunk("eXIf", Buffer.from("Exif")));
  parts.push(chunk("IDAT", Buffer.from([o.seed ?? 0, 1, 2, 3, 4, 5, 6, 7])), chunk("IEND", Buffer.alloc(0)));
  return new Uint8Array(Buffer.concat(parts));
}

/** 不透明 entry 名：sha256 前 32 位 + 副檔名。 */
export const entryName = (bytes: Uint8Array, ext: "jpg" | "png" = "jpg") => `${createHash("sha256").update(bytes).digest("hex").slice(0, 32)}.${ext}`;

export interface ManifestItem {
  file: string;
  field: string;
  doc_kind: string;
  priority: 1 | 2;
  match?: { hkid?: string | null; staff_numbers?: string[] };
}

export async function buildZip(entries: Record<string, Uint8Array | string>): Promise<Uint8Array> {
  const z = new JSZip();
  for (const [n, d] of Object.entries(entries)) z.file(n, d);
  return z.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}

/** 一張圖一個 item：回 zip bytes。 */
export async function zipOf(items: { bytes: Uint8Array; field: string; doc_kind: string; priority: 1 | 2; match: { hkid?: string | null; staff_numbers?: string[] }; ext?: "jpg" | "png" }[], extra: Record<string, Uint8Array | string> = {}): Promise<Uint8Array> {
  const entries: Record<string, Uint8Array | string> = {};
  const manifest: ManifestItem[] = [];
  for (const it of items) {
    const file = entryName(it.bytes, it.ext ?? "jpg");
    entries[file] = it.bytes;
    manifest.push({ file, field: it.field, doc_kind: it.doc_kind, priority: it.priority, match: it.match });
  }
  entries["manifest.json"] = JSON.stringify({ version: 1, items: manifest });
  return buildZip({ ...entries, ...extra });
}
