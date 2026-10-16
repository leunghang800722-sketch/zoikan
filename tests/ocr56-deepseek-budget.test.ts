// OCR-5.6：DeepSeek 思考 token 預算——請求參數（max_tokens／reasoning_effort／thinking disabled）、
// 撞頂（truncated＋content 空）自動重試一次（加倍 max_tokens、上限 8,000）、usage 計兩次。fake client，唔打外部 API。
import { describe, it, expect, afterEach } from "vitest";
import { readStageB, readDocument } from "@/lib/guards/ocr/read";
import type { ReadClients } from "@/lib/guards/ocr/clients";
import { ocrDeepseekMaxTokens } from "@/lib/guards/ocr/config";
import { DeepSeekVisionClient, OcrUnavailableError, type VisionClient, type VisionRequest, type VisionResponse } from "@/lib/guards/ocr/vision-client";

const IMG = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD";
const GOOD = JSON.stringify({ phone: { value: "90001111", confidence: "high", reason: null, alternatives: [] } });
const A = { a_fields_raw: null, provider: "claude" as const, model: "fake-a", fallback_reason: null };

function scripted(responses: VisionResponse[]): VisionClient & { calls: VisionRequest[] } {
  const calls: VisionRequest[] = [];
  return {
    model: "fake-b",
    provider: "deepseek",
    calls,
    async complete(req) {
      calls.push(req);
      return responses[Math.min(calls.length - 1, responses.length - 1)]!;
    },
  };
}
const trunc: VisionResponse = { text: "", promptTokens: 700, completionTokens: 4000, truncated: true };
const ok: VisionResponse = { text: GOOD, promptTokens: 700, completionTokens: 900 };
const imgs = { kind: "tiles" as const, images: [IMG, IMG, IMG, IMG] };

function dsApi(capture: { body?: Record<string, unknown> }) {
  return {
    chat: {
      completions: {
        create: async (b: Record<string, unknown>) => {
          capture.body = b;
          return { choices: [{ message: { content: "{}" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
        },
      },
    },
  } as never;
}

afterEach(() => {
  delete process.env.GUARD_OCR_DEEPSEEK_MAX_TOKENS;
  delete process.env.GUARD_OCR_DEEPSEEK_REASONING;
});

describe("讀 B 撞頂重試", () => {
  it("truncated 且 content 空 → 重試一次，加倍 max_tokens；重試成功", async () => {
    const b = scripted([trunc, ok]);
    const clients: ReadClients = { a: b, b };
    const r = await readStageB(clients, "onboarding_form", A, imgs);
    expect(b.calls).toHaveLength(2);
    expect(b.calls[0]!.maxTokens).toBeUndefined();
    expect(b.calls[1]!.maxTokens).toBe(8000);
    expect(r.parse_ok.b).toBe(true);
    expect(r.b_retry_truncated).toBe(1);
    expect(r.b_retry_failed).toBe(0);
    expect(r.usage.calls).toBe(2);
    expect(r.usage.completionTokens).toBe(4900);
    expect(r.usage_by_provider.deepseek.calls).toBe(2);
  });
  it("重試後仍失敗 → 只重試一次，parse b 失敗", async () => {
    const b = scripted([trunc, trunc, trunc]);
    const r = await readStageB({ a: b, b }, "onboarding_form", A, imgs);
    expect(b.calls).toHaveLength(2);
    expect(r.parse_ok.b).toBe(false);
    expect(r.b_retry_truncated).toBe(1);
  });
  it("冇撞頂或 content 非空 → 唔重試", async () => {
    const b = scripted([ok]);
    const r = await readStageB({ a: b, b }, "onboarding_form", A, imgs);
    expect(b.calls).toHaveLength(1);
    expect(r.b_retry_truncated).toBe(0);
    const b2 = scripted([{ ...ok, truncated: true }]);
    await readStageB({ a: b2, b: b2 }, "onboarding_form", A, imgs);
    expect(b2.calls).toHaveLength(1);
  });
  it("env 覆蓋 max_tokens 後，重試加倍但封頂 8000", async () => {
    process.env.GUARD_OCR_DEEPSEEK_MAX_TOKENS = "6000";
    const b = scripted([trunc, ok]);
    await readStageB({ a: b, b }, "onboarding_form", A, imgs);
    expect(b.calls[1]!.maxTokens).toBe(8000);
  });
  it("legacy readDocument 讀 B 一樣有重試", async () => {
    const b = scripted([trunc, ok]);
    const a: VisionClient = { model: "fake-a", provider: "claude", async complete() { return ok; } };
    const r = await readDocument({ a, b }, "onboarding_form", { full: IMG, tiles: [IMG, IMG, IMG, IMG] });
    expect(r.b_retry_truncated).toBe(1);
    expect(r.usage.calls).toBe(3);
  });
});

describe("驗收修正（OCR-5.7）", () => {
  function seq(steps: (VisionResponse | Error)[]): VisionClient & { calls: VisionRequest[] } {
    const calls: VisionRequest[] = [];
    return {
      model: "fake-b",
      provider: "deepseek",
      calls,
      async complete(req) {
        calls.push(req);
        const x = steps[Math.min(calls.length - 1, steps.length - 1)]!;
        if (x instanceof Error) throw x;
        return x;
      },
    };
  }
  it("S1：重試回 429 → 降級（唔拋）；第一次 usage 照計；parse b 失敗", async () => {
    const b = seq([trunc, new OcrUnavailableError(429)]);
    const r = await readStageB({ a: b, b }, "onboarding_form", A, imgs);
    expect(b.calls).toHaveLength(2);
    expect(r.parse_ok.b).toBe(false);
    expect(r.b_retry_truncated).toBe(0);
    expect(r.b_retry_failed).toBe(1);
    expect(r.usage.calls).toBe(1);
    expect(r.usage.completionTokens).toBe(4000);
  });
  it("S1：非 OcrUnavailableError 照拋", async () => {
    const b = seq([trunc, new Error("bug")]);
    await expect(readStageB({ a: b, b }, "onboarding_form", A, imgs)).rejects.toThrow("bug");
  });
  it("S1：仲裁重試失敗 → usage 計數、唔拋", async () => {
    const a: VisionClient = { model: "a", provider: "claude", async complete() { return { text: JSON.stringify({ phone: { value: "90001111", confidence: "medium", reason: "x", alternatives: [] } }), promptTokens: 1, completionTokens: 1 }; } };
    const b: VisionClient = { model: "b", provider: "deepseek", async complete() { return { text: JSON.stringify({ phone: { value: "90001112", confidence: "medium", reason: "x", alternatives: [] } }), promptTokens: 1, completionTokens: 1 }; } };
    const arb = seq([trunc, new OcrUnavailableError(429)]);
    const arbiter = { ...arb, provider: "claude" as const, complete: arb.complete };
    const r = await readStageB({ a, b, arbiter }, "onboarding_form", { a_fields_raw: { phone: { value: "90001111", confidence: "medium", reason: "x", alternatives: [] } } as never, provider: "claude", model: "a", fallback_reason: null }, { kind: "tiles", images: [IMG], full: IMG });
    expect(arb.calls).toHaveLength(2);
    expect(r.arbiter.called).toBe(true);
    expect(r.b_retry_failed).toBe(1);
    expect(r.b_retry_truncated).toBe(0);
    expect(r.usage_by_provider.claude.calls).toBe(1);
    expect(r.usage_by_provider.claude.completionTokens).toBe(4000);
  });
  it("N1：truncated 但內容非空而 JSON 被截 → 重試", async () => {
    const b = scripted([{ text: '{"phone":{"value":"9000', promptTokens: 1, completionTokens: 4000, truncated: true }, ok]);
    const r = await readStageB({ a: b, b }, "onboarding_form", A, imgs);
    expect(b.calls).toHaveLength(2);
    expect(r.parse_ok.b).toBe(true);
  });
  it("N3：base 已達 8000 → 唔重試", async () => {
    process.env.GUARD_OCR_DEEPSEEK_MAX_TOKENS = "8000";
    const b = scripted([trunc, ok]);
    const r = await readStageB({ a: b, b }, "onboarding_form", A, imgs);
    expect(b.calls).toHaveLength(1);
    expect(r.b_retry_truncated).toBe(0);
  });
  it("N4：env 嚴格解析", () => {
    const get = (v: string) => {
      process.env.GUARD_OCR_DEEPSEEK_MAX_TOKENS = v;
      return ocrDeepseekMaxTokens();
    };
    for (const bad of ["0", "-5", "abc", "9000", " 3000 ", "12abc", "1e3", "500", ""]) expect(get(bad)).toBe(4000);
    expect(get("1000")).toBe(1000);
    expect(get("3000")).toBe(3000);
    expect(get("8000")).toBe(8000);
  });
});

describe("DeepSeek 請求參數", () => {
  const req: VisionRequest = { system: "s", userText: "u", images: [IMG] };
  it("預設 max_tokens 4000＋reasoning_effort low", async () => {
    const cap: { body?: Record<string, unknown> } = {};
    await new DeepSeekVisionClient({ client: dsApi(cap) }).complete(req);
    expect(cap.body).toMatchObject({ max_tokens: 4000, reasoning_effort: "low", response_format: { type: "json_object" } });
    expect(cap.body).not.toHaveProperty("thinking");
  });
  it("env 覆蓋 max_tokens／reasoning；off＝thinking disabled；req.maxTokens 優先", async () => {
    const cap: { body?: Record<string, unknown> } = {};
    process.env.GUARD_OCR_DEEPSEEK_MAX_TOKENS = "5000";
    process.env.GUARD_OCR_DEEPSEEK_REASONING = "max";
    await new DeepSeekVisionClient({ client: dsApi(cap) }).complete(req);
    expect(cap.body).toMatchObject({ max_tokens: 5000, reasoning_effort: "max" });
    process.env.GUARD_OCR_DEEPSEEK_REASONING = "off";
    await new DeepSeekVisionClient({ client: dsApi(cap) }).complete({ ...req, maxTokens: 8000 });
    expect(cap.body).toMatchObject({ max_tokens: 8000, thinking: { type: "disabled" } });
    expect(cap.body).not.toHaveProperty("reasoning_effort");
  });
});
