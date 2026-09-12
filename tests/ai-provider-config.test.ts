// WP-AI3：`resolveAiProvider()`/`isAiConfigured()`（`src/lib/ai/config.ts`）
// 同 `getLlmClient()`（`src/lib/ai/llm.ts`）嘅 provider 揀選邏輯——三種
// env 組合（deepseek/anthropic/未配置）+ `AI_LLM=fake`／明文
// `AI_PROVIDER` 優先次序。`getLlmClient()` 有 module-level 單例，逐個
// test 之後要用 `setLlmClientForTests(undefined)` 重置，否則會漏到下一個
// test（同 tests/ai-chat-adversarial.test.ts 嘅 `afterEach` 一致做法）。
import { describe, it, expect, afterEach } from "vitest";
import { resolveAiProvider, isAiConfigured } from "@/lib/ai/config";
import { getLlmClient, setLlmClientForTests, LlmUnavailableError } from "@/lib/ai/llm";
import { DeepSeekLlmClient } from "@/lib/ai/providers/deepseek";

const ENV_KEYS = ["AI_LLM", "AI_PROVIDER", "DEEPSEEK_API_KEY", "DEEPSEEK_BASE_URL", "AI_HUB_API_KEY", "AI_HUB_BASE_URL", "AI_MODEL"] as const;

function withEnv(overrides: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>, run: () => void) {
  const saved: Partial<Record<string, string | undefined>> = {};
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  for (const key of ENV_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) process.env[key] = value;
  }
  try {
    run();
  } finally {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

describe("WP-AI3 resolveAiProvider()/isAiConfigured()", () => {
  it("DEEPSEEK_API_KEY 有值、冇明文 AI_PROVIDER → deepseek", () => {
    withEnv({ DEEPSEEK_API_KEY: "sk-test" }, () => {
      expect(resolveAiProvider()).toBe("deepseek");
      expect(isAiConfigured()).toBe(true);
    });
  });

  it("冇 DEEPSEEK_API_KEY，AI_HUB_API_KEY 有值 → anthropic", () => {
    withEnv({ AI_HUB_API_KEY: "sk-hub-test" }, () => {
      expect(resolveAiProvider()).toBe("anthropic");
      expect(isAiConfigured()).toBe(true);
    });
  });

  it("兩個 key 都冇、冇明文 AI_PROVIDER、冇 AI_LLM=fake → undefined（未配置）", () => {
    withEnv({}, () => {
      expect(resolveAiProvider()).toBeUndefined();
      expect(isAiConfigured()).toBe(false);
    });
  });

  it("兩個 key 都有 → 優先 deepseek（自動揀嗰個次序）", () => {
    withEnv({ DEEPSEEK_API_KEY: "sk-ds", AI_HUB_API_KEY: "sk-hub" }, () => {
      expect(resolveAiProvider()).toBe("deepseek");
    });
  });

  it("明文 AI_PROVIDER=anthropic 蓋過自動揀（就算 DEEPSEEK_API_KEY 都有值）", () => {
    withEnv({ DEEPSEEK_API_KEY: "sk-ds", AI_PROVIDER: "anthropic" }, () => {
      expect(resolveAiProvider()).toBe("anthropic");
    });
  });

  it("AI_LLM=fake 優先過任何 AI_PROVIDER/key（Playwright e2e 依賴呢個行為）", () => {
    withEnv({ AI_LLM: "fake", AI_PROVIDER: "anthropic", AI_HUB_API_KEY: "sk-hub" }, () => {
      expect(resolveAiProvider()).toBe("fake");
    });
  });

  it("AI_PROVIDER 打錯字（唔喺 anthropic|deepseek|fake 之內）→ 當冇設，跌返自動揀嗰個次序", () => {
    withEnv({ AI_PROVIDER: "openai", DEEPSEEK_API_KEY: "sk-ds" }, () => {
      expect(resolveAiProvider()).toBe("deepseek");
    });
  });
});

describe("WP-AI3 getLlmClient() 三種 env 組合", () => {
  afterEach(() => setLlmClientForTests(undefined));

  it("AI_LLM=fake → FakeDevLlmClient（零工具調用嘅固定回覆）", async () => {
    withEnv({ AI_LLM: "fake" }, () => {
      const client = getLlmClient();
      expect(client.constructor.name).toBe("FakeDevLlmClient");
    });
  });

  it("AI_PROVIDER=deepseek + DEEPSEEK_API_KEY → DeepSeekLlmClient", () => {
    withEnv({ AI_PROVIDER: "deepseek", DEEPSEEK_API_KEY: "sk-test-not-real" }, () => {
      const client = getLlmClient();
      expect(client).toBeInstanceOf(DeepSeekLlmClient);
    });
  });

  it("AI_HUB_API_KEY 有值（冇 DEEPSEEK_API_KEY）→ AnthropicLlmClient（保留原有 provider，未削弱）", () => {
    withEnv({ AI_HUB_API_KEY: "sk-hub-test", AI_HUB_BASE_URL: "https://ai-hub.example.zeabur.app" }, () => {
      const client = getLlmClient();
      expect(client.constructor.name).toBe("AnthropicLlmClient");
    });
  });

  it("冇任何 provider 配置好 → 拋 LlmUnavailableError（route.ts 接住轉 503 ai_provider_unavailable，唔會 undefined 或者靜靜雞 fallback）", () => {
    withEnv({}, () => {
      expect(() => getLlmClient()).toThrow(LlmUnavailableError);
    });
  });
});
