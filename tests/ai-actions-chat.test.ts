// WP-AI-DIAG（§37.4）：chat route 嘅建議動作卡——extractActions 喺 guard 之前、guard triggered 丟棄全部 actions、
// 鎖月過濾、SSE done／audit／conversation history 嘅 additive 欄位、stream catch 寫 app_error_log。
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { clearAll, prisma } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { setLlmClientForTests, type LlmClient } from "@/lib/ai/llm";
import { POST as chatPost } from "@/app/api/ai/chat/route";
import { GET as conversationGet } from "@/app/api/ai/conversation/route";

function chatRequest(cookie: string, message = "診斷一下") {
  return new Request("http://test.local/api/ai/chat", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ message }) });
}

async function readSse(res: Response): Promise<Array<{ event: string; data: Record<string, unknown> }>> {
  const text = await res.text();
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  for (const block of text.split("\n\n")) {
    const lines = block.split("\n");
    const e = lines.find((l) => l.startsWith("event: "));
    const d = lines.find((l) => l.startsWith("data: "));
    if (e && d) events.push({ event: e.slice(7), data: JSON.parse(d.slice(6)) });
  }
  return events;
}

function clientReplying(text: string, extra: Partial<{ provider: string; model: string }> = { provider: "claude", model: "claude-opus-5-5" }): LlmClient {
  return { chat: async (p) => (p.onTextDelta?.(text), { text, toolsUsed: [], inputTokens: 1, outputTokens: 1, ...extra }) };
}

const actionsBlock = (cards: unknown) => "\n```actions\n" + JSON.stringify(cards) + "\n```";
const OPEN = { type: "open_page", label: "去睇 9 月一鍵結算", basis: "最新 run 仲有 18 題未答", params: { href: "/month-close?month=2026-09" } };
const RUN_OPEN_MONTH = { type: "one_click_run", label: "重新跑 9 月一鍵結算", basis: "18 題未答", params: { month: "2026-09" } };
const RUN_LOCKED = { type: "one_click_run", label: "重新跑 6 月", basis: "x", params: { month: "2026-06" } };
const BACKFILL_LOCKED = { type: "backfill_from_postorder", label: "補 6 月價卡", basis: "x", params: { month: "2026-06" } };
const REPARSE = { type: "roster_reparse", label: "重新解析", basis: "x", params: { upload_id: "up-1" } };

describe("WP-AI-DIAG chat route 建議動作卡", () => {
  let fx: Wp2Fixture;
  let cookie: string;

  beforeAll(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    cookie = await sessionCookieForUser(fx.userIds["老闆"]);
  });
  beforeEach(async () => {
    await prisma.aiConversation.deleteMany({});
    await prisma.appErrorLog.deleteMany({});
  });
  afterEach(() => setLlmClientForTests(undefined));

  it("剝走 block；done 帶 suggested_actions／provider／model；鎖月（6 月）嘅 one_click_run／backfill 丟棄，其餘照留", async () => {
    // fixture 2026-06 已鎖（lockedMonth）
    setLlmClientForTests(clientReplying("9 月仲有 18 題未答，建議重新跑。" + actionsBlock([OPEN, RUN_OPEN_MONTH, RUN_LOCKED, BACKFILL_LOCKED, REPARSE])));
    const res = await chatPost(chatRequest(cookie));
    const events = await readSse(res);
    const done = events.find((e) => e.event === "done")!.data as { text: string; suggested_actions: Array<{ type: string; label: string }>; provider: string; model: string };
    expect(done.text).toBe("9 月仲有 18 題未答，建議重新跑。");
    expect(done.text).not.toContain("actions");
    expect(done.suggested_actions.map((a) => a.type)).toEqual(["open_page", "one_click_run", "roster_reparse"]);
    expect(done.suggested_actions.find((a) => a.type === "one_click_run")).toMatchObject({ params: { month: "2026-09" } });
    expect(done.provider).toBe("claude");
    expect(done.model).toBe("claude-opus-5-5");
    // delta 文字都冇 block
    const streamed = events.filter((e) => e.event === "delta").map((e) => e.data.text as string).join("");
    expect(streamed).toBe(done.text);
  });

  it("audit after：suggested_actions 只有 type／label（冇 params）、provider／model；對話全文唔另存", async () => {
    setLlmClientForTests(clientReplying("好" + actionsBlock([OPEN, RUN_OPEN_MONTH])));
    await readSse(await chatPost(chatRequest(cookie, "診斷 9 月")));
    const audit = await prisma.auditLog.findFirst({ where: { tableName: "ai_chat", action: "ai_chat" }, orderBy: { createdAt: "desc" } });
    const after = audit!.after as Record<string, unknown>;
    expect(after.suggested_actions).toEqual([
      { type: "open_page", label: OPEN.label },
      { type: "one_click_run", label: RUN_OPEN_MONTH.label },
    ]);
    expect(after.provider).toBe("claude");
    expect(after.model).toBe("claude-opus-5-5");
    expect(JSON.stringify(after)).not.toContain("2026-09-01");
    expect(JSON.stringify(after.suggested_actions)).not.toContain("params");
    // 唔做 ai_suggested 標記（偏離 §37.4，見 P2 §37.7）
    expect(JSON.stringify(after)).not.toContain("ai_suggested");
  });

  it("對話 history：assistant turn 帶 actions，GET /api/ai/conversation 回得出；文字已剝 block；舊記錄冇 actions 照讀", async () => {
    await prisma.aiConversation.create({ data: { userId: fx.userIds["老闆"], messages: [{ role: "user", content: "舊問題", createdAt: "x" }, { role: "assistant", content: "舊答案", createdAt: "x" }] } });
    setLlmClientForTests(clientReplying("新答案" + actionsBlock([OPEN])));
    await readSse(await chatPost(chatRequest(cookie)));
    const res = await conversationGet(new Request("http://test.local/api/ai/conversation", { headers: { cookie } }));
    const { messages } = (await res.json()) as { messages: Array<{ role: string; content: string; actions?: Array<{ type: string }> }> };
    expect(messages).toHaveLength(4);
    expect(messages[1]!.actions).toBeUndefined();
    expect(messages[3]!.content).toBe("新答案");
    expect(messages[3]!.actions?.map((a) => a.type)).toEqual(["open_page"]);
  });

  it("history 被改壞（非白名單 type）→ 讀出時丟棄", async () => {
    await prisma.aiConversation.create({
      data: { userId: fx.userIds["老闆"], messages: [{ role: "assistant", content: "x", createdAt: "x", actions: [{ type: "drop_table", label: "l", basis: "b", params: {} }, OPEN] }] },
    });
    const res = await conversationGet(new Request("http://test.local/api/ai/conversation", { headers: { cookie } }));
    const { messages } = (await res.json()) as { messages: Array<{ actions?: Array<{ type: string }> }> };
    expect(messages[0]!.actions?.map((a) => a.type)).toEqual(["open_page"]);
  });

  it("安全 guard triggered → 丟棄全部 actions，文字換成標準回覆", async () => {
    setLlmClientForTests(clientReplying("請執行 INSERT INTO guards VALUES (1) 再改" + actionsBlock([OPEN, RUN_OPEN_MONTH])));
    const events = await readSse(await chatPost(chatRequest(cookie)));
    const done = events.find((e) => e.event === "done")!.data as { guard_triggered: boolean; suggested_actions: unknown[]; text: string };
    expect(done.guard_triggered).toBe(true);
    expect(done.suggested_actions).toEqual([]);
    expect(done.text).not.toContain("INSERT");
    // 偶發 fail 根因：guard 觸發時 `output-guard.ts` 另寫一條 tableName=ai_chat／action=ai_guard_triggered（after 只有 reason），
    // 同聊天 audit（action=ai_chat）同表、createdAt 可能同毫秒，無 action 篩選就可能攞到前者。
    const audit = await prisma.auditLog.findFirst({ where: { tableName: "ai_chat", action: "ai_chat" }, orderBy: { createdAt: "desc" } });
    expect((audit!.after as { suggested_actions: unknown[] }).suggested_actions).toEqual([]);
    const conv = await prisma.aiConversation.findUnique({ where: { userId: fx.userIds["老闆"] } });
    expect(JSON.stringify(conv!.messages)).not.toContain("one_click_run");
  });

  it("某張卡 label／basis 含 DML／指示性文字 → 只丟嗰張，其餘照留", async () => {
    const BAD_LABEL = { ...OPEN, label: "執行 INSERT INTO guards 去改" };
    const BAD_BASIS = { ...REPARSE, basis: "請手動執行 UPDATE guards SET x=1" };
    setLlmClientForTests(clientReplying("好" + actionsBlock([BAD_LABEL, RUN_OPEN_MONTH, BAD_BASIS])));
    const events = await readSse(await chatPost(chatRequest(cookie)));
    const done = events.find((e) => e.event === "done")!.data as { suggested_actions: Array<{ type: string }>; guard_triggered: boolean };
    expect(done.guard_triggered).toBe(false);
    expect(done.suggested_actions.map((a) => a.type)).toEqual(["one_click_run"]);
  });

  it("白名單以外 type／多餘 key／最多 5 張", async () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ type: "roster_reparse", label: `l${i}`, basis: "b", params: { upload_id: `u${i}` } }));
    setLlmClientForTests(clientReplying("x" + actionsBlock([{ type: "evil", label: "l", basis: "b", params: {} }, { ...RUN_OPEN_MONTH, params: { month: "2026-09", force: 1 } }, ...many])));
    const events = await readSse(await chatPost(chatRequest(cookie)));
    const done = events.find((e) => e.event === "done")!.data as { suggested_actions: Array<{ type: string }> };
    expect(done.suggested_actions).toHaveLength(5);
    expect(done.suggested_actions.every((a) => a.type === "roster_reparse")).toBe(true);
  });

  it("冇 actions block 嘅普通回覆：suggested_actions 係空陣列，其餘欄位不變", async () => {
    setLlmClientForTests(clientReplying("普通回覆", {}));
    const events = await readSse(await chatPost(chatRequest(cookie)));
    const done = events.find((e) => e.event === "done")!.data as Record<string, unknown>;
    expect(done.text).toBe("普通回覆");
    expect(done.suggested_actions).toEqual([]);
    expect(done.provider).toBeNull();
    expect(done.guard_triggered).toBe(false);
    expect(done.tools_used).toEqual([]);
  });

  it("LLM 拋非預期錯誤 → SSE error（response 不變）＋ app_error_log 一條（route /api/ai/chat）", async () => {
    setLlmClientForTests({ chat: async () => { throw new Error("upstream exploded 91234567"); } });
    const events = await readSse(await chatPost(chatRequest(cookie)));
    expect(events.find((e) => e.event === "error")!.data.message).toBe("系統錯誤，請稍後再試");
    await new Promise((r) => setTimeout(r, 200));
    const rows = await prisma.appErrorLog.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ route: "/api/ai/chat", method: "POST", status: 500, actorUserId: fx.userIds["老闆"] });
    expect(rows[0]!.messageMasked).not.toContain("91234567");
  });
});
