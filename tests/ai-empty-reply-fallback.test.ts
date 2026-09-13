// WP-AI3 第三輪正式站 live 驗收發現：長對話入面偶爾會撞到真 LLM 回一句
// 完全空白嘅 `text`（真實觀察到——第 11 條問題「上月毛利幾多」冇調用
// 任何工具、`text` 係空字串）。`route.ts` 嘅 `withEmptyReplyFallback()`
// 淨係喺 `result.text` 淨係空白（或者齋得空格）先套用 fallback 文字，
// 唔會影響任何有內容嘅回覆。
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { setLlmClientForTests } from "@/lib/ai/llm";
import { fakeLlmReplying } from "./fixtures/fake-llm";
import { POST as chatPost } from "@/app/api/ai/chat/route";

function chatRequest(cookie: string, message: string) {
  return new Request("http://test.local/api/ai/chat", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ message }),
  });
}

async function collectDoneEvent(res: Response): Promise<{ text: string }> {
  const text = await res.text();
  const block = text.split("\n\n").find((b) => b.includes("event: done"));
  const dataLine = block!.split("\n").find((l) => l.startsWith("data: "))!;
  return JSON.parse(dataLine.slice("data: ".length));
}

describe("WP-AI3：LlmClient 回空白 text 嘅 fallback", () => {
  let fx: Wp2Fixture;

  beforeAll(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
  });

  afterEach(() => setLlmClientForTests(undefined));

  it("LlmClient 回完全空字串——route.ts 唔會俾用戶見到空白回覆，換做 fallback 文字", async () => {
    setLlmClientForTests(fakeLlmReplying(""));
    const cookie = await sessionCookieForUser(fx.userIds["老闆"]);
    const res = await chatPost(chatRequest(cookie, "上月毛利幾多"));
    expect(res.status).toBe(200);
    const done = await collectDoneEvent(res);
    expect(done.text.trim().length).toBeGreaterThan(0);
  });

  it("LlmClient 回齋得空格嘅 text——一樣當空白處理", async () => {
    setLlmClientForTests(fakeLlmReplying("   "));
    const cookie = await sessionCookieForUser(fx.userIds["老闆"]);
    const res = await chatPost(chatRequest(cookie, "隨便問吓"));
    const done = await collectDoneEvent(res);
    expect(done.text.trim().length).toBeGreaterThan(0);
  });

  it("正常有內容嘅回覆完全唔受影響", async () => {
    setLlmClientForTests(fakeLlmReplying("7 月毛利率係 12.2%。"));
    const cookie = await sessionCookieForUser(fx.userIds["老闆"]);
    const res = await chatPost(chatRequest(cookie, "7 月毛利率幾多"));
    const done = await collectDoneEvent(res);
    expect(done.text).toBe("7 月毛利率係 12.2%。");
  });
});
