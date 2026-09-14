// P2.5「現場反映」開會模式——Opus 驗收應修④：
// 1. `session/chat`／`session/summarize`（真係叫 LLM）同 `/api/ai/chat`
//    共用同一個每日額度（`assertUnderDailyLimit()`），計埋同一個數。
// 2. `session`（開 session，唔叫 LLM）另有每人每日最多開
//    `MAX_FEEDBACK_SESSIONS_PER_DAY` 個 session 嘅獨立上限，`abandon`
//    再開都計。
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { clearAll, prisma } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { setLlmClientForTests } from "@/lib/ai/llm";
import { fakeLlmReplying } from "./fixtures/fake-llm";
import { POST as chatPost } from "@/app/api/ai/chat/route";
import { POST as sessionOpenPost } from "@/app/api/feedback/session/route";
import { POST as sessionChatPost } from "@/app/api/feedback/session/chat/route";
import { POST as sessionAbandonPost } from "@/app/api/feedback/session/abandon/route";
import { countTodayAiChats } from "@/lib/ai-rate-limit";
import { countSessionsOpenedToday, MAX_FEEDBACK_SESSIONS_PER_DAY } from "@/lib/feedback/session";

function req(url: string, cookie: string, body?: unknown) {
  return new Request(`http://test.local${url}`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function aiChatRequest(cookie: string, message = "你好") {
  return new Request("http://test.local/api/ai/chat", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ message }),
  });
}

describe("P2.5 Opus 驗收應修④：feedback 訪談員同主助手共用每日額度＋每日開 session 上限", () => {
  let fx: Wp2Fixture;

  beforeAll(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
  });

  beforeEach(() => {
    setLlmClientForTests(fakeLlmReplying("好，明白。"));
    delete process.env.AI_DAILY_LIMIT;
  });
  afterEach(() => {
    setLlmClientForTests(undefined);
    delete process.env.AI_DAILY_LIMIT;
  });

  it("/api/ai/chat 同 /api/feedback/session/chat 共用同一個每日額度——撞到上限任一邊都 429", async () => {
    const userId = fx.userIds["主管"];
    const cookie = await sessionCookieForUser(userId);

    // 攞返呢一刻嘅已用次數（呢個測試用戶喺成個 vitest run 可能已經俾其
    // 他 test file 問過幾次）——動態定 limit = 已用 + 2，先可以唔理執行
    // 順序穩定斷言（同 tests/ai-chat-daily-limit.test.ts 一致做法）。
    const already = await countTodayAiChats(userId);
    process.env.AI_DAILY_LIMIT = String(already + 2);

    // 開返一個開會 session 先——`session/chat` 要有效 draft session。
    const openRes = await sessionOpenPost(req("/api/feedback/session", cookie, {}));
    expect(openRes.status).toBe(200);
    const { id: sessionId } = (await openRes.json()) as { id: string };

    // 第一次：叫主助手 /api/ai/chat（用咗 already+1）。
    const r1 = await chatPost(aiChatRequest(cookie, "Q1"));
    expect(r1.status).toBe(200);
    await r1.text();

    // 第二次：叫開會反映訪談員 /api/feedback/session/chat（用咗
    // already+2，撞晒個共用上限）。
    const r2 = await sessionChatPost(req("/api/feedback/session/chat", cookie, { session_id: sessionId, message: "更表撳格太細" }));
    expect(r2.status).toBe(200);
    await r2.text();

    // 第三次：唔理叫邊個 endpoint，已經 already+2 >= limit，一律 429。
    const r3 = await sessionChatPost(req("/api/feedback/session/chat", cookie, { session_id: sessionId, message: "仲有第二點" }));
    expect(r3.status).toBe(429);
    const body3 = (await r3.json()) as { error: string };
    expect(body3.error).toBe("rate_limited");

    await sessionAbandonPost(req("/api/feedback/session/abandon", cookie, { session_id: sessionId }));
  });

  it("每叫一次 session/chat 就寫一條 ai_feedback_chat audit（計入共用額度）", async () => {
    const userId = fx.userIds["會計"];
    const cookie = await sessionCookieForUser(userId);

    const openRes = await sessionOpenPost(req("/api/feedback/session", cookie, {}));
    const { id: sessionId } = (await openRes.json()) as { id: string };

    const before = await prisma.auditLog.count({ where: { tableName: "ai_feedback_chat", action: "ai_feedback_chat", actorUserId: userId } });
    const res = await sessionChatPost(req("/api/feedback/session/chat", cookie, { session_id: sessionId, message: "第一句" }));
    expect(res.status).toBe(200);
    await res.text();
    const after = await prisma.auditLog.count({ where: { tableName: "ai_feedback_chat", action: "ai_feedback_chat", actorUserId: userId } });
    expect(after).toBe(before + 1);

    await sessionAbandonPost(req("/api/feedback/session/abandon", cookie, { session_id: sessionId }));
  });

  it(`每人每日最多開 ${MAX_FEEDBACK_SESSIONS_PER_DAY} 個 session，第 ${MAX_FEEDBACK_SESSIONS_PER_DAY + 1} 個 → 429（abandon 再開都計）`, async () => {
    // 用「老闆」——呢個檔案自己 beforeAll clearAll() 已經清晒
    // feedback_sessions，之後上面兩條 test 淨係用過「主管」／「會計」，
    // 「老闆」喺呢個檔案入面仲未開過任何 session，保證由 0 開始計。
    const userId = fx.userIds["老闆"];
    const cookie = await sessionCookieForUser(userId);

    const alreadyOpened = await countSessionsOpenedToday(userId);
    expect(alreadyOpened).toBe(0);

    for (let i = 0; i < MAX_FEEDBACK_SESSIONS_PER_DAY; i++) {
      const openRes = await sessionOpenPost(req("/api/feedback/session", cookie, {}));
      expect(openRes.status).toBe(200);
      const { id: sessionId } = (await openRes.json()) as { id: string };
      // Abandon 咗先至保證下一次冇現有 draft 可以續用，一定會插一行
      // 新記錄（「abandon 再開都計」）。
      const abandonRes = await sessionAbandonPost(req("/api/feedback/session/abandon", cookie, { session_id: sessionId }));
      expect(abandonRes.status).toBe(200);
    }

    const overLimitRes = await sessionOpenPost(req("/api/feedback/session", cookie, {}));
    expect(overLimitRes.status).toBe(429);
    const body = (await overLimitRes.json()) as { error: string };
    expect(body.error).toBe("feedback_session_limit");
  });

  it("續用現有 draft（唔開新嘅）唔受開 session 上限影響", async () => {
    const userId = fx.userIds["主管"]; // 呢個檔案入面「主管」之前開咗 1 個 session（第一條 test），仲遠低於上限
    const cookie = await sessionCookieForUser(userId);

    const res1 = await sessionOpenPost(req("/api/feedback/session", cookie, {}));
    expect(res1.status).toBe(200);
    const body1 = (await res1.json()) as { id: string };

    // 連續 10 次續用（冇 abandon），全部都應該係續用返同一個 draft，
    // 完全唔受每日開 session 上限影響。
    for (let i = 0; i < 10; i++) {
      const res = await sessionOpenPost(req("/api/feedback/session", cookie, {}));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { id: string };
      expect(body.id).toBe(body1.id);
    }

    await sessionAbandonPost(req("/api/feedback/session/abandon", cookie, { session_id: body1.id }));
  });
});
