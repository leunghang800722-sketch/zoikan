// WP-AI-DIAG 部署前補：claude 路徑 max_tokens 8000（thinking 計入）；AI Hub 路徑維持 4096。
import { describe, it, expect } from "vitest";
import { AnthropicLlmClient } from "@/lib/ai/llm";

async function capturedMaxTokens(client: AnthropicLlmClient): Promise<number> {
  let captured = -1;
  const sdk = (client as unknown as { client: { beta: { messages: { toolRunner: (p: { max_tokens: number }) => AsyncIterable<never> } } } }).client;
  sdk.beta.messages.toolRunner = (p) => {
    captured = p.max_tokens;
    return (async function* () {})();
  };
  await client.chat({ systemPrompt: "s", tools: [], history: [], userMessage: "q", maxToolRounds: 1 });
  return captured;
}

describe("max_tokens", () => {
  it("claude → 8000", async () => {
    expect(await capturedMaxTokens(new AnthropicLlmClient({ auth: "api-key", apiKey: "test-key-not-real" }))).toBe(8000);
  });
  it("AI Hub（anthropic）→ 4096 不變", async () => {
    expect(await capturedMaxTokens(new AnthropicLlmClient({ baseURL: "https://hub.invalid", apiKey: "hub-key" }))).toBe(4096);
  });
});
