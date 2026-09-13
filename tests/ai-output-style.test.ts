// WP-AI3 老闆 feedback（正式站助手）：`src/lib/ai/output-style.ts`——
// 答法要用業務用語，唔准出現 snake_case 識別符／工具名／內部雞頭代號。
// 呢度分兩層測：(1) 純函數 `detectStyleIssue()`/`stripIdentifiers()`
// 逐種輸入斷言；(2) `applyOutputStyleGuard()` 用一個可控嘅假
// `LlmClient` 斷言「改寫成功」／「改寫都仲有、跌落 stripIdentifiers()
// 保底」／「改寫 provider call 本身出錯」三條路徑，同埋 audit_log。
import { describe, it, expect, beforeAll } from "vitest";
import { detectStyleIssue, stripIdentifiers, applyOutputStyleGuard } from "@/lib/ai/output-style";
import type { LlmClient, LlmChatParams, LlmChatResult } from "@/lib/ai/llm";
import { clearAll, prisma } from "./lib/db";
import { seedWp2Fixture, type Wp2Fixture } from "./fixtures/wp2-fixture";

describe("WP-AI3 detectStyleIssue()", () => {
  it("snake_case 識別符（欄位名）觸發 snake_case_identifier", () => {
    expect(detectStyleIssue("呢個盤嘅 broker_fee 係 0")).toBe("snake_case_identifier");
    expect(detectStyleIssue("estimated_payout 已經計好")).toBe("snake_case_identifier");
  });

  it("14 個工具名之一出現喺文字入面觸發（多字工具名本身已經係 snake_case，觸發邊種 reason 唔緊要，總之要觸發）", () => {
    expect(detectStyleIssue("資料嚟自 gross_margin 工具")).not.toBeNull();
    expect(detectStyleIssue("用 broker_stats 查返嚟")).not.toBeNull();
  });

  it("冇底線嘅工具名（例如 roster）出現都觸發 tool_name_leak（唔係淨係識 snake_case）", () => {
    expect(detectStyleIssue("用 roster 查返嚟嘅更表")).toBe("tool_name_leak");
  });

  it("內部雞頭代號（B + 兩位數字）觸發 internal_broker_code", () => {
    expect(detectStyleIssue("呢個盤主要係 B07 負責")).toBe("internal_broker_code");
    expect(detectStyleIssue("同 B10 傾過")).toBe("internal_broker_code");
  });

  it("純業務用語、冇任何識別符——唔觸發", () => {
    expect(detectStyleIssue("7 月毛利率係 12.2%。")).toBeNull();
    expect(detectStyleIssue("呢個盤未拆開保安員工資同雞頭費，只有出街價合計。")).toBeNull();
  });

  it("成段文字本身係合法 JSON（測試/debug 用嘅原始工具輸出）——唔觸發，唔會累到 JSON.parse() 用嘅 test 爆", () => {
    const json = JSON.stringify({ totals_note: "totals 已由系統計", broker_fee_total: null });
    expect(detectStyleIssue(json)).toBeNull();
  });

  it("普通話似樣但唔係 snake_case 唔會誤觸（純中文冇底線）", () => {
    expect(detectStyleIssue("呢個雞頭代號係 K，做咗好多更")).toBeNull();
  });
});

describe("WP-AI3 stripIdentifiers()", () => {
  it("剝走 snake_case 識別符，保留其他文字", () => {
    const out = stripIdentifiers("呢個盤嘅 broker_fee 係未拆開嘅。");
    expect(out).not.toMatch(/\bbroker_fee\b/);
    expect(out).toContain("呢個盤嘅");
  });

  it("剝走工具名同 B0x 代號", () => {
    const out = stripIdentifiers("根據 gross_margin 工具，B07 呢個月冇更。");
    expect(out).not.toContain("gross_margin");
    expect(out).not.toMatch(/\bB07\b/);
  });

  it("剝完之後唔會觸發返 detectStyleIssue()（冪等，唔會漏識別符）", () => {
    const out = stripIdentifiers("broker_fee／guard_wage 用 gross_margin 查，代號 B09。");
    expect(detectStyleIssue(out)).toBeNull();
  });
});

function scriptedClient(chatFn: (params: LlmChatParams) => Promise<LlmChatResult> | LlmChatResult): LlmClient {
  return { chat: async (params) => chatFn(params) };
}

describe("WP-AI3 applyOutputStyleGuard()", () => {
  let fx: Wp2Fixture;

  beforeAll(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
  });

  // 注意：audit_log 係 append-only（DB trigger 拒絕 DELETE，見
  // schema-constraints.test.ts），呢度冇 afterEach 清（同其他 ai-*.test.ts
  // 一致做法）——逐條 test 用 before/after 計數差，唔靠總數係 0 開始。

  it("冇識別符——唔觸發，文字原封不動，唔 call LLM", async () => {
    let called = false;
    const client = scriptedClient(() => {
      called = true;
      return { text: "唔應該行到呢度", toolsUsed: [], inputTokens: 0, outputTokens: 0 };
    });
    const result = await applyOutputStyleGuard({ text: "7 月毛利率係 12.2%。", llmClient: client, actorUserId: fx.userIds["老闆"], ip: null });
    expect(result.triggered).toBe(false);
    expect(result.text).toBe("7 月毛利率係 12.2%。");
    expect(called).toBe(false);
  });

  it("改寫成功清乾淨——用改寫之後嘅版本，記 audit_log(ai_style_rewrite)", async () => {
    const client = scriptedClient((params) => ({
      text: params.userMessage.includes("gross_margin") ? "7 月毛利率係 12.2%（根據毛利即時表）。" : "唔啱嘅 script",
      toolsUsed: [],
      inputTokens: 5,
      outputTokens: 5,
    }));
    const before = await prisma.auditLog.count({ where: { tableName: "ai_chat", action: "ai_style_rewrite" } });
    const result = await applyOutputStyleGuard({
      text: "根據 gross_margin 工具，7 月毛利率係 12.2%。",
      llmClient: client,
      actorUserId: fx.userIds["老闆"],
      ip: null,
    });
    expect(result.triggered).toBe(true);
    expect(result.rewritten).toBe(true);
    expect(result.text).toBe("7 月毛利率係 12.2%（根據毛利即時表）。");
    expect(detectStyleIssue(result.text)).toBeNull();
    const after = await prisma.auditLog.count({ where: { tableName: "ai_chat", action: "ai_style_rewrite" } });
    expect(after).toBe(before + 1);
  });

  it("改寫都仲有識別符——跌落 stripIdentifiers() 保底，rewritten=false", async () => {
    const client = scriptedClient(() => ({
      text: "改寫之後仲係有 gross_margin 呢個字。",
      toolsUsed: [],
      inputTokens: 1,
      outputTokens: 1,
    }));
    const result = await applyOutputStyleGuard({
      text: "根據 gross_margin 工具查返嚟。",
      llmClient: client,
      actorUserId: fx.userIds["老闆"],
      ip: null,
    });
    expect(result.triggered).toBe(true);
    expect(result.rewritten).toBe(false);
    expect(result.text).not.toContain("gross_margin");
    expect(detectStyleIssue(result.text)).toBeNull();
  });

  it("改寫 provider call 本身拋錯——唔會累到成個 guard 拋錯，跌落 stripIdentifiers() 保底", async () => {
    const client = scriptedClient(() => {
      throw new Error("provider 暫時連唔到");
    });
    const result = await applyOutputStyleGuard({
      text: "用 broker_stats 查返嚟嘅代號 B07 數據。",
      llmClient: client,
      actorUserId: fx.userIds["老闆"],
      ip: null,
    });
    expect(result.triggered).toBe(true);
    expect(result.text).not.toContain("broker_stats");
    expect(result.text).not.toMatch(/\bB07\b/);
  });

  it("改寫 request 用嘅 tools 一定係空陣列（同 provider、冇帶工具）", async () => {
    let receivedTools: unknown;
    const client = scriptedClient((params) => {
      receivedTools = params.tools;
      return { text: "改寫好嘅版本。", toolsUsed: [], inputTokens: 1, outputTokens: 1 };
    });
    await applyOutputStyleGuard({ text: "gross_margin 話係咁。", llmClient: client, actorUserId: fx.userIds["老闆"], ip: null });
    expect(receivedTools).toEqual([]);
  });
});
