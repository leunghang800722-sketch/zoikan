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
  // WP-OCR-1：入職表加讀姓名／HKID／出生日期——只做交叉核對（對印刷證件已核實值），唔覆蓋身份證值
  onboarding_form: ["phone", "address", "name_zh", "hkid", "dob"],
};

/** WP-OCR-1：印刷證件已核實值（refs）可以帶嘅欄位（唔含電話：身份證冇）。 */
export const OCR_REFS_FIELDS = ["name_zh", "name_en", "hkid", "dob", "sex", "address"] as const satisfies readonly OcrFieldKey[];
export type OcrRefsField = (typeof OCR_REFS_FIELDS)[number];
/** 入職表同身份證交叉核對嘅欄位。 */
export const OCR_CROSS_FIELDS = ["name_zh", "hkid", "dob"] as const satisfies readonly OcrFieldKey[];
/** WP-OCR-1.3：入職表手寫值做交叉核對嘅欄位＝上面三欄＋地址（對住址證明）。 */
export const OCR_CROSS_CHECK_FIELDS = [...OCR_CROSS_FIELDS, "address"] as const satisfies readonly OcrFieldKey[];
/** refs_token 字元上限。 */
export const OCR_MAX_REFS_CHARS = 8_000;
/** refs 單欄值字元上限（消毒時截斷）。 */
export const OCR_MAX_REF_VALUE_CHARS = 200;

export const OCR_MAX_DOCS = 3;
export const OCR_MAX_TILES = 4;
/** WP-OCR-1：欄位級裁圖上限（電話＋地址＋姓名＋HKID＋出生日期＝5，留 1 個餘位）；2×2 格（tiles）上限 OCR_MAX_TILES 不變。 */
export const OCR_MAX_FIELD_CROPS = 6;
/** 單張 data URL 字元上限（1,600px JPEG 一般 < 500KB → base64 < 700KB）。 */
export const OCR_MAX_IMAGE_CHARS = 900_000;
/** 整個請求體字元上限（3 份文件 × 5 張）。 */
export const OCR_MAX_BODY_CHARS = 8_000_000;

const DEFAULT_OCR_MODEL = "deepseek-flash";
export const DEFAULT_OCR_BASE_URL = "https://api.deepseek.com";
export const OCR_CALL_TIMEOUT_MS = 60_000;
/** OCR-5.6：DeepSeek（V4.1）係思考模型，思考 token 計入 max_tokens；1500 令入職表讀 B（5 欄裁圖）撞頂、content 空。 */
export const OCR_MAX_OUTPUT_TOKENS_DEEPSEEK = 4000;
/** OCR-5.6：撞頂自動重試嘅 max_tokens 絕對上限。 */
export const OCR_RETRY_MAX_TOKENS_CAP = 8000;
/** Claude（Opus 5.5）thinking 計入 max_tokens，1500 會令每次 max_tokens 退回 DeepSeek，所以另設。 */
export const OCR_CLAUDE_MAX_OUTPUT_TOKENS = 8000;

/** WP-OCR-CLAUDE §36：讀 A 用 Claude（老闆 2026-10-10 揀 Opus 5.5）。 */
const DEFAULT_OCR_CLAUDE_MODEL = "claude-opus-5-5";
const OCR_PROVIDERS = ["claude+deepseek", "claude", "deepseek"] as const;
export type OcrProviderMode = (typeof OCR_PROVIDERS)[number];
const DEFAULT_OCR_PROVIDER: OcrProviderMode = "claude+deepseek";

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

/**
 * WP-OCR-4：第三讀仲裁開關 `GUARD_OCR_ARBITER`（預設 1＝開）。0／false／off／no＝關。
 * 仲裁只用 Claude client（冇 Claude 就自動冇仲裁）；每份文件最多 1 次呼叫。
 */
export function ocrArbiterEnabled(): boolean {
  const v = process.env.GUARD_OCR_ARBITER?.trim().toLowerCase();
  return !(v === "0" || v === "false" || v === "off" || v === "no");
}

/**
 * WP-OCR-2：ALS（香港政府地址查詢服務）開關 `GUARD_OCR_ALS`（預設 1＝開，老闆 2026-10-15 決定）。0／false／off／no＝完全唔呼叫。
 * 送出嘅只係冇樓層／室號嘅地址（見 hk-address.alsQueryFromParts）。
 */
export function ocrAlsEnabled(): boolean {
  const v = process.env.GUARD_OCR_ALS?.trim().toLowerCase();
  return !(v === "0" || v === "false" || v === "off" || v === "no");
}
/** ALS 呼叫逾時（毫秒）。 */
export const OCR_ALS_TIMEOUT_MS = 3_000;
/** ALS Score 低過呢個值就唔出候選。 */
export const OCR_ALS_MIN_SCORE = 60;

/** OCR-5.6：DeepSeek max_tokens——env `GUARD_OCR_DEEPSEEK_MAX_TOKENS` 嚴格 `^\d+$` 且 1,000–8,000 先生效，其他（空／負／非數字／帶空白／科學記號／越界）一律預設 4000。 */
export function ocrDeepseekMaxTokens(): number {
  const raw = process.env.GUARD_OCR_DEEPSEEK_MAX_TOKENS;
  if (raw === undefined || !/^\d+$/.test(raw)) return OCR_MAX_OUTPUT_TOKENS_DEEPSEEK;
  const n = Number(raw);
  return n >= 1000 && n <= OCR_RETRY_MAX_TOKENS_CAP ? n : OCR_MAX_OUTPUT_TOKENS_DEEPSEEK;
}

export type OcrDeepseekReasoning = "low" | "high" | "max" | "off";
/** OCR-5.6：DeepSeek 思考力度——env `GUARD_OCR_DEEPSEEK_REASONING`（low|high|max|off），預設 low；唔認得當 low。 */
export function ocrDeepseekReasoning(): OcrDeepseekReasoning {
  const v = process.env.GUARD_OCR_DEEPSEEK_REASONING?.trim().toLowerCase();
  return v === "high" || v === "max" || v === "off" ? v : "low";
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
function ocrClientOverrideActive(): boolean {
  return !!(globalThis as Record<string, unknown>)[OVERRIDE_KEY];
}
export function setOcrClientOverrideFlag(client: unknown): void {
  (globalThis as Record<string, unknown>)[OVERRIDE_KEY] = client ?? undefined;
}
export function getOcrClientOverride<T>(): T | undefined {
  return (globalThis as Record<string, unknown>)[OVERRIDE_KEY] as T | undefined;
}
