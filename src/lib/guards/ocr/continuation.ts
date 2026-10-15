// WP-OCR-3：兩段式讀嘅 continuation token（server-only）。
// stage A 結果（讀 A 原始欄位讀數＋已驗證 box＋用量標籤）簽名後交俾 client，stage B 再帶返嚟——伺服器唔存任何 state。
// HMAC-SHA256（key 由 SESSION_SECRET 經固定 label 衍生）；10 分鐘有效；綁定 session userId；單次使用（process 內記 nonce）。
// 唔加密：內容本來就會回俾同一個 client（只係防篡改／防冒充）。鐵則：呢個 token 只經 HTTP 往返，唔寫 log／DB／audit。
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { OCR_DOC_TYPES, OCR_FIELDS, OCR_MAX_REFS_CHARS } from "./config";
import { sanitizeRefs, type Refs } from "./refs";
import { fieldReadSchema } from "./field-read";
import { sanitizeFieldBoxes, type FieldBoxes } from "./field-crops";
import type { ModelReads } from "./read";
import type { OcrDocType } from "./config";
import type { OcrProviderName } from "./vision-client";

export const CONTINUATION_TTL_MS = 10 * 60_000;
/** continuation 字元上限（zod 校驗用） */
export const OCR_MAX_CONTINUATION_CHARS = 64_000;
/** 固定錯誤字串（唔帶內容） */
export const CONTINUATION_INVALID_MSG = "辨識憑證無效或者已過期，請重新辨識";

const LABEL = "guard-ocr-continuation-v1";

export interface ContinuationPayload {
  type: OcrDocType;
  uid: string;
  /** 讀 A 原始讀數（未 reconcile） */
  a: ModelReads | null;
  boxes: FieldBoxes;
  provider: OcrProviderName;
  model: string;
  /** 讀 A 退回原因（冇＝null） */
  fb: string | null;
  usage: { promptTokens: number; completionTokens: number; calls: number; truncated: number };
}

const payloadSchema = z.object({
  v: z.literal(1),
  iat: z.number().int(),
  nonce: z.string().min(8).max(64),
  uid: z.string().min(1).max(100),
  type: z.enum(OCR_DOC_TYPES),
  a: z.union([z.null(), z.object(Object.fromEntries(OCR_FIELDS.map((f) => [f, fieldReadSchema.optional()])))]),
  boxes: z.unknown(),
  provider: z.enum(["claude", "deepseek"]),
  model: z.string().max(100),
  fb: z.string().max(100).nullable(),
  usage: z.object({ promptTokens: z.number().int().min(0), completionTokens: z.number().int().min(0), calls: z.number().int().min(0).max(10), truncated: z.number().int().min(0).max(10) }),
});

function key(secret: string): Buffer {
  if (!secret || secret.length < 32) throw new Error("SESSION_SECRET 未設定或長度不足 32 字符");
  return createHmac("sha256", secret).update(LABEL).digest();
}
const b64u = (b: Buffer | string): string => Buffer.from(b).toString("base64url");

export function signContinuation(p: ContinuationPayload, secret: string, now: number = Date.now()): string {
  const body = b64u(JSON.stringify({ v: 1, iat: now, nonce: randomBytes(12).toString("base64url"), ...p }));
  const sig = b64u(createHmac("sha256", key(secret)).update(body).digest());
  return `${body}.${sig}`;
}

// 單次使用：process 內記已用 nonce（過期後清走）。多實例部署下只係盡力而為，核心防線仍係簽名＋10 分鐘＋userId。
const used = new Map<string, number>();
function markUsed(nonce: string, expiresAt: number, now: number): boolean {
  for (const [n, exp] of used) if (exp < now) used.delete(n);
  if (used.has(nonce)) return false;
  used.set(nonce, expiresAt);
  return true;
}
/** 測試用：清空已用 nonce */
export function resetContinuationNonces(): void {
  used.clear();
}

export type VerifyResult = { ok: true; payload: ContinuationPayload } | { ok: false };

/** 驗簽、過期、userId、單次使用；任何失敗一律 { ok:false }（唔講原因，防探測）。 */
export function verifyContinuation(token: string, secret: string, uid: string, now: number = Date.now(), opts: { consume?: boolean } = {}): VerifyResult {
  try {
    if (token.length > OCR_MAX_CONTINUATION_CHARS) return { ok: false };
    const parts = token.split(".");
    if (parts.length !== 2) return { ok: false };
    const [body, sig] = parts as [string, string];
    const expect = createHmac("sha256", key(secret)).update(body).digest();
    const got = Buffer.from(sig, "base64url");
    if (got.length !== expect.length || !timingSafeEqual(got, expect)) return { ok: false };
    const parsed = payloadSchema.safeParse(JSON.parse(Buffer.from(body, "base64url").toString("utf-8")));
    if (!parsed.success) return { ok: false };
    const d = parsed.data;
    if (d.uid !== uid) return { ok: false };
    if (d.iat > now + 60_000 || now - d.iat > CONTINUATION_TTL_MS) return { ok: false };
    if (opts.consume !== false && !markUsed(d.nonce, d.iat + CONTINUATION_TTL_MS, now)) return { ok: false };
    return {
      ok: true,
      payload: {
        type: d.type as OcrDocType,
        uid: d.uid,
        a: d.a as ModelReads | null,
        boxes: sanitizeFieldBoxes(d.boxes, OCR_FIELDS),
        provider: d.provider,
        model: d.model,
        fb: d.fb,
        usage: d.usage,
      },
    };
  } catch {
    return { ok: false };
  }
}

// ---------------------------------------------------------------------------
// WP-OCR-1：refs_token——印刷證件 confirmed 欄位值（跨文件上下文）。同 continuation 一樣機制：
// HMAC-SHA256（key 由 SESSION_SECRET 經另一個固定 label 衍生，同 continuation 唔通用）、綁 userId、10 分鐘、≤OCR_MAX_REFS_CHARS。
// 唔加密（內容本來就係回俾同一個 client）；只防篡改／冒充／換人。可重複驗證（stage a 入職表、stage b 都帶），
// 但「抵銷第二次配額預留」嘅 credit 單次使用（process 內記 nonce；多實例盡力而為）。
// ---------------------------------------------------------------------------
const REFS_LABEL = "guard-ocr-refs-v1";
const refsPayloadSchema = z.object({
  v: z.literal(1),
  iat: z.number().int(),
  nonce: z.string().min(8).max(64),
  uid: z.string().min(1).max(100),
  refs: z.record(z.string(), z.unknown()),
});

function refsKey(secret: string): Buffer {
  if (!secret || secret.length < 32) throw new Error("SESSION_SECRET 未設定或長度不足 32 字符");
  return createHmac("sha256", secret).update(REFS_LABEL).digest();
}

/** 簽發 refs token（refs 會先消毒）。超過字元上限 → throw（caller 當冇 token）。 */
export function signRefs(refs: Refs, uid: string, secret: string, now: number = Date.now()): string {
  const body = b64u(JSON.stringify({ v: 1, iat: now, nonce: randomBytes(12).toString("base64url"), uid, refs: sanitizeRefs(refs) }));
  const token = `${body}.${b64u(createHmac("sha256", refsKey(secret)).update(body).digest())}`;
  if (token.length > OCR_MAX_REFS_CHARS) throw new Error("refs_too_large");
  return token;
}

export type VerifyRefsResult = { ok: true; refs: Refs; nonce: string } | { ok: false };

/** 驗簽、過期、userId、長度；任何失敗 { ok:false }（唔講原因）。唔消耗 nonce。 */
export function verifyRefs(token: string, secret: string, uid: string, now: number = Date.now()): VerifyRefsResult {
  try {
    if (token.length > OCR_MAX_REFS_CHARS) return { ok: false };
    const parts = token.split(".");
    if (parts.length !== 2) return { ok: false };
    const [body, sig] = parts as [string, string];
    const expect = createHmac("sha256", refsKey(secret)).update(body).digest();
    const got = Buffer.from(sig, "base64url");
    if (got.length !== expect.length || !timingSafeEqual(got, expect)) return { ok: false };
    const parsed = refsPayloadSchema.safeParse(JSON.parse(Buffer.from(body, "base64url").toString("utf-8")));
    if (!parsed.success) return { ok: false };
    const d = parsed.data;
    if (d.uid !== uid) return { ok: false };
    if (d.iat > now + 60_000 || now - d.iat > CONTINUATION_TTL_MS) return { ok: false };
    return { ok: true, refs: sanitizeRefs(d.refs), nonce: d.nonce };
  } catch {
    return { ok: false };
  }
}

const creditUsed = new Map<string, number>();
/** 抵銷「第二次 stage a 配額預留」嘅 credit：同一 refs token 只可以用一次（true＝首次，可以免預留）。 */
export function consumeRefsCredit(nonce: string, now: number = Date.now()): boolean {
  for (const [n, exp] of creditUsed) if (exp < now) creditUsed.delete(n);
  if (creditUsed.has(nonce)) return false;
  creditUsed.set(nonce, now + CONTINUATION_TTL_MS + 60_000);
  return true;
}
/** 測試用：清空已用 credit */
export function resetRefsCredits(): void {
  creditUsed.clear();
}
