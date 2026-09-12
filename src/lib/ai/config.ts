// WP-AI3：邊個 LLM 供應商——`getLlmClient()`（`src/lib/ai/llm.ts`）同
// `(app)/layout.tsx` 嘅 `aiConfigured` 判斷要用返*同一套*邏輯，抽喺呢個
// 檔案，等兩邊永遠唔會走飛。刻意零 import（唔碰 Anthropic SDK／`openai`
// SDK／DB／任何 server-only 重嘢）——`layout.tsx` 係 server component，
// 淨係想知「有冇配置好」，唔想順手拖埋成個 provider client 落 RSC bundle。
//
// 判斷次序（老闆 2026-09-12 揀 DeepSeek 之後）：
// 1. `AI_LLM=fake`——Playwright e2e 專用假分支（見 llm.ts 底
//    `FakeDevLlmClient` 嘅註解），優先過任何真 provider 判斷。
// 2. `AI_PROVIDER` 明文設咗（`anthropic`/`deepseek`/`fake`）就跟呢個。
// 3. 冇明文設，就自動揀：有 `DEEPSEEK_API_KEY` 就 `deepseek`，否則有
//    `AI_HUB_API_KEY` 就 `anthropic`，兩樣都冇就 `undefined`（未配置）。
export type AiProvider = "anthropic" | "deepseek" | "fake";

const VALID_PROVIDERS: readonly AiProvider[] = ["anthropic", "deepseek", "fake"];

function isAiProvider(value: string | undefined): value is AiProvider {
  return !!value && (VALID_PROVIDERS as readonly string[]).includes(value);
}

export function resolveAiProvider(): AiProvider | undefined {
  if (process.env.AI_LLM === "fake") return "fake";

  const explicit = process.env.AI_PROVIDER;
  if (isAiProvider(explicit)) return explicit;

  if (process.env.DEEPSEEK_API_KEY) return "deepseek";
  if (process.env.AI_HUB_API_KEY) return "anthropic";
  return undefined;
}

/** `(app)/layout.tsx` 用嚟決定側欄 AI 助手 tab 顯唔顯示——冇配置好就
 * 唔顯示，免得用戶見到一個「暫時未連接」嘅助手（見 llm.ts 頂註解）。 */
export function isAiConfigured(): boolean {
  return resolveAiProvider() !== undefined;
}
