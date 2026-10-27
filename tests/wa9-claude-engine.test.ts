// WA-9 (1)：claude 引擎診斷——失敗類別碼、effort 可調（預設 medium）、bench 失敗分佈。合成資料，唔打 API。
import { describe, it, expect, afterEach } from "vitest";
import { cardClaudeEffort, createEngine, failReason } from "@/lib/whatsapp/card-engines";
import { OcrUnavailableError, type VisionClient, type VisionRequest } from "@/lib/guards/ocr/vision-client";
import { ClaudeVisionClient } from "@/lib/guards/ocr/claude-vision-client";
import { runBench, summaryLines } from "../scripts/whatsapp/lib/card-bench-core";

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(60)]);

afterEach(() => {
  delete process.env.WA_CARD_CLAUDE_EFFORT;
});

describe("claude 引擎診斷", () => {
  it("failReason：OcrUnavailableError 帶 reason＋status；其他錯誤＝error（固定碼，唔含內容）", () => {
    expect(failReason(new OcrUnavailableError(null, "refusal"))).toBe("refusal");
    expect(failReason(new OcrUnavailableError(400, "api_error"))).toBe("api_error_400");
    expect(failReason(new OcrUnavailableError(429, "rate_limit"))).toBe("rate_limit_429");
    expect(failReason(new Error("secret text"))).toBe("error");
  });
  it("引擎失敗時回 reason（refusal／max_tokens 等），而唔係無聲 unreadable", async () => {
    const mk = (reason: string): VisionClient => ({ model: "m", complete: async () => { throw new OcrUnavailableError(null, reason); } });
    expect(await createEngine("claude", { clients: { claude: mk("refusal") } }).read(JPEG)).toMatchObject({ ok: false, error: "failed", reason: "refusal" });
    expect(await createEngine("claude", { clients: { claude: mk("max_tokens") } }).read(JPEG)).toMatchObject({ reason: "max_tokens" });
    expect(await createEngine("haiku", { clients: { haiku: { model: "m", complete: async () => { throw new Error("x"); } } } }).read(JPEG)).toMatchObject({ reason: "error" });
  });
  it("effort：工卡辨識預設 medium，可由 WA_CARD_CLAUDE_EFFORT 調；經 VisionRequest 傳到 Claude client（Haiku 唔帶）", async () => {
    expect(cardClaudeEffort()).toBe("medium");
    process.env.WA_CARD_CLAUDE_EFFORT = "high";
    expect(cardClaudeEffort()).toBe("high");
    process.env.WA_CARD_CLAUDE_EFFORT = "weird";
    expect(cardClaudeEffort()).toBe("medium");
    delete process.env.WA_CARD_CLAUDE_EFFORT;
    let seen: VisionRequest | undefined;
    const client: VisionClient = { model: "m", complete: async (r) => ((seen = r), { text: '{"is_card":false,"cards":[]}', promptTokens: 1, completionTokens: 1 }) };
    await createEngine("claude", { clients: { claude: client } }).read(JPEG);
    expect(seen?.effort).toBe("medium");
    const calls: Array<Record<string, unknown>> = [];
    const api = { messages: { create: async (a: Record<string, unknown>) => (calls.push(a), { stop_reason: "end_turn", content: [{ type: "text", text: "{}" }], usage: { input_tokens: 1, output_tokens: 1 } }) } } as never;
    const img = `data:image/jpeg;base64,${Buffer.from([1, 2, 3]).toString("base64")}`;
    await new ClaudeVisionClient({ model: "claude-opus-5-5", client: api }).complete({ system: "s", userText: "u", images: [img], effort: "medium" });
    await new ClaudeVisionClient({ model: "claude-opus-5-5", client: api }).complete({ system: "s", userText: "u", images: [img] });
    await new ClaudeVisionClient({ model: "claude-haiku-5-5", client: api }).complete({ system: "s", userText: "u", images: [img], effort: "medium" });
    expect((calls[0]!.output_config as { effort?: string }).effort).toBe("medium");
    expect((calls[1]!.output_config as { effort?: string }).effort).toBe("low"); // 其他 OCR 路徑預設不變
    expect((calls[2]!.output_config as { effort?: string }).effort).toBeUndefined();
  });
  it("bench：每引擎失敗類別分佈＋「讀到空」張數（輸出無值）", async () => {
    const eng = (name: "claude" | "haiku", f: (i: number) => ReturnType<ReturnType<typeof createEngine>["read"]>) => {
      let i = 0;
      return { name, model: "m", read: async () => f(i++) };
    };
    const rep = await runBench({
      photos: [1, 2, 3].map((n) => ({ id: `p${n}`, truth: new Set(["U12345"]) })),
      engines: [
        { key: "claude", engine: eng("claude", async (i) => (i < 2 ? { ok: false as const, error: "failed" as const, usage: null, reason: "refusal" } : { ok: true as const, is_card: false, cards: [], usage: null })) },
        { key: "haiku", engine: eng("haiku", async () => ({ ok: true as const, is_card: true, cards: [{ is_card: true, staff_no: "U12345", name_zh: null, name_en: null, confidence: "high" as const }], usage: null })) },
      ],
      strategies: [],
      load: async () => JPEG,
    });
    const c = rep.engines.find((e) => e.engine === "claude")!;
    expect(c).toMatchObject({ unreadable: 3, failures: { refusal: 2 }, empty_but_truth_has_cards: 1 });
    expect(rep.engines.find((e) => e.engine === "haiku")).toMatchObject({ exact: 3, failures: {}, empty_but_truth_has_cards: 0 });
    const txt = summaryLines(rep).join("\n");
    expect(txt).toContain("refusal×2");
    expect(txt).toContain("讀到空 1");
    expect(txt).not.toMatch(/U12345/);
  });
});
