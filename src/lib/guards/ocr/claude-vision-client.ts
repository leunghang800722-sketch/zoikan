// WP-OCR-CLAUDE §36：Claude 視覺呼叫（Anthropic 官方 TypeScript SDK，Messages API；唔用 OpenAI 相容 shim）。
// - 圖片只放 user message 嘅 content（base64 image block）；system 係純文字。
// - Opus 5.5：唔設 temperature／thinking／budget_tokens（會 400）；effort low；JSON 用 structured output（output_config.format）。
// - 回應先 check stop_reason：refusal／max_tokens 都當失敗（OcrUnavailableError），由 read.ts 退回 DeepSeek。
// - 錯誤用 SDK 型別映射，全部變 OcrUnavailableError（訊息唔帶請求內容）。SDK log 關（唔印 request body）。
import Anthropic from "@anthropic-ai/sdk";
import { OCR_CALL_TIMEOUT_MS, OCR_CLAUDE_MAX_OUTPUT_TOKENS, ocrClaudeModel, type OcrFieldKey } from "./config";
import { READ_CONFIDENCE, READ_REASONS } from "./field-read";
import { OcrUnavailableError, type VisionClient, type VisionRequest, type VisionResponse } from "./vision-client";

type MessagesApi = { messages: Pick<Anthropic["messages"], "create"> };

/** Anthropic client 設定：log 關、唔重試（重試/退回由 read.ts 決定）。 */
export function anthropicClientOptions(apiKey: string, timeoutMs: number) {
  // baseURL／authToken 明確指定：防 ANTHROPIC_BASE_URL／ANTHROPIC_AUTH_TOKEN 環境變數令證件圖打去錯地方
  return { apiKey, baseURL: "https://api.anthropic.com", authToken: null, timeout: timeoutMs, maxRetries: 0, logLevel: "off" as const };
}

/**
 * WP-OCR-4：每個欄位係 object `{ value, confidence, reason, alternatives }`（全部 required、唔准多餘 key）。
 * value＝字串（含 "unclear"）或 null；reason 無則 null；alternatives 最多 2 個由 read.ts 截（structured output 唔支援 maxItems）。
 * 舊純字串格式只會由 DeepSeek／舊 fake 出，read.ts 照樣接受。
 */
const BOX_COORDS = ["x", "y", "w", "h"] as const;

export function ocrJsonSchema(fields: readonly string[], boxFields: readonly string[] = []): { type: "object"; properties: Record<string, unknown>; required: string[]; additionalProperties: false } {
  const fieldObject = {
    type: "object",
    properties: {
      value: { anyOf: [{ type: "string" }, { type: "null" }] },
      confidence: { type: "string", enum: [...READ_CONFIDENCE] },
      reason: { anyOf: [{ type: "string", enum: [...READ_REASONS] }, { type: "null" }] },
      alternatives: { type: "array", items: { type: "string" } },
    },
    required: ["value", "confidence", "reason", "alternatives"],
    additionalProperties: false,
  };
  // WP-OCR-3：電話欄加 digit_count（模型自報位數，只用於後處理）
  const phoneObject = {
    ...fieldObject,
    properties: { ...fieldObject.properties, digit_count: { anyOf: [{ type: "integer" }, { type: "null" }] } },
    required: [...fieldObject.required, "digit_count"],
  };
  // WP-OCR-3／OCR-5.4 熱修：讀 A 回報欄位 box（0–1 正規化）。原本每欄 anyOf(null|object) 嘅巢狀寫法加埋 5 欄候選結構會令
  // Anthropic structured output 嘅文法「compiled grammar is too large」（HTTP 400）→ 整份入職表退回 DeepSeek。改為攤平成
  // `<欄>_x／_y／_w／_h` 四個數字（冇法定位就全部 0；parseFieldBoxes 接受巢狀同攤平兩種）。實測 5 欄＋5 box 可通過。
  const properties: Record<string, unknown> = Object.fromEntries(fields.map((f) => [f, f === "phone" ? phoneObject : fieldObject]));
  const required = [...fields];
  if (boxFields.length > 0) {
    const boxKeys = boxFields.flatMap((f) => BOX_COORDS.map((c) => `${f}_${c}`));
    properties.field_boxes = { type: "object", properties: Object.fromEntries(boxKeys.map((k) => [k, { type: "number" }])), required: boxKeys, additionalProperties: false };
    required.push("field_boxes");
  }
  return { type: "object", properties, required, additionalProperties: false };
}

const DEFAULT_FIELDS: readonly OcrFieldKey[] = ["name_zh", "name_en", "hkid", "dob", "sex", "phone", "address"];

/** data:image/jpeg;base64,… → media_type＋base64（browser-images 輸出）。 */
export function splitDataUrl(url: string): { mediaType: "image/jpeg"; data: string } {
  const m = /^data:(image\/jpeg);base64,([A-Za-z0-9+/]+={0,2})$/.exec(url);
  if (!m) throw new OcrUnavailableError(null, "bad_image");
  return { mediaType: "image/jpeg", data: m[2]! };
}

function apiBodyError(e: unknown): { type?: unknown; message?: unknown } {
  const body = (e as { error?: unknown }).error as { error?: { type?: unknown; message?: unknown } } | undefined;
  return body?.error ?? {};
}

/** API 回傳嘅 error.type（例如 permission_error）；冇 body 就用 SDK 嘅 type。只係類型字串。 */
function sdkErrorType(e: unknown): string | null {
  if (!(e instanceof Anthropic.APIError)) return null;
  const t = apiBodyError(e).type ?? (e as { type?: unknown }).type;
  return typeof t === "string" && /^[a-z_]{1,64}$/.test(t) ? t : null;
}

/** 4xx 嘅 API error.message：去換行、截 200 字；出現 sk-ant 整段換 [redacted]。其他情況 null。 */
function sdkErrorMessage(e: unknown): string | null {
  if (!(e instanceof Anthropic.APIError)) return null;
  if (typeof e.status !== "number" || e.status < 400 || e.status > 499) return null;
  const m = apiBodyError(e).message;
  if (typeof m !== "string" || !m) return null;
  if (/sk-ant/i.test(m)) return "[redacted]";
  const t = m.replace(/\s+/g, " ").trim().slice(0, 200);
  return /sk-ant/i.test(t) ? "[redacted]" : t;
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
        max_tokens: OCR_CLAUDE_MAX_OUTPUT_TOKENS,
        output_config: { effort: "low", format: { type: "json_schema", schema: ocrJsonSchema(req.fields ?? DEFAULT_FIELDS, req.boxFields ?? []) } },
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
      if (e instanceof Anthropic.AuthenticationError) throw new OcrUnavailableError(e.status ?? 401, "auth", sdkErrorType(e), sdkErrorMessage(e));
      if (e instanceof Anthropic.RateLimitError) throw new OcrUnavailableError(e.status ?? 429, "rate_limit", sdkErrorType(e), sdkErrorMessage(e));
      if (e instanceof Anthropic.APIError) throw new OcrUnavailableError(typeof e.status === "number" ? e.status : null, "api_error", sdkErrorType(e), sdkErrorMessage(e));
      throw e; // 其餘（bug）原樣拋，唔吞
    }
    if (res.stop_reason === "refusal") throw new OcrUnavailableError(null, "refusal");
    if (res.stop_reason === "max_tokens") throw new OcrUnavailableError(null, "max_tokens");
    const text = res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    return { text, promptTokens: res.usage?.input_tokens ?? 0, completionTokens: res.usage?.output_tokens ?? 0, truncated: false };
  }
}
