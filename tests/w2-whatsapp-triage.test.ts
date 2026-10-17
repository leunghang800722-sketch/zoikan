// W2：WhatsApp 分診題——六種 kind 產題（冪等、revision supersede、撤回）、owner、通知（無 PII）、
// 答題（預覽→確認→寫入 pending_approval／再問／略過／忽略／人手）、alias 學習、取消舊記錄同 tx、鎖月 400、
// 同一 intent 最多兩輪、RBAC、遮罩、batch-accept 白名單。全部假資料（測試甲／乙／明一／明二，假群、假電話）；LLM 用腳本化 fake。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { runWhatsappParse } from "@/lib/jobs/whatsapp-parse";
import { ingestEvent } from "@/lib/whatsapp/ingest";
import type { NormalizedWaEvent } from "@/lib/whatsapp/schema";
import type { LlmClient, LlmChatParams } from "@/lib/ai/llm";
import { pickWaOwner } from "@/lib/whatsapp/triage";
import { waQuestionViews, WA_LOCKED_MSG } from "@/lib/whatsapp/triage-answer";
import { POST as previewPost } from "@/app/api/triage/questions/[id]/preview/route";
import { POST as answerPost } from "@/app/api/triage/questions/[id]/answer/route";
import { GET as sessionGet } from "@/app/api/triage/sessions/[id]/route";
import { GET as sessionsGet } from "@/app/api/triage/sessions/route";
import { GET as batchPreviewGet } from "@/app/api/triage/questions/batch-accept/preview/route";
import { POST as batchPost } from "@/app/api/triage/questions/batch-accept/route";
import { GET as intentsGet } from "@/app/api/whatsapp/intents/route";

const T0 = new Date("2026-10-16T05:00:00Z"); // HK 2026-10-16 13:00 星期五
const NOW = new Date(T0.getTime() + 60_000);
const G1 = "w2-g1@g.us";
const SENDER_X = "85290009999@c.us"; // 未知發訊人
const BASE = "http://test.local";

let fx: Wp2Fixture;
let ids: { site: string; tA: string; tN: string; gA: string; gB: string; gM1: string; gM2: string; gC: string };
let boss: string;
let cookie: string;

const intent = (over: Record<string, unknown> = {}) => ({
  type: "shift",
  date: { raw: "聽日", kind: "relative", iso_guess: null, to_iso_guess: null },
  site_raw: null,
  persons: [{ raw: "測試乙", role: "worker" }],
  self_reference: false,
  shift_raw: "夜",
  shift_code_guess: null,
  hours: null,
  leave_raw: null,
  leave_code_guess: null,
  confidence: 0.85,
  evidence: "e",
  ...over,
});
const llmJson = (over: Record<string, unknown> = {}) => JSON.stringify({ noise: false, intents: [intent(over)] });
const person = (raw: string) => ({ persons: [{ raw, role: "worker" }] });

function fakeLlm(script: (text: string) => string): LlmClient {
  return {
    async chat(params: LlmChatParams) {
      const text = (JSON.parse(params.userMessage) as { text: string }).text;
      return { text: script(text), toolsUsed: [], inputTokens: 10, outputTokens: 5, provider: "fake", model: "fake-m" };
    },
  };
}
function ev(kind: "message" | "edited" | "revoked", mid: string, text: string, tsOffsetSec = 0, over: Partial<NormalizedWaEvent> = {}): NormalizedWaEvent {
  return { kind, session: "default", messageId: mid, chatJid: G1, senderJid: SENDER_X, fromMe: false, ts: new Date(T0.getTime() + tsOffsetSec * 1000), text, mediaType: null, quotedMessageId: null, eventId: `${mid}-${kind}-${tsOffsetSec}-${text.length}`, ...over };
}
const ingest = (e: NormalizedWaEvent) => ingestEvent(e, new Date(Math.max(NOW.getTime(), (e.ts?.getTime() ?? 0) + 60_000)));
const run = (llm: LlmClient) => runWhatsappParse(NOW, { llm: [llm], force: true });
/** 收一條訊息並跑 job（腳本化 LLM 回固定 intent json）。 */
async function feed(mid: string, text: string, json: string, offset = 0, over: Partial<NormalizedWaEvent> = {}) {
  await ingest(ev("message", mid, text, offset, over));
  await run(fakeLlm(() => json));
}
const qsOf = (mid: string) => prisma.triageQuestion.findMany({ where: { session: { sourceType: "whatsapp" }, evidenceJson: { path: ["message", "message_id"], equals: mid } }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
const openQ = async (mid: string) => (await qsOf(mid)).filter((q) => q.status === "open");
/** 剔走 uuid／ISO 時間戳再睇有冇 8 位連續數字（uuid 有機會含 8 位數字，唔剔會 flaky）。 */
const stripIds = (v: unknown): string => JSON.stringify(v).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<id>").replace(/\d{4}-\d{2}-\d{2}(T[\d:.]+Z)?/g, "<date>");
const evidence = (q: { evidenceJson: unknown }) => q.evidenceJson as Record<string, unknown> & { candidates: { guard_ids: string[]; dates: string[] }; round: number; text: string };

function post(path: string, body: unknown, ck: string | null = cookie) {
  return new Request(`${BASE}${path}`, { method: "POST", headers: { "content-type": "application/json", ...(ck ? { cookie: ck } : {}) }, body: JSON.stringify(body) });
}
function get(path: string, ck: string | null = cookie) {
  return new Request(`${BASE}${path}`, { headers: ck ? { cookie: ck } : {} });
}
const params = (id: string) => ({ params: Promise.resolve({ id }) });
async function preview(qid: string, answer: Record<string, unknown>, ck: string | null = cookie) {
  const res = await previewPost(post(`/api/triage/questions/${qid}/preview`, { answer }, ck), params(qid));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}
async function answer(qid: string, ans: Record<string, unknown>, hash?: string, ck: string | null = cookie) {
  const res = await answerPost(post(`/api/triage/questions/${qid}/answer`, { answer: ans, ...(hash ? { preview_hash: hash } : {}) }, ck), params(qid));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}
/** 預覽＋確認（寫入類答案）。 */
async function confirm(qid: string, ans: Record<string, unknown>) {
  const pv = await preview(qid, ans);
  expect(pv.status).toBe(200);
  return answer(qid, ans, pv.body.preview_hash);
}
const recOf = (guardId: string, iso: string) => prisma.shiftRecord.findMany({ where: { guardId, workDate: new Date(`${iso}T00:00:00Z`) } });

beforeEach(async () => {
  await clearAll();
  fx = await seedWp2Fixture();
  boss = fx.userIds["老闆"];
  cookie = await sessionCookieForUser(boss);
  const site = await prisma.site.create({ data: { canonicalName: "測試盤W2", clientName: "測試客戶W2", billingModel: "per_shift", createdBy: "test:w2" } });
  const tA = await prisma.shiftType.create({ data: { siteId: site.id, code: "A", label: "早更", startTime: new Date("1970-01-01T07:00:00Z"), endTime: new Date("1970-01-01T15:00:00Z"), hours: 8, createdBy: "test:w2" } });
  const tN = await prisma.shiftType.create({ data: { siteId: site.id, code: "N", label: "夜更", startTime: new Date("1970-01-01T19:00:00Z"), endTime: new Date("1970-01-01T07:00:00Z"), hours: 12, createdBy: "test:w2" } });
  const mk = (nameZh: string, tel: string, extra: Record<string, unknown> = {}) => prisma.guard.create({ data: { nameZh, employmentType: "cash_casual", tel, createdBy: "test:w2", ...extra } as never });
  const gA = await mk("測試甲", "90000011");
  const gB = await mk("測試乙", "90000012", { nameAliases: ["阿乙"] });
  const gM1 = await mk("測試明一", "90000013", { nameAliases: ["阿明"] });
  const gM2 = await mk("測試明二", "90000014", { nameAliases: ["阿明"] });
  const gC = await mk("測試丙", "90000015");
  ids = { site: site.id, tA: tA.id, tN: tN.id, gA: gA.id, gB: gB.id, gM1: gM1.id, gM2: gM2.id, gC: gC.id };
  await prisma.whatsappGroup.create({ data: { groupJid: G1, label: "W2測試群一", kind: "site", siteId: site.id, shiftWordMap: { 早: "A", 夜: "N" }, createdBy: boss } });
});
afterEach(async () => {
  await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS w2_fail_trg ON audit_log`);
  await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS w2_fail()`);
});

// ---------------------------------------------------------------------------
describe("W2 產題：六種 kind、session、owner、冪等、通知", () => {
  it("wa_person_ambiguous：session／owner／evidence／options／result_ref／冇電話全號", async () => {
    await feed("p1", "阿明聽日夜更", llmJson(person("阿明")));
    const qs = await qsOf("p1");
    expect(qs).toHaveLength(1);
    const q = qs[0]!;
    expect(q).toMatchObject({ kind: "wa_person_ambiguous", status: "open", groupKey: "p1:1:0" });
    const session = await prisma.triageSession.findUniqueOrThrow({ where: { id: q.sessionId }, include: { owner: { include: { role: true } } } });
    expect(session).toMatchObject({ sourceType: "whatsapp", sourceRef: `${G1}:2026-10`, status: "open" });
    expect(session.owner.role.baseRole).toBe("老闆");
    const e = evidence(q);
    expect(e.text).toBe("阿明聽日夜更");
    expect([...e.candidates.guard_ids].sort()).toEqual([ids.gM1, ids.gM2].sort());
    expect(stripIds(q.evidenceJson)).not.toMatch(/\d{8}/); // 冇電話全號
    expect(JSON.stringify(q.evidenceJson)).toContain("9999"); // 發訊人只留尾 4 位
    const opts = q.optionsJson as Array<{ id: string; guard_id?: string; input?: string }>;
    expect(opts.filter((o) => o.id === "wa_pick_guard" && o.guard_id).map((o) => o.guard_id).sort()).toEqual([ids.gM1, ids.gM2].sort());
    expect(opts.some((o) => o.id === "wa_pick_guard" && o.input === "guard_search")).toBe(true);
    expect(opts.some((o) => o.id === "skip")).toBe(true);
    const [it0] = await prisma.whatsappIntent.findMany({ where: { messageId: "p1" } });
    expect(it0).toMatchObject({ routed: "triage", resultRef: q.id });
  });

  it("冪等：同一 intent 重跑（重置 received）唔重覆開題，result_ref 指返同一題", async () => {
    await feed("p2", "阿明聽日夜更", llmJson(person("阿明")));
    const [q] = await qsOf("p2");
    await prisma.whatsappMessage.update({ where: { messageId: "p2" }, data: { status: "received" } });
    await run(fakeLlm(() => llmJson(person("阿明"))));
    expect(await qsOf("p2")).toHaveLength(1);
    expect((await prisma.whatsappIntent.findFirstOrThrow({ where: { messageId: "p2" } })).resultRef).toBe(q!.id);
  });

  it("通知 owner：kind=whatsapp_triage、audience=owner、title／body 冇姓名／電話／原話", async () => {
    await feed("p3", "阿明聽日夜更", llmJson(person("阿明")));
    const [q] = await qsOf("p3");
    const session = await prisma.triageSession.findUniqueOrThrow({ where: { id: q!.sessionId } });
    const n = await prisma.appNotification.findMany({ where: { kind: "whatsapp_triage" } });
    expect(n).toHaveLength(1);
    expect(n[0]!.audience).toEqual([session.ownerUserId]);
    expect(`${n[0]!.title}${n[0]!.body}`).not.toMatch(/阿明|測試|\d{8}|W2測試群/);
    expect(n[0]!.href).toBe("/triage");
    // 同一 session 同一日再有新題 → dedupe，仍然 1 條
    await feed("p3b", "阿明後日夜更", llmJson({ ...person("阿明"), date: { raw: "後日", kind: "relative" } }), 5);
    expect(await prisma.appNotification.count({ where: { kind: "whatsapp_triage" } })).toBe(1);
  });

  it("六種 kind 都產到題（site／person_unknown／date／conflict／unparsed）", async () => {
    await feed("k-site", "唔存在盤聽日測試乙返夜", llmJson({ site_raw: "完全唔存在盤XYZ" }), 0);
    await feed("k-unk", "陌生人聽日夜更", llmJson(person("陌生人")), 1);
    await feed("k-date", "今晚測試乙返夜", llmJson({ date: { raw: "今晚", kind: "relative" } }), 13 * 3600);
    await prisma.shiftRecord.create({ data: { workDate: new Date("2026-10-17T00:00:00Z"), siteId: ids.site, shiftTypeId: ids.tA, guardId: ids.gA, recordType: "shift", status: "confirmed", createdBy: "test:w2" } });
    await feed("k-conf", "測試甲聽日夜更", llmJson(person("測試甲")), 2);
    await feed("k-cover", "測試甲頂測試乙聽日夜更", llmJson({ type: "cover", persons: [{ raw: "測試甲", role: "worker" }, { raw: "測試乙", role: "replaced" }] }), 3);
    const kinds = Object.fromEntries(await Promise.all(["k-site", "k-unk", "k-date", "k-conf", "k-cover"].map(async (m) => [m, (await qsOf(m))[0]?.kind])));
    expect(kinds).toEqual({ "k-site": "wa_site_ambiguous", "k-unk": "wa_person_unknown", "k-date": "wa_date_ambiguous", "k-conf": "wa_shift_conflict", "k-cover": "wa_cover" });
  });

  it("優先次序 unparsed > site > person > date > conflict（一條 intent 同時卡幾樣，只出最優先一題）", async () => {
    await feed("o1", "聽日夜更", llmJson({ site_raw: "完全唔存在盤XYZ", ...person("陌生人"), date: null }));
    const qs = await qsOf("o1");
    expect(qs).toHaveLength(1);
    expect(qs[0]!.kind).toBe("wa_site_ambiguous");
    await feed("o2", "聽日夜更", llmJson({ ...person("陌生人"), date: null }), 1);
    expect((await qsOf("o2"))[0]!.kind).toBe("wa_person_unknown");
    await feed("o3", "聽日夜更", llmJson({ ...person("陌生人"), shift_raw: "神秘更" }), 2);
    expect((await qsOf("o3"))[0]!.kind).toBe("wa_unparsed");
  });

  it("owner：群綁定盤有判頭分配、而判頭用戶屬主管 → 主管；否則老闆", async () => {
    const mgr = fx.userIds["主管"];
    expect(await pickWaOwner(prisma, ids.site)).toBe(boss);
    await prisma.brokerSiteAssignment.create({ data: { brokerId: fx.brokerA.id, siteId: ids.site, month: new Date("2026-10-01T00:00:00Z"), createdBy: "test:w2" } });
    await prisma.user.update({ where: { id: mgr }, data: { brokerId: fx.brokerA.id } });
    expect(await pickWaOwner(prisma, ids.site)).toBe(mgr);
    expect(await pickWaOwner(prisma, null)).toBe(boss);
    // 雞頭用戶（唔屬 TRIAGE_OWNER_ROLES）唔會被揀
    await prisma.user.update({ where: { id: mgr }, data: { brokerId: null } });
    await prisma.user.update({ where: { id: fx.userIds["雞頭"] }, data: { brokerId: fx.brokerA.id } });
    expect(await pickWaOwner(prisma, ids.site)).toBe(boss);
  });

  it("revision supersede：編輯 → 舊 revision open 題 superseded，新題 groupKey 帶 revision 2；撤回 → 全部 superseded", async () => {
    await feed("r1", "阿明聽日夜更", llmJson(person("阿明")));
    await ingest(ev("edited", "r1", "阿明聽日夜更，唔該", 60));
    await run(fakeLlm(() => llmJson(person("阿明"))));
    const qs = await qsOf("r1");
    expect(qs.map((q) => [q.groupKey, q.status])).toEqual([["r1:1:0", "superseded"], ["r1:2:0", "open"]]);
    expect(evidence(qs[1]!).text).toBe("阿明聽日夜更，唔該");
    await ingest(ev("revoked", "r1", "", 120));
    await run(fakeLlm(() => llmJson(person("阿明"))));
    expect((await qsOf("r1")).map((q) => q.status)).toEqual(["superseded", "superseded"]);
    const session = await prisma.triageSession.findFirstOrThrow({ where: { sourceType: "whatsapp" } });
    expect(session.status).toBe("done");
    // 已撤回 → 答題 409
    const dead = (await qsOf("r1"))[1]!;
    expect((await preview(dead.id, { option: "skip" })).status).toBe(409);
  });

  it("新 revision 被過濾（編輯成閒話）→ 舊 open 題 superseded、冇新題", async () => {
    await feed("r2", "阿明聽日夜更", llmJson(person("阿明")));
    await ingest(ev("edited", "r2", "唔使喇多謝", 60));
    await run(fakeLlm(() => llmJson(person("阿明"))));
    expect((await qsOf("r2")).map((q) => q.status)).toEqual(["superseded"]);
  });
});

// ---------------------------------------------------------------------------
describe("W2 答題：寫入 pending_approval、alias 學習、冪等、hash", () => {
  it("wa_person_unknown → 搜尋揀人＋記住花名：寫入 pending_approval（source／provenance）、alias 加入＋audit、之後同一花名自動解到", async () => {
    await feed("a1", "明仔聽日夜更", llmJson(person("明仔")));
    const [q] = await qsOf("a1");
    expect(q!.kind).toBe("wa_person_unknown");
    const ans = { option: "wa_pick_guard", guard_id: ids.gM1, remember_alias: true };
    const pv = await preview(q!.id, ans);
    expect(pv.status).toBe(200);
    expect(pv.body.writes).toBe(true);
    expect(pv.body.impact.summary.join("")).toContain("待批核");
    expect(pv.body.impact.summary.join("")).toContain("記住呢個花名");
    expect(await prisma.shiftRecord.count({ where: { source: "whatsapp" } })).toBe(0); // 預覽唔寫
    const res = await answer(q!.id, ans, pv.body.preview_hash);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("answered");
    const [rec] = await recOf(ids.gM1, "2026-10-17");
    expect(rec).toMatchObject({ status: "pending_approval", source: "whatsapp", shiftTypeId: ids.tN, siteId: ids.site, recordType: "shift" });
    expect(rec!.provenance).toEqual({ message_id: "a1", revision: 1, intent_idx: 0, triage_question_id: q!.id });
    const g = await prisma.guard.findUniqueOrThrow({ where: { id: ids.gM1 } });
    expect(g.nameAliases).toContain("明仔");
    const audits = await prisma.auditLog.findMany({ where: { tableName: "guards", rowId: ids.gM1, action: "update" } });
    expect(audits.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(audits.map((a) => a.after))).toContain("whatsapp_triage");
    const done = await prisma.triageQuestion.findUniqueOrThrow({ where: { id: q!.id } });
    expect(done).toMatchObject({ status: "answered", answeredBy: boss });
    expect(done.applyResultJson).toMatchObject({ plan: "write", alias_added: true });
    expect((await prisma.triageSession.findUniqueOrThrow({ where: { id: q!.sessionId } })).status).toBe("done");
    // 重覆作答 → 409
    expect((await answer(q!.id, ans, pv.body.preview_hash)).status).toBe(409);
    // 第二次同一花名 → 自動（唔開題）
    await feed("a1b", "明仔後日夜更", llmJson({ ...person("明仔"), date: { raw: "後日", kind: "relative" } }), 30);
    expect((await prisma.whatsappIntent.findFirstOrThrow({ where: { messageId: "a1b" } })).routed).toBe("auto_write");
    expect(await qsOf("a1b")).toHaveLength(0);
  });

  it("wa_person_ambiguous：揀候選一鍵寫入；冇勾記住花名就唔加 alias", async () => {
    await feed("a2", "阿明聽日夜更", llmJson(person("阿明")));
    const [q] = await qsOf("a2");
    const r = await confirm(q!.id, { option: "wa_pick_guard", guard_id: ids.gM2 });
    expect(r.status).toBe(200);
    expect((await recOf(ids.gM2, "2026-10-17"))[0]).toMatchObject({ status: "pending_approval", source: "whatsapp" });
    expect((await prisma.guard.findUniqueOrThrow({ where: { id: ids.gM2 } })).nameAliases).toEqual(["阿明"]);
  });

  it("答案必須屬於選項：唔係候選嘅 guard（ambiguous 題冇搜尋選項時）／亂揀盤／亂日子 → 400", async () => {
    await feed("a3", "阿明聽日夜更", llmJson(person("阿明")));
    const [q] = await qsOf("a3");
    // ambiguous 題有 guard_search 選項，所以任何現存 guard 都得；但唔存在嘅 guard → 400
    expect((await preview(q!.id, { option: "wa_pick_guard", guard_id: "no-such" })).status).toBe(400);
    expect((await preview(q!.id, { option: "wa_pick_site", site_id: ids.site })).status).toBe(400);
    expect((await preview(q!.id, { option: "wa_ignore" })).status).toBe(400); // 呢題冇「忽略」選項
    expect((await preview(q!.id, { option: "wa_pick_guard" })).status).toBe(400);
  });

  it("preview_hash：缺／唔啱 → 400／409；預覽後資料變咗（已有同更記錄）→ 409，冇寫入", async () => {
    await feed("a4", "阿明聽日夜更", llmJson(person("阿明")));
    const [q] = await qsOf("a4");
    const ans = { option: "wa_pick_guard", guard_id: ids.gM1 };
    expect((await answer(q!.id, ans)).status).toBe(400); // 冇 hash
    expect((await answer(q!.id, ans, "0".repeat(64))).status).toBe(409);
    const pv = await preview(q!.id, ans);
    await prisma.shiftRecord.create({ data: { workDate: new Date("2026-10-17T00:00:00Z"), siteId: ids.site, shiftTypeId: ids.tA, guardId: ids.gM1, recordType: "shift", status: "confirmed", createdBy: "test:w2" } });
    const res = await answer(q!.id, ans, pv.body.preview_hash);
    expect(res.status).toBe(409);
    expect((await prisma.triageQuestion.findUniqueOrThrow({ where: { id: q!.id } })).status).toBe("open");
    expect(await prisma.shiftRecord.count({ where: { source: "whatsapp" } })).toBe(0);
  });

  it("wa_site_ambiguous：揀候選盤 → 重解更碼 → 寫入", async () => {
    await feed("s1", "唔存在盤聽日測試乙返夜", llmJson({ site_raw: "完全唔存在盤XYZ" }));
    const [q] = await qsOf("s1");
    expect(q!.kind).toBe("wa_site_ambiguous");
    expect((q!.optionsJson as Array<{ site_id?: string }>).some((o) => o.site_id === ids.site)).toBe(true);
    expect((await confirm(q!.id, { option: "wa_pick_site", site_id: ids.site })).status).toBe(200);
    expect((await recOf(ids.gB, "2026-10-17"))[0]).toMatchObject({ shiftTypeId: ids.tN, siteId: ids.site, status: "pending_approval", source: "whatsapp" });
  });

  it("wa_date_ambiguous：凌晨「今晚」→ 揀候選日；輸入日期要真實日子；人手揀嘅日子唔再擋 −2～+45 窗口", async () => {
    await feed("d1", "今晚測試乙返夜", llmJson({ date: { raw: "今晚", kind: "relative" } }), 13 * 3600);
    const [q] = await qsOf("d1");
    expect(q!.kind).toBe("wa_date_ambiguous");
    expect(evidence(q!).candidates.dates).toEqual(["2026-10-17", "2026-10-16"]);
    expect((await preview(q!.id, { option: "wa_set_date", value: "2026-02-30" })).status).toBe(400);
    expect((await preview(q!.id, { option: "wa_set_date", value: "唔係日期" })).status).toBe(400);
    expect((await confirm(q!.id, { option: "wa_set_date", value: "2026-10-16" })).status).toBe(200);
    expect(await recOf(ids.gB, "2026-10-16")).toHaveLength(1);
    // 輸入遠日（超過 +45 日）＝人已確認 → 照寫
    await feed("d2", "今晚測試乙返夜", llmJson({ date: { raw: "今晚", kind: "relative" } }), 13 * 3600 + 5);
    const [q2] = await qsOf("d2");
    expect((await confirm(q2!.id, { option: "wa_set_date", value: "2026-12-30" })).status).toBe(200);
    expect(await recOf(ids.gB, "2026-12-30")).toHaveLength(1);
  });

  it("請假 intent（日期含糊）答完日子 → 寫 leave 格（用該保安員最近用過嘅更種）", async () => {
    await prisma.shiftRecord.create({ data: { workDate: new Date("2026-10-10T00:00:00Z"), siteId: ids.site, shiftTypeId: ids.tA, guardId: ids.gB, recordType: "shift", status: "confirmed", createdBy: "test:w2" } });
    await feed("l1", "今晚測試乙病假", llmJson({ type: "leave", shift_raw: null, leave_raw: "病假", date: { raw: "今晚", kind: "relative" } }), 13 * 3600);
    const [q] = await qsOf("l1");
    expect(q!.kind).toBe("wa_date_ambiguous");
    expect((await confirm(q!.id, { option: "wa_set_date", value: "2026-10-17" })).status).toBe(200);
    expect((await recOf(ids.gB, "2026-10-17"))[0]).toMatchObject({ recordType: "leave", leaveCode: "SL", shiftTypeId: ids.tA, status: "pending_approval", source: "whatsapp" });
  });
});

// ---------------------------------------------------------------------------
describe("W2 wa_shift_conflict", () => {
  const existingA = () => prisma.shiftRecord.create({ data: { workDate: new Date("2026-10-17T00:00:00Z"), siteId: ids.site, shiftTypeId: ids.tA, guardId: ids.gB, recordType: "shift", status: "confirmed", createdBy: "test:w2" } });

  it("「以 WhatsApp 為準」＝同 tx 取消舊記錄（audit void）＋寫新 pending_approval", async () => {
    const old = await existingA();
    await feed("c1", "測試乙聽日夜更", llmJson());
    const [q] = await qsOf("c1");
    expect(q).toMatchObject({ kind: "wa_shift_conflict" });
    expect((q!.optionsJson as Array<{ id: string }>).map((o) => o.id)).toEqual(["wa_use_whatsapp", "wa_keep_old", "wa_manual", "skip"]);
    const r = await confirm(q!.id, { option: "wa_use_whatsapp" });
    expect(r.status).toBe(200);
    expect((await prisma.shiftRecord.findUniqueOrThrow({ where: { id: old.id } })).status).toBe("cancelled");
    expect(await prisma.auditLog.findMany({ where: { tableName: "shift_records", rowId: old.id, action: "void" } })).toHaveLength(1);
    expect((await recOf(ids.gB, "2026-10-17")).filter((x) => x.status === "pending_approval" && x.shiftTypeId === ids.tN)).toHaveLength(1);
  });

  it("取消舊＋寫新係同一個 transaction：寫新時失敗 → 舊記錄冇被取消、題保持 open", async () => {
    const old = await existingA();
    await feed("c2", "測試乙聽日夜更", llmJson());
    const [q] = await qsOf("c2");
    const ans = { option: "wa_use_whatsapp" };
    const pv = await preview(q!.id, ans);
    await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION w2_fail() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'w2 forced failure'; END; $$ LANGUAGE plpgsql`);
    await prisma.$executeRawUnsafe(`CREATE TRIGGER w2_fail_trg BEFORE INSERT ON audit_log FOR EACH ROW WHEN (NEW.table_name = 'shift_records' AND NEW.action = 'create') EXECUTE FUNCTION w2_fail()`);
    const res = await answer(q!.id, ans, pv.body.preview_hash);
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect((await prisma.shiftRecord.findUniqueOrThrow({ where: { id: old.id } })).status).toBe("confirmed");
    expect(await prisma.shiftRecord.count({ where: { source: "whatsapp" } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { tableName: "shift_records", rowId: old.id, action: "void" } })).toBe(0);
    expect((await prisma.triageQuestion.findUniqueOrThrow({ where: { id: q!.id } })).status).toBe("open");
  });

  it("「保留舊」→ answered、唔寫、舊記錄不變；「人手改」→ answered＋manual；skip → skipped 可再答", async () => {
    const old = await existingA();
    await feed("c3", "測試乙聽日夜更", llmJson());
    const [q] = await qsOf("c3");
    const k = await answer(q!.id, { option: "wa_keep_old" });
    expect(k.status).toBe(200);
    expect(await prisma.shiftRecord.count({ where: { source: "whatsapp" } })).toBe(0);
    expect((await prisma.shiftRecord.findUniqueOrThrow({ where: { id: old.id } })).status).toBe("confirmed");
    await feed("c3b", "測試乙聽日夜更", llmJson(), 5);
    const [q2] = await qsOf("c3b");
    const m = await answer(q2!.id, { option: "wa_manual" });
    expect(m.status).toBe(200);
    expect(m.body.result.manual).toBe(true);
    await feed("c3c", "測試乙聽日夜更", llmJson(), 6);
    const [q3] = await qsOf("c3c");
    const s = await answer(q3!.id, { option: "skip" });
    expect(s.body.status).toBe("skipped");
    expect((await prisma.triageQuestion.findUniqueOrThrow({ where: { id: q3!.id } })).status).toBe("skipped");
    expect((await confirm(q3!.id, { option: "wa_use_whatsapp" })).status).toBe(200); // 跳過後可以再答
  });

  it("同更已存在（答題之前人手入咗）→ 答「以 WhatsApp 為準」＝當處理咗，唔重覆寫", async () => {
    await existingA();
    await feed("c4", "測試乙聽日夜更", llmJson());
    const [q] = await qsOf("c4");
    await prisma.shiftRecord.create({ data: { workDate: new Date("2026-10-17T00:00:00Z"), siteId: ids.site, shiftTypeId: ids.tN, guardId: ids.gB, recordType: "shift", status: "confirmed", createdBy: "test:w2" } });
    const r = await confirm(q!.id, { option: "wa_use_whatsapp" });
    expect(r.status).toBe(200);
    expect((await prisma.triageQuestion.findUniqueOrThrow({ where: { id: q!.id } })).applyResultJson).toMatchObject({ plan: "exists" });
    expect(await prisma.shiftRecord.count({ where: { source: "whatsapp" } })).toBe(0);
  });

  it("額滿 slot_full：「仍然入更」先寫；「唔入更」唔寫", async () => {
    await prisma.dailyRequirement.create({ data: { siteId: ids.site, shiftTypeId: ids.tN, workDate: new Date("2026-10-17T00:00:00Z"), headcountRequired: 1, createdBy: "test:w2" } });
    await prisma.shiftRecord.create({ data: { workDate: new Date("2026-10-17T00:00:00Z"), siteId: ids.site, shiftTypeId: ids.tN, guardId: ids.gA, recordType: "shift", status: "confirmed", createdBy: "test:w2" } });
    await feed("f1", "測試乙聽日夜更", llmJson());
    const [q] = await qsOf("f1");
    expect(q!.kind).toBe("wa_shift_conflict");
    expect((q!.optionsJson as Array<{ id: string }>).map((o) => o.id)).toEqual(["wa_force_write", "wa_keep_old", "wa_manual", "skip"]);
    expect((await confirm(q!.id, { option: "wa_force_write" })).status).toBe(200);
    expect((await recOf(ids.gB, "2026-10-17"))[0]).toMatchObject({ status: "pending_approval", source: "whatsapp" });
  });
});

// ---------------------------------------------------------------------------
describe("W2 wa_unparsed、輪次上限、鎖月", () => {
  it("取消冇可取消記錄（cancel）→ wa_unparsed：只有人手／忽略／跳過（冇「照解析入更」）；忽略→answered 唔寫", async () => {
    await feed("u1", "測試甲聽日唔返", llmJson({ type: "cancel", persons: [{ raw: "測試甲", role: "worker" }], shift_raw: null }));
    const [q] = await qsOf("u1");
    expect(q!.kind).toBe("wa_unparsed");
    expect((q!.optionsJson as Array<{ id: string }>).map((o) => o.id)).toEqual(["wa_manual", "wa_ignore", "skip"]);
    expect((await answer(q!.id, { option: "wa_ignore" })).status).toBe(200);
    expect(await prisma.shiftRecord.count({ where: { source: "whatsapp" } })).toBe(0);
    expect((await prisma.triageQuestion.findUniqueOrThrow({ where: { id: q!.id } })).status).toBe("answered");
  });

  it("低信心（只因 low_confidence）→ wa_unparsed＋「照解析入更」→ 寫入 pending_approval", async () => {
    await feed("u2", "測試乙聽日夜更", llmJson({ confidence: 0.5 }));
    const [q] = await qsOf("u2");
    expect(q!.kind).toBe("wa_unparsed");
    expect((q!.optionsJson as Array<{ id: string }>).map((o) => o.id)).toEqual(["wa_accept", "wa_manual", "wa_ignore", "skip"]);
    const r = await confirm(q!.id, { option: "wa_accept" });
    expect(r.status).toBe(200);
    expect((await recOf(ids.gB, "2026-10-17"))[0]).toMatchObject({ status: "pending_approval", source: "whatsapp" });
  });

  it("同一 intent 最多問兩輪，第三輪一律 wa_unparsed（site → person → 日子仍缺 → wa_unparsed，唔再死循環）", async () => {
    await feed("m1", "聽日夜更", llmJson({ site_raw: "完全唔存在盤XYZ", ...person("陌生人"), date: null }));
    const [q1] = await qsOf("m1");
    expect(q1!.kind).toBe("wa_site_ambiguous");
    const r1 = await confirm(q1!.id, { option: "wa_pick_site", site_id: ids.site });
    expect(r1.status).toBe(200);
    expect(r1.body.result.next_kind).toBe("wa_person_unknown");
    const q2 = (await openQ("m1"))[0]!;
    expect(q2).toMatchObject({ kind: "wa_person_unknown", groupKey: "m1:1:0:r2" });
    expect(evidence(q2).round).toBe(2);
    const r2 = await confirm(q2.id, { option: "wa_pick_guard", guard_id: ids.gC });
    expect(r2.status).toBe(200);
    expect(r2.body.result.next_kind).toBe("wa_unparsed");
    const q3 = (await openQ("m1"))[0]!;
    expect(q3).toMatchObject({ kind: "wa_unparsed", groupKey: "m1:1:0:r3" });
    expect(evidence(q3).round).toBe(3);
    expect((q3.optionsJson as Array<{ id: string }>).map((o) => o.id)).toEqual(["wa_manual", "wa_ignore", "skip"]);
    expect((await qsOf("m1")).map((q) => q.status)).toEqual(["answered", "answered", "open"]);
    expect((await prisma.whatsappIntent.findFirstOrThrow({ where: { messageId: "m1" } })).resultRef).toBe(q3.id);
    expect(await prisma.shiftRecord.count({ where: { source: "whatsapp" } })).toBe(0);
  });

  it("鎖月：預覽／確認都 400 固定字串、題保持 open、冇寫入；解鎖後照答", async () => {
    await feed("lk", "阿明聽日夜更", llmJson(person("阿明")));
    const [q] = await qsOf("lk");
    const ans = { option: "wa_pick_guard", guard_id: ids.gM1 };
    const pv = await preview(q!.id, ans);
    expect(pv.status).toBe(200);
    const mc = await prisma.monthClose.create({ data: { month: new Date("2026-10-01T00:00:00Z"), lockedAt: new Date(), createdBy: "test:w2" } });
    const p2 = await preview(q!.id, ans);
    expect(p2.status).toBe(400);
    expect(p2.body.message).toBe(WA_LOCKED_MSG);
    const a2 = await answer(q!.id, ans, pv.body.preview_hash);
    expect(a2.status).toBe(400);
    expect(a2.body.message).toBe(WA_LOCKED_MSG);
    expect((await prisma.triageQuestion.findUniqueOrThrow({ where: { id: q!.id } })).status).toBe("open");
    expect(await prisma.shiftRecord.count({ where: { source: "whatsapp" } })).toBe(0);
    await prisma.monthClose.delete({ where: { id: mc.id } });
    expect((await confirm(q!.id, ans)).status).toBe(200);
  });

  it("鎖月 intent 本身（W1 判 month_locked）→ wa_shift_conflict 只有「人手處理」／跳過", async () => {
    await prisma.monthClose.create({ data: { month: new Date("2026-10-01T00:00:00Z"), lockedAt: new Date(), createdBy: "test:w2" } });
    await feed("lk2", "測試乙聽日夜更", llmJson());
    const [q] = await qsOf("lk2");
    expect(q).toMatchObject({ kind: "wa_shift_conflict" });
    expect((q!.optionsJson as Array<{ id: string }>).map((o) => o.id)).toEqual(["wa_manual", "skip"]);
    expect((await answer(q!.id, { option: "wa_manual" })).status).toBe(200); // 純人手處理，唔寫
  });
});

// ---------------------------------------------------------------------------
describe("W2 RBAC、遮罩、對照頁、session 清單", () => {
  it("答題權限：會計（冇更表新增）／雞頭／安員 → 403；主管（非 owner）→ 403；未登入 401", async () => {
    await feed("rb", "阿明聽日夜更", llmJson(person("阿明")));
    const [q] = await qsOf("rb");
    for (const r of ["會計", "雞頭", "安員", "主管"] as const) {
      const ck = await sessionCookieForUser(fx.userIds[r]);
      expect((await preview(q!.id, { option: "skip" }, ck)).status, `${r} preview`).toBe(403);
      expect((await answer(q!.id, { option: "skip" }, undefined, ck)).status, `${r} answer`).toBe(403);
    }
    expect((await preview(q!.id, { option: "skip" }, null)).status).toBe(401);
  });

  it("session 清單：老闆見到 whatsapp session；主管（非 owner）見唔到；GET session 帶 wa 內容（原話／候選）", async () => {
    await feed("rb2", "阿明聽日夜更", llmJson(person("阿明")));
    const [q] = await qsOf("rb2");
    const list = (await (await sessionsGet(get("/api/triage/sessions"))).json()) as { sessions: Array<{ id: string; source_type: string }> };
    expect(list.sessions.some((s) => s.id === q!.sessionId && s.source_type === "whatsapp")).toBe(true);
    const mgrList = (await (await sessionsGet(get("/api/triage/sessions", await sessionCookieForUser(fx.userIds["主管"])))).json()) as { sessions: Array<{ id: string }> };
    expect(mgrList.sessions.some((s) => s.id === q!.sessionId)).toBe(false);
    const res = await sessionGet(get(`/api/triage/sessions/${q!.sessionId}?status=open&take=5`), params(q!.sessionId));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { questions: Array<{ id: string; kind: string; restricted: boolean; wa: { text: string; group_label: string; sender: string; guard_candidates: Array<{ name_zh: string; guard_id: string }>; reasons: string[]; can_remember_alias: boolean } }> };
    const v = body.questions[0]!;
    expect(v).toMatchObject({ id: q!.id, kind: "wa_person_ambiguous", restricted: false });
    expect(v.wa.text).toBe("阿明聽日夜更");
    expect(v.wa.group_label).toBe("W2測試群一");
    expect(v.wa.sender).toBe("…9999");
    expect(v.wa.guard_candidates.map((c) => c.name_zh).sort()).toEqual(["測試明一", "測試明二"]);
    expect(v.wa.can_remember_alias).toBe(true);
  });

  it("遮罩：冇「保安員:view」／「更表:create」→ restricted，原話／姓名／候選／raw 全部隱藏", async () => {
    await feed("mk", "阿明聽日夜更", llmJson(person("阿明")));
    const rows = await qsOf("mk");
    const [v] = await waQuestionViews(rows, { canSee: false, canWrite: false });
    expect(v).toMatchObject({ restricted: true });
    expect(v!.wa.text).toBeNull();
    expect(v!.wa.raw).toBeNull();
    expect(v!.wa.guard_candidates).toEqual([]);
    expect(v!.wa.intent.guard_name).toBeNull();
    expect(JSON.stringify(v)).not.toContain("阿明聽日夜更");
    const [w] = await waQuestionViews(rows, { canSee: true, canWrite: false });
    expect(w!.restricted).toBe(true); // 睇得唔答得
    expect(w!.wa.text).toBe("阿明聽日夜更");
  });

  it("原訊息已被修改／撤回：題目 view 標 source_changed／source_revoked（已答題唔自動改）", async () => {
    await feed("sc", "阿明聽日夜更", llmJson(person("阿明")));
    const [q] = await qsOf("sc");
    await ingest(ev("edited", "sc", "阿明聽日夜更，改咗", 60));
    const [v1] = await waQuestionViews([q!], { canSee: true, canWrite: true });
    expect(v1!.wa.source_changed).toBe(true);
    expect(v1!.wa.source_revoked).toBe(false);
    // 未跑 job：題仍 open，但答題擋住（原訊息已改）
    expect((await preview(q!.id, { option: "skip" })).status).toBe(409);
    await ingest(ev("revoked", "sc", "", 120));
    const [v2] = await waQuestionViews([q!], { canSee: true, canWrite: true });
    expect(v2!.wa.source_revoked).toBe(true);
  });

  it("/api/whatsapp/intents：routed=triage 帶 triage_question_id／session／status", async () => {
    await feed("ia", "阿明聽日夜更", llmJson(person("阿明")));
    const [q] = await qsOf("ia");
    const res = await intentsGet(get("/api/whatsapp/intents?from=2026-10-16&to=2026-10-16"));
    const body = (await res.json()) as { rows: Array<{ routed: string; triage_question_id: string | null; triage_session_id: string | null; triage_status: string | null }> };
    expect(body.rows[0]).toMatchObject({ routed: "triage", triage_question_id: q!.id, triage_session_id: q!.sessionId, triage_status: "open" });
  });
});

// ---------------------------------------------------------------------------
describe("W2 batch-accept 白名單", () => {
  async function previewItems() {
    const res = await batchPreviewGet(get("/api/triage/questions/batch-accept/preview?month=2026-10"));
    expect(res.status).toBe(200);
    return ((await res.json()) as { items: Array<{ id: string; kind: string; suggestion: string | null }> }).items;
  }

  it("只列兩類：wa_person_ambiguous 有唯一近 60 日同盤候選、wa_shift_conflict（撞更／撞請假）預設保留舊；其他 kind／多候選唔列", async () => {
    // 明一近 60 日喺同盤有更、明二冇 → 唯一
    await prisma.shiftRecord.create({ data: { workDate: new Date("2026-10-10T00:00:00Z"), siteId: ids.site, shiftTypeId: ids.tA, guardId: ids.gM1, recordType: "shift", status: "confirmed", createdBy: "test:w2" } });
    await feed("b1", "阿明聽日夜更", llmJson(person("阿明")), 0);
    // 撞更
    await prisma.shiftRecord.create({ data: { workDate: new Date("2026-10-17T00:00:00Z"), siteId: ids.site, shiftTypeId: ids.tA, guardId: ids.gB, recordType: "shift", status: "confirmed", createdBy: "test:w2" } });
    await feed("b2", "測試乙聽日夜更", llmJson(), 1);
    // 非白名單：site／unknown／unparsed
    await feed("b3", "聽日夜更", llmJson({ site_raw: "完全唔存在盤XYZ" }), 2);
    await feed("b4", "陌生人聽日夜更", llmJson(person("陌生人")), 3);
    const items = await previewItems();
    const byKind = Object.fromEntries(items.map((i) => [i.kind, i]));
    expect(Object.keys(byKind).sort()).toEqual(["wa_person_ambiguous", "wa_shift_conflict"]);
    expect(items).toHaveLength(2);
    expect(byKind.wa_shift_conflict!.suggestion).toContain("保留舊");
    expect(byKind.wa_person_ambiguous!.suggestion).toContain("近 60 日");
    // 執行：兩題都處理（明一 pending_approval；撞更保留舊＝唔寫）
    const ids2 = items.map((i) => i.id);
    const res = await batchPost(post("/api/triage/questions/batch-accept", { question_ids: ids2 }));
    expect(res.status).toBe(200);
    const out = (await res.json()) as { counts: { answered: number; skipped: number; error: number } };
    expect(out.counts).toEqual({ answered: 2, skipped: 0, error: 0 });
    expect((await recOf(ids.gM1, "2026-10-17"))[0]).toMatchObject({ status: "pending_approval", source: "whatsapp" });
    expect((await recOf(ids.gB, "2026-10-17")).filter((r) => r.source === "whatsapp")).toHaveLength(0);
    // audit 帶 batch_id
    const aud = await prisma.auditLog.findMany({ where: { tableName: "triage_questions", action: "triage_answer", rowId: { in: ids2 } } });
    expect(aud.every((a) => JSON.stringify(a.after).includes("batch_id"))).toBe(true);
  });

  it("兩位候選都近 60 日同盤有更 → 唔列；非白名單題直接 POST → skipped(no_suggestion)；鎖月份唔列", async () => {
    for (const g of [ids.gM1, ids.gM2]) await prisma.shiftRecord.create({ data: { workDate: new Date("2026-10-10T00:00:00Z"), siteId: ids.site, shiftTypeId: ids.tA, guardId: g, recordType: "shift", status: "confirmed", createdBy: "test:w2" } });
    await feed("b5", "阿明聽日夜更", llmJson(person("阿明")));
    await feed("b6", "聽日夜更", llmJson({ site_raw: "完全唔存在盤XYZ" }), 1);
    expect(await previewItems()).toHaveLength(0);
    const [site] = await qsOf("b6");
    const res = await batchPost(post("/api/triage/questions/batch-accept", { question_ids: [site!.id] }));
    expect(((await res.json()) as { results: Array<{ status: string; reason: string }> }).results[0]).toMatchObject({ status: "skipped", reason: "no_suggestion" });
    // 鎖月
    await prisma.shiftRecord.deleteMany({ where: { guardId: ids.gM2 } });
    expect(await previewItems()).toHaveLength(1);
    await prisma.monthClose.create({ data: { month: new Date("2026-10-01T00:00:00Z"), lockedAt: new Date(), createdBy: "test:w2" } });
    expect(await previewItems()).toHaveLength(0);
  });

  it("無「保安員:view」＋「更表:create」嘅人（會計）見唔到可批量項目", async () => {
    await prisma.shiftRecord.create({ data: { workDate: new Date("2026-10-10T00:00:00Z"), siteId: ids.site, shiftTypeId: ids.tA, guardId: ids.gM1, recordType: "shift", status: "confirmed", createdBy: "test:w2" } });
    await feed("b7", "阿明聽日夜更", llmJson(person("阿明")));
    const [q] = await qsOf("b7");
    await prisma.triageSession.update({ where: { id: q!.sessionId }, data: { ownerUserId: fx.userIds["會計"] } });
    const res = await batchPreviewGet(get("/api/triage/questions/batch-accept/preview?month=2026-10", await sessionCookieForUser(fx.userIds["會計"])));
    expect(((await res.json()) as { items: unknown[] }).items).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
describe("W2.3 驗收修正（S1／N1／N2／N3）", () => {
  async function asManagerOwner(q: { sessionId: string }, off: Array<"void" | "update">) {
    const mgr = fx.userIds["主管"];
    await prisma.triageSession.update({ where: { id: q.sessionId }, data: { ownerUserId: mgr } });
    for (const a of off) {
      const perm = await prisma.permission.findFirstOrThrow({ where: { module: "更表", action: a } });
      await prisma.rolePermission.updateMany({ where: { roleId: fx.roleIds["主管"], permissionId: perm.id }, data: { granted: false } });
    }
    return sessionCookieForUser(mgr);
  }

  it("S1：有 create 冇 void 嘅角色揀「以 WhatsApp 為準」→ preview／submit 都 403，舊記錄不變", async () => {
    const old = await prisma.shiftRecord.create({ data: { workDate: new Date("2026-10-17T00:00:00Z"), siteId: ids.site, shiftTypeId: ids.tA, guardId: ids.gB, recordType: "shift", status: "confirmed", createdBy: "test:w2" } });
    await feed("s1", "測試乙聽日夜更", llmJson());
    const [q] = await qsOf("s1");
    const ck = await asManagerOwner(q!, ["void"]);
    expect((await preview(q!.id, { option: "wa_use_whatsapp" }, ck)).status).toBe(403);
    expect((await answer(q!.id, { option: "wa_use_whatsapp" }, "0".repeat(64), ck)).status).toBe(403);
    expect((await prisma.shiftRecord.findUniqueOrThrow({ where: { id: old.id } })).status).toBe("confirmed");
    expect((await prisma.triageQuestion.findUniqueOrThrow({ where: { id: q!.id } })).status).toBe("open");
    // 唔取消舊記錄嘅答案（保留舊）仍然得
    expect((await answer(q!.id, { option: "wa_keep_old" }, undefined, ck)).status).toBe(200);
  });

  it("S1：目標格已有行（已取消重用）→ 要「更表:update」，冇就 403；有就照寫", async () => {
    await prisma.shiftRecord.create({ data: { workDate: new Date("2026-10-17T00:00:00Z"), siteId: ids.site, shiftTypeId: ids.tN, guardId: ids.gM1, recordType: "shift", status: "cancelled", createdBy: "test:w2" } });
    await feed("s2", "阿明聽日夜更", llmJson(person("阿明")));
    const [q] = await qsOf("s2");
    const ans = { option: "wa_pick_guard", guard_id: ids.gM1 };
    const ck = await asManagerOwner(q!, ["update"]);
    expect((await preview(q!.id, ans, ck)).status).toBe(403);
    expect((await answer(q!.id, ans, "0".repeat(64), ck)).status).toBe(403);
    expect(await prisma.shiftRecord.count({ where: { source: "whatsapp" } })).toBe(0);
    // 老闆（有 update）照寫
    expect((await confirm(q!.id, ans)).status).toBe(200);
    expect(await prisma.shiftRecord.count({ where: { source: "whatsapp", guardId: ids.gM1 } })).toBe(1);
  });

  it("N1：請假格揀更種時排除 PR 佔位更別（最近用過 PR／盤只剩 PR 以外第一個）", async () => {
    const pr = await prisma.shiftType.create({ data: { siteId: ids.site, code: "A0PR", label: "佔位", hours: 0, createdBy: "test:w2" } });
    await prisma.shiftType.update({ where: { id: pr.id }, data: { code: "PR" } });
    await prisma.shiftRecord.create({ data: { workDate: new Date("2026-10-12T00:00:00Z"), siteId: ids.site, shiftTypeId: pr.id, guardId: ids.gB, recordType: "shift", status: "confirmed", createdBy: "test:w2" } });
    await feed("n1", "今晚測試乙病假", llmJson({ type: "leave", shift_raw: null, leave_raw: "病假", date: { raw: "今晚", kind: "relative" } }), 13 * 3600);
    const [q] = await qsOf("n1");
    expect((await confirm(q!.id, { option: "wa_set_date", value: "2026-10-17" })).status).toBe(200);
    const rec = (await recOf(ids.gB, "2026-10-17"))[0]!;
    expect(rec.recordType).toBe("leave");
    expect(rec.shiftTypeId).not.toBe(pr.id);
    expect(rec.shiftTypeId).toBe(ids.tA); // 排除 PR 後第一個（代號 A）
  });

  it("N2：被取消記錄含已確認／已結算 → 預覽有明顯警示，仍可繼續", async () => {
    await prisma.shiftRecord.create({ data: { workDate: new Date("2026-10-17T00:00:00Z"), siteId: ids.site, shiftTypeId: ids.tA, guardId: ids.gB, recordType: "shift", status: "confirmed", billed: true, createdBy: "test:w2" } });
    await feed("n2", "測試乙聽日夜更", llmJson());
    const [q] = await qsOf("n2");
    const pv = await preview(q!.id, { option: "wa_use_whatsapp" });
    expect(pv.status).toBe(200);
    expect(pv.body.impact.can_confirm).toBe(true);
    expect((pv.body.impact.notes as string[]).join("")).toContain("會取消已確認／已結算記錄");
    expect((await answer(q!.id, { option: "wa_use_whatsapp" }, pv.body.preview_hash)).status).toBe(200);
  });

  it("N3：alias 學習 audit 帶 before／after nameAliases 陣列", async () => {
    await feed("n3", "明仔聽日夜更", llmJson(person("明仔")));
    const [q] = await qsOf("n3");
    expect((await confirm(q!.id, { option: "wa_pick_guard", guard_id: ids.gM1, remember_alias: true })).status).toBe(200);
    const a = (await prisma.auditLog.findMany({ where: { tableName: "guards", rowId: ids.gM1, action: "update" } })).find((x) => JSON.stringify(x.after).includes("whatsapp_triage"))!;
    expect(JSON.stringify(a.before)).toContain("阿明");
    expect(JSON.stringify(a.before)).not.toContain("明仔");
    expect(JSON.stringify(a.after)).toContain("明仔");
  });
});
