// WP-OCR-CLAUDE §36：Claude 讀 A＋DeepSeek 讀 B、Claude 失敗退回 DeepSeek、供應商選擇、route 新欄位。
// 全部 mock（唔打真 Anthropic／DeepSeek API）；合成資料。
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { ClaudeVisionClient, anthropicClientOptions, ocrJsonSchema, splitDataUrl } from "@/lib/guards/ocr/claude-vision-client";
import { OcrUnavailableError, setVisionClientForTests, type VisionClient, type VisionRequest } from "@/lib/guards/ocr/vision-client";
import { readDocument } from "@/lib/guards/ocr/read";
import { OCR_CLAUDE_MAX_OUTPUT_TOKENS, OCR_MAX_OUTPUT_TOKENS, effectiveOcrProvider, isGuardOcrConfigured, ocrClaudeModel } from "@/lib/guards/ocr/config";
import { selftestFailLine } from "@/lib/guards/ocr/selftest-log";
import { getReadClients, type ReadClients } from "@/lib/guards/ocr/clients";
import { POST as ocrRoute } from "@/app/api/guards/ocr/read/route";

const IMG = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD";
const STD = { name_zh: "陳大文", name_en: "CHAN, Tai Man", hkid: "A123456(3)", dob: "15-03-1988", sex: "M" };

const claudeMsg = (over: Record<string, unknown> = {}) => ({ id: "m", type: "message", role: "assistant", model: "x", content: [{ type: "text", text: JSON.stringify(STD) }], stop_reason: "end_turn", usage: { input_tokens: 2100, output_tokens: 90 }, ...over });
const mkClaude = (create: ReturnType<typeof vi.fn>) => new ClaudeVisionClient({ client: { messages: { create } } as never });

function fake(provider: "claude" | "deepseek", opts: { fail?: Error; json?: Record<string, unknown> } = {}) {
  const calls: VisionRequest[] = [];
  const client: VisionClient = {
    model: `fake-${provider}`,
    provider,
    async complete(req) {
      calls.push(req);
      if (opts.fail) throw opts.fail;
      return { text: JSON.stringify(opts.json ?? STD), promptTokens: 1000, completionTokens: 50 };
    },
  };
  return { client, calls };
}
const IMGS = { full: IMG, tiles: [IMG, IMG, IMG, IMG] };

describe("ClaudeVisionClient：請求形狀＋回應處理", () => {
  it("請求：官方 SDK 形狀、structured output、effort low、冇 temperature／thinking；圖片 base64 block 只喺 user；system 純文字", async () => {
    const create = vi.fn().mockResolvedValue(claudeMsg());
    const c = mkClaude(create);
    const r = await c.complete({ system: "SYS", userText: "U", images: [IMG, IMG + "2"], fields: ["hkid", "dob"] });
    expect(r).toEqual({ text: JSON.stringify(STD), promptTokens: 2100, completionTokens: 90, truncated: false });
    const req = create.mock.calls[0]![0];
    expect(req.model).toBe("claude-opus-5-5");
    expect(req.max_tokens).toBe(8000);
    expect(OCR_CLAUDE_MAX_OUTPUT_TOKENS).toBe(8000);
    expect(OCR_MAX_OUTPUT_TOKENS).toBe(1500);
    expect(req.system).toBe("SYS");
    expect(req.output_config.effort).toBe("low");
    expect(req.output_config.format).toEqual({ type: "json_schema", schema: ocrJsonSchema(["hkid", "dob"]) });
    expect(req).not.toHaveProperty("temperature");
    expect(req).not.toHaveProperty("thinking");
    expect(req.messages).toHaveLength(1);
    expect(req.messages[0].role).toBe("user");
    expect(req.messages[0].content).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "/9j/4AAQSkZJRgABAQAAAQABAAD" } },
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "/9j/4AAQSkZJRgABAQAAAQABAAD2" } },
      { type: "text", text: "U" },
    ]);
    expect(JSON.stringify(req.system)).not.toContain("base64");
  });
  it("structured output schema：全部 required、禁多餘 key、欄位可為 string／null", () => {
    const s = ocrJsonSchema(["hkid", "dob"]);
    expect(s.required).toEqual(["hkid", "dob"]);
    expect(s.additionalProperties).toBe(false);
    expect(s.properties.hkid).toEqual({ anyOf: [{ type: "string" }, { type: "null" }] });
  });
  it("structured output 回應文字經現有解析器得出欄位（readDocument 一致 → confirmed）", async () => {
    const claude = mkClaude(vi.fn().mockResolvedValue(claudeMsg()));
    const ds = fake("deepseek");
    const r = await readDocument({ a: claude, b: ds.client }, "id_card", IMGS);
    expect(r.fields.hkid).toMatchObject({ status: "confirmed", value: "A123456(3)" });
    expect(r.provider_used).toEqual({ a: "claude", b: "deepseek" });
    expect(r.fallback_reason).toBeNull();
    expect(r.usage_by_provider.claude).toEqual({ promptTokens: 2100, completionTokens: 90, calls: 1 });
    expect(r.usage_by_provider.deepseek.calls).toBe(1);
  });
  it("model 預設 claude-opus-5-5，可由 GUARD_OCR_CLAUDE_MODEL 覆蓋", () => {
    const prev = process.env.GUARD_OCR_CLAUDE_MODEL;
    delete process.env.GUARD_OCR_CLAUDE_MODEL;
    expect(ocrClaudeModel()).toBe("claude-opus-5-5");
    process.env.GUARD_OCR_CLAUDE_MODEL = "claude-x";
    expect(mkClaude(vi.fn()).model).toBe("claude-x");
    if (prev === undefined) delete process.env.GUARD_OCR_CLAUDE_MODEL;
    else process.env.GUARD_OCR_CLAUDE_MODEL = prev;
  });
  it("stop_reason refusal／max_tokens → OcrUnavailableError（帶固定 reason）", async () => {
    await expect(mkClaude(vi.fn().mockResolvedValue(claudeMsg({ stop_reason: "refusal", stop_details: { type: "refusal" } }))).complete({ system: "s", userText: "u", images: [IMG] })).rejects.toMatchObject({ name: "OcrUnavailableError", reason: "refusal" });
    await expect(mkClaude(vi.fn().mockResolvedValue(claudeMsg({ stop_reason: "max_tokens" }))).complete({ system: "s", userText: "u", images: [IMG] })).rejects.toMatchObject({ name: "OcrUnavailableError", reason: "max_tokens" });
  });
  it("SDK 錯誤型別映射：401／429／500／連線／超時 → OcrUnavailableError；其他錯誤原樣拋", async () => {
    const h = new Headers();
    const errs: [Error, number | null, string][] = [
      [new Anthropic.AuthenticationError(401, {}, "x", h), 401, "auth"],
      [new Anthropic.RateLimitError(429, {}, "x", h), 429, "rate_limit"],
      [new Anthropic.InternalServerError(500, {}, "x", h), 500, "api_error"],
      [new Anthropic.APIConnectionError({ message: "x" }), null, "connection"],
      [new Anthropic.APIConnectionTimeoutError(), null, "connection"],
    ];
    for (const [e, status, reason] of errs) {
      const err = await mkClaude(vi.fn().mockRejectedValue(e)).complete({ system: "s", userText: "u", images: [IMG] }).catch((x) => x);
      expect(err).toBeInstanceOf(OcrUnavailableError);
      expect(err).toMatchObject({ status, reason });
    }
    const bug = new TypeError("bug");
    await expect(mkClaude(vi.fn().mockRejectedValue(bug)).complete({ system: "s", userText: "u", images: [IMG] })).rejects.toBe(bug);
  });
  it("splitDataUrl：拆 media_type＋base64；非 JPEG data URL 拒絕", () => {
    expect(splitDataUrl(IMG)).toEqual({ mediaType: "image/jpeg", data: "/9j/4AAQSkZJRgABAQAAAQABAAD" });
    expect(() => splitDataUrl("data:image/png;base64,AAAA")).toThrow(OcrUnavailableError);
  });
  it("SDK client 設定：log 關、唔重試、60 秒 timeout；冇 key 又冇注入 → OcrUnavailableError", () => {
    expect(anthropicClientOptions("k", 60_000)).toEqual({ apiKey: "k", baseURL: "https://api.anthropic.com", authToken: null, timeout: 60_000, maxRetries: 0, logLevel: "off" });
    // 真 SDK 構造：環境變數 ANTHROPIC_BASE_URL／ANTHROPIC_AUTH_TOKEN 唔會生效
    const pb = process.env.ANTHROPIC_BASE_URL, pt = process.env.ANTHROPIC_AUTH_TOKEN;
    process.env.ANTHROPIC_BASE_URL = "https://evil.example";
    process.env.ANTHROPIC_AUTH_TOKEN = "tok-not-real";
    const sdk = new Anthropic(anthropicClientOptions("k", 60_000));
    expect(sdk.baseURL).toBe("https://api.anthropic.com");
    expect(sdk.authToken).toBeNull();
    if (pb === undefined) delete process.env.ANTHROPIC_BASE_URL; else process.env.ANTHROPIC_BASE_URL = pb;
    if (pt === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN; else process.env.ANTHROPIC_AUTH_TOKEN = pt;
    const prev = process.env.CLAUDE_API_KEY;
    delete process.env.CLAUDE_API_KEY;
    expect(() => new ClaudeVisionClient()).toThrow(OcrUnavailableError);
    if (prev !== undefined) process.env.CLAUDE_API_KEY = prev;
  });
});

describe("自檢 fail log：API error.type／error.message", () => {
  const body = (message: string) => ({ type: "error", error: { type: "permission_error", message } });
  const run = async (status: number, message: string) => {
    const e = new Anthropic.APIError(status, body(message), message, new Headers());
    const err = await mkClaude(vi.fn().mockRejectedValue(e)).complete({ system: "s", userText: "u", images: [IMG] }).catch((x) => x);
    return selftestFailLine("claude", "claude-opus-5-5", 67, err);
  };
  it("403 permission_error → error_type＋error_message（去換行、截 200 字）", async () => {
    const line = await run(403, "Your org\nis not allowed to use this model. ".repeat(10));
    expect(line).toContain("provider=claude model=claude-opus-5-5 ms=67");
    expect(line).toContain("status=403 error_type=permission_error error_message=\"Your org is not allowed");
    expect(line).not.toContain("\n");
    expect(/error_message="([^"]*)"/.exec(line)![1]!.length).toBeLessThanOrEqual(200);
    expect(await run(403, "Model not enabled for this workspace.")).toContain('error_type=permission_error error_message="Model not enabled for this workspace."');
  });
  it("訊息含 sk-ant → [redacted]", async () => {
    const line = await run(401, "invalid x-api-key sk-ant-api03-xxxx");
    expect(line).toContain('error_message="[redacted]"');
    expect(line).not.toContain("sk-ant");
  });
  it("5xx 唔帶 message；audit／route 用嘅 reason 欄不變", async () => {
    const line = await run(500, "internal detail");
    expect(line).not.toContain("error_message");
    expect(line).toContain("reason=api_error");
  });
});

describe("readDocument：Claude 失敗退回 DeepSeek", () => {
  const h = new Headers();
  const failures: [string, Error][] = [
    ["429", new Anthropic.RateLimitError(429, {}, "x", h)],
    ["500", new Anthropic.InternalServerError(500, {}, "x", h)],
    ["連線錯誤", new Anthropic.APIConnectionError({ message: "x" })],
    ["refusal", new OcrUnavailableError(null, "refusal")],
    ["max_tokens", new OcrUnavailableError(null, "max_tokens")],
  ];
  for (const [label, e] of failures) {
    it(`Claude ${label} → 讀 A 改用 DeepSeek（兩邊 DeepSeek），結果照出`, async () => {
      const create = vi.fn().mockRejectedValue(e instanceof OcrUnavailableError ? e : e);
      // refusal／max_tokens 經真 ClaudeVisionClient 行一次；其餘 SDK error 一樣
      const claude: VisionClient = e instanceof OcrUnavailableError
        ? mkClaude(vi.fn().mockResolvedValue(claudeMsg({ stop_reason: e.reason === "refusal" ? "refusal" : "max_tokens" })))
        : mkClaude(create);
      const dsA = fake("deepseek");
      const dsB = fake("deepseek");
      const clients: ReadClients = { a: claude, b: dsB.client, fallbackA: dsA.client };
      const r = await readDocument(clients, "id_card", IMGS);
      expect(r.provider_used).toEqual({ a: "deepseek", b: "deepseek" });
      expect(r.fallback_reason).toBeTruthy();
      expect(dsA.calls).toHaveLength(1);
      expect(dsA.calls[0]!.images).toEqual([IMG]); // 同一個讀 A 請求（全圖）
      expect(r.fields.hkid).toMatchObject({ status: "confirmed" });
      expect(r.usage_by_provider.claude.calls).toBe(0);
      expect(r.usage_by_provider.deepseek.calls).toBe(2);
    });
  }
  it("Claude end_turn 但 JSON 解析失敗＋有後備 → DeepSeek 重讀（fallback_reason=parse）；冇後備就照舊 unclear", async () => {
    const claude = mkClaude(vi.fn().mockResolvedValue(claudeMsg({ content: [{ type: "text", text: "not json" }] })));
    const dsA = fake("deepseek");
    const r = await readDocument({ a: claude, b: fake("deepseek").client, fallbackA: dsA.client }, "id_card", IMGS);
    expect(r.fallback_reason).toBe("parse");
    expect(r.provider_used.a).toBe("deepseek");
    expect(dsA.calls).toHaveLength(1);
    expect(r.fields.hkid).toMatchObject({ status: "confirmed" });
    const r2 = await readDocument({ a: claude, b: fake("deepseek").client }, "id_card", IMGS);
    expect(r2.fallback_reason).toBeNull();
    expect(r2.parse_ok.a).toBe(false);
  });
  it("錯誤帶 SDK error.type（只類型）", async () => {
    const e = new Anthropic.APIError(400, { type: "error", error: { type: "invalid_request_error", message: "SECRET-BODY" } }, "SECRET-BODY", new Headers());
    const err = await mkClaude(vi.fn().mockRejectedValue(e)).complete({ system: "s", userText: "u", images: [IMG] }).catch((x) => x);
    expect(err).toBeInstanceOf(OcrUnavailableError);
    expect(err.errorType === null || err.errorType === "invalid_request_error").toBe(true);
    expect(JSON.stringify(err.message)).not.toContain("SECRET");
  });
  it("Claude 同 DeepSeek 讀到唔一致 → review（兩個候選都回）", async () => {
    const r = await readDocument({ a: fake("claude").client, b: fake("deepseek", { json: { ...STD, hkid: "A123456(8)" } }).client }, "id_card", IMGS);
    expect(r.fields.hkid).toMatchObject({ status: "review", candidates: ["A123456(3)", "A123456(8)"] });
  });
  it("Claude 同後備都失敗 → 拋 OcrUnavailableError（route 回 503）；冇後備（provider=claude）Claude 失敗亦拋", async () => {
    const bad = new OcrUnavailableError(429, "rate_limit");
    await expect(readDocument({ a: fake("claude", { fail: bad }).client, b: fake("deepseek").client, fallbackA: fake("deepseek", { fail: new OcrUnavailableError(500) }).client }, "id_card", IMGS)).rejects.toBeInstanceOf(OcrUnavailableError);
    await expect(readDocument({ a: fake("claude", { fail: bad }).client, b: fake("claude").client }, "id_card", IMGS)).rejects.toBeInstanceOf(OcrUnavailableError);
  });
  it("DeepSeek（讀 B）失敗 → 照拋；非 OcrUnavailableError（bug）唔觸發退回", async () => {
    await expect(readDocument({ a: fake("claude").client, b: fake("deepseek", { fail: new OcrUnavailableError(503) }).client, fallbackA: fake("deepseek").client }, "id_card", IMGS)).rejects.toBeInstanceOf(OcrUnavailableError);
    const fb = fake("deepseek");
    await expect(readDocument({ a: fake("claude", { fail: new TypeError("bug") }).client, b: fake("deepseek").client, fallbackA: fb.client }, "id_card", IMGS)).rejects.toBeInstanceOf(TypeError);
    expect(fb.calls).toHaveLength(0);
  });
  it("單一 client（舊簽名）照用，provider 標籤預設 deepseek", async () => {
    const r = await readDocument(fake("deepseek").client, "id_card", IMGS);
    expect(r.provider_used).toEqual({ a: "deepseek", b: "deepseek" });
  });
});

describe("供應商選擇（config／getReadClients）", () => {
  const keys = ["CLAUDE_API_KEY", "DEEPSEEK_API_KEY", "GUARD_OCR_PROVIDER"] as const;
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => { for (const k of keys) { saved[k] = process.env[k]; delete process.env[k]; } });
  afterEach(() => { for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } setVisionClientForTests(null); });

  it("預設 claude+deepseek；冇 CLAUDE_API_KEY → deepseek；冇 DEEPSEEK_API_KEY → claude；兩個都冇 → null／未啟用", () => {
    expect(effectiveOcrProvider()).toBeNull();
    expect(isGuardOcrConfigured()).toBe(false);
    process.env.DEEPSEEK_API_KEY = "d";
    expect(effectiveOcrProvider()).toBe("deepseek");
    process.env.CLAUDE_API_KEY = "c";
    expect(effectiveOcrProvider()).toBe("claude+deepseek");
    delete process.env.DEEPSEEK_API_KEY;
    expect(effectiveOcrProvider()).toBe("claude");
    expect(isGuardOcrConfigured()).toBe(true);
  });
  it("GUARD_OCR_PROVIDER 明確指定；claude 但冇 key → deepseek；唔認得嘅值當預設", () => {
    process.env.DEEPSEEK_API_KEY = "d";
    process.env.GUARD_OCR_PROVIDER = "claude";
    expect(effectiveOcrProvider()).toBe("deepseek"); // 冇 CLAUDE_API_KEY
    process.env.CLAUDE_API_KEY = "c";
    expect(effectiveOcrProvider()).toBe("claude");
    process.env.GUARD_OCR_PROVIDER = "deepseek";
    expect(effectiveOcrProvider()).toBe("deepseek");
    process.env.GUARD_OCR_PROVIDER = "nonsense";
    expect(effectiveOcrProvider()).toBe("claude+deepseek");
  });
  it("getReadClients：claude+deepseek → A Claude／B DeepSeek／後備 DeepSeek；deepseek → 兩邊 DeepSeek；冇 key → OcrUnavailableError", () => {
    expect(() => getReadClients()).toThrow(OcrUnavailableError);
    process.env.DEEPSEEK_API_KEY = "d";
    let c = getReadClients();
    expect([c.a.provider, c.b.provider, c.fallbackA]).toEqual(["deepseek", "deepseek", undefined]);
    process.env.CLAUDE_API_KEY = "c";
    c = getReadClients();
    expect([c.a.provider, c.a.model, c.b.provider, c.fallbackA?.provider]).toEqual(["claude", "claude-opus-5-5", "deepseek", "deepseek"]);
  });
});

describe("POST /api/guards/ocr/read：provider_used", () => {
  let fx: Wp2Fixture;
  let owner: string;
  const savedDs = process.env.DEEPSEEK_API_KEY;
  beforeEach(async () => {
    process.env.DEEPSEEK_API_KEY = "test-ds-not-real"; // 啟用 route（getReadClients 另行 mock）
    await clearAll();
    await prisma.triageQuestion.deleteMany({});
    await prisma.triageSession.deleteMany({});
    fx = await seedWp2Fixture();
    owner = await sessionCookieForUser(fx.userIds["老闆"]);
  });
  afterEach(() => { setVisionClientForTests(null); vi.restoreAllMocks(); if (savedDs === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = savedDs; delete process.env.CLAUDE_API_KEY; });
  const call = (docs: unknown) => ocrRoute(new Request("http://t/api/guards/ocr/read", { method: "POST", headers: { "content-type": "application/json", cookie: owner }, body: JSON.stringify({ documents: docs }) }));
  const doc = { type: "id_card", full: IMG, tiles: [IMG, IMG] };

  it("注入 fake（舊路徑）：回應多 provider_used／models_used／usage_by_provider；舊欄位不變；冇圖冇值", async () => {
    setVisionClientForTests(fake("deepseek").client);
    const j = await (await call([doc])).json();
    expect(j.usage).toEqual({ prompt_tokens: 2000, completion_tokens: 100, calls: 2 });
    expect(j.provider_used).toEqual({ a: "deepseek", b: "deepseek" });
    expect(j.models_used).toEqual({ a: "fake-deepseek", b: "fake-deepseek" });
    expect(j.usage_by_provider.deepseek).toEqual({ prompt_tokens: 2000, completion_tokens: 100, calls: 2 });
    expect(j.documents[0].provider_used).toEqual({ a: "deepseek", b: "deepseek" });
    expect(JSON.stringify(j.provider_used) + JSON.stringify(j.usage_by_provider)).not.toMatch(/data:image|base64/);
  });
  it("真 getReadClients 路徑：Claude 成功＋DeepSeek 成功 → provider_used claude／deepseek；audit 冇圖冇值", async () => {
    process.env.CLAUDE_API_KEY = "test-claude-not-real";
    process.env.DEEPSEEK_API_KEY = "test-ds-not-real";
    const clients: ReadClients = { a: mkClaude(vi.fn().mockResolvedValue(claudeMsg())), b: fake("deepseek").client };
    const mod = await import("@/lib/guards/ocr/clients");
    vi.spyOn(mod, "getReadClients").mockReturnValue(clients);
    const logs = [vi.spyOn(console, "log"), vi.spyOn(console, "error"), vi.spyOn(console, "warn")];
    const res = await call([doc]);
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.provider_used).toEqual({ a: "claude", b: "deepseek" });
    expect(j.model).toBe("claude-opus-5-5");
    expect(j.usage_by_provider.claude).toEqual({ prompt_tokens: 2100, completion_tokens: 90, calls: 1 });
    expect(j.documents[0].fields.hkid.status).toBe("confirmed");
    const rows = JSON.stringify(await prisma.auditLog.findMany({ where: { action: "guard_ocr_read" } }));
    const logged = JSON.stringify(logs.flatMap((l) => l.mock.calls));
    for (const v of ["陳大文", "A123456", "base64", "/9j/", "data:image", "test-claude-not-real"]) {
      expect(rows).not.toContain(v);
      expect(logged).not.toContain(v);
    }
    expect(rows).toContain("claude_fallbacks");
    delete process.env.CLAUDE_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;
  });
  it("Claude 429 → 退回 DeepSeek：200，provider_used.a＝deepseek，audit 記 claude_fallbacks=[rate_limit]", async () => {
    const dsA = fake("deepseek");
    const clients: ReadClients = { a: mkClaude(vi.fn().mockRejectedValue(new Anthropic.RateLimitError(429, {}, "x", new Headers()))), b: fake("deepseek").client, fallbackA: dsA.client };
    const mod = await import("@/lib/guards/ocr/clients");
    vi.spyOn(mod, "getReadClients").mockReturnValue(clients);
    const res = await call([doc]);
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.provider_used).toEqual({ a: "deepseek", b: "deepseek" });
    const a = (await prisma.auditLog.findFirstOrThrow({ where: { action: "guard_ocr_read" }, orderBy: { createdAt: "desc" } })).after as Record<string, unknown>;
    expect(a.claude_fallbacks).toEqual(["rate_limit"]);
  });
  it("Claude 同後備都失敗 → 503 友善訊息；冇 key（getReadClients 拋）→ 503", async () => {
    const bad = (s: number) => fake("deepseek", { fail: new OcrUnavailableError(s) }).client;
    const mod = await import("@/lib/guards/ocr/clients");
    vi.spyOn(mod, "getReadClients").mockReturnValue({ a: bad(429), b: fake("deepseek").client, fallbackA: bad(500) });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect((await call([doc])).status).toBe(503);
  });
});
