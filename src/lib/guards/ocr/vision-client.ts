// WP-GUARD-OCR §29：DeepSeek 視覺呼叫（§36 起係讀 B／Claude 後備）（OpenAI SDK，chat completions）。
// - 圖片只准放喺 user message 嘅 content 陣列（image_url）；system message 係純文字（放圖會 400）。
// - 唔改 `LlmClient`／AI 助手。client 可注入（測試用 fake，vitest 唔准真打外部 API）。
// - 錯誤：超時／401／429／5xx／網絡 → OcrUnavailableError（route 回 503）。錯誤訊息唔帶任何請求內容。
import OpenAI from "openai";
import { DEFAULT_OCR_BASE_URL, OCR_CALL_TIMEOUT_MS, OCR_RETRY_MAX_TOKENS_CAP, getOcrClientOverride, ocrDeepseekMaxTokens, ocrDeepseekReasoning, ocrModel, setOcrClientOverrideFlag } from "./config";

export interface VisionRequest {
  system: string;
  userText: string;
  /** data:image/jpeg;base64,… */
  images: readonly string[];
  /** 要抽嘅欄位 key（Claude structured output 用嚟砌 JSON schema；DeepSeek 忽略） */
  fields?: readonly string[];
  /** WP-OCR-3：讀 A 要求回報 field_boxes 嘅欄位（Claude 加入 schema；DeepSeek 只靠 prompt） */
  boxFields?: readonly string[];
  /** OCR-5.6：覆蓋預設 output token 上限（撞頂重試用；Claude client 忽略） */
  maxTokens?: number;
  /** WA-8：Claude structured output 用嘅自訂 JSON schema（工卡辨識）；冇＝用證件欄位 schema。DeepSeek 忽略。 */
  jsonSchema?: Record<string, unknown>;
}
export interface VisionResponse {
  text: string;
  promptTokens: number;
  completionTokens: number;
  /** finish_reason==="length"＝撞咗 output token 上限（只記有冇，冇內容） */
  truncated?: boolean;
}
export type OcrProviderName = "claude" | "deepseek";
export interface VisionClient {
  readonly model: string;
  /** 供應商標籤（冇寫＝deepseek／測試 fake） */
  readonly provider?: OcrProviderName;
  complete(req: VisionRequest): Promise<VisionResponse>;
}

/** OCR-5.6：DeepSeek 請求參數（抽出嚟方便單元測試）。 */
export function deepseekReasoningParams(): Record<string, unknown> {
  const mode = ocrDeepseekReasoning();
  return mode === "off" ? { thinking: { type: "disabled" } } : { reasoning_effort: mode };
}

function isParsableJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * OCR-5.6：呼叫一次；回應撞 output 上限（truncated）而 content 空或 JSON 被截（parse 唔到）→ 用加倍 max_tokens（上限 8,000）重試一次。
 * base 已達上限就唔重試。重試本身拋 OcrUnavailableError → 降級：回第一次回應（retried:true、extra:null），由呼叫方照舊當 parse 失敗。
 * 重試成功時 extra＝第一次回應（usage 兩次都計）。只對 DeepSeek 有意義（Claude 遇 max_tokens 直接拋，唔會 truncated）。
 */
export async function completeWithTruncRetry(client: VisionClient, req: VisionRequest): Promise<{ resp: VisionResponse; retried: boolean; extra: VisionResponse | null }> {
  const first = await client.complete(req);
  if (!first.truncated || (first.text.trim() !== "" && isParsableJson(first.text))) return { resp: first, retried: false, extra: null };
  const base = req.maxTokens ?? ocrDeepseekMaxTokens();
  if (base >= OCR_RETRY_MAX_TOKENS_CAP) return { resp: first, retried: false, extra: null };
  try {
    const second = await client.complete({ ...req, maxTokens: Math.min(base * 2, OCR_RETRY_MAX_TOKENS_CAP) });
    return { resp: second, retried: true, extra: first };
  } catch (e) {
    if (!(e instanceof OcrUnavailableError)) throw e;
    return { resp: first, retried: true, extra: null };
  }
}

export class OcrUnavailableError extends Error {
  readonly status: number | null;
  /** 失敗類別（只係固定字串，唔帶內容）：refusal／max_tokens／api_error… */
  readonly reason: string | null;
  /** SDK error.type（只係類型字串） */
  readonly errorType: string | null;
  /** 已消毒嘅 Anthropic error.message（淨 4xx、≤200 字）；只供啟動自檢 log，route／audit／response 唔用 */
  readonly errorMessage: string | null;
  constructor(status: number | null, reason: string | null = null, errorType: string | null = null, errorMessage: string | null = null) {
    super("ocr_provider_unavailable");
    this.name = "OcrUnavailableError";
    this.status = status;
    this.reason = reason;
    this.errorType = errorType;
    this.errorMessage = errorMessage;
  }
}

type ChatApi = Pick<OpenAI, "chat">;

/** OpenAI client 設定：固定 logLevel "off"，就算 `OPENAI_LOG=debug` 都唔會印 request body（內含證件圖）。 */
export function openAiClientOptions(apiKey: string, baseURL: string, timeoutMs: number) {
  return { apiKey, baseURL, timeout: timeoutMs, maxRetries: 0, logLevel: "off" as const };
}

export class DeepSeekVisionClient implements VisionClient {
  readonly model: string;
  readonly provider = "deepseek" as const;
  private readonly api: ChatApi;

  constructor(opts?: { apiKey?: string; baseURL?: string; model?: string; timeoutMs?: number; client?: ChatApi }) {
    this.model = opts?.model ?? ocrModel();
    if (opts?.client) {
      this.api = opts.client;
      return;
    }
    const apiKey = opts?.apiKey ?? process.env.DEEPSEEK_API_KEY;
    if (!apiKey) throw new OcrUnavailableError(null);
    this.api = new OpenAI(openAiClientOptions(apiKey, opts?.baseURL ?? process.env.DEEPSEEK_BASE_URL ?? DEFAULT_OCR_BASE_URL, opts?.timeoutMs ?? OCR_CALL_TIMEOUT_MS));
  }

  async complete(req: VisionRequest): Promise<VisionResponse> {
    try {
      const res = await this.api.chat.completions.create({
        model: this.model,
        max_tokens: req.maxTokens ?? ocrDeepseekMaxTokens(),
        temperature: 0,
        response_format: { type: "json_object" },
        ...deepseekReasoningParams(),
        messages: [
          { role: "system", content: req.system },
          { role: "user", content: [{ type: "text", text: req.userText }, ...req.images.map((url) => ({ type: "image_url" as const, image_url: { url } }))] },
        ],
      });
      return { text: res.choices[0]?.message?.content ?? "", promptTokens: res.usage?.prompt_tokens ?? 0, completionTokens: res.usage?.completion_tokens ?? 0, truncated: res.choices[0]?.finish_reason === "length" };
    } catch (e) {
      // OpenAI.APIError 包括連線／超時子類；其餘（例如 bug）原樣拋，唔吞
      if (e instanceof OpenAI.APIError) throw new OcrUnavailableError(typeof e.status === "number" ? e.status : null);
      throw e;
    }
  }
}

/** 測試注入 fake client（傳 null 清除）。 */
export function setVisionClientForTests(client: VisionClient | null): void {
  setOcrClientOverrideFlag(client);
}

export function getOcrOverrideClient(): VisionClient | undefined {
  return getOcrClientOverride<VisionClient>();
}

export function getVisionClient(): VisionClient {
  return getOcrClientOverride<VisionClient>() ?? new DeepSeekVisionClient();
}
