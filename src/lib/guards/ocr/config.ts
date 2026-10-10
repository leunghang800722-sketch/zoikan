// WP-GUARD-OCR §29：單人新增保安員——證件圖由 Claude（讀 A）同 DeepSeek（讀 B）視覺模型辨識（§36）。
// 刻意零重 import（server component／layout 都可以安全 import）。
//
// 鐵則例外（老闆 2026-10-05）：AI 助手照舊唔准見個人資料；淨係呢個功能、淨係用戶自己上載嗰幾張
// 證件圖會送去 DeepSeek。圖片同辨識出嚟嘅欄位值只喺記憶體處理，唔寫磁碟／DB／log／audit。

export const OCR_DOC_TYPES = ["id_card", "address_proof", "onboarding_form"] as const;
export type OcrDocType = (typeof OCR_DOC_TYPES)[number];

export const OCR_FIELDS = ["name_zh", "name_en", "hkid", "dob", "sex", "phone", "address"] as const;
export type OcrFieldKey = (typeof OCR_FIELDS)[number];

/** 每種文件要抽嘅欄位（來源優先次序照 §26：身份證＝姓名／身份證號／出生日期／性別；住址證明＝住址；入職表＝電話，冇住址證明時補住址）。 */
export const OCR_DOC_FIELDS: Record<OcrDocType, readonly OcrFieldKey[]> = {
  id_card: ["name_zh", "name_en", "hkid", "dob", "sex"],
  address_proof: ["address"],
  onboarding_form: ["phone", "address"],
};

export const OCR_MAX_DOCS = 3;
export const OCR_MAX_TILES = 4;
/** 單張 data URL 字元上限（1,600px JPEG 一般 < 500KB → base64 < 700KB）。 */
export const OCR_MAX_IMAGE_CHARS = 900_000;
/** 整個請求體字元上限（3 份文件 × 5 張）。 */
export const OCR_MAX_BODY_CHARS = 8_000_000;

export const DEFAULT_OCR_MODEL = "deepseek-flash";
export const DEFAULT_OCR_BASE_URL = "https://api.deepseek.com";
export const OCR_CALL_TIMEOUT_MS = 60_000;
export const OCR_MAX_OUTPUT_TOKENS = 1500;

/** WP-OCR-CLAUDE §36：讀 A 用 Claude（老闆 2026-10-10 揀 Opus 5.5）。 */
export const DEFAULT_OCR_CLAUDE_MODEL = "claude-opus-5-5";
export const OCR_PROVIDERS = ["claude+deepseek", "claude", "deepseek"] as const;
export type OcrProviderMode = (typeof OCR_PROVIDERS)[number];
export const DEFAULT_OCR_PROVIDER: OcrProviderMode = "claude+deepseek";

export function ocrClaudeModel(): string {
  return process.env.GUARD_OCR_CLAUDE_MODEL?.trim() || DEFAULT_OCR_CLAUDE_MODEL;
}

/**
 * 實際生效嘅供應商組合：`GUARD_OCR_PROVIDER`（預設 claude+deepseek；唔認得嘅值當預設）按已配置嘅 key 降級——
 * 冇 CLAUDE_API_KEY → deepseek；claude+deepseek 但冇 DEEPSEEK_API_KEY → claude；兩邊都用唔到 → null。
 * 測試注入咗 fake client 時由 getReadClients 直接用 fake，唔經呢度。
 */
export function effectiveOcrProvider(): OcrProviderMode | null {
  const raw = process.env.GUARD_OCR_PROVIDER?.trim().toLowerCase();
  const req = (OCR_PROVIDERS as readonly string[]).includes(raw ?? "") ? (raw as OcrProviderMode) : DEFAULT_OCR_PROVIDER;
  const hasClaude = !!process.env.CLAUDE_API_KEY;
  const hasDeepseek = !!process.env.DEEPSEEK_API_KEY;
  if (req !== "deepseek" && hasClaude) return req === "claude+deepseek" && hasDeepseek ? "claude+deepseek" : "claude";
  return hasDeepseek ? "deepseek" : null;
}

export function ocrModel(): string {
  return process.env.GUARD_OCR_MODEL?.trim() || DEFAULT_OCR_MODEL;
}

/** 有可用供應商（`CLAUDE_API_KEY` 或 `DEEPSEEK_API_KEY`，或者測試注入咗 fake client）先啟用；冇 → 入口隱藏、API 404。 */
export function isGuardOcrConfigured(): boolean {
  return effectiveOcrProvider() !== null || ocrClientOverrideActive();
}

// 測試注入點放喺 vision-client.ts；呢度用 globalThis 旗避免 config.ts import client（保持零重 import）
const OVERRIDE_KEY = "__guardOcrClientOverride";
export function ocrClientOverrideActive(): boolean {
  return !!(globalThis as Record<string, unknown>)[OVERRIDE_KEY];
}
export function setOcrClientOverrideFlag(client: unknown): void {
  (globalThis as Record<string, unknown>)[OVERRIDE_KEY] = client ?? undefined;
}
export function getOcrClientOverride<T>(): T | undefined {
  return (globalThis as Record<string, unknown>)[OVERRIDE_KEY] as T | undefined;
}
