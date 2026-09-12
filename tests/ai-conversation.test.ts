// WP-AI1：`GET /api/ai/conversation`（攞返自己嘅對話）／`DELETE`（清空
// 自己嘅對話）；對話最多保留 30 turn（60 條 message）。
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { setLlmClientForTests } from "@/lib/ai/llm";
import { fakeLlmReplying } from "./fixtures/fake-llm";
import { POST as chatPost } from "@/app/api/ai/chat/route";
import { GET as conversationGet, DELETE as conversationDelete } from "@/app/api/ai/conversation/route";
import { appendConversationTurn, getConversation } from "@/lib/ai-conversation";

function req(method: string, cookie: string, body?: unknown) {
  return new Request("http://test.local/api/ai/conversation", {
    method,
    headers: { cookie, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
}

describe("WP-AI1：GET/DELETE /api/ai/conversation", () => {
  let fx: Wp2Fixture;

  beforeAll(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
  });

  afterEach(() => setLlmClientForTests(undefined));

  it("問完一條之後，GET 攞到問答記錄", async () => {
    setLlmClientForTests(fakeLlmReplying("已經幫你查好。"));
    const cookie = await sessionCookieForUser(fx.userIds["老闆"]);
    const chatRes = await chatPost(
      new Request("http://test.local/api/ai/chat", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ message: "呢個盤點呀？" }) }),
    );
    await chatRes.text();

    const getRes = await conversationGet(req("GET", cookie));
    expect(getRes.status).toBe(200);
    const body = await getRes.json();
    expect(Array.isArray(body.messages)).toBe(true);
    expect(body.messages.length).toBeGreaterThanOrEqual(2);
    expect(body.messages.at(-2).role).toBe("user");
    expect(body.messages.at(-1).role).toBe("assistant");
  });

  it("DELETE 之後 GET 返回空", async () => {
    const cookie = await sessionCookieForUser(fx.userIds["會計"]);
    await appendConversationTurn(fx.userIds["會計"], "問題", "答案");
    expect((await getConversation(fx.userIds["會計"])).length).toBeGreaterThan(0);

    const delRes = await conversationDelete(req("DELETE", cookie));
    expect(delRes.status).toBe(200);

    const getRes = await conversationGet(req("GET", cookie));
    const body = await getRes.json();
    expect(body.messages).toEqual([]);
  });

  it("最多保留 30 turn（60 條 message）", async () => {
    const userId = fx.userIds["主管"];
    for (let i = 0; i < 35; i++) {
      await appendConversationTurn(userId, `問題${i}`, `答案${i}`);
    }
    const messages = await getConversation(userId);
    expect(messages.length).toBe(60);
    expect(messages[0]!.content).toBe("問題5"); // 頭 5 個 turn（10 條）俾冧走
  });

  it("雞頭冇助手:view → 403", async () => {
    const cookie = await sessionCookieForUser(fx.userIds["雞頭"]);
    const res = await conversationGet(req("GET", cookie));
    expect(res.status).toBe(403);
  });
});
