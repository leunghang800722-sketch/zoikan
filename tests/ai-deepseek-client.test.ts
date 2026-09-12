// WP-AI3：`DeepSeekLlmClient`（`src/lib/ai/providers/deepseek.ts`）嘅手寫
// agentic loop——用 inject 嘅假 `openai` client（唔使真 key、唔使真係打
// DeepSeek API）逐個腳本化 `chat.completions.create()` 嘅回應，斷言個
// loop 行為：單工具、並行 tool_calls、8 輪上限、工具拋錯、
// `finish_reason==="length"`、401 → `LlmUnavailableError`。
import { describe, it, expect, vi } from "vitest";
import OpenAI from "openai";
import type { ChatCompletion } from "openai/resources/chat/completions";
import { DeepSeekLlmClient } from "@/lib/ai/providers/deepseek";
import { LlmUnavailableError, type LlmChatParams } from "@/lib/ai/llm";
import type { BetaRunnableTool } from "@anthropic-ai/sdk/lib/tools/BetaRunnableTool";

function fakeTool(name: string, run: (args: unknown) => Promise<string> | string): BetaRunnableTool<unknown> {
  return {
    type: "custom",
    name,
    description: `測試工具 ${name}`,
    input_schema: { type: "object", properties: {}, additionalProperties: false },
    run: async (args: unknown) => run(args),
    parse: (raw: unknown) => raw,
  } as unknown as BetaRunnableTool<unknown>;
}

function baseParams(overrides: Partial<LlmChatParams> = {}): LlmChatParams {
  return {
    systemPrompt: "你係測試助手。",
    tools: [],
    history: [],
    userMessage: "測試問題",
    maxToolRounds: 8,
    ...overrides,
  };
}

/** 攞第幾個 `create()` call 嘅完整 request body（等測試斷言 messages 有冇帶齊
 * 每個 tool_call_id 嘅 `role:"tool"` 回應）。 */
function completion(opts: {
  content?: string | null;
  toolCalls?: Array<{ id: string; name: string; args: string }>;
  finishReason?: ChatCompletion["choices"][number]["finish_reason"];
  usage?: { prompt_tokens: number; completion_tokens: number };
}): ChatCompletion {
  return {
    id: "chatcmpl-test",
    object: "chat.completion",
    created: 0,
    model: "deepseek-v4-pro",
    choices: [
      {
        index: 0,
        finish_reason: opts.finishReason ?? (opts.toolCalls?.length ? "tool_calls" : "stop"),
        logprobs: null,
        message: {
          role: "assistant",
          content: opts.content ?? null,
          refusal: null,
          tool_calls: opts.toolCalls?.map((c) => ({
            id: c.id,
            type: "function" as const,
            function: { name: c.name, arguments: c.args },
          })),
        },
      },
    ],
    usage: opts.usage
      ? { prompt_tokens: opts.usage.prompt_tokens, completion_tokens: opts.usage.completion_tokens, total_tokens: opts.usage.prompt_tokens + opts.usage.completion_tokens }
      : undefined,
  } as ChatCompletion;
}

function mockClient(createImpl: (call: number) => ChatCompletion | Promise<ChatCompletion>) {
  let call = 0;
  // `_body`：唔使斷言個 request shape 就用返呢個做 mock 實現，但要保留
  // 呢個參數等 `create.mock.calls[i][0]` 攞返真正傳落去嘅 request body
  // （斷言「forced-final 嗰輪冇帶 tools」／「tool message 有冇對齊
  // tool_call_id」要用）。
  const create = vi.fn(async (body: { messages: unknown[]; tools?: unknown[] }) => {
    void body; // 唔喺呢度斷言 request body——留俾外面用 `create.mock.calls[i][0]` 攞
    return createImpl(call++);
  });
  return { client: { chat: { completions: { create } } }, create };
}

describe("WP-AI3 DeepSeekLlmClient", () => {
  it("單一工具調用：問一輪 → call 工具 → 再問一輪收尾", async () => {
    const tool = fakeTool("gross_margin", async () => JSON.stringify({ profit: 100 }));
    const { client, create } = mockClient((call) =>
      call === 0
        ? completion({ toolCalls: [{ id: "call_1", name: "gross_margin", args: "{}" }], usage: { prompt_tokens: 50, completion_tokens: 20 } })
        : completion({ content: "毛利係 100（根據 gross_margin 工具）。", usage: { prompt_tokens: 80, completion_tokens: 15 } }),
    );
    const deepseek = new DeepSeekLlmClient({ client: client as unknown as OpenAI });

    const result = await deepseek.chat(baseParams({ tools: [tool] }));

    expect(result.text).toBe("毛利係 100（根據 gross_margin 工具）。");
    expect(result.toolsUsed).toEqual(["gross_margin"]);
    expect(result.inputTokens).toBe(130);
    expect(result.outputTokens).toBe(35);
    expect(create).toHaveBeenCalledTimes(2);

    // 第二次 request 嘅 messages 要帶返 tool_call_id 對應嘅 role:"tool" message
    const secondCallArgs = create.mock.calls[1]![0] as { messages: Array<{ role: string; tool_call_id?: string }> };
    const toolMsg = secondCallArgs.messages.find((m) => m.role === "tool");
    expect(toolMsg?.tool_call_id).toBe("call_1");
  });

  it("並行 tool_calls：一個 assistant turn 帶兩個 tool_calls，兩個都要逐個 run() 同覆 tool message", async () => {
    const calledWith: string[] = [];
    const toolA = fakeTool("list_sites", async () => {
      calledWith.push("list_sites");
      return JSON.stringify({ sites: ["A"] });
    });
    const toolB = fakeTool("guard_lookup", async () => {
      calledWith.push("guard_lookup");
      return JSON.stringify({ guards: ["G1"] });
    });
    const { client, create } = mockClient((call) =>
      call === 0
        ? completion({
            toolCalls: [
              { id: "call_a", name: "list_sites", args: "{}" },
              { id: "call_b", name: "guard_lookup", args: "{}" },
            ],
          })
        : completion({ content: "兩個工具都查咗。" }),
    );
    const deepseek = new DeepSeekLlmClient({ client: client as unknown as OpenAI });

    const result = await deepseek.chat(baseParams({ tools: [toolA, toolB] }));

    expect(calledWith.sort()).toEqual(["guard_lookup", "list_sites"]);
    expect(result.toolsUsed.sort()).toEqual(["guard_lookup", "list_sites"]);
    expect(result.text).toBe("兩個工具都查咗。");

    const secondCallArgs = create.mock.calls[1]![0] as { messages: Array<{ role: string; tool_call_id?: string }> };
    const toolMsgIds = secondCallArgs.messages.filter((m) => m.role === "tool").map((m) => m.tool_call_id);
    expect(toolMsgIds.sort()).toEqual(["call_a", "call_b"]);
  });

  it("8 輪上限：模型無限求 tool_calls，loop 唔會死循環——行齊 maxToolRounds 輪工具調用之後，加一輪冧走 tools 逼收尾", async () => {
    const tool = fakeTool("recent_audit", async () => "{}");
    const { client, create } = mockClient((call) =>
      call < 8
        ? completion({ toolCalls: [{ id: `call_${call}`, name: "recent_audit", args: "{}" }] })
        : completion({ content: "夠鐘收尾。" }), // 第 9 次（index 8）先係 forced-final，冇 tools
    );
    const deepseek = new DeepSeekLlmClient({ client: client as unknown as OpenAI });

    const result = await deepseek.chat(baseParams({ tools: [tool], maxToolRounds: 8 }));

    expect(create).toHaveBeenCalledTimes(9); // 8 輪工具調用 + 1 輪 forced-final
    expect(result.toolsUsed).toEqual(["recent_audit"]);
    expect(result.text).toBe("夠鐘收尾。");

    // forced-final 嗰一次 request 唔應該帶 `tools`（逼佢唔好再求 tool_calls）
    const finalCallArgs = create.mock.calls[8]![0] as { tools?: unknown };
    expect(finalCallArgs.tools).toBeUndefined();
  });

  it("工具拋錯：run() reject → 對應 tool message content 帶 error，loop 繼續行落去（唔會令成個 request 死）", async () => {
    const badTool = fakeTool("shortfall", async () => {
      throw new Error("DB 逾時");
    });
    const { client } = mockClient((call) =>
      call === 0
        ? completion({ toolCalls: [{ id: "call_1", name: "shortfall", args: "{}" }] })
        : completion({ content: "查唔到，可能要問人。" }),
    );
    const deepseek = new DeepSeekLlmClient({ client: client as unknown as OpenAI });

    const result = await deepseek.chat(baseParams({ tools: [badTool] }));

    expect(result.text).toBe("查唔到，可能要問人。");
    expect(result.toolsUsed).toEqual(["shortfall"]);
  });

  it("finish_reason=length（純文字，冇 tool_calls）：唔拋錯，原樣交返（可能截斷嘅）文字", async () => {
    const { client } = mockClient(() => completion({ content: "呢段答案畀 max_tokens 切斷咗，冇", finishReason: "length" }));
    const deepseek = new DeepSeekLlmClient({ client: client as unknown as OpenAI });

    const result = await deepseek.chat(baseParams());

    expect(result.text).toBe("呢段答案畀 max_tokens 切斷咗，冇");
  });

  it("finish_reason=length（tool_calls 嘅 arguments 中途截斷成壞 JSON）：JSON.parse 拋錯俾 runTool() 接住，唔會令成個 request 死", async () => {
    const tool = fakeTool("roster", async () => "唔應該行到呢度");
    const { client } = mockClient((call) =>
      call === 0
        ? completion({ toolCalls: [{ id: "call_1", name: "roster", args: '{"site_id": "abc", "mon' }], finishReason: "length" })
        : completion({ content: "工具輸入截斷咗，答唔到，建議問人。" }),
    );
    const deepseek = new DeepSeekLlmClient({ client: client as unknown as OpenAI });

    const result = await deepseek.chat(baseParams({ tools: [tool] }));

    expect(result.text).toBe("工具輸入截斷咗，答唔到，建議問人。");
    expect(result.toolsUsed).toEqual(["roster"]);
  });

  it("401 authentication error → LlmUnavailableError（route.ts 會接住轉 503 ai_provider_unavailable）", async () => {
    const authError = new OpenAI.AuthenticationError(401, { message: "invalid api key" }, "invalid api key", new Headers());
    const create = vi.fn(async () => {
      throw authError;
    });
    const deepseek = new DeepSeekLlmClient({ client: { chat: { completions: { create } } } as unknown as OpenAI });

    await expect(deepseek.chat(baseParams())).rejects.toBeInstanceOf(LlmUnavailableError);
  });

  it("429/5xx/網絡錯誤都係 OpenAI.APIError 嘅子類——一樣映射做 LlmUnavailableError", async () => {
    const rateLimitError = new OpenAI.RateLimitError(429, { message: "rate limited" }, "rate limited", new Headers());
    const create = vi.fn(async () => {
      throw rateLimitError;
    });
    const deepseek = new DeepSeekLlmClient({ client: { chat: { completions: { create } } } as unknown as OpenAI });

    await expect(deepseek.chat(baseParams())).rejects.toBeInstanceOf(LlmUnavailableError);
  });

  it("非 APIError 嘅錯誤（例如自己段碼 bug）原樣拋出，唔會被吞或者誤判做 provider unavailable", async () => {
    const bug = new TypeError("唔關 provider 事嘅 bug");
    const create = vi.fn(async () => {
      throw bug;
    });
    const deepseek = new DeepSeekLlmClient({ client: { chat: { completions: { create } } } as unknown as OpenAI });

    await expect(deepseek.chat(baseParams())).rejects.toBe(bug);
  });

  it("constructor：冇 apiKey 又冇 inject client → 即刻拋 LlmUnavailableError（唔使等到 chat() 先發現）", () => {
    const savedKey = process.env.DEEPSEEK_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;
    try {
      expect(() => new DeepSeekLlmClient()).toThrow(LlmUnavailableError);
    } finally {
      if (savedKey !== undefined) process.env.DEEPSEEK_API_KEY = savedKey;
    }
  });
});
