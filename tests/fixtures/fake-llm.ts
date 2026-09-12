// WP-AI1：假 LLM——實現 `LlmClient` interface（`src/lib/ai/llm.ts`），
// 令 route/loop test 唔使真 key、唔使真係 call Anthropic API。
//
// 可以腳本化「模型想 call 邊個工具、傳咩 input」＋「最後答咩」：
// - `toolCalls`：一串 `{name, args}`，`chat()` 會由 `params.tools`
//   （route.ts 傳落嚟嘅*真*工具物件，用真 session 建構）逐個搵返個名
//   call `.run(args)`——等測試可以驗證真實工具邏輯（field-group gate/
//   權限拒絕/DB 查詢）行為，唔淨係 mock 咗個 route 本身。
// - `replyText`：最終回覆，可以係固定字串，或者一個 function 攞返
//   `Record<toolName, resultString>` 自己砌返個字串（isolation test 用
//   嚟直接搬字過紙 tool 嘅 JSON output 出嚟俾斷言）。
import type { LlmClient, LlmChatParams, LlmChatResult } from "@/lib/ai/llm";

export interface FakeLlmScript {
  toolCalls?: Array<{ name: string; args: unknown }>;
  replyText?: string | ((toolResults: Record<string, string>) => string);
}

export class FakeLlmClient implements LlmClient {
  constructor(private script: FakeLlmScript) {}

  async chat(params: LlmChatParams): Promise<LlmChatResult> {
    const toolResults: Record<string, string> = {};
    const toolsUsed: string[] = [];

    for (const call of this.script.toolCalls ?? []) {
      const tool = params.tools.find((t) => "name" in t && (t as { name?: string }).name === call.name);
      if (!tool) throw new Error(`FakeLlmClient: 搵唔到工具「${call.name}」`);
      const raw = await (tool as { run: (args: unknown) => Promise<string | unknown> }).run(call.args);
      const asString = typeof raw === "string" ? raw : JSON.stringify(raw);
      toolResults[call.name] = asString;
      toolsUsed.push(call.name);
    }

    const text = typeof this.script.replyText === "function" ? this.script.replyText(toolResults) : (this.script.replyText ?? "");

    // 模擬串流：逐個字元 call onTextDelta，等 route.ts 嘅 SSE 邏輯有嘢可以行。
    if (params.onTextDelta) {
      for (const ch of text) params.onTextDelta(ch);
    }

    return { text, toolsUsed, inputTokens: 10, outputTokens: text.length };
  }
}

/** 快捷：淨係想測「模型講咗啲乜」（唔使真係 call 工具）嘅 adversarial
 * test 用呢個。 */
export function fakeLlmReplying(text: string): FakeLlmClient {
  return new FakeLlmClient({ replyText: text });
}
