// WP-AI1：`助手` module 權限——雞頭／保安員 403（硬性），主管/會計/老闆
// 出廠都有 助手:view（跟矩陣），成功可以攞到 SSE 回覆。
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { setLlmClientForTests } from "@/lib/ai/llm";
import { fakeLlmReplying } from "./fixtures/fake-llm";
import { POST as chatPost } from "@/app/api/ai/chat/route";

function chatRequest(cookie: string, message = "你好") {
  return new Request("http://test.local/api/ai/chat", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ message }),
  });
}

async function readSse(res: Response): Promise<{ status: number; events: Array<{ event: string; data: unknown }> }> {
  const status = res.status;
  if (!res.body) return { status, events: [] };
  const text = await res.text();
  const events: Array<{ event: string; data: unknown }> = [];
  for (const block of text.split("\n\n")) {
    if (!block.trim()) continue;
    const lines = block.split("\n");
    const eventLine = lines.find((l) => l.startsWith("event: "));
    const dataLine = lines.find((l) => l.startsWith("data: "));
    if (eventLine && dataLine) {
      events.push({ event: eventLine.slice("event: ".length), data: JSON.parse(dataLine.slice("data: ".length)) });
    }
  }
  return { status, events };
}

describe("WP-AI1 §3：助手 module 權限", () => {
  let fx: Wp2Fixture;

  beforeAll(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
  });

  beforeEach(() => {
    setLlmClientForTests(fakeLlmReplying("你好，我係在勤 AI 助手。"));
  });
  afterEach(() => {
    setLlmClientForTests(undefined);
  });

  it("雞頭 → 403（硬性）", async () => {
    const cookie = await sessionCookieForUser(fx.userIds["雞頭"]);
    const res = await chatPost(chatRequest(cookie));
    expect(res.status).toBe(403);
  });

  it("保安員 → 403（硬性）", async () => {
    const cookie = await sessionCookieForUser(fx.userIds["安員"]);
    const res = await chatPost(chatRequest(cookie));
    expect(res.status).toBe(403);
  });

  it("老闆 → 200，攞到 SSE 回覆", async () => {
    const cookie = await sessionCookieForUser(fx.userIds["老闆"]);
    const res = await chatPost(chatRequest(cookie));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const { events } = await readSse(res);
    const done = events.find((e) => e.event === "done");
    expect(done).toBeTruthy();
    expect((done!.data as { text: string }).text).toContain("在勤 AI 助手");
  });

  it("主管 → 200（出廠有 助手:view）", async () => {
    const cookie = await sessionCookieForUser(fx.userIds["主管"]);
    const res = await chatPost(chatRequest(cookie));
    expect(res.status).toBe(200);
  });

  it("會計 → 200（出廠有 助手:view）", async () => {
    const cookie = await sessionCookieForUser(fx.userIds["會計"]);
    const res = await chatPost(chatRequest(cookie));
    expect(res.status).toBe(200);
  });

  it("未登入 → 401", async () => {
    const res = await chatPost(new Request("http://test.local/api/ai/chat", { method: "POST", body: JSON.stringify({ message: "hi" }) }));
    expect(res.status).toBe(401);
  });
});
