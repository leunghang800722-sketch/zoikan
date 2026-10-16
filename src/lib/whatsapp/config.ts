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
