// W1：第 1 層解析（fake LLM，唔打真 API）。schema 嚴格解析、壞 JSON、question_only、結構化參數、後備 chain、私隱（唔傳名單）。
import { describe, it, expect, vi, afterEach } from "vitest";
import { parseMessage, parseModelText, buildUserMessage, WA_SYSTEM_PROMPT, WA_LLM_MAX_TOKENS } from "@/lib/whatsapp/parse";
import { LlmUnavailableError, AnthropicLlmClient, getLlmClient, setLlmClientForTests, type LlmClient, type LlmChatParams, type LlmChatResult } from "@/lib/ai/llm";
import { DeepSeekLlmClient } from "@/lib/ai/providers/deepseek";

const TS = new Date("2026-10-16T05:00:00Z");
const INPUT = { text: "我聽日18號病假，返唔到", ts: TS, groupKind: "site", shiftTable: [{ code: "A", label: "早更", time: "07:00-15:00" }], wordMap: { 早: "A" }, quotedText: null };

function stub(text: string | (() => string), seen?: LlmChatParams[]): LlmClient {
  return {
    async chat(params: LlmChatParams): Promise<LlmChatResult> {
      seen?.push(params);
      return { text: typeof text === "function" ? text() : text, toolsUsed: [], inputTokens: 123, outputTokens: 45, provider: "fake", model: "fake-m" };
    },
  };
}
const VALID = JSON.stringify({
  noise: false,
  intents: [{ type: "leave", date: { raw: "聽日18號", kind: "absolute", iso_guess: "2026-10-17", to_iso_guess: null }, site_raw: null, persons: [], self_reference: true, shift_raw: null, shift_code_guess: null, hours: null, leave_raw: "病假", leave_code_guess: "SL", confidence: 0.9, evidence: "聽日18號病假" }],
});

afterEach(() => {
  setLlmClientForTests(undefined);
  delete process.env.AI_LLM;
});

describe("W1 parse：schema 嚴格解析", () => {
  it("合法輸出", () => {
    const r = parseModelText(VALID);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.output.intents[0]).toMatchObject({ type: "leave", self_reference: true, persons: [] });
  });
  it("```json 圍欄都接受", () => {
    expect(parseModelText("```json\n" + VALID + "\n```").ok).toBe(true);
  });
  it("壞 JSON → bad_json", () => {
    expect(parseModelText("{noise:true")).toEqual({ ok: false, error: "bad_json" });
    expect(parseModelText("")).toEqual({ ok: false, error: "bad_json" });
    expect(parseModelText("好呀，我幫你睇")).toEqual({ ok: false, error: "bad_json" });
  });
  it("多餘欄位／缺 confidence／type 非法／信心超界 → bad_schema（strict）", () => {
    const o = JSON.parse(VALID);
    expect(parseModelText(JSON.stringify({ ...o, extra: 1 }))).toEqual({ ok: false, error: "bad_schema" });
    const i = o.intents[0];
    const mkr = (x: unknown) => parseModelText(JSON.stringify({ noise: false, intents: [x] }));
    expect(mkr({ ...i, surprise: "x" })).toEqual({ ok: false, error: "bad_schema" });
    const { confidence: _c, ...noConf } = i; // eslint-disable-line @typescript-eslint/no-unused-vars
    expect(mkr(noConf)).toEqual({ ok: false, error: "bad_schema" });
    expect(mkr({ ...i, type: "transfer" })).toEqual({ ok: false, error: "bad_schema" });
    expect(mkr({ ...i, confidence: 1.5 })).toEqual({ ok: false, error: "bad_schema" });
    expect(mkr({ ...i, persons: [{ raw: "測試甲", role: "boss" }] })).toEqual({ ok: false, error: "bad_schema" });
  });
  it("noise=true／intents 空；question_only 類型", () => {
    expect(parseModelText('{"noise":true,"intents":[]}')).toMatchObject({ ok: true });
    const q = parseModelText(JSON.stringify({ noise: false, intents: [{ type: "question_only", confidence: 0.8 }] }));
    expect(q.ok).toBe(true);
    if (q.ok) expect(q.output.intents[0]).toMatchObject({ type: "question_only", persons: [], self_reference: false });
  });
});

describe("W1 parse：parseMessage（fake LLM）", () => {
  it("結構化參數：json_object、上限 2000、temperature 0、reasoning low；唔帶工具／歷史", async () => {
    const seen: LlmChatParams[] = [];
    const r = await parseMessage(INPUT, [stub(VALID, seen)]);
    expect(r.ok).toBe(true);
    expect(r.usage).toEqual({ provider: "fake", model: "fake-m", tokensIn: 123, tokensOut: 45 });
    expect(seen[0]!.structured).toEqual({ format: "json_object", maxTokens: 2000, temperature: 0, reasoningEffort: "low" });
    expect(WA_LLM_MAX_TOKENS).toBe(2000);
    expect(seen[0]!.tools).toEqual([]);
    expect(seen[0]!.history).toEqual([]);
  });
  it("壞 JSON → ok:false，唔拋錯，usage 照記", async () => {
    const r = await parseMessage(INPUT, [stub("不是 JSON")]);
    expect(r).toMatchObject({ ok: false, error: "bad_json" });
    expect(r.usage.tokensOut).toBe(45);
  });
  it("question_only 輸出", async () => {
    const r = await parseMessage({ ...INPUT, text: "邊個返聽日？" }, [stub(JSON.stringify({ noise: false, intents: [{ type: "question_only", confidence: 0.9 }] }))]);
    expect(r.ok && r.output.intents[0]!.type).toBe("question_only");
  });
  it("後備 chain：第一個 LlmUnavailable → 用第二個；其他錯誤照拋", async () => {
    const down: LlmClient = { chat: async () => { throw new LlmUnavailableError(); } };
    const r = await parseMessage(INPUT, [down, stub(VALID)]);
    expect(r.ok).toBe(true);
    const boom: LlmClient = { chat: async () => { throw new Error("boom"); } };
    await expect(parseMessage(INPUT, [boom, stub(VALID)])).rejects.toThrow("boom");
    await expect(parseMessage(INPUT, [down])).rejects.toBeInstanceOf(LlmUnavailableError);
  });
});

describe("W1 parse：私隱（唔傳保安員名單）", () => {
  it("user message 只含訊息原文＋更碼表＋口語對照＋時間，冇其他欄位", () => {
    const m = JSON.parse(buildUserMessage({ ...INPUT, quotedText: "被回覆文字" }));
    expect(Object.keys(m).sort()).toEqual(["group_kind", "message_time_hk", "quoted_text", "shift_table", "shift_words", "text"]);
    expect(m.message_time_hk).toContain("2026-10-16 13:00");
    expect(m.message_time_hk).toContain("星期五");
  });
  it("system prompt 用合成例子（測試甲／乙），冇 8 位電話、冇 HKID", () => {
    expect(WA_SYSTEM_PROMPT).toContain("測試甲");
    expect(WA_SYSTEM_PROMPT).not.toMatch(/(?<!\d)\d{8}(?!\d)/);
    expect(WA_SYSTEM_PROMPT).not.toMatch(/[A-Z]{1,2}\d{6}\(?[0-9A]\)?/);
  });
  it("超長訊息截斷（1500 字）", () => {
    const m = JSON.parse(buildUserMessage({ ...INPUT, text: "字".repeat(5000) }));
    expect(m.text.length).toBe(1500);
  });
});

describe("W1 parse：provider 結構化模式（additive，原有行為不變）", () => {
  it("DeepSeek：response_format json_object＋temperature 0＋reasoning_effort low＋max_tokens 2000，冇 tools", async () => {
    const create = vi.fn(async () => ({ choices: [{ message: { content: VALID } }], usage: { prompt_tokens: 100, completion_tokens: 30 } }));
    const c = new DeepSeekLlmClient({ client: { chat: { completions: { create } } } as never, model: "deepseek-test" });
    const r = await parseMessage(INPUT, [c]);
    expect(r.ok).toBe(true);
    expect(r.usage).toEqual({ provider: "deepseek", model: "deepseek-test", tokensIn: 100, tokensOut: 30 });
    const body = (create.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(body).toMatchObject({ model: "deepseek-test", max_tokens: 2000, temperature: 0, reasoning_effort: "low", response_format: { type: "json_object" } });
    expect(body).not.toHaveProperty("tools");
    expect((body.messages as Array<{ role: string }>).map((m) => m.role)).toEqual(["system", "user"]);
  });
  it("Claude：單次 messages.create（max_tokens 2000，唔傳 temperature／thinking／tools）", async () => {
    const create = vi.fn(async () => ({ content: [{ type: "text", text: VALID }], usage: { input_tokens: 80, output_tokens: 20 } }));
    const c = new AnthropicLlmClient({ auth: "api-key", apiKey: "fake-claude-key", model: "claude-test" });
    (c as unknown as { client: unknown }).client = { messages: { create } };
    const r = await parseMessage(INPUT, [c]);
    expect(r.ok).toBe(true);
    expect(r.usage).toEqual({ provider: "claude", model: "claude-test", tokensIn: 80, tokensOut: 20 });
    const body = (create.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(body).toMatchObject({ model: "claude-test", max_tokens: 2000 });
    for (const k of ["temperature", "thinking", "tools"]) expect(body).not.toHaveProperty(k);
  });
  it("AI_LLM=fake 嘅開發假 client：結構化模式回純雜訊 JSON（唔冒充業務數據）", async () => {
    process.env.AI_LLM = "fake";
    setLlmClientForTests(undefined);
    const c = getLlmClient();
    const r = await parseMessage(INPUT, [c]);
    expect(r.ok && r.output).toEqual({ noise: true, intents: [] });
  });
});
