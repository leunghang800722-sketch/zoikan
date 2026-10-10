// P3-5.3：兩條 chat route（`/api/ai/chat`、`/api/feedback/session/chat`）抽共用
// `src/lib/ai/chat-handler.ts` 之後，response（status／header／SSE 全文）要逐 byte
// 同重構前一樣。golden 係喺重構前嘅舊碼上錄低（`P3_5_UPDATE_GOLDEN=1 npx vitest run
// tests/p3-5-chat-sse.test.ts`），之後每次跑都逐字比對。全部用假 LLM，唔使真 key。
import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { setLlmClientForTests, LlmUnavailableError, type LlmClient } from "@/lib/ai/llm";
import { fakeLlmReplying } from "./fixtures/fake-llm";
import { POST as chatPost } from "@/app/api/ai/chat/route";
import { POST as sessionOpenPost } from "@/app/api/feedback/session/route";
import { POST as sessionChatPost } from "@/app/api/feedback/session/chat/route";

const GOLDEN_PATH = path.join(__dirname, "fixtures", "p3-5-chat-sse-golden.json");
const UPDATE = process.env.P3_5_UPDATE_GOLDEN === "1";
const golden: Record<string, { status: number; contentType: string | null; cacheControl: string | null; connection: string | null; body: string }> =
  !UPDATE && fs.existsSync(GOLDEN_PATH) ? JSON.parse(fs.readFileSync(GOLDEN_PATH, "utf8")) : {};
const recorded: typeof golden = {};

function post(url: string, cookie: string | null, body?: unknown) {
  return new Request(`http://test.local${url}`, {
    method: "POST",
    headers: { ...(cookie ? { cookie } : {}), "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function snapshot(name: string, res: Response) {
  const snap = {
    status: res.status,
    contentType: res.headers.get("content-type"),
    cacheControl: res.headers.get("cache-control"),
    connection: res.headers.get("connection"),
    body: await res.text(),
  };
  if (UPDATE) {
    recorded[name] = snap;
  } else {
    expect(golden[name], `golden 缺 ${name}`).toBeTruthy();
    expect(snap).toEqual(golden[name]);
  }
}

function throwingLlm(err: unknown): LlmClient {
  return {
    async chat() {
      throw err;
    },
  } as LlmClient;
}

const LONG_REPLY = "好的，呢個月嘅更數同上個月比較，主要分別喺於新增咗兩個盤，而且有三位保安員轉咗長工，所以整體人手分佈有啲變化，建議你去月結頁睇下詳細數字。".repeat(2);

describe("P3-5.3：chat route SSE 逐 byte 對照 golden", () => {
  let fx: Wp2Fixture;
  let bossCookie: string;
  let sessionId: string;

  beforeAll(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    bossCookie = await sessionCookieForUser(fx.userIds["老闆"]);
    const openRes = await sessionOpenPost(post("/api/feedback/session", bossCookie, {}));
    sessionId = ((await openRes.json()) as { id: string }).id;
  });
  beforeEach(() => setLlmClientForTests(undefined));
  afterEach(() => setLlmClientForTests(undefined));

  it("ai/chat：一般回覆", async () => {
    setLlmClientForTests(fakeLlmReplying("你好，我係在勤 AI 助手。"));
    await snapshot("ai-basic", await chatPost(post("/api/ai/chat", bossCookie, { message: "你好" })));
  });
  it("ai/chat：長回覆（多於一個 SSE chunk）", async () => {
    setLlmClientForTests(fakeLlmReplying(LONG_REPLY));
    await snapshot("ai-long", await chatPost(post("/api/ai/chat", bossCookie, { message: "點解" })));
  });
  it("ai/chat：空白回覆 → fallback 文字", async () => {
    setLlmClientForTests(fakeLlmReplying("   "));
    await snapshot("ai-empty", await chatPost(post("/api/ai/chat", bossCookie, { message: "hello" })));
  });
  it("ai/chat：輸出 guard 觸發（DML）", async () => {
    setLlmClientForTests(fakeLlmReplying("你可以直接執行 DELETE FROM guards WHERE 1=1; 嚟清走資料。"));
    await snapshot("ai-guard", await chatPost(post("/api/ai/chat", bossCookie, { message: "點樣清資料" })));
  });
  it("ai/chat：LLM 拋 LlmUnavailableError → SSE error", async () => {
    setLlmClientForTests(throwingLlm(new LlmUnavailableError("AI 服務暫時用唔到")));
    await snapshot("ai-unavailable", await chatPost(post("/api/ai/chat", bossCookie, { message: "hi" })));
  });
  it("ai/chat：LLM 拋一般 Error → SSE error（系統錯誤）", async () => {
    setLlmClientForTests(throwingLlm(new Error("boom")));
    await snapshot("ai-error", await chatPost(post("/api/ai/chat", bossCookie, { message: "hi" })));
  });
  it("ai/chat：未登入 401／空問題 400／未知欄位 400", async () => {
    await snapshot("ai-401", await chatPost(post("/api/ai/chat", null, { message: "hi" })));
    await snapshot("ai-400-empty", await chatPost(post("/api/ai/chat", bossCookie, { message: "" })));
    await snapshot("ai-400-strict", await chatPost(post("/api/ai/chat", bossCookie, { message: "hi", extra: 1 })));
  });

  it("feedback/chat：一般回覆", async () => {
    setLlmClientForTests(fakeLlmReplying("明白，仲有咩想補充？"));
    await snapshot("fb-basic", await sessionChatPost(post("/api/feedback/session/chat", bossCookie, { session_id: sessionId, message: "手機版撳格好細" })));
  });
  it("feedback/chat：長回覆", async () => {
    setLlmClientForTests(fakeLlmReplying(LONG_REPLY));
    await snapshot("fb-long", await sessionChatPost(post("/api/feedback/session/chat", bossCookie, { session_id: sessionId, message: "仲有" })));
  });
  it("feedback/chat：空白回覆 → fallback 文字", async () => {
    setLlmClientForTests(fakeLlmReplying(""));
    await snapshot("fb-empty", await sessionChatPost(post("/api/feedback/session/chat", bossCookie, { session_id: sessionId, message: "再講" })));
  });
  it("feedback/chat：輸出 guard 觸發（DML）", async () => {
    setLlmClientForTests(fakeLlmReplying("你可以直接執行 DROP TABLE guards; 嚟處理。"));
    await snapshot("fb-guard", await sessionChatPost(post("/api/feedback/session/chat", bossCookie, { session_id: sessionId, message: "點做" })));
  });
  it("feedback/chat：可行性 guard 觸發", async () => {
    setLlmClientForTests(fakeLlmReplying("呢個功能技術上好易做，大概兩日就可以完成，冇問題。"));
    await snapshot("fb-feasibility", await sessionChatPost(post("/api/feedback/session/chat", bossCookie, { session_id: sessionId, message: "可唔可以做到" })));
  });
  it("feedback/chat：LLM 錯誤 → SSE error", async () => {
    setLlmClientForTests(throwingLlm(new LlmUnavailableError("AI 服務暫時用唔到")));
    await snapshot("fb-unavailable", await sessionChatPost(post("/api/feedback/session/chat", bossCookie, { session_id: sessionId, message: "hi" })));
    setLlmClientForTests(throwingLlm(new Error("boom")));
    await snapshot("fb-error", await sessionChatPost(post("/api/feedback/session/chat", bossCookie, { session_id: sessionId, message: "hi" })));
  });
  it("feedback/chat：未登入 401／session 不存在 404／空問題 400", async () => {
    await snapshot("fb-401", await sessionChatPost(post("/api/feedback/session/chat", null, { session_id: sessionId, message: "hi" })));
    await snapshot("fb-404", await sessionChatPost(post("/api/feedback/session/chat", bossCookie, { session_id: "00000000-0000-4000-8000-000000000000", message: "hi" })));
    await snapshot("fb-400", await sessionChatPost(post("/api/feedback/session/chat", bossCookie, { session_id: sessionId, message: "" })));
  });

  it("（錄 golden 用）", () => {
    if (UPDATE) fs.writeFileSync(GOLDEN_PATH, JSON.stringify(recorded, null, 2) + "\n");
    expect(true).toBe(true);
  });
});
