// WA-9 (2)：文件類型分類、姓名身份讀取（打卡紙／簽到表／app 截圖）、盤／判頭範圍內姓名配對、相上時間定更。全部合成資料（假名、假工號），唔打 API。
import { describe, it, expect } from "vitest";
import { buildGuardMatchIndex } from "@/lib/roster-upload/match";
import type { ResolveContext, ResolveRepo, ShiftTypeLite } from "@/lib/whatsapp/resolve";
import { resolveCardPhoto, type CardDeps } from "@/lib/whatsapp/card-resolve";
import { readCardPhoto, type CardPhotoResult, type PhotoCard } from "@/lib/whatsapp/card-ocr";
import type { CardEngine, CardEngineName, EngineOutcome } from "@/lib/whatsapp/card-engines";
import { normDocType, normTime, parseCardText } from "@/lib/whatsapp/card-parse";
import { pickWaKind } from "@/lib/whatsapp/triage-types";

const BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
const card = (over: Record<string, unknown> = {}) => ({ is_card: true, staff_no: null, name_zh: null, name_en: null, confidence: "high" as const, time_on: null, time_off: null, ...over });
const out = (cards: ReturnType<typeof card>[], doc: "work_card" | "punch_card" | "signin_sheet" | "app_screenshot" | "other" | null = "punch_card"): EngineOutcome => ({ ok: true, is_card: cards.length > 0, cards, usage: null, doc_type: doc });
const fake = (name: CardEngineName, o: EngineOutcome): CardEngine => ({ name, model: "m", read: async () => o });
const engs = (m: Partial<Record<CardEngineName, EngineOutcome>>) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, fake(k as CardEngineName, v!)])) as Partial<Record<CardEngineName, CardEngine>>;

describe("解析：doc_type／時間", () => {
  it("normDocType／normTime", () => {
    expect(normDocType("punch_card")).toBe("punch_card");
    expect(normDocType("weird")).toBeNull();
    expect([normTime("8:05"), normTime("0805"), normTime("08.05"), normTime("08:05:33"), normTime("25:00"), normTime("abc"), normTime(null)]).toEqual(["08:05", "08:05", "08:05", "08:05", null, null, null]);
  });
  it("parseCardText 帶 doc_type 同每張卡時間；純文字 fallback doc_type=null", () => {
    const p = parseCardText('{"doc_type":"app_screenshot","cards":[{"staff_no":null,"name_zh":"測試甲","name_en":null,"time_on":"8:07","time_off":null,"confidence":"high"}]}');
    expect(p.doc_type).toBe("app_screenshot");
    expect(p.cards[0]).toMatchObject({ name_zh: "測試甲", time_on: "08:07", time_off: null });
    expect(parseCardText("U12345 測試甲").doc_type).toBeNull();
  });
});

describe("readCardPhoto：姓名身份", () => {
  it("兩引擎讀到同一姓名（冇工號）→ confirmed（votes 2）、doc_type 多數、時間多數；today 提示傳畀引擎；唔仲裁", async () => {
    let hint: unknown;
    const e1: CardEngine = { name: "qwen", model: "m", read: async (_b, h) => ((hint = h), out([card({ name_zh: "測試甲", time_on: "08:05" })])) };
    const e2 = fake("tesseract", out([card({ name_zh: "測試 甲", time_on: "08:05" })]));
    const r = await readCardPhoto(BYTES, { strategy: "S4", today: "2026-10-26", engines: { qwen: e1, tesseract: e2 } });
    expect(hint).toEqual({ today: "2026-10-26" });
    expect(r.arbiter_used).toBe(false);
    expect(r.doc_type).toBe("punch_card");
    expect(r.cards).toEqual([expect.objectContaining({ staff_no: null, name_zh: "測試甲", status: "confirmed", votes: 2, time_on: "08:05", doc_type: "punch_card" })]);
  });
  it("姓名分歧 → 仲裁；仲裁同其中一個一致＝confirmed；三個都唔同＝一條 review 列全部姓名候選", async () => {
    const e = (a: string, b: string, c: string) => engs({ tesseract: out([card({ name_zh: a })]), deepseek: out([card({ name_zh: b })]), claude: out([card({ name_zh: c })]) });
    const win = await readCardPhoto(BYTES, { strategy: "S1", engines: e("測試甲", "測試乙", "測試乙") });
    expect(win.arbiter_used).toBe(true);
    expect(win.cards).toEqual([expect.objectContaining({ name_zh: "測試乙", status: "confirmed", votes: 2 })]);
    const diff = await readCardPhoto(BYTES, { strategy: "S1", engines: e("測試甲", "測試乙", "測試丙") });
    expect(diff.cards).toHaveLength(1);
    expect(diff.cards[0]).toMatchObject({ status: "review", staff_no: null });
    expect([...diff.cards[0]!.name_candidates!].sort()).toEqual(["測試丙", "測試乙", "測試甲"].sort());
  });
  it("有工號就照舊以工號為主（姓名只輔助）", async () => {
    const r = await readCardPhoto(BYTES, { strategy: "S1", engines: engs({ tesseract: out([card({ staff_no: "U90001", name_zh: "測試甲" })], "work_card"), deepseek: out([card({ staff_no: "U90001", name_zh: "測試甲" })], "work_card") }) });
    expect(r.cards[0]).toMatchObject({ staff_no: "U90001", status: "confirmed", doc_type: "work_card" });
  });
});

describe("resolve：姓名喺盤／判頭範圍內配對", () => {
  const S1 = "site-1";
  const MON_9AM = new Date("2026-10-19T01:00:00Z");
  const guards = [
    { id: "g1", nameZh: "測試甲", tel: null, staffNo: null, staffNoMw: null, nameAliases: [] },
    { id: "g2", nameZh: "測試乙", tel: null, staffNo: null, staffNoMw: null, nameAliases: [] },
    { id: "g3", nameZh: "測試乙", tel: null, staffNo: null, staffNoMw: null, nameAliases: [] }, // 同名（另一盤）
    { id: "g4", nameZh: "測試甲甲", tel: null, staffNo: null, staffNoMw: null, nameAliases: [] },
  ];
  const index = buildGuardMatchIndex({ guards, staffNumbers: [], phones: [] });
  const types: ShiftTypeLite[] = [{ id: "t-d", siteId: S1, code: "D", label: "日更", startHour: 8 }, { id: "t-n", siteId: S1, code: "N", label: "夜更", startHour: 20 }];
  const repo = (atSite: string[], ofBroker: string[] = []): ResolveRepo => ({
    shiftTypes: async () => types,
    recentGuardIdsAtSite: async () => new Set(atSite),
    recentGuardIdsOfBroker: async () => new Set(ofBroker),
    existing: async () => [],
    headcount: async () => ({ required: null, current: 0 }),
    quota: async () => null,
    monthLocked: async () => false,
  });
  const ctx = (r: ResolveRepo, over: Partial<ResolveContext["group"]> = {}, ts = MON_9AM): ResolveContext => ({
    ts,
    group: { id: "grp", kind: "site", siteId: S1, brokerId: null, shiftWordMap: {}, autoWrite: true, ...over },
    senderGuardId: null,
    senderTelNorm: null,
    sites: [{ id: S1, canonicalName: "測試盤", aliases: [] }],
    index,
    repo: r,
  });
  const deps: CardDeps = { scheduled: async () => [], recentSites: async () => new Map() };
  const pc = (over: Partial<PhotoCard> = {}): PhotoCard => ({ staff_no: null, name_zh: "測試甲", name_en: null, status: "confirmed", reasons: ["card_name_only"], candidates: [], votes: 2, doc_type: "punch_card", ...over });
  const photo = (cards: PhotoCard[]) => ({ kind: "photo" as const, photo: { kind: "cards", cards, usage: [], arbiter_used: false, engines: [] } as CardPhotoResult });

  it("盤口群：姓名喺該盤近 60 日有更嘅 guard 入面唯一（兩引擎讀同一名）→ confirmed，auto_write；更按相上時間推", async () => {
    const [r] = await resolveCardPhoto({ ctx: ctx(repo(["g1", "g2"])), input: photo([pc({ time_on: "20:10" })]), mediaId: null, deps });
    expect(r).toMatchObject({ guardId: "g1", siteId: S1, shiftTypeId: "t-n", routed: "auto_write" }); // ts 係 09:00，但相上打卡 20:10 → 夜更
    expect(r!.resolution.basis.person).toBe("card_name_in_scope");
    const [noTime] = await resolveCardPhoto({ ctx: ctx(repo(["g1"])), input: photo([pc()]), mediaId: null, deps });
    expect(noTime).toMatchObject({ shiftTypeId: "t-d" }); // 冇相上時間 → 用訊息 ts 09:00 → 日更
  });
  it("同名喺多個 guard，但範圍內只有一個 → 揀範圍內嗰個（唔誤揀另一盤同名者）", async () => {
    const [r] = await resolveCardPhoto({ ctx: ctx(repo(["g2"])), input: photo([pc({ name_zh: "測試乙" })]), mediaId: null, deps });
    expect(r).toMatchObject({ guardId: "g2", routed: "auto_write" });
  });
  it("範圍內同名多個／冇 → 揀人題（wa_person_ambiguous）：候選＝同名者＋同範圍字形接近嘅 guard；讀數未確認＝一撳確認", async () => {
    const [multi] = await resolveCardPhoto({ ctx: ctx(repo(["g2", "g3"])), input: photo([pc({ name_zh: "測試乙" })]), mediaId: null, deps });
    expect(multi!.guardId).toBeNull();
    expect(multi!.resolution.candidates.guard_ids).toEqual(expect.arrayContaining(["g2", "g3"]));
    expect(pickWaKind(multi!.resolution.reasons, "shift")).toBe("wa_person_ambiguous");
    const [none] = await resolveCardPhoto({ ctx: ctx(repo(["g1", "g4"])), input: photo([pc({ name_zh: "測試丁" })]), mediaId: null, deps });
    expect(none!.guardId).toBeNull();
    expect(none!.resolution.candidates.guard_ids).toEqual(expect.arrayContaining(["g1", "g4"])); // 同盤字形接近（共用「測試」）
    expect(pickWaKind(none!.resolution.reasons, "shift")).toBe("wa_person_ambiguous");
    const [review] = await resolveCardPhoto({ ctx: ctx(repo(["g1"])), input: photo([pc({ status: "review", votes: 1 })]), mediaId: null, deps });
    expect(review).toMatchObject({ guardId: "g1", routed: "triage" });
    expect(pickWaKind(review!.resolution.reasons, "shift")).toBe("wa_card_confirm");
  });
  it("判頭群：用該判頭旗下 guard 做範圍；大群（multi_site）冇範圍＝配到但要確認", async () => {
    const broker = { kind: "broker" as const, siteId: null, brokerId: "b1" };
    const rb = { ...repo([], ["g2"]) };
    const [b] = await resolveCardPhoto({ ctx: ctx(rb, broker), input: photo([pc({ name_zh: "測試乙" })]), mediaId: null, deps: { scheduled: async () => [{ siteId: S1, shiftTypeId: "t-d" }], recentSites: async () => new Map() } });
    expect(b).toMatchObject({ guardId: "g2", siteId: S1, shiftTypeId: "t-d", routed: "auto_write" });
    const [m] = await resolveCardPhoto({ ctx: ctx(repo([]), { kind: "multi_site", siteId: null }), input: photo([pc({ name_zh: "測試甲" })]), mediaId: null, deps: { scheduled: async () => [{ siteId: S1, shiftTypeId: "t-d" }], recentSites: async () => new Map() } });
    expect(m).toMatchObject({ guardId: "g1", routed: "triage" });
    expect(m!.resolution.reasons).toContain("card_name_only");
  });
  it("證據帶 doc_type／相上時間", async () => {
    const [r] = await resolveCardPhoto({ ctx: ctx(repo(["g1"])), input: photo([pc({ time_on: "08:07", doc_type: "app_screenshot" })]), mediaId: "m1", deps });
    expect(r!.src?.card).toMatchObject({ doc_type: "app_screenshot", time_on: "08:07", media_id: "m1" });
  });
});
