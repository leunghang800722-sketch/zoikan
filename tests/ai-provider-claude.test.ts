// WP-AI-DIAG（§37.2）：`claude` provider——自動判斷次序、型號 env、client auth 形狀。唔打網絡、冇真 key。
import { describe, it, expect, afterEach } from "vitest";
import { resolveAiProvider, isAiConfigured, describeAiProvider, claudeModel, DEFAULT_CLAUDE_MODEL } from "@/lib/ai/config";
import { getLlmClient, setLlmClientForTests, AnthropicLlmClient } from "@/lib/ai/llm";
import { DeepSeekLlmClient } from "@/lib/ai/providers/deepseek";

const KEYS = ["AI_LLM", "AI_PROVIDER", "CLAUDE_API_KEY", "AI_CLAUDE_MODEL", "DEEPSEEK_API_KEY", "AI_HUB_API_KEY", "AI_HUB_BASE_URL", "AI_MODEL"] as const;

function withEnv(overrides: Partial<Record<(typeof KEYS)[number], string>>, run: () => void) {
  const saved: Record<string, string | undefined> = {};
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  for (const [k, v] of Object.entries(overrides)) process.env[k] = v;
  try {
    run();
  } finally {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

afterEach(() => setLlmClientForTests(undefined));

describe("WP-AI-DIAG claude provider 判斷次序", () => {
  it("只有 CLAUDE_API_KEY → claude", () => {
    withEnv({ CLAUDE_API_KEY: "test-key-not-real" }, () => {
      expect(resolveAiProvider()).toBe("claude");
      expect(isAiConfigured()).toBe(true);
    });
  });

  it("CLAUDE_API_KEY ＋ DEEPSEEK_API_KEY ＋ AI_HUB_API_KEY → claude 優先", () => {
    withEnv({ CLAUDE_API_KEY: "a", DEEPSEEK_API_KEY: "b", AI_HUB_API_KEY: "c" }, () => {
      expect(resolveAiProvider()).toBe("claude");
    });
  });

  it("明文 AI_PROVIDER=deepseek 贏過 CLAUDE_API_KEY", () => {
    withEnv({ AI_PROVIDER: "deepseek", CLAUDE_API_KEY: "a", DEEPSEEK_API_KEY: "b" }, () => {
      expect(resolveAiProvider()).toBe("deepseek");
    });
  });

  it("明文 AI_PROVIDER=claude 接受", () => {
    withEnv({ AI_PROVIDER: "claude" }, () => {
      expect(resolveAiProvider()).toBe("claude");
    });
  });

  it("AI_LLM=fake 贏晒", () => {
    withEnv({ AI_LLM: "fake", CLAUDE_API_KEY: "a", AI_PROVIDER: "claude" }, () => {
      expect(resolveAiProvider()).toBe("fake");
    });
  });

  it("冇 CLAUDE_API_KEY → 舊次序不變（deepseek > anthropic hub > 未配置）", () => {
    withEnv({ DEEPSEEK_API_KEY: "b", AI_HUB_API_KEY: "c" }, () => expect(resolveAiProvider()).toBe("deepseek"));
    withEnv({ AI_HUB_API_KEY: "c" }, () => expect(resolveAiProvider()).toBe("anthropic"));
    withEnv({}, () => expect(resolveAiProvider()).toBeUndefined());
  });
});

describe("WP-AI-DIAG claude 型號", () => {
  it("預設 claude-opus-5-5；AI_CLAUDE_MODEL 覆蓋；唔讀 AI_MODEL", () => {
    withEnv({ AI_MODEL: "deepseek-chat" }, () => {
      expect(claudeModel()).toBe(DEFAULT_CLAUDE_MODEL);
      expect(DEFAULT_CLAUDE_MODEL).toBe("claude-opus-5-5");
    });
    withEnv({ AI_CLAUDE_MODEL: "claude-sonnet-5-5", AI_MODEL: "deepseek-chat" }, () => {
      expect(claudeModel()).toBe("claude-sonnet-5-5");
    });
  });

  it("getLlmClient：claude → AnthropicLlmClient（型號跟 AI_CLAUDE_MODEL，唔係 AI_MODEL）", () => {
    withEnv({ CLAUDE_API_KEY: "test-key-not-real", AI_MODEL: "deepseek-chat" }, () => {
      const c = getLlmClient();
      expect(c).toBeInstanceOf(AnthropicLlmClient);
      expect((c as unknown as { model: string }).model).toBe("claude-opus-5-5");
      expect((c as unknown as { providerName: string }).providerName).toBe("claude");
    });
  });

  it("claude client：baseURL 固定 api.anthropic.com、apiKey auth（唔係 Bearer authToken）、maxRetries 1", () => {
    withEnv({ CLAUDE_API_KEY: "test-key-not-real", AI_HUB_BASE_URL: "https://hub.invalid" }, () => {
      const c = new AnthropicLlmClient({ auth: "api-key" });
      const sdk = (c as unknown as { client: { baseURL: string; apiKey: string | null; authToken: string | null; maxRetries: number } }).client;
      expect(sdk.baseURL).toBe("https://api.anthropic.com");
      expect(sdk.apiKey).toBe("test-key-not-real");
      expect(sdk.authToken).toBeNull();
      expect(sdk.maxRetries).toBe(1);
    });
  });

  it("AI Hub 路徑不變：Bearer authToken、用 AI_HUB_BASE_URL、型號跟 AI_MODEL", () => {
    withEnv({ AI_HUB_API_KEY: "hub-key", AI_HUB_BASE_URL: "https://hub.invalid", AI_MODEL: "claude-opus-5" }, () => {
      const c = getLlmClient();
      const sdk = (c as unknown as { client: { baseURL: string; apiKey: string | null; authToken: string | null } }).client;
      expect(sdk.baseURL).toBe("https://hub.invalid");
      expect(sdk.authToken).toBe("hub-key");
      expect((c as unknown as { providerName: string }).providerName).toBe("anthropic");
    });
  });

  it("DeepSeek 路徑不變：getLlmClient → DeepSeekLlmClient", () => {
    withEnv({ DEEPSEEK_API_KEY: "ds" }, () => {
      expect(getLlmClient()).toBeInstanceOf(DeepSeekLlmClient);
    });
  });

  it("describeAiProvider：只有名稱，冇 key", () => {
    withEnv({ CLAUDE_API_KEY: "secret-should-not-appear" }, () => {
      const d = describeAiProvider();
      expect(d).toEqual({ provider: "claude", model: "claude-opus-5-5" });
      expect(JSON.stringify(d)).not.toContain("secret-should-not-appear");
    });
    withEnv({}, () => expect(describeAiProvider()).toEqual({ provider: "none", model: "none" }));
  });

  it("claude 但冇 key → LlmUnavailableError", () => {
    withEnv({ AI_PROVIDER: "claude" }, () => {
      expect(() => getLlmClient()).toThrow();
    });
  });
});
