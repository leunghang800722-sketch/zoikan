// WA-8 B：工卡辨識——容錯解析、策略（三取二／成本優先）、引擎（fake client）、bench（--dry）。全部合成資料，唔打任何 API。
import { describe, it, expect, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { extractStaffNos, normStaffNo, parseCardText } from "@/lib/whatsapp/card-parse";
import { readCardPhoto, cardStrategyFromEnv, CARD_STRATEGIES } from "@/lib/whatsapp/card-ocr";
import { createEngine, CARD_JSON_SCHEMA, type CardEngine, type CardEngineName, type EngineOutcome } from "@/lib/whatsapp/card-engines";
import { ClaudeVisionClient } from "@/lib/guards/ocr/claude-vision-client";
import type { VisionClient } from "@/lib/guards/ocr/vision-client";
import { BenchArgError, parseTruthCsv, scoreEngine, scoreStrategy, summaryLines } from "../scripts/whatsapp/lib/card-bench-core";
import { dryFixture, parseArgs, run } from "../scripts/whatsapp/card-ocr-bench";

const card = (no: string | null, over: Record<string, unknown> = {}) => ({ is_card: true, staff_no: no, name_zh: null, name_en: null, confidence: "high" as const, ...over });
const okOut = (name: CardEngineName, nos: string[], extra: Record<string, unknown> = {}): EngineOutcome => ({
  ok: true,
  is_card: nos.length > 0,
  cards: nos.map((n) => card(n, extra)),
  usage: name === "tesseract" ? null : { engine: name, model: `m-${name}`, promptTokens: 100, completionTokens: 10 },
});
const failOut = (): EngineOutcome => ({ ok: false, error: "failed", usage: null });
const fake = (name: CardEngineName, out: EngineOutcome): CardEngine => ({ name, model: `m-${name}`, read: async () => out });
const BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

describe("容錯解析", () => {
  it("工號格式：U+5／MP|MG|MW+4；大小寫／空白／O→0、I→1", () => {
    expect(normStaffNo("u 12345")).toBe("U12345");
    expect(normStaffNo("MP1234")).toBe("MP1234");
    for (const bad of ["U1234", "MP12345", "MX1234", "12345", null, ""]) expect(normStaffNo(bad as never)).toBeNull();
    expect(extractStaffNos("工號 U1234O 同 MP 12l4，另有 U123456")).toEqual(["U12340", "MP1214"]);
  });
  it("JSON（含圍欄／array／單卡平面）", () => {
    expect(parseCardText('{"is_card":true,"cards":[{"staff_no":"U12345","name_zh":"測試甲","name_en":null,"confidence":"high"}]}').cards[0]).toMatchObject({ staff_no: "U12345", name_zh: "測試甲" });
    expect(parseCardText('```json\n{"is_card":false,"cards":[]}\n```')).toMatchObject({ is_card: false, cards: [] });
    expect(parseCardText('[{"staff_no":"mp1234"},{"staff_no":"U22222"}]').cards.map((c) => c.staff_no)).toEqual(["MP1234", "U22222"]);
    expect(parseCardText('{"staff_no":"U12345","confidence":"low"}').cards[0]).toMatchObject({ staff_no: "U12345", confidence: "low" });
    // 工號格式唔啱 → 該張卡冇工號（唔猜）
    expect(parseCardText('{"is_card":true,"cards":[{"staff_no":"X999","name_zh":"測試乙"}]}').cards[0]).toMatchObject({ staff_no: null, name_zh: "測試乙" });
  });
  it("qwen-vl-ocr 純文字：正則抽工號；剛好一個工號先配姓名候選；冇嘢＝非卡", () => {
    const one = parseCardText("在勤保安\n姓名 測試丙\n工號 U12345\n");
    expect(one.cards).toHaveLength(1);
    expect(one.cards[0]).toMatchObject({ staff_no: "U12345", name_zh: "測試丙" });
    const two = parseCardText("U11111 測試甲 / MG2222 測試乙");
    expect(two.cards.map((c) => [c.staff_no, c.name_zh])).toEqual([["U11111", null], ["MG2222", null]]);
    expect(parseCardText("今日天氣好").cards).toHaveLength(0);
    expect(parseCardText("今日天氣好").is_card).toBe(false);
  });
});

describe("策略：成本優先、三取二", () => {
  const eng = (m: Partial<Record<CardEngineName, EngineOutcome>>) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, fake(k as CardEngineName, v!)])) as Partial<Record<CardEngineName, CardEngine>>;
  it("兩個便宜引擎一致 → confirmed，唔呼叫仲裁（零 Claude 成本）", async () => {
    let arbCalls = 0;
    const claude: CardEngine = { name: "claude", model: "m", read: async () => (arbCalls++, okOut("claude", ["U12345"])) };
    const r = await readCardPhoto(BYTES, { strategy: "S1", engines: { ...eng({ tesseract: okOut("tesseract", ["U12345"]), deepseek: okOut("deepseek", ["U12345"]) }), claude } });
    expect(r).toMatchObject({ kind: "cards", arbiter_used: false });
    expect(r.cards).toEqual([expect.objectContaining({ staff_no: "U12345", status: "confirmed", votes: 2 })]);
    expect(arbCalls).toBe(0);
    expect(r.usage.map((u) => u.engine)).toEqual(["deepseek"]);
  });
  it("唔一致 → 仲裁一次（S1=claude、S2=haiku）；仲裁同其中一個一致＝confirmed；三個都唔同＝review", async () => {
    const e = (arb: string[]) => eng({ tesseract: okOut("tesseract", ["U12345"]), deepseek: okOut("deepseek", ["U12346"]), claude: okOut("claude", arb), haiku: okOut("haiku", arb) });
    const s1 = await readCardPhoto(BYTES, { strategy: "S1", engines: e(["U12346"]) });
    expect(s1.arbiter_used).toBe(true);
    expect(s1.cards).toEqual([expect.objectContaining({ staff_no: "U12346", status: "confirmed", votes: 2 })]); // U12345 同 U12346 只差一位＝誤讀候選，唔另開卡
    expect(s1.usage.map((u) => u.engine)).toContain("claude");
    const s2 = await readCardPhoto(BYTES, { strategy: "S2", engines: e(["U12346"]) });
    expect(s2.usage.map((u) => u.engine)).toContain("haiku");
    expect(s2.usage.map((u) => u.engine)).not.toContain("claude");
    const allDiff = await readCardPhoto(BYTES, { strategy: "S1", engines: eng({ tesseract: okOut("tesseract", ["U11111"]), deepseek: okOut("deepseek", ["MP2222"]), claude: okOut("claude", ["MG3333"]) }) });
    expect(allDiff.cards.every((c) => c.status === "review")).toBe(true);
    expect(allDiff.cards.flatMap((c) => c.reasons)).toContain("card_disputed");
  });
  it("引擎失敗／唔可用 → 仲裁；仲裁都失敗＝review（card_arbiter_unavailable）；全部失敗＝unreadable", async () => {
    const r = await readCardPhoto(BYTES, { strategy: "S1", engines: eng({ tesseract: failOut(), deepseek: okOut("deepseek", ["U12345"]), claude: failOut() }) });
    expect(r.cards).toEqual([expect.objectContaining({ staff_no: "U12345", status: "review", reasons: ["card_arbiter_unavailable"] })]);
    const ok = await readCardPhoto(BYTES, { strategy: "S1", engines: eng({ tesseract: failOut(), deepseek: okOut("deepseek", ["U12345"]), claude: okOut("claude", ["U12345"]) }) });
    expect(ok.cards[0]).toMatchObject({ status: "confirmed", votes: 2 });
    const dead = await readCardPhoto(BYTES, { strategy: "S1", engines: eng({ tesseract: failOut(), deepseek: failOut(), claude: failOut() }) });
    expect(dead).toMatchObject({ kind: "unreadable", cards: [] });
  });
  it("兩個都讀得到而話冇卡＝not_card（唔仲裁）；多張卡逐張判定；名只讀到姓名＝review（card_name_only）", async () => {
    const none = await readCardPhoto(BYTES, { strategy: "S1", engines: eng({ tesseract: okOut("tesseract", []), deepseek: okOut("deepseek", []) }) });
    expect(none).toMatchObject({ kind: "not_card", arbiter_used: false });
    const multi = await readCardPhoto(BYTES, { strategy: "S1", engines: eng({ tesseract: okOut("tesseract", ["U11111", "MG2222"]), deepseek: okOut("deepseek", ["U11111", "MG2222"]) }) });
    expect(multi.cards.map((c) => [c.staff_no, c.status])).toEqual([["U11111", "confirmed"], ["MG2222", "confirmed"]]);
    const nameOnly = await readCardPhoto(BYTES, {
      strategy: "S1",
      engines: eng({
        tesseract: { ok: true, is_card: true, cards: [card(null, { name_zh: "測試甲" })], usage: null },
        deepseek: { ok: true, is_card: true, cards: [card(null, { name_zh: "測試甲" })], usage: null },
      }),
    });
    expect(nameOnly.cards).toEqual([expect.objectContaining({ staff_no: null, name_zh: "測試甲", status: "review", reasons: ["card_name_only"] })]);
  });
  it("五個策略引擎組合；env WA_CARD_OCR_STRATEGY 預設 S1", () => {
    expect(CARD_STRATEGIES.S1).toEqual({ primary: ["tesseract", "deepseek"], arbiter: "claude" });
    expect(CARD_STRATEGIES.S2.arbiter).toBe("haiku");
    expect(CARD_STRATEGIES.S3).toEqual({ primary: ["deepseek", "haiku"], arbiter: "claude" });
    expect(CARD_STRATEGIES.S4).toEqual({ primary: ["tesseract", "qwen"], arbiter: "haiku" });
    expect(CARD_STRATEGIES.S5).toEqual({ primary: ["qwen", "deepseek"], arbiter: "claude" });
    delete process.env.WA_CARD_OCR_STRATEGY;
    expect(cardStrategyFromEnv()).toBe("S1");
    process.env.WA_CARD_OCR_STRATEGY = "s4";
    expect(cardStrategyFromEnv()).toBe("S4");
    process.env.WA_CARD_OCR_STRATEGY = "zzz";
    expect(cardStrategyFromEnv()).toBe("S1");
    delete process.env.WA_CARD_OCR_STRATEGY;
  });
});

describe("引擎", () => {
  afterEach(() => {
    delete process.env.QWEN_API_KEY;
    delete process.env.TESSERACT_BIN;
  });
  it("deepseek／haiku／claude 經 VisionClient：帶 JSON schema、記 usage；client 拋錯＝failed", async () => {
    let seen: Record<string, unknown> | undefined;
    const client: VisionClient = { model: "fake-model", complete: async (req) => ((seen = req as unknown as Record<string, unknown>), { text: '{"is_card":true,"cards":[{"staff_no":"U12345","name_zh":null,"name_en":null,"confidence":"high"}]}', promptTokens: 321, completionTokens: 12 }) };
    // 注入 client 時唔需要真 image 工具：JPEG magic bytes 原圖照用
    const e = createEngine("haiku", { clients: { haiku: client } });
    const out = await e.read(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(50)]));
    expect(out).toMatchObject({ ok: true, usage: { engine: "haiku", model: "fake-model", promptTokens: 321, completionTokens: 12 } });
    expect((seen as { jsonSchema?: unknown }).jsonSchema).toEqual(CARD_JSON_SCHEMA);
    const boom: VisionClient = { model: "x", complete: async () => { throw new Error("nope"); } };
    expect(await createEngine("deepseek", { clients: { deepseek: boom } }).read(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(50)]))).toMatchObject({ ok: false, error: "failed" });
  });
  it("Claude client：jsonSchema 覆寫；Haiku 唔帶 effort", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const api = { messages: { create: async (a: Record<string, unknown>) => (calls.push(a), { stop_reason: "end_turn", content: [{ type: "text", text: "{}" }], usage: { input_tokens: 1, output_tokens: 1 } }) } } as never;
    const img = `data:image/jpeg;base64,${Buffer.from([1, 2, 3]).toString("base64")}`;
    await new ClaudeVisionClient({ model: "claude-haiku-5-5", client: api }).complete({ system: "s", userText: "u", images: [img], jsonSchema: CARD_JSON_SCHEMA });
    await new ClaudeVisionClient({ model: "claude-opus-5-5", client: api }).complete({ system: "s", userText: "u", images: [img], jsonSchema: CARD_JSON_SCHEMA });
    const oc = (i: number) => calls[i]!.output_config as { effort?: string; format: { schema: unknown } };
    expect(oc(0).effort).toBeUndefined();
    expect(oc(1).effort).toBe("low");
    expect(oc(0).format.schema).toEqual(CARD_JSON_SCHEMA);
  });
  it("qwen：冇 key＝unavailable；有 client 純文字輸出照解析並記 usage（含 qwen3-vl-plus 型號）", async () => {
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(50)]);
    expect(await createEngine("qwen").read(jpeg)).toEqual({ ok: false, error: "unavailable", usage: null });
    const client = { chat: { completions: { create: async () => ({ choices: [{ message: { content: "工號：MP1234 姓名 測試丁" } }], usage: { prompt_tokens: 410, completion_tokens: 20 } }) } } } as never;
    const out = await createEngine("qwen", { qwenClient: client, qwenModel: "qwen3-vl-plus" }).read(jpeg);
    expect(out).toMatchObject({ ok: true, cards: [expect.objectContaining({ staff_no: "MP1234" })], usage: { engine: "qwen", model: "qwen3-vl-plus", promptTokens: 410, completionTokens: 20 } });
  });
  it("tesseract：冇 binary＝unavailable（唔拋錯）", async () => {
    process.env.TESSERACT_BIN = "/nonexistent/tesseract-xyz";
    expect(await createEngine("tesseract").read(Buffer.from([0xff, 0xd8, 0xff, 0, 0, 0]))).toEqual({ ok: false, error: "unavailable", usage: null });
  });
});

const HAS_TESS = spawnSync("tesseract", ["--version"]).status === 0;
describe("tesseract 真引擎（本機有 binary 先跑；合成圖）", () => {
  it.skipIf(!HAS_TESS)("合成工卡圖（SVG→PNG）讀到工號；冇字白圖＝非卡", async () => {
    const name = "sharp";
    const sharp = ((await import(/* @vite-ignore */ name)) as { default: (b: Buffer) => { png(): { toBuffer(): Promise<Buffer> } } }).default;
    const svg = (txt: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="500"><rect width="900" height="500" fill="white"/>${txt}</svg>`;
    const withNo = await sharp(Buffer.from(svg('<text x="60" y="200" font-size="120" font-family="Arial, Helvetica, sans-serif" fill="black">U12345</text>'))).png().toBuffer();
    const out = await createEngine("tesseract").read(withNo);
    expect(out).toMatchObject({ ok: true, cards: [expect.objectContaining({ staff_no: "U12345" })] });
    const blank = await sharp(Buffer.from(svg(""))).png().toBuffer();
    expect(await createEngine("tesseract").read(blank)).toMatchObject({ ok: true, is_card: false, cards: [] });
  });
});

describe("bench（--dry）", () => {
  it("truth CSV 解析／驗證；engine／strategy 類別", () => {
    const t = parseTruthCsv("file,staff_nos\na.jpg,U12345\nb.jpg,MP1234|U22222\nc.jpg,\n");
    expect([...t.get("b.jpg")!].sort()).toEqual(["MP1234", "U22222"]);
    expect(t.get("c.jpg")!.size).toBe(0);
    expect(() => parseTruthCsv("a.jpg,XX99")).toThrow(BenchArgError);
    const truth = new Set(["U12345"]);
    expect(scoreEngine(okOut("deepseek", ["U12345"]), truth)).toBe("exact");
    expect(scoreEngine(okOut("deepseek", ["U12346"]), truth)).toBe("wrong");
    expect(scoreEngine(okOut("deepseek", []), truth)).toBe("unreadable");
    expect(scoreEngine({ ...okOut("deepseek", ["U12346"]), cards: [card("U12346", { confidence: "low" })] } as EngineOutcome, truth)).toBe("review");
    expect(scoreEngine(okOut("deepseek", []), new Set())).toBe("exact");
    expect(scoreStrategy({ kind: "cards", cards: [{ staff_no: "U99999", name_zh: null, name_en: null, status: "confirmed", reasons: [], candidates: [], votes: 2 }], usage: [], arbiter_used: false, engines: [] }, truth)).toBe("confirmed_wrong");
  });
  it("parseArgs 驗證", () => {
    expect(() => parseArgs(["--engines", "gpt"])).toThrow(BenchArgError);
    expect(() => parseArgs(["--strategies", "S9"])).toThrow(BenchArgError);
    expect(parseArgs(["--engines", "tesseract,qwen", "--qwen-models", "qwen-vl-ocr,qwen3-vl-plus", "--dry"])).toMatchObject({ engines: ["tesseract", "qwen"], qwenModels: ["qwen-vl-ocr", "qwen3-vl-plus"], dry: true });
  });
  it("--dry：每引擎／策略計數＋token 用量；輸出冇工號／值；--out 必須喺 data/ 下", async () => {
    const a = parseArgs(["--dry"]);
    const { report, lines } = await run(a);
    expect(report.photos).toBe(4);
    const tess = report.engines.find((e) => e.engine === "tesseract")!;
    expect(tess).toMatchObject({ exact: 2, wrong: 2 });
    const s1 = report.strategies.find((s) => s.strategy === "S1")!;
    expect(s1).toMatchObject({ exact: 4, confirmed_wrong: 0, arbiter_triggered: 2 });
    expect(s1.arbiter_rate).toBe(0.5);
    expect(s1.tokens_by_model["claude:fake-claude"]).toBeDefined();
    const txt = lines.join("\n") + JSON.stringify(report);
    expect(txt).not.toMatch(/U12345|MP1234|U22222|MG3333/);
    expect(summaryLines(report).length).toBeGreaterThan(5);
    // 成本估算：實測 usage × env 單價（唔寫死）；冇設單價＝null
    expect(report.engines.find((e) => e.engine === "deepseek")!.est_usd_per_photo).toBeNull();
    process.env.WA_CARD_PRICE_USD_PER_MTOK = JSON.stringify({ deepseek: { in: 1, out: 2 }, claude: { in: 10, out: 20 } });
    const priced = await run(a);
    delete process.env.WA_CARD_PRICE_USD_PER_MTOK;
    expect(priced.report.engines.find((e) => e.engine === "deepseek")!.est_usd_per_photo).toBeCloseTo((300 * 1 + 40 * 2) / 1e6, 7);
    expect(priced.report.engines.find((e) => e.engine === "haiku")!.est_usd_per_photo).toBeNull(); // 冇設該引擎單價
    expect(priced.report.strategies.find((x) => x.strategy === "S1")!.est_usd_per_photo).toBeGreaterThan(0);
    expect(priced.lines.join("\n")).toMatch(/預估 US\$/);
    await expect(run({ ...a, out: "/tmp/x.json" })).rejects.toThrow(/out_not_under_data/);
    expect(dryFixture().photos).toHaveLength(4);
  });
});
