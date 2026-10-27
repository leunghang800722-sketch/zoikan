// WA-8.2：同一相多張卡提示＋「加多一位」。基於 wa8-card-flow 同一 harness。原：webhook 落庫（即時拉圖）→ parse job（辨識→歸屬）→ 自動寫入／分流題（wa_card_confirm）→ 答題 → 刪圖；圖片 GET 權限；指標。
// 引擎全部 fake（唔打任何 API／唔需要 tesseract）；合成 JPEG；假名、假工號（U9xxxx）。
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { runWhatsappParse } from "@/lib/jobs/whatsapp-parse";
import { ingestEvent } from "@/lib/whatsapp/ingest";
import type { NormalizedWaEvent } from "@/lib/whatsapp/schema";
import type { CardEngine, CardEngineName, EngineOutcome } from "@/lib/whatsapp/card-engines";
import { hasDistinctCandidates, similarStaffNos } from "@/lib/whatsapp/card-parse";
import { loadMediaEvidence } from "@/lib/whatsapp/media";
import { GET as sessionGet } from "@/app/api/triage/sessions/[id]/route";
import { POST as previewPost } from "@/app/api/triage/questions/[id]/preview/route";
import { POST as answerPost } from "@/app/api/triage/questions/[id]/answer/route";

const T0 = new Date("2026-10-19T01:00:00Z"); // HK 2026-10-19 09:00 星期一
const NOW = new Date(T0.getTime() + 60_000);
const G1 = "wa82-g1@g.us";
const BASE = "http://test.local";
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(300, 9), Buffer.from([0xff, 0xd9])]);

let fx: Wp2Fixture;
let boss: string;
let cookie: string;
let ids: { site: string; tD: string; gA: string; gB: string; gC: string };

const engineOut = (nos: string[], usage = true): EngineOutcome => ({ ok: true, is_card: nos.length > 0, cards: nos.map((n) => ({ is_card: true, staff_no: n, name_zh: null, name_en: null, confidence: "high" as const })), usage: usage ? { engine: "deepseek", model: "fake", promptTokens: 100, completionTokens: 10 } : null });
const fakeEngine = (name: CardEngineName, nos: string[]): CardEngine => ({ name, model: "fake", read: async () => engineOut(nos, name !== "tesseract") });
const engines = (a: string[], b: string[], arb: string[] = []) => ({ tesseract: fakeEngine("tesseract", a), deepseek: fakeEngine("deepseek", b), claude: { ...fakeEngine("claude", arb), name: "claude" as const } });

function ev(mid: string, over: Partial<NormalizedWaEvent> = {}): NormalizedWaEvent {
  return { kind: "message", session: "default", messageId: mid, chatJid: G1, senderJid: "85290009998@c.us", fromMe: false, ts: T0, text: "", mediaType: "image", mediaUrl: "http://x/api/files/default/a.jpg", mediaError: false, quotedMessageId: null, eventId: `e-${mid}`, ...over };
}
const feed = async (mid: string, e: Partial<NormalizedWaEvent> = {}) => ingestEvent(ev(mid, e), NOW);
const run = (en: ReturnType<typeof engines>) => runWhatsappParse(NOW, { force: true, cardEngines: en });
const recs = () => prisma.shiftRecord.findMany({ where: { siteId: ids.site }, orderBy: [{ createdAt: "asc" }] });
const req = (path: string, ck: string | null = cookie, method = "GET", body?: unknown) =>
  new Request(`${BASE}${path}`, { method, headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(ck ? { cookie: ck } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
const params = (id: string) => ({ params: Promise.resolve({ id }) });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = async (r: Response) => (await r.json()) as Record<string, any>;
const openQs = (mid: string) => prisma.triageQuestion.findMany({ where: { status: "open", session: { sourceType: "whatsapp" }, evidenceJson: { path: ["message", "message_id"], equals: mid } } });

beforeEach(async () => {
  process.env.WA_CARD_OCR_STRATEGY = "S1"; // 預設已改 S6；呢批測試注入 tesseract+deepseek，釘返 S1
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
  const gB = await prisma.guard.create({ data: { nameZh: "測試乙", employmentType: "cash_casual", tel: "90000012", createdBy: "test:w8" } });
  await prisma.guardStaffNumber.create({ data: { guardId: gB.id, scheme: "MP", number: "MP9002", status: "current" } });
  const gC = await prisma.guard.create({ data: { nameZh: "測試丙", employmentType: "cash_casual", tel: "90000013", createdBy: "test:w8" } });
  await prisma.guardStaffNumber.create({ data: { guardId: gC.id, scheme: "U", number: "U90002", status: "current" } });
  ids = { site: site.id, tD: tD.id, gA: gA.id, gB: gB.id, gC: gC.id };
  await prisma.whatsappGroup.create({ data: { groupJid: G1, label: "W8測試群", kind: "site", siteId: site.id, shiftWordMap: { 開工: "D" }, autoWrite: true, cardPhotoMode: true, createdBy: boss } });
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.WAHA_BASE_URL;
  delete process.env.WA_CARD_PRICE_USD_PER_MTOK;
});


const sessionQs = async (sid: string) => ((await json(await sessionGet(req(`/api/triage/sessions/${sid}`), params(sid)))).questions as Array<{ id: string; kind: string; wa?: { card?: { multi_hint: boolean; staff_no: string | null }; guard_candidates: Array<{ guard_id: string }> } }>);
const doAnswer = async (qid: string, ans: Record<string, unknown>) => {
  const pv = await previewPost(req(`/api/triage/questions/${qid}/preview`, cookie, "POST", { answer: ans }), params(qid));
  if (pv.status !== 200) return pv;
  const pj = await json(pv);
  return answerPost(req(`/api/triage/questions/${qid}/answer`, cookie, "POST", { answer: ans, preview_hash: pj.preview_hash }), params(qid));
};

describe("WA-8.2 提示判定（純函數）", () => {
  it("similarStaffNos：同前綴同長度差 ≤2 位＝相似；hasDistinctCandidates：有一對互不相似先提示", () => {
    expect(similarStaffNos("U01095", "U01096")).toBe(true);
    expect(similarStaffNos("U01095", "U01195")).toBe(true); // 差 1 位
    expect(similarStaffNos("U01095", "U02196")).toBe(false); // 差 3 位
    expect(similarStaffNos("U01095", "MP1095")).toBe(false);
    expect(hasDistinctCandidates(["U01095", "U01096"])).toBe(false);
    expect(hasDistinctCandidates(["U01095"])).toBe(false);
    expect(hasDistinctCandidates(["U01095", "U01096", "MP9002"])).toBe(true);
    expect(hasDistinctCandidates(["U01095", "bad"])).toBe(false);
  });
});

describe("WA-8.2 題卡提示＋加多一位", () => {
  it("兩引擎讀到唔同卡、仲裁讀唔到 → 一條揀人題＋multi_hint；揀 A 並加多 B → A 入更、同一相另開 B 嘅確認題（圖片保留）；答 B → 入更、圖刪走", async () => {
    await feed("h1");
    await run(engines(["U90001"], ["MP9002"], []));
    const [q] = await openQs("h1");
    expect(q!.kind).toBe("wa_person_ambiguous");
    expect(await openQs("h1")).toHaveLength(1); // 唔係幾條
    const view = (await sessionQs(q!.sessionId)).find((x) => x.id === q!.id)!;
    expect(view.wa?.card?.multi_hint).toBe(true);
    expect(view.wa!.guard_candidates.map((c) => c.guard_id).sort()).toEqual([ids.gA, ids.gB].sort());
    // 驗證：加多嘅一位要係候選之一、唔可以同今條一樣、唔可以配 wa_ignore
    expect((await doAnswer(q!.id, { option: "wa_pick_guard", guard_id: ids.gA, also_guard_id: ids.gC })).status).toBe(400);
    expect((await doAnswer(q!.id, { option: "wa_pick_guard", guard_id: ids.gA, also_guard_id: ids.gA })).status).toBe(400);
    expect((await doAnswer(q!.id, { option: "wa_ignore", also_guard_id: ids.gB })).status).toBe(400);
    expect(await recs()).toHaveLength(0);
    // 真答
    const r = await doAnswer(q!.id, { option: "wa_pick_guard", guard_id: ids.gA, also_guard_id: ids.gB });
    expect(r.status).toBe(200);
    expect((await recs()).map((x) => x.guardId)).toEqual([ids.gA]);
    const open2 = await openQs("h1");
    expect(open2).toHaveLength(1);
    expect(open2[0]!.kind).toBe("wa_card_confirm");
    const ev2 = open2[0]!.evidenceJson as { intent: { guard_id: string }; card: { staff_no_read: string; media_id: string | null; others: Array<{ staff_no: string | null }> }; message: { idx: number } };
    expect(ev2.intent.guard_id).toBe(ids.gB);
    expect(ev2.card.staff_no_read).toBe("MP9002");
    expect(ev2.card.media_id).not.toBeNull(); // 仲有 open 題 → 圖片保留
    expect(await loadMediaEvidence("h1")).not.toBeNull();
    expect(ev2.message.idx).toBeGreaterThan(0);
    const r2 = await doAnswer(open2[0]!.id, { option: "wa_accept" });
    expect(r2.status).toBe(200);
    expect((await recs()).map((x) => x.guardId).sort()).toEqual([ids.gA, ids.gB].sort());
    expect(await loadMediaEvidence("h1")).toBeNull(); // 全部答完 → 刪圖
  });

  it("候選工號相似（差 ≤2 位）→ 唔顯示提示", async () => {
    await feed("h2");
    await run(engines(["U90001"], ["U90002"], []));
    const [q] = await openQs("h2");
    expect(q!.kind).toBe("wa_person_ambiguous");
    const view = (await sessionQs(q!.sessionId)).find((x) => x.id === q!.id)!;
    expect(view.wa?.card?.multi_hint).toBe(false);
  });

  it("wa_card_confirm（疑似第二張，工號唔相似）亦有提示；加多一位對象係同相另一位", async () => {
    await prisma.guardStaffNumber.create({ data: { guardId: ids.gB, scheme: "U", number: "U55555", status: "current" } });
    await feed("h3");
    // 引擎 A 見到兩張卡（U90001＋MP9002），B／仲裁只見 U90001 → MP9002 疑似第二張
    await run(engines(["U90001", "MP9002"], ["U90001"], ["U90001"]));
    const qs = await openQs("h3");
    expect(qs.map((x) => x.kind)).toEqual(["wa_card_confirm"]);
    const view = (await sessionQs(qs[0]!.sessionId)).find((x) => x.id === qs[0]!.id)!;
    expect(view.wa?.card?.multi_hint).toBe(true);
    // 已確認嗰張 U90001 已經自動寫入
    expect((await recs()).map((x) => x.guardId)).toEqual([ids.gA]);
  });
});
