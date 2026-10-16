// W0：webhook 來源驗證（純函數，冇 DB）。HMAC-sha512 對 **raw body bytes** ＋ 自訂 header secret，
// 兩個都用 timingSafeEqual；任何一個唔過（或 key／secret 未設）＝拒絕（fail closed）。
import { createHmac, createHash, timingSafeEqual } from "node:crypto";

/** 常數時間字串比較（先各自 sha256 成等長，避免長度洩漏同 timingSafeEqual 長度要求）。 */
export function safeEqualStr(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}

export function computeHmacHex(rawBody: Buffer | string, key: string): string {
  return createHmac("sha512", key).update(rawBody).digest("hex");
}

export type VerifyResult = { ok: true } | { ok: false; reason: "no_key" | "no_secret" | "bad_algo" | "bad_hmac" | "bad_header" };

export function verifyWebhook(args: {
  rawBody: Buffer;
  hmacHeader: string | null;
  algoHeader: string | null;
  hookHeader: string | null;
  hmacKey: string;
  headerSecret: string;
}): VerifyResult {
  if (!args.hmacKey) return { ok: false, reason: "no_key" };
  if (!args.headerSecret) return { ok: false, reason: "no_secret" };
  if (args.algoHeader && args.algoHeader.trim().toLowerCase() !== "sha512") return { ok: false, reason: "bad_algo" };
  const expected = computeHmacHex(args.rawBody, args.hmacKey);
  const got = (args.hmacHeader ?? "").trim().toLowerCase();
  // 兩個檢查都一定行晒（唔提早 return），減少時序差異
  const hmacOk = safeEqualStr(got, expected);
  const headerOk = safeEqualStr(args.hookHeader ?? "", args.headerSecret);
  if (!hmacOk) return { ok: false, reason: "bad_hmac" };
  if (!headerOk) return { ok: false, reason: "bad_header" };
  return { ok: true };
}
