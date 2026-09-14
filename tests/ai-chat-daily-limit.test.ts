// WP-AI1：每人每日問答上限（AI_DAILY_LIMIT）——超過就 429；每問一條寫
// audit_log（table_name=ai_chat, action=ai_chat）。
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { clearAll, prisma } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { setLlmClientForTests } from "@/lib/ai/llm";
import { fakeLlmReplying } from "./fixtures/fake-llm";
import { POST as chatPost } from "@/app/api/ai/chat/route";
import { countTodayAiChats } from "@/lib/ai-rate-limit";

function chatRequest(cookie: string, message = "你好") {
  return new Request("http://test.local/api/ai/chat", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ message }),
  });
}

describe("WP-AI1 §？：每日上限 + audit", () => {
  let fx: Wp2Fixture;

  beforeAll(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
  });

  beforeEach(() => {
    setLlmClientForTests(fakeLlmReplying("好"));
    delete process.env.AI_DAILY_LIMIT;
  });
  afterEach(() => {
    setLlmClientForTests(undefined);
    delete process.env.AI_DAILY_LIMIT;
  });

  it("每問一條就寫一條 audit_log（table_name=ai_chat, action=ai_chat）", async () => {
    const cookie = await sessionCookieForUser(fx.userIds["老闆"]);
    const before = await prisma.auditLog.count({ where: { tableName: "ai_chat", action: "ai_chat", actorUserId: fx.userIds["老闆"] } });
    const res = await chatPost(chatRequest(cookie, "第一條問題"));
    expect(res.status).toBe(200);
    await res.text();
    const after = await prisma.auditLog.count({ where: { tableName: "ai_chat", action: "ai_chat", actorUserId: fx.userIds["老闆"] } });
    expect(after).toBe(before + 1);
  });

  it("超過 AI_DAILY_LIMIT → 429", async () => {
    const userId = fx.userIds["會計"];
    // 6 個固定測試用戶成個 vitest run 淨係種一次唔會刪（audit_log
    // append-only，見 tests/lib/db.ts clearAll() 註解）——「會計」呢個
    // 用戶可能俾其他 test file（例如 ai-chat-isolation.test.ts、P2.5
    // 開會反映嘅 session/chat／summarize，見 tests/feedback-daily-
    // limit.test.ts）今日已經問過幾次，唔可以假設由 0 開始。用
    // `countTodayAiChats()`（同 `assertUnderDailyLimit()` 實際用嘅
    // 一樣，P2.5 之後計埋 `ai_chat`／`ai_feedback_chat`／
    // `ai_feedback_summarize`——見 `src/lib/ai-rate-limit.ts`）攞返呢一
    // 刻嘅已用次數，動態定個 limit = 已用 + 2，先可以喺唔理執行順序嘅
    // 情況下穩定斷言。
    const already = await countTodayAiChats(userId);
    process.env.AI_DAILY_LIMIT = String(already + 2);
    const cookie = await sessionCookieForUser(userId);

    const r1 = await chatPost(chatRequest(cookie, "Q1"));
    expect(r1.status).toBe(200);
    await r1.text();
    const r2 = await chatPost(chatRequest(cookie, "Q2"));
    expect(r2.status).toBe(200);
    await r2.text();
    const r3 = await chatPost(chatRequest(cookie, "Q3"));
    expect(r3.status).toBe(429);
    const body = await r3.json();
    expect(body.error).toBe("rate_limited");
  });
});
