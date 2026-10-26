// WA-8 D：工卡相端到端——webhook 落庫（即時拉圖）→ parse job（辨識→歸屬）→ 自動寫入／分流題（wa_card_confirm）→ 答題 → 刪圖；圖片 GET 權限；指標。
// 引擎全部 fake（唔打任何 API／唔需要 tesseract）；合成 JPEG；假名、假工號（U9xxxx）。
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { runWhatsappParse } from "@/lib/jobs/whatsapp-parse";
import { ingestEvent } from "@/lib/whatsapp/ingest";
import type { NormalizedWaEvent } from "@/lib/whatsapp/schema";
import type { CardEngine, CardEngineName, EngineOutcome } from "@/lib/whatsapp/card-engines";
import { computeMetrics } from "@/lib/whatsapp/metrics";
import { loadMediaEvidence } from "@/lib/whatsapp/media";
import { GET as mediaGet } from "@/app/api/whatsapp/media/[id]/route";
import { GET as sessionGet } from "@/app/api/triage/sessions/[id]/route";
import { POST as previewPost } from "@/app/api/triage/questions/[id]/preview/route";
import { POST as answerPost } from "@/app/api/triage/questions/[id]/answer/route";

const T0 = new Date("2026-10-19T01:00:00Z"); // HK 2026-10-19 09:00 星期一
const NOW = new Date(T0.getTime() + 60_000);
const G1 = "wa8-flow-g1@g.us";
const BASE = "http://test.local";
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(300, 9), Buffer.from([0xff, 0xd9])]);

let fx: Wp2Fixture;
let boss: string;
let cookie: string;
let ids: { site: string; tD: string; gA: string };

const engineOut = (nos: string[], usage = true): EngineOutcome => ({ ok: true, is_card: nos.length > 0, cards: nos.map((n) => ({ is_card: true, staff_no: n, name_zh: null, name_en: null, confidence: "high" as const })), usage: usage ? { engine: "deepseek", model: "fake", promptTokens: 100, completionTokens: 10 } : null });
const fakeEngine = (name: CardEngineName, nos: string[]): CardEngine => ({ name, model: "fake", read: async () => engineOut(nos, name !== "tesseract") });
const engines = (a: string[], b: string[], arb: string[] = []) => ({ tesseract: fakeEngine("tesseract", a), deepseek: fakeEngine("deepseek", b), claude: { ...fakeEngine("claude", arb), name: "claude" as const } });

function ev(mid: string, over: Partial<NormalizedWaEvent> = {}): NormalizedWaEvent {
  return { kind: "message", session: "default", messageId: mid, chatJid: G1, senderJid: "85290009998@c.us", fromMe: false, ts: T0, text: "", mediaType: "image", mediaUrl: "http://x/api/files/default/a.jpg", mediaError: false, quotedMessageId: null, eventId: `e-${mid}`, ...over };
}
const feed = async (mid: string, e: Partial<NormalizedWaEvent> = {}) => ingestEvent(ev(mid, e), NOW);
const run = (en: ReturnType<typeof engines>) => runWhatsappParse(NOW, { force: true, cardEngines: en });
const setGroup = (data: Record<string, unknown>) => prisma.whatsappGroup.update({ where: { groupJid: G1 }, data });
const recs = () => prisma.shiftRecord.findMany({ where: { siteId: ids.site }, orderBy: [{ createdAt: "asc" }] });
const req = (path: string, ck: string | null = cookie, method = "GET", body?: unknown) =>
  new Request(`${BASE}${path}`, { method, headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(ck ? { cookie: ck } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
const params = (id: string) => ({ params: Promise.resolve({ id }) });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = async (r: Response) => (await r.json()) as Record<string, any>;
const openQs = (mid: string) => prisma.triageQuestion.findMany({ where: { status: "open", session: { sourceType: "whatsapp" }, evidenceJson: { path: ["message", "message_id"], equals: mid } } });

beforeEach(async () => {
  await clearAll();
  await prisma.triageQuestion.deleteMany({});
  await prisma.triageSession.deleteMany({});
  fx = await seedWp2Fixture();
  boss = fx.userIds["老闆"];
  cookie = await sessionCookieForUser(boss);
  process.env.WAHA_BASE_URL = "http://waha.test:3000";
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JPEG as never, { status: 200 })));
  const site = await prisma.site.create({ data: { canonicalName: "測試盤W8", clientName: "測試客戶W8", billingModel: "per_shift", createdBy: "test:w8" } });
  const tD = await prisma.shiftType.create({ data: { siteId: site.id, code: "D", label: "日更", startTime: new Date("1970-01-01T08:00:00Z"), endTime: new Date("1970-01-01T20:00:00Z"), hours: 12, createdBy: "test:w8" } as never });
  const gA = await prisma.guard.create({ data: { nameZh: "測試甲", employmentType: "cash_casual", tel: "90000011", createdBy: "test:w8" } });
  await prisma.guardStaffNumber.create({ data: { guardId: gA.id, scheme: "U", number: "U90001", status: "current" } });
  ids = { site: site.id, tD: tD.id, gA: gA.id };
  await prisma.whatsappGroup.create({ data: { groupJid: G1, label: "W8測試群", kind: "site", siteId: site.id, shiftWordMap: { 開工: "D" }, autoWrite: true, cardPhotoMode: true, createdBy: boss } });
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.WAHA_BASE_URL;
  delete process.env.WA_CARD_PRICE_USD_PER_MTOK;
});

describe("WA-8 D 工卡相端到端", () => {
  it("兩引擎工號一致＋自動寫入開 → 寫 pending_approval（source whatsapp）、冇分流題、暫存圖即刪、冇仲裁", async () => {
    expect(await feed("c1")).toBe("inserted");
    expect(await loadMediaEvidence("c1")).not.toBeNull();
    await run(engines(["U90001"], ["U90001"]));
    const rs = await recs();
    expect(rs).toHaveLength(1);
    expect(rs[0]).toMatchObject({ guardId: ids.gA, shiftTypeId: ids.tD, status: "pending_approval", source: "whatsapp" });
    expect(rs[0]!.workDate.toISOString().slice(0, 10)).toBe("2026-10-19");
    expect(rs[0]!.provenance).toMatchObject({ message_id: "c1", revision: 1 });
    expect(await openQs("c1")).toHaveLength(0);
    expect(await loadMediaEvidence("c1")).toBeNull(); // 全自動：即時刪
    const m = await prisma.whatsappMessage.findUniqueOrThrow({ where: { messageId: "c1" } });
    expect(m).toMatchObject({ status: "routed", llmProvider: "card" });
    const cardJson = (m.parsedJson as { card: Record<string, unknown> }).card;
    expect(cardJson).toMatchObject({ kind: "cards", confirmed: 1, review: 0, arbiter: null });
    expect(JSON.stringify(m.parsedJson)).not.toMatch(/U90001/); // 只記計數／引擎名／token，唔含工號
  });

  it("群組冇開自動寫入 → wa_card_confirm 題（帶圖片）；答「確認入更」→ 寫入、題 answered、暫存圖刪走", async () => {
    await setGroup({ autoWrite: false });
    await feed("c2");
    await run(engines(["U90001"], ["U90001"]));
    expect(await recs()).toHaveLength(0);
    const [q] = await openQs("c2");
    expect(q!.kind).toBe("wa_card_confirm");
    expect((q!.optionsJson as Array<{ id: string }>).map((o) => o.id)).toEqual(["wa_accept", "wa_manual", "wa_ignore", "skip"]);
    const card = (q!.evidenceJson as { card: { media_id: string; staff_no_read: string } }).card;
    expect(card.staff_no_read).toBe("U90001");
    // 圖片 GET：有權限 → 200 解密一致；冇登入 → 401；雞頭 → 403
    const img = await mediaGet(req(`/api/whatsapp/media/${card.media_id}`), params(card.media_id));
    expect(img.status).toBe(200);
    expect(img.headers.get("cache-control")).toContain("no-store");
    expect(Buffer.from(await img.arrayBuffer()).equals(JPEG)).toBe(true);
    expect((await mediaGet(req(`/api/whatsapp/media/${card.media_id}`, null), params(card.media_id))).status).toBe(401);
    const brokerCk = await sessionCookieForUser(fx.userIds["雞頭"]);
    expect((await mediaGet(req(`/api/whatsapp/media/${card.media_id}`, brokerCk), params(card.media_id))).status).toBe(403);
    expect((await mediaGet(req(`/api/whatsapp/media/not-a-real-id`), params("not-a-real-id"))).status).toBe(404);
    // session DTO 帶 wa.card（含圖片 URL，冇值洩漏給冇權限者）
    const sid = q!.sessionId;
    const sj = await json(await sessionGet(req(`/api/triage/sessions/${sid}`), params(sid)));
    const view = (sj.questions as Array<{ id: string; wa?: { card?: { media_url: string; staff_no: string } } }>).find((x) => x.id === q!.id)!;
    expect(view.wa?.card).toMatchObject({ media_url: `/api/whatsapp/media/${card.media_id}`, staff_no: "U90001" });
    // 答題
    const ans = { option: "wa_accept" };
    const pv = await json(await previewPost(req(`/api/triage/questions/${q!.id}/preview`, cookie, "POST", { answer: ans }), params(q!.id)));
    const r = await answerPost(req(`/api/triage/questions/${q!.id}/answer`, cookie, "POST", { answer: ans, preview_hash: pv.preview_hash }), params(q!.id));
    expect(r.status).toBe(200);
    expect(await recs()).toHaveLength(1);
    expect((await prisma.triageQuestion.findUniqueOrThrow({ where: { id: q!.id } })).status).toBe("answered");
    expect(await loadMediaEvidence("c2")).toBeNull();
    expect((await mediaGet(req(`/api/whatsapp/media/${card.media_id}`), params(card.media_id))).status).toBe(404);
  });

  it("兩引擎唔一致 → 仲裁一次（三取二）→ 自動寫入；三個都唔同 → 揀人題（候選 guard），唔寫", async () => {
    await feed("c3");
    await run(engines(["U90002"], ["U90001"], ["U90001"])); // tesseract 讀錯，deepseek＋仲裁一致
    expect(await recs()).toHaveLength(1);
    const m = await prisma.whatsappMessage.findUniqueOrThrow({ where: { messageId: "c3" } });
    expect((m.parsedJson as { card: { arbiter: string } }).card.arbiter).toBe("S1");
    // 第二張：三個都唔同
    await feed("c4", { ts: new Date(T0.getTime() + 5000) });
    await run(engines(["U90001"], ["MP9999"], ["MG8888"]));
    const [q] = await openQs("c4");
    expect(["wa_person_ambiguous", "wa_person_unknown"]).toContain(q!.kind);
    expect(await recs()).toHaveLength(1);
  });

  it("相片過期（拉唔到）→ wa_card_confirm（相片已過期，只可人手／忽略）；唔係工卡 → 同樣題型；暫存圖冇", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("gone", { status: 404 })));
    await feed("c5");
    expect((await prisma.whatsappMessage.findUniqueOrThrow({ where: { messageId: "c5" } })).mediaState).toBe("expired");
    await run(engines([], []));
    const [q] = await openQs("c5");
    expect(q!.kind).toBe("wa_card_confirm");
    expect((q!.evidenceJson as { card: { none: string } }).card.none).toBe("expired");
    expect((q!.optionsJson as Array<{ id: string }>).map((o) => o.id)).toEqual(["wa_manual", "wa_ignore", "skip"]);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JPEG as never, { status: 200 })));
    await feed("c6", { ts: new Date(T0.getTime() + 9000) });
    await run(engines([], []));
    const [q6] = await openQs("c6");
    expect(q6!.kind).toBe("wa_card_confirm");
    expect((q6!.evidenceJson as { card: { none: string } }).card.none).toBe("not_card");
    expect(await recs()).toHaveLength(0);
  });

  it("群組關住 card_photo_mode 嘅圖片：照舊 media_only 略過（唔拉圖、唔辨識）", async () => {
    await setGroup({ cardPhotoMode: false });
    await feed("c7");
    await run(engines(["U90001"], ["U90001"]));
    const m = await prisma.whatsappMessage.findUniqueOrThrow({ where: { messageId: "c7" } });
    expect(m).toMatchObject({ status: "ignored", mediaState: null });
    expect(m.filterReasons).toEqual(["media_only"]);
    expect(await recs()).toHaveLength(0);
  });

  it("指標：card_photos／ok／triage／fail／仲裁次數／預估成本（env 單價；冇設＝null）", async () => {
    await feed("m1");
    await run(engines(["U90001"], ["U90001"])); // ok
    vi.stubGlobal("fetch", vi.fn(async () => new Response("gone", { status: 404 })));
    await feed("m2", { ts: new Date(T0.getTime() + 4000) });
    await run(engines([], [])); // fail（expired）→ 題
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JPEG as never, { status: 200 })));
    await feed("m3", { ts: new Date(T0.getTime() + 8000) });
    await run(engines(["U90002"], ["U90001"], ["U90001"])); // 仲裁
    const now = new Date(T0.getTime() + 3600_000);
    const m0 = await computeMetrics(7, now);
    expect(m0.totals).toMatchObject({ card_photos: 3, card_ok: 2, card_triage: 1, card_fail: 1, card_arbiter: 1, card_cost_est: null });
    process.env.WA_CARD_PRICE_USD_PER_MTOK = JSON.stringify({ deepseek: { in: 1, out: 2 }, claude: { in: 10, out: 20 } });
    const m1 = await computeMetrics(7, now);
    expect(m1.totals.card_cost_est).not.toBeNull();
    expect(m1.totals.card_cost_est!).toBeGreaterThan(0);
    const g = m1.groups.find((x) => x.label === "W8測試群")!;
    expect(g).toMatchObject({ card_photos: 3, card_arbiter: 1 });
    expect(JSON.stringify(m1)).not.toMatch(/U9000/);
  });
});
