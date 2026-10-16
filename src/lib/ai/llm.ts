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
import { claudeModel, resolveAiProvider } from "./config";
import { DeepSeekLlmClient } from "./providers/deepseek";

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
  /** W1（additive）：結構化單次輸出（WhatsApp 解析用）。有值＝單次 JSON 輸出、冇工具、冇歷史；
   * DeepSeek 用 response_format json_object＋temperature＋reasoning_effort＋max_tokens；Claude 用單次 messages.create
   * （唔傳 temperature／thinking，避免新型號拒收）。冇值＝原有行為完全不變。 */
  structured?: LlmStructuredOptions;
}

interface LlmStructuredOptions {
  format: "json_object";
  /** 輸出上限（含思考 token）。 */
  maxTokens: number;
  temperature?: number;
  /** DeepSeek reasoning_effort。 */
  reasoningEffort?: "low" | "medium" | "high";
}

export interface LlmChatResult {
  text: string;
  toolsUsed: string[];
  inputTokens: number;
  outputTokens: number;
  /** WP-AI-DIAG（additive）：邊個 provider／型號答嘅（audit／SSE `done` 用）；舊 client／測試 fake 可以冇。 */
  provider?: string;
  model?: string;
}

export interface LlmClient {
  chat(params: LlmChatParams): Promise<LlmChatResult>;
}

// WP-AI3：由「AI Hub 暫時連唔到」改做「AI 服務暫時連唔到」——加咗
// DeepSeek 之後呢個 error 唔再淨係 Zeabur AI Hub（Anthropic）先會拋，
// DeepSeek 嗰邊 401/429/5xx/網絡錯誤（`src/lib/ai/providers/deepseek.ts`
// 嘅 `mapDeepSeekError()`）同「冇任何 provider 配置好」都會拋呢個，
// 訊息唔應該再點名邊個供應商。route.ts 嘅 JSON error code 同步由
// `ai_hub_unavailable` 改做 `ai_provider_unavailable`（前端
// `friendlyAiError()` 淨係跟 HTTP status 503 揀文字，本身冇提
// 「Hub」，唔使改）。
export class LlmUnavailableError extends Error {
  constructor(cause?: unknown) {
    super("AI 服務暫時連唔到，請稍後再試");
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
  private providerName: "anthropic" | "claude";

  /** WP-AI-DIAG：兩種 auth——
   * - 預設（`anthropic`，Zeabur AI Hub）：Bearer `authToken`，baseURL／key 嚟自 `AI_HUB_*`（行為不變）。
   * - `claude`（Anthropic 官方 API 直連）：`apiKey`（x-api-key）＝`CLAUDE_API_KEY`，baseURL 固定
   *   `https://api.anthropic.com`，型號 `AI_CLAUDE_MODEL`（預設 `claude-opus-5-5`，**唔讀 `AI_MODEL`**），
   *   `maxRetries:1`、`logLevel:"off"`、`authToken:null`（唔俾 SDK 自動讀 ANTHROPIC_* env）。 */
  constructor(opts?: { baseURL?: string; apiKey?: string; model?: string; auth?: "bearer" | "api-key" }) {
    if (opts?.auth === "api-key") {
      const apiKey = opts.apiKey ?? process.env.CLAUDE_API_KEY;
      if (!apiKey) throw new LlmUnavailableError(new Error("CLAUDE_API_KEY 未設定"));
      this.client = new Anthropic({ baseURL: opts.baseURL ?? "https://api.anthropic.com", apiKey, authToken: null, maxRetries: 1, logLevel: "off" });
      this.model = opts.model ?? claudeModel();
      this.providerName = "claude";
      return;
    }
    const baseURL = opts?.baseURL ?? process.env.AI_HUB_BASE_URL;
    const apiKey = opts?.apiKey ?? process.env.AI_HUB_API_KEY;
    if (!baseURL || !apiKey) {
      throw new LlmUnavailableError(new Error("AI_HUB_BASE_URL/AI_HUB_API_KEY 未設定"));
    }
    // Zeabur AI Hub 用 Anthropic 官方格式，Bearer token——SDK 嘅 `authToken`
    // 選項（唔係 `apiKey`，避免 SDK 自動加 `x-api-key` header）。
    this.client = new Anthropic({ baseURL, authToken: apiKey });
    this.model = opts?.model ?? process.env.AI_MODEL ?? "claude-opus-5";
    this.providerName = "anthropic";
  }

  async chat(params: LlmChatParams): Promise<LlmChatResult> {
    const toolsUsed = new Set<string>();
    let text = "";
    let inputTokens = 0;
    let outputTokens = 0;

    if (params.structured) {
      // W1：單次 JSON 輸出（無工具、無 thinking、無 temperature）；上限 = structured.maxTokens
      try {
        const msg = await this.client.messages.create({
          model: this.model,
          max_tokens: params.structured.maxTokens,
          system: params.systemPrompt,
          messages: [{ role: "user", content: params.userMessage }],
        });
        const out = msg.content.filter((b): b is AnthropicTypes.TextBlock => b.type === "text").map((b) => b.text).join("");
        return { text: out, toolsUsed: [], inputTokens: msg.usage.input_tokens, outputTokens: msg.usage.output_tokens, provider: this.providerName, model: this.model };
      } catch (err) {
        if (err instanceof Anthropic.APIError) throw new LlmUnavailableError(err);
        throw err;
      }
    }

    try {
      const runner = this.client.beta.messages.toolRunner({
        model: this.model,
        // claude provider（Opus＋adaptive thinking，thinking 計入）要較大；AI Hub／DeepSeek 路徑維持 4096
        max_tokens: this.providerName === "claude" ? 8000 : 4096,
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

      return { text, toolsUsed: [...toolsUsed], inputTokens, outputTokens, provider: this.providerName, model: this.model };
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
// P2.5：「整理並送出」（`POST /api/feedback/session/summarize`）叫模型
// 出返固定 JSON（`src/lib/ai/feedback-prompt.ts` 嘅
// `buildFeedbackSummarizePrompt()`）——fake dev client 冇工具/歷史可以
// 判斷「而家係咪摘要模式」，靠 systemPrompt 有冇呢個 marker 分支答；
// 淨係喺 `systemPrompt` 含呢個字串先觸發，唔影響平時嘅通用假回覆（見
// feedback-prompt.ts 頂註解——真 provider 見到呢句純粹當普通文字）。
const FEEDBACK_SUMMARIZE_MARKER = "ZOIKAN_P25_FEEDBACK_SUMMARIZE_MODE";

function fakeFeedbackSummaryJson(userMessage: string): string {
  // 攞用戶訊息（transcript 節錄）頭 60 字做 current_problem，等 e2e／
  // 本機冒煙睇到嘅摘要同真係傾過嘅嘢有關連，唔係齋一句固定字。
  const snippet = userMessage.replace(/\s+/g, " ").trim().slice(0, 60);
  return JSON.stringify({
    title: "（開發測試用）現場反映",
    current_problem: snippet || "（開發測試——未有實際訪談內容）",
    desired_change: "（開發測試用嘅假摘要，未連接真 AI Hub）",
    reason: "（開發測試用嘅假摘要，未連接真 AI Hub）",
    related: "冇特別提及",
    open_questions: "",
  });
}

// WP-AI-DIAG（§37.4）：userMessage 含「診斷」就回一段帶兩張建議動作卡（open_page＋one_click_run）嘅固定回覆，
// 方便 e2e／人手睇；月份用固定假月份（2099-01，永遠唔會鎖）。卡 block 照真 provider 格式（fenced `actions`）。
const FAKE_DIAG_REPLY = [
  "（開發測試用嘅假診斷）2099-01 一鍵結算仲有 18 題未答，建議先去睇一鍵結算頁，再重新跑一次。",
  "",
  "```actions",
  JSON.stringify([
    { type: "open_page", label: "去睇 2099-01 一鍵結算", params: { href: "/month-close?month=2099-01" }, basis: "最新一次執行仲有 18 題未答" },
    { type: "one_click_run", label: "重新跑 2099-01 一鍵結算", params: { month: "2099-01" }, basis: "上次執行有 18 題待人手處理" },
  ]),
  "```",
].join("\n");

class FakeDevLlmClient implements LlmClient {
  async chat(params: LlmChatParams): Promise<LlmChatResult> {
    if (params.structured) {
      // W1：結構化輸出（WhatsApp 解析）——假 client 一律回「純雜訊」，唔會冒充任何業務數據
      const text = JSON.stringify({ noise: true, intents: [] });
      return { text, toolsUsed: [], inputTokens: 0, outputTokens: text.length, provider: "fake", model: "fake" };
    }
    const text = params.systemPrompt.includes(FEEDBACK_SUMMARIZE_MARKER)
      ? fakeFeedbackSummaryJson(params.userMessage)
      : params.userMessage.includes("診斷")
        ? FAKE_DIAG_REPLY
        : `（開發測試用嘅假 AI 回覆，未連接真 AI Hub）已收到你嘅問題：「${params.userMessage}」。`;
    for (const ch of text) params.onTextDelta?.(ch);
    return { text, toolsUsed: [], inputTokens: 0, outputTokens: text.length, provider: "fake", model: "fake" };
  }
}

let singleton: LlmClient | undefined;

// WP-AI3：邊個 provider——判斷邏輯（`AI_LLM=fake` 優先 → 明文
// `AI_PROVIDER` → 有邊個 key 就自動揀）抽咗去 `./config.ts`
// `resolveAiProvider()`，同 `(app)/layout.tsx` 嘅 `isAiConfigured()`
// 共用同一套（見嗰個檔案頂註解，兩邊判斷結果一定一致，唔會出現「tab
// 顯示咗但打落去 503」或者「tab 唔顯示但其實配置好」呢種走飛）。
// **呢個唔削弱任何 guard／權限**：呢個 factory 淨係決定「用邊個
// `LlmClient` 去問模型」，之前之後嘅 `requirePermission()`／daily
// limit／`checkOutputGuardAndAudit()` 完全唔受影響（無論揀邊個
// provider，`LlmClient.chat()` 個 return shape 一樣，route.ts 睇唔出
// 分別）。
/** production 用嘅單例——route.ts 淨係 call 呢個，唔會自己 `new
 * AnthropicLlmClient()`/`new DeepSeekLlmClient()`（等測試可以用
 * `setLlmClientForTests()` 換走）。冇任何 provider 配置好就拋
 * `LlmUnavailableError`（route.ts 接住轉 503 `ai_provider_unavailable`），
 * 唔會靜靜雞 fallback 去第個 provider。 */
export function getLlmClient(): LlmClient {
  if (singleton) return singleton;

  const provider = resolveAiProvider();
  switch (provider) {
    case "fake":
      singleton = new FakeDevLlmClient();
      break;
    case "deepseek":
      singleton = new DeepSeekLlmClient();
      break;
    case "claude":
      singleton = new AnthropicLlmClient({ auth: "api-key" });
      break;
    case "anthropic":
      singleton = new AnthropicLlmClient();
      break;
    default:
      throw new LlmUnavailableError(new Error("AI_PROVIDER 未設定，亦搵唔到 CLAUDE_API_KEY/DEEPSEEK_API_KEY/AI_HUB_API_KEY"));
  }
  return singleton;
}

export function setLlmClientForTests(client: LlmClient | undefined): void {
  singleton = client;
}
