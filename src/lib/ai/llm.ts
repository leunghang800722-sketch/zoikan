// WP-AI1：LLM 可注入——`LlmClient` 呢個 interface 係全部 route/loop test
// 唔使真 key 嘅關鍵：production 用 `AnthropicLlmClient`（真係 call
// Anthropic SDK），測試用 fake（`tests/fixtures/fake-llm.ts`）。
//
// Anthropic client 用 SDK 官方 Tool Runner（beta，`client.beta.messages
// .toolRunner()`）——「唔好手寫成個 agentic loop」，跟返
// typescript/claude-api/tool-use.md／streaming.md 嘅寫法：streaming
// runner 外層 loop 每次 iteration 攞一個 message stream，內層 loop 攞
// individual token events；`pause_turn` 要手動 push 返個 assistant turn
// 先可以 resume（SDK 唔會自動幫手 resume，見 tool-use.md 註解）。
import Anthropic from "@anthropic-ai/sdk";
import type { BetaRunnableTool } from "@anthropic-ai/sdk/lib/tools/BetaRunnableTool";
import type { Anthropic as AnthropicTypes } from "@anthropic-ai/sdk";

export interface LlmHistoryTurn {
  role: "user" | "assistant";
  content: string;
}

export interface LlmChatParams {
  systemPrompt: string;
  // 逐個工具嘅 z.infer<InputSchema> 唔同形狀，`BetaRunnableTool<unknown>[]`
  // 會撞 TS 嘅 function-parameter contravariance（每個 tool 嘅 run() 入參
  // 形狀唔同），呢度同 Anthropic SDK 自己 `BetaToolRunnerParams.tools`
  // 嘅寫法一致，用 `any` 先可以擺一個異質 tool 陣列入去。
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tools: BetaRunnableTool<any>[];
  history: LlmHistoryTurn[];
  userMessage: string;
  maxToolRounds: number;
  onTextDelta?: (delta: string) => void;
}

export interface LlmChatResult {
  text: string;
  toolsUsed: string[];
  inputTokens: number;
  outputTokens: number;
}

export interface LlmClient {
  chat(params: LlmChatParams): Promise<LlmChatResult>;
}

export class LlmUnavailableError extends Error {
  constructor(cause?: unknown) {
    super("AI Hub 暫時連唔到，請稍後再試");
    this.name = "LlmUnavailableError";
    if (cause instanceof Error) this.cause = cause;
  }
}

function historyToMessages(history: LlmHistoryTurn[]): AnthropicTypes.Beta.BetaMessageParam[] {
  return history.map((h) => ({ role: h.role, content: h.content }));
}

export class AnthropicLlmClient implements LlmClient {
  private client: Anthropic;
  private model: string;

  constructor(opts?: { baseURL?: string; apiKey?: string; model?: string }) {
    const baseURL = opts?.baseURL ?? process.env.AI_HUB_BASE_URL;
    const apiKey = opts?.apiKey ?? process.env.AI_HUB_API_KEY;
    if (!baseURL || !apiKey) {
      throw new LlmUnavailableError(new Error("AI_HUB_BASE_URL/AI_HUB_API_KEY 未設定"));
    }
    // Zeabur AI Hub 用 Anthropic 官方格式，Bearer token——SDK 嘅 `authToken`
    // 選項（唔係 `apiKey`，避免 SDK 自動加 `x-api-key` header）。
    this.client = new Anthropic({ baseURL, authToken: apiKey });
    this.model = opts?.model ?? process.env.AI_MODEL ?? "claude-opus-5";
  }

  async chat(params: LlmChatParams): Promise<LlmChatResult> {
    const toolsUsed = new Set<string>();
    let text = "";
    let inputTokens = 0;
    let outputTokens = 0;

    try {
      const runner = this.client.beta.messages.toolRunner({
        model: this.model,
        max_tokens: 4096,
        max_iterations: params.maxToolRounds,
        thinking: { type: "adaptive" },
        output_config: { effort: "medium" },
        system: [{ type: "text", text: params.systemPrompt, cache_control: { type: "ephemeral" } }],
        tools: params.tools,
        messages: [...historyToMessages(params.history), { role: "user", content: params.userMessage }],
        stream: true,
      });

      for await (const messageStream of runner) {
        for await (const event of messageStream) {
          if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
            text += event.delta.text;
            params.onTextDelta?.(event.delta.text);
          }
          if (event.type === "content_block_start" && event.content_block.type === "tool_use") {
            toolsUsed.add(event.content_block.name);
          }
        }
        const message = await messageStream.finalMessage();
        inputTokens += message.usage.input_tokens;
        outputTokens += message.usage.output_tokens;
        if (message.stop_reason === "pause_turn") {
          runner.pushMessages({ role: "assistant", content: message.content });
        }
      }

      return { text, toolsUsed: [...toolsUsed], inputTokens, outputTokens };
    } catch (err) {
      if (err instanceof Anthropic.APIError) {
        throw new LlmUnavailableError(err);
      }
      throw err;
    }
  }
}

// WP-AI2：Playwright e2e（`tests/e2e/ai.spec.ts`）打嘅係真正起緊嘅
// dev server（唔似 vitest 可以喺同一個 process 入面用
// `setLlmClientForTests()` 換走 singleton），所以要有一個由 env 啟動嘅
// 假 LLM——`AI_LLM=fake`（`playwright.config.ts` 嘅 webServer.env 設
// 呢個）令呢個 factory 直接回一個唔會真係打 AI Hub 嘅假 client。
//
// **呢個唔削弱任何 guard／權限**：`getLlmClient()` 淨係決定「用邊個
// LlmClient 去問模型」，喺呢個之前 route.ts 已經行完
// `requirePermission()`／daily limit／`computeFieldVisibility()`；喺
// 之後 `checkOutputGuardAndAudit()` 一樣會對假 client 回傳嘅 `text`
// 生效。假 client 本身零工具調用（`toolsUsed: []`），純粹回一句固定
// 廣東話回覆，唔會冒充任何真實業務數據。
class FakeDevLlmClient implements LlmClient {
  async chat(params: LlmChatParams): Promise<LlmChatResult> {
    const text = `（開發測試用嘅假 AI 回覆，未連接真 AI Hub）已收到你嘅問題：「${params.userMessage}」。`;
    for (const ch of text) params.onTextDelta?.(ch);
    return { text, toolsUsed: [], inputTokens: 0, outputTokens: text.length };
  }
}

let singleton: LlmClient | undefined;

/** production 用嘅單例——route.ts 淨係 call 呢個，唔會自己 `new
 * AnthropicLlmClient()`（等測試可以用 `setLlmClientForTests()` 換走）。 */
export function getLlmClient(): LlmClient {
  if (!singleton) {
    singleton = process.env.AI_LLM === "fake" ? new FakeDevLlmClient() : new AnthropicLlmClient();
  }
  return singleton;
}

export function setLlmClientForTests(client: LlmClient | undefined): void {
  singleton = client;
}
