// WP-OCR-CLAUDE §36：Claude 視覺呼叫（Anthropic 官方 TypeScript SDK，Messages API；唔用 OpenAI 相容 shim）。
// - 圖片只放 user message 嘅 content（base64 image block）；system 係純文字。
// - Opus 5.5：唔設 temperature／thinking／budget_tokens（會 400）；effort low；JSON 用 structured output（output_config.format）。
// - 回應先 check stop_reason：refusal／max_tokens 都當失敗（OcrUnavailableError），由 read.ts 退回 DeepSeek。
// - 錯誤用 SDK 型別映射，全部變 OcrUnavailableError（訊息唔帶請求內容）。SDK log 關（唔印 request body）。
import Anthropic from "@anthropic-ai/sdk";
import { OCR_CALL_TIMEOUT_MS, OCR_MAX_OUTPUT_TOKENS, ocrClaudeModel, type OcrFieldKey } from "./config";
import { OcrUnavailableError, type VisionClient, type VisionRequest, type VisionResponse } from "./vision-client";

type MessagesApi = { messages: Pick<Anthropic["messages"], "create"> };

/** Anthropic client 設定：log 關、唔重試（重試/退回由 read.ts 決定）。 */
export function anthropicClientOptions(apiKey: string, timeoutMs: number) {
  return { apiKey, timeout: timeoutMs, maxRetries: 0, logLevel: "off" as const };
}

/** 每個欄位：字串（含 "unclear"）或 null；全部 required、唔准多餘 key。 */
export function ocrJsonSchema(fields: readonly string[]): { type: "object"; properties: Record<string, unknown>; required: string[]; additionalProperties: false } {
  return {
    type: "object",
    properties: Object.fromEntries(fields.map((f) => [f, { anyOf: [{ type: "string" }, { type: "null" }] }])),
    required: [...fields],
    additionalProperties: false,
  };
}

const DEFAULT_FIELDS: readonly OcrFieldKey[] = ["name_zh", "name_en", "hkid", "dob", "sex", "phone", "address"];

/** data:image/jpeg;base64,… → media_type＋base64（browser-images 輸出）。 */
export function splitDataUrl(url: string): { mediaType: "image/jpeg"; data: string } {
  const m = /^data:(image\/jpeg);base64,([A-Za-z0-9+/]+={0,2})$/.exec(url);
  if (!m) throw new OcrUnavailableError(null, "bad_image");
  return { mediaType: "image/jpeg", data: m[2]! };
}

export class ClaudeVisionClient implements VisionClient {
  readonly model: string;
  readonly provider = "claude" as const;
  private readonly api: MessagesApi;

  constructor(opts?: { apiKey?: string; model?: string; timeoutMs?: number; client?: MessagesApi }) {
    this.model = opts?.model ?? ocrClaudeModel();
    if (opts?.client) {
      this.api = opts.client;
      return;
    }
    const apiKey = opts?.apiKey ?? process.env.CLAUDE_API_KEY;
    if (!apiKey) throw new OcrUnavailableError(null, "no_api_key");
    this.api = new Anthropic(anthropicClientOptions(apiKey, opts?.timeoutMs ?? OCR_CALL_TIMEOUT_MS));
  }

  async complete(req: VisionRequest): Promise<VisionResponse> {
    const images = req.images.map((u) => splitDataUrl(u));
    let res: Anthropic.Message;
    try {
      res = await this.api.messages.create({
        model: this.model,
        max_tokens: OCR_MAX_OUTPUT_TOKENS,
        output_config: { effort: "low", format: { type: "json_schema", schema: ocrJsonSchema(req.fields ?? DEFAULT_FIELDS) } },
        system: req.system,
        messages: [
          {
            role: "user",
            content: [
              ...images.map((i) => ({ type: "image" as const, source: { type: "base64" as const, media_type: i.mediaType, data: i.data } })),
              { type: "text" as const, text: req.userText },
            ],
          },
        ],
      });
    } catch (e) {
      if (e instanceof Anthropic.APIConnectionError) throw new OcrUnavailableError(null, "connection");
      if (e instanceof Anthropic.AuthenticationError) throw new OcrUnavailableError(e.status ?? 401, "auth");
      if (e instanceof Anthropic.RateLimitError) throw new OcrUnavailableError(e.status ?? 429, "rate_limit");
      if (e instanceof Anthropic.APIError) throw new OcrUnavailableError(typeof e.status === "number" ? e.status : null, "api_error");
      throw e; // 其餘（bug）原樣拋，唔吞
    }
    if (res.stop_reason === "refusal") throw new OcrUnavailableError(null, "refusal");
    if (res.stop_reason === "max_tokens") throw new OcrUnavailableError(null, "max_tokens");
    const text = res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    return { text, promptTokens: res.usage?.input_tokens ?? 0, completionTokens: res.usage?.output_tokens ?? 0, truncated: false };
  }
}
