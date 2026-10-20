// WP-OCR-4：第三讀仲裁（觸發／唔觸發／每份文件上限 1 次／出錯唔影響主流程／用量）、GUARD_OCR_ARBITER 開關、
// POST /api/guards/ocr/read 新舊格式回應（additive）。全部 fake client＋合成資料，唔打外部 API。
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { readDocument } from "@/lib/guards/ocr/read";
import { getReadClients, type ReadClients } from "@/lib/guards/ocr/clients";
import { ocrArbiterEnabled } from "@/lib/guards/ocr/config";
import { OcrUnavailableError, setVisionClientForTests, type OcrProviderName, type VisionClient, type VisionRequest, type VisionResponse } from "@/lib/guards/ocr/vision-client";
import { POST as ocrRoute } from "@/app/api/guards/ocr/read/route";

const IMG = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD";
const IMGS = { full: IMG, tiles: [IMG, IMG, IMG, IMG] };

type Spec = Record<string, unknown>;
/** 按 userText／system 分辨讀 A（全圖）、讀 B（分格）、仲裁（system 含 tie-breaker）；記錄所有請求。 */
function fake(provider: OcrProviderName | undefined, answers: { a?: Spec; b?: Spec; arbiter?: Spec | Error; raw?: { a?: string } }, calls: VisionRequest[] = []): VisionClient & { calls: VisionRequest[] } {
  return {
    model: `fake-${provider ?? "plain"}`,
    ...(provider ? { provider } : {}),
    calls,
    async complete(req: VisionRequest): Promise<VisionResponse> {
      calls.push(req);
      const isArb = req.system.includes("tie-breaker");
      const isB = !isArb && req.userText.includes("overlapping");
      const spec = isArb ? answers.arbiter : isB ? answers.b : answers.a;
      if (spec instanceof Error) throw spec;
      const text = !isArb && !isB && answers.raw?.a ? answers.raw.a : JSON.stringify(spec ?? {});
      return { text, promptTokens: 500, completionTokens: 50 };
    },
  };
}

/** A／B／仲裁三個獨立 client（provider：A＝claude、B＝deepseek、仲裁＝claude），共用一個 calls 記錄。 */
function trio(answers: Parameters<typeof fake>[1]) {
  const calls: VisionRequest[] = [];
  const a = fake("claude", answers, calls);
  const b = fake("deepseek", answers, calls);
  const arbiter = fake("claude", answers, calls);
  const clients: ReadClients = { a, b, arbiter };
  return { clients, calls, arbCalls: () => calls.filter((c) => c.system.includes("tie-breaker")) };
}

const obj = (value: string, confidence: "high" | "medium" | "low", extra: Spec = {}) => ({ value, confidence, reason: confidence === "high" ? null : "blurry", alternatives: [], ...extra });

describe("第三讀仲裁：觸發條件", () => {
  it("兩讀唔同且 confidence 都唔係 high → 觸發 1 次；仲裁同讀 A 一致且 valid → review（OCR-6：電話 2/3 唔再 confirmed）", async () => {
    const t = trio({
      a: { phone: obj("90001111", "low"), address: obj("新界火炭示範街99號虛構大廈15樓A室", "high") },
      b: { phone: obj("90001112", "medium"), address: obj("新界火炭示範街99號虛構大廈15樓A室", "high") },
      arbiter: { phone: obj("90001111", "medium") },
    });
    const r = await readDocument(t.clients, "onboarding_form", IMGS);
    expect(t.arbCalls()).toHaveLength(1);
    expect(r.fields.phone).toMatchObject({ status: "review", value: "90001111", arbiter: "agree_a", reason: "phone_needs_three_way" });
    expect(r.fields.address).toMatchObject({ status: "confirmed" });
    expect(r.arbiter).toEqual({ called: true, fields: 1 });
    // 仲裁 request：只問分歧欄、圖＝全圖＋全部格、prompt 列出候選
    const arb = t.arbCalls()[0]!;
    expect(arb.fields).toEqual(["phone"]);
    expect(arb.images).toHaveLength(5);
    // OCR-6.1：電話盲讀仲裁——prompt 唔帶兩讀候選值（避免錨定），只要求獨立讀
    expect(arb.userText).not.toContain("90001111");
    expect(arb.userText).not.toContain("90001112");
    expect(arb.userText).toContain("BLIND");
    expect(arb.userText).not.toContain("新界火炭");
  });
  it("OCR-4.4 觸發矩陣：A high/B high 唔觸發；A high/B medium、A medium/B high、A low/B low 觸發", async () => {
    const run = async (ca: "high" | "medium" | "low", cb: "high" | "medium" | "low") => {
      const t = trio({ a: { phone: obj("90001111", ca) }, b: { phone: obj("90001112", cb) }, arbiter: { phone: obj("90001111", "medium") } });
      const r = await readDocument(t.clients, "onboarding_form", IMGS);
      return { n: t.arbCalls().length, r };
    };
    const hh = await run("high", "high");
    expect(hh.n).toBe(1); // OCR-6：電話永遠仲裁（兩讀都 high 都跑）
    expect(hh.r.fields.phone).toMatchObject({ status: "review", reason: "phone_needs_three_way", arbiter: "agree_a" });
    expect(hh.r.arbiter).toEqual({ called: true, fields: 1 });
    expect(hh.r.usage.calls).toBe(3);
    for (const [ca, cb] of [["high", "medium"], ["medium", "high"], ["low", "low"], ["high", "low"]] as const) {
      const x = await run(ca, cb);
      expect(x.n, `${ca}/${cb}`).toBe(1);
      expect(x.r.fields.phone).toMatchObject({ status: "review", value: "90001111", arbiter: "agree_a", reason: "phone_needs_three_way" });
    }
  });
  it("OCR-6：電話兩讀一致（即使都 high 或 low）都跑仲裁；三讀一致先 confirmed；仲裁唔同 → review independent", async () => {
    for (const c of ["high", "low"] as const) {
      const t = trio({ a: { phone: obj("90001111", c) }, b: { phone: obj("90001111", c) }, arbiter: { phone: obj("90001112", "high") } });
      const r = await readDocument(t.clients, "onboarding_form", IMGS);
      expect(t.arbCalls()).toHaveLength(1);
      expect(t.arbCalls()[0]!.fields).toEqual(["phone"]);
      expect(r.fields.phone).toMatchObject({ status: "review", value: "90001111", arbiter: "independent", reason: "phone_needs_three_way" });
      const t3 = trio({ a: { phone: obj("90001111", c) }, b: { phone: obj("90001111", c) }, arbiter: { phone: obj("90001111", "high") } });
      const r3 = await readDocument(t3.clients, "onboarding_form", IMGS, new Date(), { independentPhones: ["9000 1111"] });
      expect(t3.arbCalls()).toHaveLength(1);
      expect(r3.fields.phone).toMatchObject({ status: "confirmed", value: "90001111", arbiter: "agree_a" });
    }
  });
  it("OCR-4.4：地址只差形近字（村／邨）→ strict 分歧入仲裁（即使 canon 一致）；仲裁同讀 B strict 一致 → confirmed", async () => {
    const t = trio({
      a: { address: obj("新界火炭示範村99號虛構樓15樓A室", "medium") },
      b: { address: obj("新界火炭示範邨99號虛構樓15樓A室", "medium") },
      arbiter: { address: obj("新界火炭示範邨99號虛構樓15樓A室", "medium") },
    });
    const r = await readDocument(t.clients, "onboarding_form", IMGS);
    expect(t.arbCalls()).toHaveLength(1);
    expect(t.arbCalls()[0]!.fields).toEqual(["address"]);
    expect(r.fields.address).toMatchObject({ status: "confirmed", arbiter: "agree_b" });
  });
  it("OCR-4.5 M1：仲裁同標準寫法（廈）一致 → confirmed agree_b；同變體寫法（厦）一致 → 維持 review（vtag 保留、標準寫法排前）", async () => {
    const A = "新界火炭示範街99號虛構大厦15樓A室";
    const B = "新界火炭示範街99號虛構大廈15樓A室";
    const std = trio({ a: { address: obj(A, "medium") }, b: { address: obj(B, "medium") }, arbiter: { address: obj(B, "medium") } });
    const r1 = await readDocument(std.clients, "onboarding_form", IMGS);
    expect(std.arbCalls()).toHaveLength(1);
    expect(r1.fields.address).toMatchObject({ status: "confirmed", value: B, arbiter: "agree_b" });
    const vr = trio({ a: { address: obj(A, "medium") }, b: { address: obj(B, "medium") }, arbiter: { address: obj(A, "medium") } });
    const r2 = await readDocument(vr.clients, "onboarding_form", IMGS);
    expect(r2.fields.address).toMatchObject({ status: "review", reason: "address_variant_chars", arbiter: "agree_a" });
    expect(r2.fields.address!.value).toBe(B);
    expect(r2.fields.address!.candidates.slice(0, 2)).toEqual([B, A]);
    // OCR-4.6：invalid（過短）alternative 唔可以跳到有效候選前面；預填不變
    const inv = trio({ a: { address: obj(A, "medium", { alternatives: ["短址"] }) }, b: { address: obj(B, "medium") }, arbiter: { address: obj(A, "medium") } });
    const r3 = await readDocument(inv.clients, "onboarding_form", IMGS);
    expect(r3.fields.address).toMatchObject({ status: "review", arbiter: "agree_a", value: B });
    expect(r3.fields.address!.candidates).toEqual([B, A, "短址"]);
  });
  it("OCR-4.4：地址 strict 完全一致 → 唔觸發", async () => {
    const t = trio({ a: { address: obj("新界火炭示範街99號虛構大廈15樓A室", "low") }, b: { address: obj("新界火炭示範街99號虛構大廈15樓A室", "medium") }, arbiter: {} });
    await readDocument(t.clients, "onboarding_form", IMGS);
    expect(t.arbCalls()).toHaveLength(0);
  });
  it("舊純字串格式（冇 confidence）兩讀唔同 → 當唔係 high，觸發仲裁", async () => {
    const t = trio({ a: { phone: "90001111" }, b: { phone: "90001112" }, arbiter: { phone: "90001113" } });
    const r = await readDocument(t.clients, "onboarding_form", IMGS);
    expect(t.arbCalls()).toHaveLength(1);
    expect(r.fields.phone).toMatchObject({ status: "review", reason: "reads_differ", arbiter: "independent" });
    expect(r.fields.phone!.candidates).toHaveLength(3);
  });
  it("地址兩讀一致／一邊 unclear → 唔觸發（OCR-6：只有電話欄永遠入仲裁）", async () => {
    const t = trio({ a: { phone: "90001111", address: "unclear" }, b: { phone: "9000 1111", address: "新界火炭示範街99號虛構大廈15樓A室" } });
    await readDocument(t.clients, "onboarding_form", IMGS);
    expect(t.arbCalls()).toHaveLength(1);
    expect(t.arbCalls()[0]!.fields).toEqual(["phone"]);
    const t2 = trio({ a: { address: "unclear" }, b: { address: "新界火炭示範街99號虛構大廈15樓A室" } });
    await readDocument(t2.clients, "onboarding_form", IMGS);
    expect(t2.arbCalls()).toHaveLength(0);
  });
  it("多個分歧欄 → 一次過問（每份文件最多 1 次呼叫）", async () => {
    const t = trio({
      a: { name_zh: obj("測試申", "medium"), hkid: obj("Z900001(3)", "low"), dob: obj("15-01-1990", "medium"), sex: obj("M", "high"), name_en: obj("TEST ALPHA", "high") },
      b: { name_zh: obj("測試由", "medium"), hkid: obj("Z900001(2)", "low"), dob: obj("15-01-1991", "medium"), sex: obj("M", "high"), name_en: obj("TEST ALPHA", "high") },
      arbiter: { name_zh: obj("測試甲", "medium"), hkid: obj("Z900001(2)", "high"), dob: obj("15-01-1990", "high") },
    });
    const r = await readDocument(t.clients, "id_card", IMGS);
    expect(t.arbCalls()).toHaveLength(1);
    expect(t.arbCalls()[0]!.fields).toEqual(["name_zh", "hkid", "dob"]);
    expect(r.arbiter).toEqual({ called: true, fields: 3 });
    expect(r.fields.hkid).toMatchObject({ status: "confirmed", value: "Z900001(2)", arbiter: "agree_b" });
    expect(r.fields.dob).toMatchObject({ status: "confirmed", arbiter: "agree_a" });
    expect(r.fields.name_zh).toMatchObject({ status: "review", value: "測試甲", arbiter: "independent" });
    expect(r.fields.sex).toMatchObject({ status: "confirmed" });
  });
  it("冇 arbiter client（GUARD_OCR_ARBITER 關／冇 Claude）→ 唔仲裁，行為同舊版", async () => {
    const calls: VisionRequest[] = [];
    const a = fake("claude", { a: { phone: obj("90001111", "low") } }, calls);
    const b = fake("deepseek", { b: { phone: obj("90001112", "low") } }, calls);
    const r = await readDocument({ a, b }, "onboarding_form", IMGS);
    expect(calls).toHaveLength(2);
    expect(r.arbiter.called).toBe(false);
  });
  it("讀 A 退回咗 DeepSeek 後備 → 唔仲裁（仲裁只用 Claude）", async () => {
    const calls: VisionRequest[] = [];
    const failing: VisionClient = { model: "c", provider: "claude", async complete() { throw new OcrUnavailableError(500, "api_error"); } };
    const ds1 = fake("deepseek", { a: { phone: obj("90001111", "low") } }, calls);
    const ds2 = fake("deepseek", { b: { phone: obj("90001112", "low") } }, calls);
    const arbiter = fake("claude", { arbiter: { phone: obj("90001111", "high") } }, calls);
    const r = await readDocument({ a: failing, b: ds2, fallbackA: ds1, arbiter }, "onboarding_form", IMGS);
    expect(r.provider_used.a).toBe("deepseek");
    expect(calls.filter((c) => c.system.includes("tie-breaker"))).toHaveLength(0);
  });
});

describe("第三讀仲裁：出錯、用量", () => {
  it("仲裁 client 出 OcrUnavailableError → 照用兩讀結果（review），主流程唔失敗", async () => {
    const t = trio({ a: { phone: obj("90001111", "low") }, b: { phone: obj("90001112", "low") }, arbiter: new OcrUnavailableError(429, "rate_limit") });
    const r = await readDocument(t.clients, "onboarding_form", IMGS);
    expect(r.fields.phone).toMatchObject({ status: "review", reason: "reads_differ" });
    expect(r.fields.phone!.arbiter).toBeUndefined();
    expect(r.arbiter).toEqual({ called: false, fields: 0 });
    expect(r.usage.calls).toBe(2);
  });
  it("仲裁出非 OcrUnavailableError（bug）→ 原樣拋，唔吞", async () => {
    const t = trio({ a: { phone: obj("90001111", "low") }, b: { phone: obj("90001112", "low") }, arbiter: new TypeError("boom") });
    await expect(readDocument(t.clients, "onboarding_form", IMGS)).rejects.toThrow(TypeError);
  });
  it("仲裁 JSON 壞 → 當冇仲裁結果，兩讀照 review，但用量照計", async () => {
    const calls: VisionRequest[] = [];
    const a = fake("claude", { a: { phone: obj("90001111", "low") } }, calls);
    const b = fake("deepseek", { b: { phone: obj("90001112", "low") } }, calls);
    const arbiter: VisionClient = { model: "arb", provider: "claude", async complete(req) { calls.push(req); return { text: "not json", promptTokens: 300, completionTokens: 5 }; } };
    const r = await readDocument({ a, b, arbiter }, "onboarding_form", IMGS);
    expect(r.fields.phone).toMatchObject({ status: "review", reason: "reads_differ" });
    expect(r.fields.phone!.arbiter).toBeUndefined();
    expect(r.arbiter.called).toBe(true);
  });
  it("用量：calls／tokens 計埋仲裁；usage_by_provider 記 Claude 嘅仲裁", async () => {
    const t = trio({ a: { phone: obj("90001111", "low") }, b: { phone: obj("90001112", "low") }, arbiter: { phone: obj("90001111", "medium") } });
    const r = await readDocument(t.clients, "onboarding_form", IMGS);
    expect(r.usage).toMatchObject({ calls: 3, promptTokens: 1500, completionTokens: 150, truncated: 0 });
    expect(r.usage_by_provider.claude).toEqual({ promptTokens: 1000, completionTokens: 100, calls: 2 });
    expect(r.usage_by_provider.deepseek).toEqual({ promptTokens: 500, completionTokens: 50, calls: 1 });
  });
});

describe("GUARD_OCR_ARBITER 開關／getReadClients", () => {
  const saved = { arb: process.env.GUARD_OCR_ARBITER, ck: process.env.CLAUDE_API_KEY, dk: process.env.DEEPSEEK_API_KEY, prov: process.env.GUARD_OCR_PROVIDER };
  afterEach(() => {
    setVisionClientForTests(null);
    for (const [k, v] of [["GUARD_OCR_ARBITER", saved.arb], ["CLAUDE_API_KEY", saved.ck], ["DEEPSEEK_API_KEY", saved.dk], ["GUARD_OCR_PROVIDER", saved.prov]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
  it("預設開；0／false／off／no 關", () => {
    delete process.env.GUARD_OCR_ARBITER;
    expect(ocrArbiterEnabled()).toBe(true);
    for (const v of ["0", "false", "OFF", " no "]) {
      process.env.GUARD_OCR_ARBITER = v;
      expect(ocrArbiterEnabled()).toBe(false);
    }
    process.env.GUARD_OCR_ARBITER = "1";
    expect(ocrArbiterEnabled()).toBe(true);
  });
  it("claude+deepseek：有 Claude arbiter；GUARD_OCR_ARBITER=0 就冇", () => {
    process.env.CLAUDE_API_KEY = "sk-ant-test-not-real";
    process.env.DEEPSEEK_API_KEY = "sk-test-not-real";
    delete process.env.GUARD_OCR_PROVIDER;
    delete process.env.GUARD_OCR_ARBITER;
    const on = getReadClients();
    expect(on.arbiter?.provider).toBe("claude");
    expect(on.a.provider).toBe("claude");
    process.env.GUARD_OCR_ARBITER = "0";
    expect(getReadClients().arbiter).toBeUndefined();
  });
  it("純 deepseek 模式冇 arbiter；測試 override：只有 provider=claude 嘅 fake 先有 arbiter", () => {
    delete process.env.CLAUDE_API_KEY;
    process.env.DEEPSEEK_API_KEY = "sk-test-not-real";
    delete process.env.GUARD_OCR_ARBITER;
    expect(getReadClients().arbiter).toBeUndefined();
    setVisionClientForTests(fake(undefined, {}));
    expect(getReadClients().arbiter).toBeUndefined();
    const c = fake("claude", {});
    setVisionClientForTests(c);
    expect(getReadClients().arbiter).toBe(c);
  });
});

describe("POST /api/guards/ocr/read：新舊格式回應 additive", () => {
  let fx: Wp2Fixture;
  let owner: string;
  const savedKey = process.env.DEEPSEEK_API_KEY;
  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    owner = await sessionCookieForUser(fx.userIds["老闆"]);
    delete process.env.DEEPSEEK_API_KEY;
  });
  afterEach(() => {
    setVisionClientForTests(null);
    vi.restoreAllMocks();
    if (savedKey !== undefined) process.env.DEEPSEEK_API_KEY = savedKey;
  });
  const call = (docs: unknown) => ocrRoute(new Request("http://t/api/guards/ocr/read", { method: "POST", headers: { "content-type": "application/json", cookie: owner }, body: JSON.stringify({ documents: docs }) }));
  const doc = (type = "id_card") => ({ type, full: IMG, tiles: [IMG, IMG, IMG, IMG] });

  it("舊格式 fake（純字串）：照樣 confirmed／review；每欄多 candidates_ranked；文件多 arbiter 計數", async () => {
    const std = { name_zh: "測試甲", name_en: "TEST ALPHA", hkid: "Z900001(2)", dob: "15-01-1990", sex: "M" };
    const client: VisionClient = { model: "fake-old", async complete(req) { return { text: JSON.stringify(req.userText.includes("overlapping") ? { ...std, name_zh: "測試乙" } : std), promptTokens: 10, completionTokens: 5 }; } };
    setVisionClientForTests(client);
    const res = await call([doc()]);
    expect(res.status).toBe(200);
    const j = await res.json();
    const f = j.documents[0].fields;
    expect(f.hkid).toMatchObject({ status: "confirmed", value: "Z900001(2)", candidates: [], candidates_ranked: [] });
    expect(f.name_zh).toMatchObject({ status: "review", reason: "reads_differ", candidates: ["測試甲", "測試乙"] });
    expect(f.name_zh.candidates_ranked.map((c: { value: string }) => c.value)).toEqual(["測試甲", "測試乙"]);
    expect(f.name_zh.candidates_ranked[0]).toMatchObject({ sources: ["a"], reason: "valid" });
    expect(j.documents[0].arbiter).toEqual({ called: false, fields: 0 });
    expect(j.usage.calls).toBe(2);
  });
  it("新格式＋仲裁（fake provider=claude）：alternatives 入候選、仲裁 confirmed、audit 記 arbiter_calls 但冇任何欄位值", async () => {
    const calls: VisionRequest[] = [];
    const client = fake("claude", {
      a: { phone: obj("90001111", "low", { alternatives: ["90001117"] }), address: obj("新界火炭示範街99號虛構大廈15樓A室", "high") },
      b: { phone: obj("90001112", "low"), address: obj("新界火炭示範街99號虛構大廈15樓A室", "high") },
      arbiter: { phone: obj("90001112", "medium") },
    }, calls);
    setVisionClientForTests(client);
    const res = await call([doc("onboarding_form")]);
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.documents[0].fields.phone).toMatchObject({ status: "review", value: "90001112", arbiter: "agree_b", reason: "phone_needs_three_way" });
    expect(j.documents[0].arbiter).toEqual({ called: true, fields: 1 });
    expect(j.usage.calls).toBe(3);
    const row = (await prisma.auditLog.findMany({ where: { action: "guard_ocr_read", actorUserId: fx.userIds["老闆"] }, orderBy: { createdAt: "desc" }, take: 1 }))[0]!;
    expect((row.after as Record<string, unknown>).arbiter_calls).toBe(1);
    const all = JSON.stringify(await prisma.auditLog.findMany({ where: { actorUserId: fx.userIds["老闆"], action: "guard_ocr_read" } }));
    for (const v of ["90001111", "90001112", "90001117", "新界火炭", "base64", "/9j/"]) expect(all).not.toContain(v);
  });
  it("review 欄回應帶 alternatives 候選（兩讀唔同、冇仲裁）", async () => {
    const client = fake(undefined, {
      a: { name_zh: obj("測試申", "medium", { alternatives: ["測試甲"] }), name_en: obj("TEST ALPHA", "high"), hkid: obj("Z900001(2)", "high"), dob: obj("15-01-1990", "high"), sex: obj("M", "high") },
      b: { name_zh: obj("測試由", "medium"), name_en: obj("TEST ALPHA", "high"), hkid: obj("Z900001(2)", "high"), dob: obj("15-01-1990", "high"), sex: obj("M", "high") },
    });
    setVisionClientForTests(client);
    const j = await (await call([doc()])).json();
    const nz = j.documents[0].fields.name_zh;
    expect(nz.status).toBe("review");
    expect(nz.candidates).toEqual(["測試申", "測試由", "測試甲"]);
    expect(nz.candidates_ranked.map((c: { sources: string[] }) => c.sources)).toEqual([["a"], ["b"], ["a_alt"]]);
  });
});

describe("OCR-6：read.ts 電話強制仲裁", () => {
  it("兩讀一致都 high、只有電話 → 仲裁只問 phone；三讀一致 confirmed；仲裁 prompt 候選淨一個值", async () => {
    const t = trio({ a: { phone: obj("90001111", "high") }, b: { phone: obj("90001111", "high") }, arbiter: { phone: obj("90001111", "high") } });
    const r = await readDocument(t.clients, "onboarding_form", IMGS, new Date(), { independentPhones: ["90001111"] });
    expect(t.arbCalls()).toHaveLength(1);
    expect(t.arbCalls()[0]!.fields).toEqual(["phone"]);
    expect(r.arbiter).toEqual({ called: true, fields: 1 });
    expect(r.fields.phone).toMatchObject({ status: "confirmed", value: "90001111" });
    expect(t.arbCalls()[0]!.userText).not.toContain("90001111"); // 盲讀：連兩讀一致嘅候選都唔帶
  });
  it("冇仲裁 client（例如純 DeepSeek 模式）→ 電話唔會 confirmed", async () => {
    const t = trio({ a: { phone: obj("90001111", "high") }, b: { phone: obj("90001111", "high") } });
    const r = await readDocument({ a: t.clients.a, b: t.clients.b }, "onboarding_form", IMGS);
    expect(r.fields.phone).toMatchObject({ status: "review", reason: "phone_needs_three_way" });
  });
  it("其他欄兩讀一致 high 仍唔觸發仲裁（身份證）", async () => {
    const t = trio({ a: { hkid: obj("Z900001(2)", "high") }, b: { hkid: obj("Z900001(2)", "high") } });
    await readDocument(t.clients, "id_card", IMGS);
    expect(t.arbCalls()).toHaveLength(0);
  });
});
