// WA-8：工卡相——WAHA 媒體即時拉取（webhook request 內）＋加密暫存（whatsapp_media_evidence）。server-only。
//  - WAHA 預設只保留下載檔 180 秒（WHATSAPP_FILES_LIFETIME），所以唔可以等 parse job：webhook 落庫嗰個 request 內即拉。
//  - 拉取只經我哋自己嘅 WAHA_BASE_URL（私網）＋X-Api-Key；`media.url` 只取 pathname+search 拼返落 WAHA_BASE_URL（唔信 payload 內 host，防 SSRF）。
//  - ≤8MB、timeout 10s、只收 image/jpeg｜png（magic bytes 驗證）；bytes 只喺記憶體→AES-256-GCM 加密落 DB（TTL 7 日，答題後刪）。唔寫檔案系統、唔 log。
//  - bytes 白名單：imageBytes／iv／tag 只喺本檔出現。
import { createHash, randomUUID } from "node:crypto";
import { prisma } from "@/lib/db";
import { decryptImage, encryptImage } from "@/lib/triage/evidence-images";
import { wahaApiKey, wahaBaseUrl } from "./config";

export const WA_MEDIA_MAX_BYTES = 8 * 1024 * 1024;
export const WA_MEDIA_TIMEOUT_MS = 10_000;
export const WA_MEDIA_TTL_MS = 7 * 86_400_000;
const ENC_VERSION = 1;

export type MediaFetchResult = { ok: true; bytes: Buffer; mime: "image/jpeg" | "image/png" } | { ok: false; error: "not_configured" | "bad_url" | "unreachable" | "timeout" | "http_error" | "too_large" | "not_image" };

export function sniffImage(b: Uint8Array): "image/jpeg" | "image/png" | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return "image/png";
  return null;
}

/** media.url → 我哋自己 WAHA_BASE_URL 下嘅 URL（只取 path＋query）；格式唔啱 → null。 */
export function internalMediaUrl(mediaUrl: string, base: string = wahaBaseUrl()): string | null {
  if (!base) return null;
  let u: URL;
  try {
    u = new URL(mediaUrl, base);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (!u.pathname.startsWith("/")) return null;
  return `${base}${u.pathname}${u.search}`;
}

export async function fetchMedia(mediaUrl: string, fetchImpl: typeof fetch = fetch): Promise<MediaFetchResult> {
  const base = wahaBaseUrl();
  if (!base) return { ok: false, error: "not_configured" };
  const url = internalMediaUrl(mediaUrl, base);
  if (!url) return { ok: false, error: "bad_url" };
  const headers: Record<string, string> = {};
  const key = wahaApiKey();
  if (key) headers["X-Api-Key"] = key;
  let res: Response;
  try {
    res = await fetchImpl(url, { method: "GET", headers, signal: AbortSignal.timeout(WA_MEDIA_TIMEOUT_MS), cache: "no-store" });
  } catch (e) {
    const name = e instanceof Error ? e.name : "";
    return { ok: false, error: name === "TimeoutError" || name === "AbortError" ? "timeout" : "unreachable" };
  }
  if (!res.ok) return { ok: false, error: "http_error" };
  const len = Number(res.headers.get("content-length"));
  if (Number.isFinite(len) && len > WA_MEDIA_MAX_BYTES) return { ok: false, error: "too_large" };
  let buf: Buffer;
  try {
    buf = await readCapped(res, WA_MEDIA_MAX_BYTES);
  } catch (e) {
    return { ok: false, error: e instanceof Error && e.message === "too_large" ? "too_large" : "unreachable" };
  }
  const mime = sniffImage(buf);
  if (!mime) return { ok: false, error: "not_image" };
  return { ok: true, bytes: buf, mime };
}

async function readCapped(res: Response, max: number): Promise<Buffer> {
  if (!res.body) {
    const b = Buffer.from(await res.arrayBuffer());
    if (b.length > max) throw new Error("too_large");
    return b;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      throw new Error("too_large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------------------
// 加密暫存
// ---------------------------------------------------------------------------
export async function storeMediaEvidence(args: { messageId: string; chatJid: string; bytes: Uint8Array; mime: "image/jpeg" | "image/png"; width?: number | null; height?: number | null; now?: Date }): Promise<void> {
  const id = randomUUID();
  const enc = encryptImage(args.bytes, id);
  const now = args.now ?? new Date();
  await prisma.whatsappMediaEvidence.upsert({
    where: { messageId: args.messageId },
    create: {
      id,
      messageId: args.messageId,
      chatJid: args.chatJid,
      imageBytes: new Uint8Array(enc.bytes),
      iv: new Uint8Array(enc.iv),
      tag: new Uint8Array(enc.tag),
      encVersion: ENC_VERSION,
      width: args.width ?? null,
      height: args.height ?? null,
      mime: args.mime,
      sha256: createHash("sha256").update(args.bytes).digest("hex"),
      expiresAt: new Date(now.getTime() + WA_MEDIA_TTL_MS),
    },
    update: {}, // 重送：保持原圖（冪等）
  });
}

/** 解密讀返（OCR／圖片 GET 用）；搵唔到／過期／key 輪換 → null。 */
export async function loadMediaEvidence(messageId: string, now: Date = new Date()): Promise<{ id: string; bytes: Buffer; mime: string } | null> {
  const r = await prisma.whatsappMediaEvidence.findUnique({ where: { messageId }, select: { id: true, imageBytes: true, iv: true, tag: true, mime: true, encVersion: true, expiresAt: true } });
  if (!r || r.expiresAt <= now || r.encVersion !== ENC_VERSION) return null;
  try {
    return { id: r.id, bytes: decryptImage({ bytes: r.imageBytes, iv: r.iv, tag: r.tag }, r.id), mime: r.mime };
  } catch {
    return null;
  }
}

export async function loadMediaEvidenceById(id: string, now: Date = new Date()): Promise<{ bytes: Buffer; mime: string; messageId: string } | null> {
  const r = await prisma.whatsappMediaEvidence.findUnique({ where: { id }, select: { id: true, messageId: true, imageBytes: true, iv: true, tag: true, mime: true, encVersion: true, expiresAt: true } });
  if (!r || r.expiresAt <= now || r.encVersion !== ENC_VERSION) return null;
  try {
    return { bytes: decryptImage({ bytes: r.imageBytes, iv: r.iv, tag: r.tag }, r.id), mime: r.mime, messageId: r.messageId };
  } catch {
    return null;
  }
}

/** 只回 meta（唔含 bytes）：圖片 id。 */
export async function mediaEvidenceId(messageId: string): Promise<string | null> {
  const r = await prisma.whatsappMediaEvidence.findUnique({ where: { messageId }, select: { id: true } });
  return r?.id ?? null;
}

export async function deleteMediaEvidence(messageIds: readonly string[]): Promise<number> {
  if (messageIds.length === 0) return 0;
  return (await prisma.whatsappMediaEvidence.deleteMany({ where: { messageId: { in: [...messageIds] } } })).count;
}

export async function purgeExpiredMedia(now: Date = new Date()): Promise<number> {
  return (await prisma.whatsappMediaEvidence.deleteMany({ where: { expiresAt: { lte: now } } })).count;
}
