// W0：WhatsApp 報更模組嘅 env 讀取（server-only；全部 optional，預設總開關關閉）。
// 唔 log 任何值；key／secret 只用嚟比對，從不回傳。
export const WA_MAX_BODY_BYTES = 64 * 1024;
/** `timestamp` 早過呢個毫秒數 → 落庫標 ignored:stale（防重放）。 */
export const WA_STALE_MS = 72 * 3600 * 1000;
/** `timestamp` 遲過 now + 呢個毫秒數 → 落庫標 ignored:future_ts。 */
export const WA_FUTURE_MS = 10 * 60 * 1000;
/** 單條訊息文字上限（字元）；超出截斷（保守，防極端長文塞爆 DB）。 */
export const WA_MAX_TEXT_CHARS = 20000;
/** 保留期（日）：ts 早過 now - 90 日嘅 text／text_history 置空。 */
export const WA_RETENTION_DAYS = 90;
export const WA_HOOK_HEADER = "x-zoikan-hook";
export const WA_HMAC_HEADER = "x-webhook-hmac";
export const WA_HMAC_ALGO_HEADER = "x-webhook-hmac-algorithm";

export function waEnabled(): boolean {
  return process.env.WA_ENABLED === "1";
}
export function waHmacKey(): string {
  return process.env.WA_WEBHOOK_HMAC_KEY ?? "";
}
export function waHeaderSecret(): string {
  return process.env.WA_WEBHOOK_HEADER_SECRET ?? "";
}
export function wahaBaseUrl(): string {
  return (process.env.WAHA_BASE_URL ?? "").replace(/\/+$/, "");
}
export function wahaApiKey(): string {
  return process.env.WAHA_API_KEY ?? "";
}
export function wahaSession(): string {
  return process.env.WAHA_SESSION || "default";
}

/**
 * W3：自動寫入總開關。預設開（env 冇設）；設 "1" 都係開；任何其他值（"0"、"false"、亂碼）一律當關（fail closed）
 * ——關咗之後 routed=auto_write 嘅 intent 全部改 Triage（reason `auto_disabled`），唔寫更。
 */
export function waAutoWriteEnabled(): boolean {
  const v = process.env.WA_AUTO_WRITE_ENABLED;
  if (v === undefined) return true;
  return v.trim() === "1";
}
/** W3：同一發訊人重覆同一 intent 嘅去重窗口。 */
export const WA_DEDUPE_WINDOW_MS = 5 * 60 * 1000;
/** W3：自動寫入最低信心（§6.1；W1 resolve 已擋，寫入前再擋一次）。 */
export const WA_AUTO_MIN_CONFIDENCE = 0.6;
