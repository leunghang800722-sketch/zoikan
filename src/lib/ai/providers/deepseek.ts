// WP-AI3：DeepSeek client（OpenAI 格式，官方 `openai` npm SDK）——實現
// 同一個 `LlmClient` interface（`src/lib/ai/llm.ts`），俾 `getLlmClient()`
// 揀。DeepSeek 冇官方 SDK，官方文件明講用 OpenAI SDK 打
// `https://api.deepseek.com`（OpenAI-compatible）。
//
// 同 `AnthropicLlmClient` 嗰邊唔同：Anthropic SDK 有官方 Tool Runner
// （`client.beta.messages.toolRunner()`），呢度冇——`openai` SDK 冇對應
// 嘅高層 helper，所以手寫成個 agentic loop（request → 如果有
// `tool_calls` 就逐個 run() 攞返 `role:"tool"` message → 再問一次，
// 最多 `params.maxToolRounds` 輪；行齊晒都仲有 tool_calls 就額外加一次
// 冧 `tools`嘅 forced-final call，等用戶起碼有段收尾文字，唔會齋收空
// 白）。
//
// 工具 schema：**唔使自己再用 zod-to-json-schema 轉一次**——
// `betaZodTool()`（`@anthropic-ai/sdk/helpers/beta/zod`，`src/lib/ai/
// tools/*.ts` 逐個工具都用緊）內部已經用 zod v4 `z.toJSONSchema()` 將
// `inputSchema` 轉咗做 `input_schema`（draft 2020-12，`.strict()` 嘅
// object 已經帶 `additionalProperties:false`），掛喺每個
// `BetaRunnableTool` 物件度——`params.tools` 傳落嚟嗰陣已經係轉好嘅形狀，
// 呢度淨係將個 key 由 `input_schema`（snake_case，Anthropic 慣例）搬做
// OpenAI 要嘅 `function.parameters`，順手剝走 `$schema`（OpenAI 格式
// 唔需要呢個 meta key）。
import OpenAI from "openai";
import type { ChatCompletionMessageParam, ChatCompletionFunctionTool, ChatCompletionToolMessageParam } from "openai/resources/chat/completions";
import type { BetaRunnableTool } from "@anthropic-ai/sdk/lib/tools/BetaRunnableTool";
import { LlmUnavailableError, type LlmChatParams, type LlmChatResult, type LlmClient } from "../llm";

const DEFAULT_BASE_URL = "https://api.deepseek.com";
const DEFAULT_MODEL = "deepseek-v4-pro";
const MAX_TOKENS = 4096;
const TEMPERATURE = 0.2;

// 廣東話用語微調（老闆要求，只加俾 DeepSeek——`buildSystemPrompt()`
// 本身係 provider-agnostic、俾晒 Anthropic 路徑同 adversarial test 共用，
// 唔想淨係為咗一個 provider 嘅語氣微調就去改嗰個共用函數，所以喺呢度
// 一次性 append）。鐵律本身（system-prompt.ts 嗰七條）完全冇改。
const CANTONESE_STYLE_SUFFIX =
  "\n\n## 語言\n用廣東話口語回答（香港中文），唔好用普通話書面語（例如唔好用「的」代替「嘅」、唔好用「這個/那個」代替「呢個/嗰個」）。";

function toOpenAiChatMessages(params: LlmChatParams): ChatCompletionMessageParam[] {
  return [
    { role: "system", content: params.systemPrompt + CANTONESE_STYLE_SUFFIX },
    ...params.history.map((h): ChatCompletionMessageParam => ({ role: h.role, content: h.content })),
    { role: "user", content: params.userMessage },
  ];
}

/** 將一個 `betaZodTool()` 造出嚟嘅 `BetaRunnableTool` 轉做 OpenAI
 * `tools:[{type:"function",...}]` 要嘅形狀。Export 俾測試直接斷言
 * 14 個工具逐個轉換都成功、`additionalProperties:false`。 */
// `BetaRunnableTool<any>`（唔係 `<unknown>`）：同 `llm.ts` `LlmChatParams.
// tools` 嗰個 `BetaRunnableTool<any>[]` 一樣嘅原因——真實用嘅 14 個工具
// 逐個 `run()` 嘅入參形狀唔同（`z.infer<InputSchema>` 各有唔同），擺埋
// 一個異質陣列會撞 TS function-parameter contravariance，呢度同 Anthropic
// SDK 自己 `BetaToolRunnerParams.tools` 嘅寫法一致，用 `any` 先可以接受
// 任何一個具體工具物件。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function toOpenAiTool(tool: BetaRunnableTool<any>): ChatCompletionFunctionTool {
  // `BetaRunnableTool` 個 union 型別入面 bash/text-editor 嗰幾款冇
  // `name`/`input_schema`（用 `type` 做名，冇 schema）——AI 助手呢邊
  // `buildAiTools()` 全部用 `betaZodTool()`，實際上永遠係
  // `{type:"custom", name, input_schema, description}` 呢種形狀，但
  // 呢度用返 union 型別（同 llm.ts `LlmChatParams.tools` 一致），落嚟
  // runtime 要防守式咁攞。
  const t = tool as unknown as { name?: string; description?: string; input_schema?: Record<string, unknown> };
  const name = t.name ?? ("type" in tool ? String((tool as { type: string }).type) : "unknown_tool");
  const schema = t.input_schema ?? { type: "object", properties: {}, additionalProperties: false };
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { $schema, ...parameters } = schema;
  return {
    type: "function",
    function: {
      name,
      description: t.description ?? "",
      parameters,
    },
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toolByName(tools: BetaRunnableTool<any>[]): Map<string, BetaRunnableTool<any>> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const map = new Map<string, BetaRunnableTool<any>>();
  for (const tool of tools) {
    const name = (tool as unknown as { name?: string }).name;
    if (name) map.set(name, tool);
  }
  return map;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function runTool(tool: BetaRunnableTool<any> | undefined, name: string, rawArgs: string | undefined): Promise<string> {
  if (!tool) {
    return JSON.stringify({ error: `unknown_tool`, message: `搵唔到工具「${name}」` });
  }
  try {
    const args: unknown = rawArgs ? JSON.parse(rawArgs) : {};
    const result = await (tool as unknown as { run: (a: unknown) => Promise<string | unknown> }).run(args);
    return typeof result === "string" ? result : JSON.stringify(result);
  } catch (err) {
    // 工具拋錯（包括 `rawArgs` 因為 `finish_reason:"length"` 中途截斷
    // 令 JSON.parse() 拋錯嗰種情況）——同 Anthropic 路徑一致，唔會令
    // 成個 request 死，用一個 error 結果餵返俾模型，等佢可以自己決定
    // 點答（例如話「查唔到，可能要問人」），loop 照繼續。
    return JSON.stringify({ error: "tool_error", message: err instanceof Error ? err.message : String(err) });
  }
}

/** 401/429/5xx/網絡錯誤（`OpenAI.APIError`——`APIConnectionError`／
 * `APIConnectionTimeoutError` 都係佢嘅子類）一律映射做
 * `LlmUnavailableError`，等 route.ts 嘅 503 `ai_provider_unavailable`
 * 分支接住；其他錯誤（例如工具本身邏輯 bug）原樣拋出，唔好吞。 */
function mapDeepSeekError(err: unknown): unknown {
  if (err instanceof OpenAI.APIError) {
    return new LlmUnavailableError(err);
  }
  return err;
}

export class DeepSeekLlmClient implements LlmClient {
  private client: Pick<OpenAI, "chat">;
  private model: string;

  constructor(opts?: { apiKey?: string; baseURL?: string; model?: string; client?: Pick<OpenAI, "chat"> }) {
    this.model = opts?.model ?? process.env.AI_MODEL ?? DEFAULT_MODEL;
    if (opts?.client) {
      this.client = opts.client;
      return;
    }
    const apiKey = opts?.apiKey ?? process.env.DEEPSEEK_API_KEY;
    if (!apiKey) {
      throw new LlmUnavailableError(new Error("DEEPSEEK_API_KEY 未設定"));
    }
    const baseURL = opts?.baseURL ?? process.env.DEEPSEEK_BASE_URL ?? DEFAULT_BASE_URL;
    this.client = new OpenAI({ baseURL, apiKey });
  }

  async chat(params: LlmChatParams): Promise<LlmChatResult> {
    // Set：同 `AnthropicLlmClient` 一致——一個工具喺多輪之間可能被 call
    // 多次，`toolsUsed` 對上層（audit_log／SSE `done` event）嚟講係
    // 「用過邊啲工具」嘅集合，唔係逐次調用嘅流水帳。
    const toolsUsed = new Set<string>();
    let inputTokens = 0;
    let outputTokens = 0;
    let finalText = "";

    const tools = toolByName(params.tools);
    const openAiTools = params.tools.map(toOpenAiTool);
    const messages = toOpenAiChatMessages(params);

    try {
      // 最多 `maxToolRounds` 輪會帶埋 `tools`；如果第 `maxToolRounds`
      // 輪都仲要求 tool_calls，加多一輪冧走 `tools`（forced-final，唔算
      // 入 `maxToolRounds`）逼佢收尾答文字——同 Anthropic SDK Tool
      // Runner 嘅 `max_iterations` 唔完全一樣（嗰個到頂就直接停），但
      // 呢度想保證用戶唔會齋收空白回覆。
      for (let round = 1; round <= params.maxToolRounds + 1; round++) {
        // WP-AI3：`output-style.ts` 嘅改寫 request 用 `tools: []` call
        // 呢個 client（同 provider、冇工具）——`openAiTools.length === 0`
        // 嗰陣連 `tools` key 都唔傳（唔傳一個空陣列），保守做法，唔靠
        // DeepSeek/OpenAI-compatible API 對空陣列嘅行為一定同傳有嘢嗰陣
        // 一致。
        const allowTools = round <= params.maxToolRounds && openAiTools.length > 0;
        const response = await this.client.chat.completions.create({
          model: this.model,
          max_tokens: MAX_TOKENS,
          temperature: TEMPERATURE,
          messages,
          ...(allowTools ? { tools: openAiTools } : {}),
        });

        if (response.usage) {
          inputTokens += response.usage.prompt_tokens ?? 0;
          outputTokens += response.usage.completion_tokens ?? 0;
        }

        const choice = response.choices[0];
        const message = choice?.message;
        if (!message) break;

        const toolCalls = allowTools ? (message.tool_calls ?? []) : [];

        if (toolCalls.length === 0) {
          // 冧咗 `tools`（forced-final）或者模型自己揀唔再 call 工具
          // ——`finish_reason==="length"` 呢度都當正常收尾處理：內容
          // 可能截斷，但唔拋錯，將（可能截斷嘅）文字原樣交俾上層
          // `checkOutputGuardAndAudit()` 判斷，同 OpenAI 官方文件建議
          // 一致（唔特別即刻 throw）。
          finalText = message.content ?? "";
          if (finalText) params.onTextDelta?.(finalText);
          break;
        }

        // 一個 assistant turn 可以帶多個並行 `tool_calls`——逐個 run()，
        // 但全部結果要喺*同一個* follow-up request 入面用多個
        // `role:"tool"` message 交返（OpenAI 格式要求每個 tool_call_id
        // 都要有對應嘅 tool message，唔可以淨係答第一個）。
        messages.push({
          role: "assistant",
          content: message.content ?? null,
          tool_calls: toolCalls,
        });

        const toolMessages: ChatCompletionToolMessageParam[] = await Promise.all(
          toolCalls.map(async (call) => {
            // 我哋喺 `toOpenAiTool()` 淨係定義咗 `type:"function"` 嘅
            // 工具（冇 custom tool），理論上唔會收到
            // `ChatCompletionMessageCustomToolCall`，但 SDK 嘅
            // `tool_calls` 型別係個 union——防守式判斷，就算真係收到
            // 都要對返個 `tool_call_id` 覆一個 tool message（OpenAI
            // 格式要求逐個 `tool_call_id` 都要有回應，唔可以淨係漏低）。
            if (call.type !== "function") {
              return { role: "tool", tool_call_id: call.id, content: JSON.stringify({ error: "unsupported_tool_call_type", type: call.type }) };
            }
            const name = call.function.name;
            toolsUsed.add(name);
            const resultText = await runTool(tools.get(name), name, call.function.arguments);
            return { role: "tool", tool_call_id: call.id, content: resultText };
          }),
        );
        messages.push(...toolMessages);
      }
    } catch (err) {
      throw mapDeepSeekError(err);
    }

    return { text: finalText, toolsUsed: [...toolsUsed], inputTokens, outputTokens, provider: "deepseek", model: this.model };
  }
}
