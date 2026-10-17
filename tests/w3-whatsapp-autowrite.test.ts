// W3：WhatsApp 自動寫入——條件矩陣（群組開關、信心、鎖月、已存在、每日上限、總開關、5 分鐘去重）、
// pending_approval vs auto_confirm、請假、編輯／撤回後 reject／標示、待批清單／批核、排更格 records API、
// 統計／對照頁 auto_result、日摘要。全部假資料（測試甲／乙、假群、假電話）；LLM 用腳本化 fake。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { runWhatsappParse, runWhatsappDailySummary } from "@/lib/jobs/whatsapp-parse";
import { ingestEvent } from "@/lib/whatsapp/ingest";
import type { NormalizedWaEvent } from "@/lib/whatsapp/schema";
import type { LlmClient, LlmChatParams } from "@/lib/ai/llm";
import { autoWriteIntentsTx } from "@/lib/whatsapp/autowrite";
import { waAutoWriteEnabled } from "@/lib/whatsapp/config";
import { autoWriteOutcomeOf } from "@/lib/whatsapp/stats";
import { GET as pendingGet } from "@/app/api/whatsapp/pending/route";
import { GET as recordsGet } from "@/app/api/whatsapp/records/route";
import { GET as intentsGet } from "@/app/api/whatsapp/intents/route";
import { GET as statsGet } from "@/app/api/whatsapp/stats/route";
import { PATCH as groupsPatch } from "@/app/api/whatsapp/groups/route";
import { POST as approvePost } from "@/app/api/shift-records/[id]/approve/route";
import { POST as rejectPost } from "@/app/api/shift-records/[id]/reject/route";

const T0 = new Date("2026-10-16T05:00:00Z"); // HK 2026-10-16 13:00 星期五
const NOW = new Date(T0.getTime() + 60_000);
const G1 = "w3-g1@g.us";
const SENDER_A = "85290000011@c.us"; // 測試甲（已知保安員）
const SENDER_X = "85290009999@c.us"; // 未知
const BASE = "http://test.local";

let fx: Wp2Fixture;
let ids: { site: string; tA: string; tN: string; gA: string; gB: string };
let boss: string;
let cookie: string;
let groupId: string;

const shiftIntent = (over: Record<string, unknown> = {}) => ({
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
const llmJson = (over: Record<string, unknown> = {}) => JSON.stringify({ noise: false, intents: [shiftIntent(over)] });
const leaveJson = (over: Record<string, unknown> = {}) =>
  llmJson({ type: "leave", persons: [], self_reference: true, shift_raw: null, leave_raw: "病假", leave_code_guess: "SL", ...over });

function fakeLlm(script: (text: string) => string): LlmClient {
  return {
    async chat(params: LlmChatParams) {
      const text = (JSON.parse(params.userMessage) as { text: string }).text;
      return { text: script(text), toolsUsed: [], inputTokens: 10, outputTokens: 5, provider: "fake", model: "fake-m" };
    },
  };
}
function ev(kind: "message" | "edited" | "revoked", mid: string, text: string, tsOffsetSec = 0, over: Partial<NormalizedWaEvent> = {}): NormalizedWaEvent {
  return { kind, session: "default", messageId: mid, chatJid: G1, senderJid: SENDER_A, fromMe: false, ts: new Date(T0.getTime() + tsOffsetSec * 1000), text, mediaType: null, quotedMessageId: null, eventId: `${mid}-${kind}-${tsOffsetSec}-${text.length}`, ...over };
}
const ingest = (e: NormalizedWaEvent) => ingestEvent(e, new Date(Math.max(NOW.getTime(), (e.ts?.getTime() ?? 0) + 60_000)));
const run = (llm: LlmClient) => runWhatsappParse(NOW, { llm: [llm], force: true });
async function feed(mid: string, text: string, json: string, offset = 0, over: Partial<NormalizedWaEvent> = {}) {
  await ingest(ev("message", mid, text, offset, over));
  await run(fakeLlm(() => json));
}
async function editAndRun(mid: string, text: string, json: string, offset = 30) {
  await ingest(ev("edited", mid, text, offset));
  await run(fakeLlm(() => json));
}
const intentsOf = (mid: string) => prisma.whatsappIntent.findMany({ where: { messageId: mid }, orderBy: [{ messageRevision: "asc" }, { idx: "asc" }] });
const recs = (guardId?: string) => prisma.shiftRecord.findMany({ where: { siteId: ids.site, ...(guardId ? { guardId } : {}) }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
const qCount = () => prisma.triageQuestion.count({ where: { session: { sourceType: "whatsapp" } } });
const setGroup = (data: Record<string, unknown>) => prisma.whatsappGroup.update({ where: { groupJid: G1 }, data });

function req(path: string, ck: string | null = cookie, method = "GET", body?: unknown) {
  return new Request(`${BASE}${path}`, { method, headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(ck ? { cookie: ck } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
}
const params = (id: string) => ({ params: Promise.resolve({ id }) });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = async (res: Response) => (await res.json()) as Record<string, any>;

beforeEach(async () => {
  await clearAll();
  fx = await seedWp2Fixture();
  boss = fx.userIds["老闆"];
  cookie = await sessionCookieForUser(boss);
  const site = await prisma.site.create({ data: { canonicalName: "測試盤W3", clientName: "測試客戶W3", billingModel: "per_shift", createdBy: "test:w3" } });
  const tA = await prisma.shiftType.create({ data: { siteId: site.id, code: "A", label: "早更", startTime: new Date("1970-01-01T07:00:00Z"), endTime: new Date("1970-01-01T15:00:00Z"), hours: 8, createdBy: "test:w3" } });
  const tN = await prisma.shiftType.create({ data: { siteId: site.id, code: "N", label: "夜更", startTime: new Date("1970-01-01T19:00:00Z"), endTime: new Date("1970-01-01T07:00:00Z"), hours: 12, createdBy: "test:w3" } });
  const gA = await prisma.guard.create({ data: { nameZh: "測試甲", employmentType: "cash_casual", tel: "90000011", createdBy: "test:w3" } });
  const gB = await prisma.guard.create({ data: { nameZh: "測試乙", employmentType: "cash_casual", tel: "90000012", createdBy: "test:w3" } });
  ids = { site: site.id, tA: tA.id, tN: tN.id, gA: gA.id, gB: gB.id };
  const g = await prisma.whatsappGroup.create({ data: { groupJid: G1, label: "W3測試群", kind: "site", siteId: site.id, shiftWordMap: { 早: "A", 夜: "N" }, autoWrite: true, createdBy: boss } });
  groupId = g.id;
});
afterEach(() => {
  delete process.env.WA_AUTO_WRITE_ENABLED;
});

// ---------------------------------------------------------------------------
describe("W3 自動寫入：基本路徑", () => {
  it("報更：寫入 pending_approval（source／provenance／audit）、result_ref＝記錄 id、冇分流題", async () => {
    await feed("a1", "聽日測試乙返夜", llmJson());
    const rs = await recs(ids.gB);
    expect(rs).toHaveLength(1);
    const r = rs[0]!;
    expect(r).toMatchObject({ status: "pending_approval", source: "whatsapp", shiftTypeId: ids.tN, siteId: ids.site, recordType: "shift" });
    expect(r.workDate.toISOString().slice(0, 10)).toBe("2026-10-17");
    expect(r.provenance).toMatchObject({ message_id: "a1", revision: 1, intent_idx: 0, sender_guard_id: ids.gA });
    const sys = await prisma.user.findUniqueOrThrow({ where: { id: r.createdBy! } });
    expect(sys.status).toBe("inactive"); // 系統排程帳號
    const [it] = await intentsOf("a1");
    expect(it).toMatchObject({ routed: "auto_write", resultRef: r.id });
    expect(it!.resolution).toMatchObject({ auto_write: { result: "written", record_id: r.id, status: "pending_approval" } });
    expect(await qCount()).toBe(0);
    const audits = await prisma.auditLog.findMany({ where: { tableName: "shift_records", rowId: r.id } });
    expect(audits.length).toBeGreaterThanOrEqual(1);
  });

  it("群組 auto_confirm=true → status=confirmed", async () => {
    await setGroup({ autoConfirm: true });
    await feed("a2", "聽日測試乙返夜", llmJson());
    expect((await recs(ids.gB))[0]).toMatchObject({ status: "confirmed", source: "whatsapp" });
  });

  it("請假：經 write service 寫 leave 記錄（code＝請假碼，更種用該盤第一個更種）", async () => {
    await feed("a3", "我聽日病假", leaveJson());
    const rs = await recs(ids.gA);
    expect(rs).toHaveLength(1);
    expect(rs[0]).toMatchObject({ recordType: "leave", leaveCode: "SL", status: "pending_approval", source: "whatsapp", shiftTypeId: ids.tA });
    expect((await intentsOf("a3"))[0]).toMatchObject({ routed: "auto_write", resultRef: rs[0]!.id });
  });

  it("群組 auto_write=false → dry-run：保持 routed=auto_write、唔寫、唔開題", async () => {
    await setGroup({ autoWrite: false });
    await feed("a4", "聽日測試乙返夜", llmJson());
    expect(await recs()).toHaveLength(0);
    expect(await qCount()).toBe(0);
    const [it] = await intentsOf("a4");
    expect(it).toMatchObject({ routed: "auto_write", resultRef: null });
    expect(autoWriteOutcomeOf(it!.resolution, null)).toBe("suggested");
  });

  it("信心 < 0.6 → triage（low_confidence），唔寫", async () => {
    await feed("a5", "聽日測試乙返夜", llmJson({ confidence: 0.5 }));
    expect(await recs()).toHaveLength(0);
    expect((await intentsOf("a5"))[0]).toMatchObject({ routed: "triage" });
    expect(await qCount()).toBe(1);
  });

  it("鎖月（resolve 時已鎖）→ triage wa_shift_conflict，唔寫", async () => {
    await prisma.monthClose.create({ data: { month: new Date("2026-10-01T00:00:00Z"), lockedAt: new Date(), createdBy: "test:w3" } });
    await feed("a6", "聽日測試乙返夜", llmJson());
    expect(await recs()).toHaveLength(0);
    const q = await prisma.triageQuestion.findFirstOrThrow({ where: { session: { sourceType: "whatsapp" } } });
    expect(q.kind).toBe("wa_shift_conflict");
  });

  it("同更已存在 → 唔寫（W1 判 ignored/already_exists）", async () => {
    await prisma.shiftRecord.create({ data: { workDate: new Date("2026-10-17T00:00:00Z"), siteId: ids.site, shiftTypeId: ids.tN, guardId: ids.gB, recordType: "shift", status: "confirmed", source: "manual", createdBy: boss } });
    await feed("a7", "聽日測試乙返夜", llmJson());
    expect(await recs()).toHaveLength(1);
    expect((await intentsOf("a7"))[0]).toMatchObject({ routed: "ignored" });
    expect(await qCount()).toBe(0);
  });

  it("同日撞另一更 → triage（wa_shift_conflict），唔寫", async () => {
    await prisma.shiftRecord.create({ data: { workDate: new Date("2026-10-17T00:00:00Z"), siteId: ids.site, shiftTypeId: ids.tA, guardId: ids.gB, recordType: "shift", status: "confirmed", source: "manual", createdBy: boss } });
    await feed("a8", "聽日測試乙返夜", llmJson());
    expect(await recs()).toHaveLength(1);
    expect((await intentsOf("a8"))[0]).toMatchObject({ routed: "triage" });
  });
});

// ---------------------------------------------------------------------------
describe("W3 安全閥：每日上限、總開關、5 分鐘去重", () => {
  it("每群每日上限：cap=1 → 第二條改 triage（daily_cap），第一條照寫；cap=0 → 全部 triage", async () => {
    await setGroup({ autoWriteDailyCap: 1 });
    await feed("c1", "聽日測試乙返夜", llmJson());
    await feed("c2", "後日測試乙返夜", llmJson({ date: { raw: "18號", kind: "absolute", iso_guess: "2026-10-18", to_iso_guess: null } }), 60);
    expect(await recs(ids.gB)).toHaveLength(1);
    const [i2] = await intentsOf("c2");
    expect(i2).toMatchObject({ routed: "triage" });
    expect(i2!.resolution).toMatchObject({ reasons: ["daily_cap"] });
    const q = await prisma.triageQuestion.findFirstOrThrow({ where: { session: { sourceType: "whatsapp" } } });
    expect(q.kind).toBe("wa_unparsed");
    const opts = q.optionsJson as Array<{ id: string }>;
    expect(opts.some((o) => o.id === "wa_accept")).toBe(true); // 可人手「照解析結果入更」
    await setGroup({ autoWriteDailyCap: 0 });
    await feed("c3", "19號測試乙返夜", llmJson({ date: { raw: "19號", kind: "absolute", iso_guess: "2026-10-19", to_iso_guess: null } }), 120);
    expect((await intentsOf("c3"))[0]!.resolution).toMatchObject({ reasons: ["daily_cap"] });
    expect(await recs(ids.gB)).toHaveLength(1);
  });

  it("每日上限按香港日計：另一個香港日重新計", async () => {
    await setGroup({ autoWriteDailyCap: 1 });
    await feed("d1", "聽日測試乙返夜", llmJson());
    // 下一個香港日（HK 10-17 13:00）嘅訊息，今日計數 0
    await feed("d2", "18號測試乙返夜", llmJson({ date: { raw: "18號", kind: "absolute", iso_guess: "2026-10-18", to_iso_guess: null } }), 24 * 3600);
    expect(await recs(ids.gB)).toHaveLength(2);
  });

  it("總開關 WA_AUTO_WRITE_ENABLED=0（或亂碼）→ 全部改 triage（auto_disabled），唔寫；預設／1 → 開", async () => {
    expect(waAutoWriteEnabled()).toBe(true);
    process.env.WA_AUTO_WRITE_ENABLED = "1";
    expect(waAutoWriteEnabled()).toBe(true);
    process.env.WA_AUTO_WRITE_ENABLED = "0";
    expect(waAutoWriteEnabled()).toBe(false);
    process.env.WA_AUTO_WRITE_ENABLED = "yes-please";
    expect(waAutoWriteEnabled()).toBe(false); // fail closed
    process.env.WA_AUTO_WRITE_ENABLED = "0";
    await feed("s1", "聽日測試乙返夜", llmJson());
    expect(await recs()).toHaveLength(0);
    const [i] = await intentsOf("s1");
    expect(i).toMatchObject({ routed: "triage" });
    expect(i!.resolution).toMatchObject({ reasons: ["auto_disabled"] });
    expect(await qCount()).toBe(1);
  });

  it("5 分鐘去重：同發訊人重覆同一 intent（第一條記錄已被退回）→ ignored(duplicate_recent)；超過 5 分鐘 → 照寫", async () => {
    await feed("u1", "聽日測試乙返夜", llmJson());
    const first = (await recs(ids.gB))[0]!;
    await prisma.shiftRecord.update({ where: { id: first.id }, data: { status: "cancelled" } });
    await feed("u2", "聽日測試乙返夜", llmJson(), 120);
    const [i2] = await intentsOf("u2");
    expect(i2).toMatchObject({ routed: "ignored", resultRef: null });
    expect(i2!.resolution).toMatchObject({ reasons: ["duplicate_recent"] });
    expect((await recs(ids.gB)).filter((r) => r.status !== "cancelled")).toHaveLength(0);
    await feed("u3", "聽日測試乙返夜", llmJson(), 420);
    expect((await intentsOf("u3"))[0]).toMatchObject({ routed: "auto_write" });
    expect((await recs(ids.gB)).filter((r) => r.status === "pending_approval")).toHaveLength(1);
  });

  it("不同發訊人重覆同一 intent 唔去重（走正常衝突流程）", async () => {
    await feed("u4", "聽日測試乙返夜", llmJson());
    const first = (await recs(ids.gB))[0]!;
    await prisma.shiftRecord.update({ where: { id: first.id }, data: { status: "cancelled" } });
    await feed("u5", "聽日測試乙返夜", llmJson(), 60, { senderJid: SENDER_X });
    expect((await intentsOf("u5"))[0]).toMatchObject({ routed: "auto_write" });
  });
});

// ---------------------------------------------------------------------------
describe("W3 autoWriteIntentsTx 直接測（併發競態／鎖月 race）", () => {
  async function seedIntent(over: Record<string, unknown> = {}) {
    const msg = await prisma.whatsappMessage.create({ data: { session: "default", chatJid: G1, messageId: "direct1", senderJid: SENDER_A, ts: T0, text: "x", status: "routed" } });
    const row = await prisma.whatsappIntent.create({
      data: { messageId: msg.messageId, messageRevision: 1, idx: 0, kind: "shift", workDate: new Date("2026-10-17T00:00:00Z"), siteId: ids.site, guardId: ids.gB, shiftTypeId: ids.tN, confidence: 0.9, resolution: { type: "shift", reasons: [], notes: [] }, routed: "auto_write", ...over } as never,
    });
    return { msg, row };
  }
  const grp = () => ({ id: groupId, autoWrite: true, autoConfirm: false, autoWriteDailyCap: 50 });
  const m = (msg: { messageId: string; chatJid: string; senderJid: string; ts: Date }) => ({ messageId: msg.messageId, revision: 1, chatJid: msg.chatJid, senderJid: msg.senderJid, senderGuardId: ids.gA, ts: msg.ts });

  it("resolve 之後先鎖月（race）→ 改 triage(month_locked)，唔寫", async () => {
    const { msg, row } = await seedIntent();
    await prisma.monthClose.create({ data: { month: new Date("2026-10-01T00:00:00Z"), lockedAt: new Date(), createdBy: "test:w3" } });
    const out = await prisma.$transaction((tx) => autoWriteIntentsTx(tx, { msg: m(msg), group: grp(), rows: [row], actorUserId: boss }));
    expect(out.patches.get(0)).toMatchObject({ routed: "triage", resultRef: null });
    expect(out.patches.get(0)!.resolution).toMatchObject({ reasons: ["month_locked"] });
    expect(await recs()).toHaveLength(0);
  });

  it("resolve 之後先出現同更記錄（race）→ no_op，result_ref＝既有記錄 id，唔重覆寫", async () => {
    const { msg, row } = await seedIntent();
    const ex = await prisma.shiftRecord.create({ data: { workDate: new Date("2026-10-17T00:00:00Z"), siteId: ids.site, shiftTypeId: ids.tN, guardId: ids.gB, recordType: "shift", status: "pending_approval", source: "manual", createdBy: boss } });
    const out = await prisma.$transaction((tx) => autoWriteIntentsTx(tx, { msg: m(msg), group: grp(), rows: [row], actorUserId: boss }));
    expect(out.patches.get(0)).toMatchObject({ routed: "auto_write", resultRef: ex.id });
    expect(out.patches.get(0)!.resolution).toMatchObject({ auto_write: { result: "no_op" } });
    expect(await recs()).toHaveLength(1);
    expect(autoWriteOutcomeOf(out.patches.get(0)!.resolution, "pending_approval")).toBe("no_op");
  });

  it("race 下撞另一更（409）→ 改 triage（conflict_other_shift），唔寫、唔拋錯", async () => {
    const { msg, row } = await seedIntent({ kind: "leave", shiftTypeId: null, leaveCode: "SL" });
    await prisma.shiftRecord.create({ data: { workDate: new Date("2026-10-17T00:00:00Z"), siteId: ids.site, shiftTypeId: ids.tA, guardId: ids.gB, recordType: "shift", status: "confirmed", source: "manual", createdBy: boss } });
    // 同格（leaveRowShiftType＝最近用過嘅更種 A）已有 shift 記錄 → 類型唔同 → 409
    const out = await prisma.$transaction((tx) => autoWriteIntentsTx(tx, { msg: m(msg), group: grp(), rows: [row], actorUserId: boss }));
    expect(out.patches.get(0)).toMatchObject({ routed: "triage" });
    expect(out.patches.get(0)!.resolution).toMatchObject({ reasons: ["conflict_other_shift"] });
    expect(await recs()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
describe("W3 編輯／撤回後續", () => {
  it("編輯（內容改咗）：舊 pending 記錄自動退回（cancelled＋audit reason）、新 revision 重寫新記錄；舊 intent source_changed", async () => {
    await feed("e1", "聽日測試乙返夜", llmJson());
    const old = (await recs(ids.gB))[0]!;
    await editAndRun("e1", "聽日測試乙返早", llmJson({ shift_raw: "早" }));
    const after = await recs(ids.gB);
    expect(after).toHaveLength(2);
    const oldNow = after.find((r) => r.id === old.id)!;
    expect(oldNow.status).toBe("cancelled");
    const fresh = after.find((r) => r.id !== old.id)!;
    expect(fresh).toMatchObject({ status: "pending_approval", shiftTypeId: ids.tA, source: "whatsapp" });
    expect(fresh.provenance).toMatchObject({ message_id: "e1", revision: 2 });
    const aud = await prisma.auditLog.findMany({ where: { tableName: "shift_records", rowId: old.id, action: "void" } });
    expect(aud).toHaveLength(1);
    expect(JSON.stringify(aud[0]!.after)).toContain("source_message_edited");
    const its = await intentsOf("e1");
    expect(its[0]).toMatchObject({ messageRevision: 1, sourceChanged: true, supersededByRevision: 2 });
    expect(its[0]!.resolution).toMatchObject({ auto_write: { followup: "rejected_edited" } });
    expect(its[1]).toMatchObject({ messageRevision: 2, routed: "auto_write", resultRef: fresh.id });
  });

  it("編輯（只改無關字）：同一格 → 舊記錄退回後重用同一行重新寫入 pending", async () => {
    await feed("e2", "聽日測試乙返夜", llmJson());
    const old = (await recs(ids.gB))[0]!;
    await editAndRun("e2", "聽日測試乙返夜呀", llmJson());
    const after = await recs(ids.gB);
    expect(after).toHaveLength(1); // 重用已取消行
    expect(after[0]).toMatchObject({ id: old.id, status: "pending_approval" });
    expect(after[0]!.provenance).toMatchObject({ revision: 2 });
  });

  it("編輯後新 revision 變雜訊／唔再報更：舊 pending 記錄照樣退回，冇新記錄", async () => {
    await feed("e3", "聽日測試乙返夜", llmJson());
    await ingest(ev("edited", "e3", "收到", 30));
    await run(fakeLlm(() => llmJson()));
    const after = await recs(ids.gB);
    expect(after).toHaveLength(1);
    expect(after[0]!.status).toBe("cancelled");
  });

  it("舊記錄已 confirmed：編輯唔自動改記錄，只標 source_changed；新 revision 同格 → 已存在唔重寫", async () => {
    await feed("e4", "聽日測試乙返夜", llmJson());
    const old = (await recs(ids.gB))[0]!;
    await prisma.shiftRecord.update({ where: { id: old.id }, data: { status: "confirmed" } });
    await editAndRun("e4", "聽日測試乙返早", llmJson({ shift_raw: "早" }));
    const after = await recs(ids.gB);
    expect(after.find((r) => r.id === old.id)!.status).toBe("confirmed");
    // 新 revision 想要 A 更，但同日已有 N 更（confirmed）→ 撞更 → triage，唔自動寫
    expect(after).toHaveLength(1);
    const its = await intentsOf("e4");
    expect(its[0]).toMatchObject({ sourceChanged: true });
    expect(its[0]!.resolution).toMatchObject({ auto_write: { followup: "flagged" } });
    expect(its[1]).toMatchObject({ routed: "triage" });
    expect(await prisma.auditLog.count({ where: { tableName: "shift_records", rowId: old.id, action: "void" } })).toBe(0);
  });

  it("舊記錄 pending 但該月已鎖 → 唔退回，只標示", async () => {
    await feed("e5", "聽日測試乙返夜", llmJson());
    const old = (await recs(ids.gB))[0]!;
    await prisma.monthClose.create({ data: { month: new Date("2026-10-01T00:00:00Z"), lockedAt: new Date(), createdBy: "test:w3" } });
    await editAndRun("e5", "聽日測試乙返夜呀", llmJson());
    expect((await recs(ids.gB)).find((r) => r.id === old.id)!.status).toBe("pending_approval");
    expect((await intentsOf("e5"))[0]!.resolution).toMatchObject({ auto_write: { followup: "flagged" } });
  });

  it("撤回：pending 記錄喺下個 job tick 自動退回（冪等）；confirmed 記錄唔掂、intent 標 source_changed", async () => {
    await feed("r1", "聽日測試乙返夜", llmJson());
    await feed("r2", "18號測試甲返早", llmJson({ persons: [{ raw: "測試甲", role: "worker" }], shift_raw: "早", date: { raw: "18號", kind: "absolute", iso_guess: "2026-10-18", to_iso_guess: null } }), 60, { senderJid: SENDER_X });
    const rB = (await recs(ids.gB))[0]!;
    const rA = (await recs(ids.gA))[0]!;
    await prisma.shiftRecord.update({ where: { id: rA.id }, data: { status: "confirmed" } });
    await ingest(ev("revoked", "r1", "", 90));
    await ingest(ev("revoked", "r2", "", 95, { senderJid: SENDER_X }));
    const res = await run(fakeLlm(() => llmJson()));
    expect(res.summary).toMatchObject({ revoked_rejected: 1 });
    expect((await recs(ids.gB))[0]!.status).toBe("cancelled");
    expect((await recs(ids.gA))[0]!.status).toBe("confirmed");
    expect((await intentsOf("r1"))[0]!.resolution).toMatchObject({ auto_write: { followup: "rejected_revoked" } });
    expect((await intentsOf("r2"))[0]).toMatchObject({ sourceChanged: true });
    const aud = await prisma.auditLog.findMany({ where: { tableName: "shift_records", rowId: rB.id, action: "void" } });
    expect(aud).toHaveLength(1);
    expect(JSON.stringify(aud[0]!.after)).toContain("source_message_revoked");
    const again = await run(fakeLlm(() => llmJson()));
    expect(again.summary).toMatchObject({ revoked_rejected: 0 });
    expect(await prisma.auditLog.count({ where: { tableName: "shift_records", rowId: rB.id, action: "void" } })).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe("W3 待批清單 API／批核", () => {
  it("pending API：列出 source=whatsapp＋pending_approval（原話／姓名按權限）、⚠ 標示（編輯後）、can_approve", async () => {
    await feed("p1", "聽日測試乙返夜", llmJson());
    const rec = (await recs(ids.gB))[0]!;
    const r = await json(await pendingGet(req("/api/whatsapp/pending")));
    expect(r.total).toBe(1);
    expect(r.can_see_text).toBe(true);
    expect(r.can_approve).toBe(true);
    expect(r.rows[0]).toMatchObject({ id: rec.id, site_name: "測試盤W3", work_date: "2026-10-17", code: "N", record_type: "shift", text: "聽日測試乙返夜", guard_name: "測試乙", group_label: "W3測試群", source_changed: false });
    // 手人編輯但未跑 job：原訊息 revision 已 > 記錄 revision → ⚠
    await ingest(ev("edited", "p1", "聽日測試乙返早", 30));
    const r2 = await json(await pendingGet(req("/api/whatsapp/pending")));
    expect(r2.rows[0].source_changed).toBe(true);
  });

  it("pending API RBAC：會計（無『保安員』view？）見唔到原話；雞頭／安員 403；未登入 401；group 篩選", async () => {
    await feed("p2", "聽日測試乙返夜", llmJson());
    for (const role of ["雞頭", "安員"] as const) {
      const ck = await sessionCookieForUser(fx.userIds[role]);
      expect((await pendingGet(req("/api/whatsapp/pending", ck))).status).toBe(403);
    }
    expect((await pendingGet(req("/api/whatsapp/pending", null))).status).toBe(401);
    const acc = await sessionCookieForUser(fx.userIds["會計"]);
    const ra = await pendingGet(req("/api/whatsapp/pending", acc));
    expect(ra.status).toBe(200);
    const ba = await json(ra);
    expect(ba.can_see_text).toBe(ba.rows[0].text !== null);
    expect(JSON.stringify(ba).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<id>").replace(/\d{4}-\d{2}-\d{2}(T[\d:.]+Z)?/g, "<d>")).not.toMatch(/\d{8}/);
    const other = await json(await pendingGet(req(`/api/whatsapp/pending?group=${groupId}`)));
    expect(other.total).toBe(1);
    await prisma.whatsappGroup.create({ data: { groupJid: "w3-g2@g.us", label: "第二群", kind: "ignored", createdBy: boss } });
    const g2 = await prisma.whatsappGroup.findFirstOrThrow({ where: { groupJid: "w3-g2@g.us" } });
    const none = await json(await pendingGet(req(`/api/whatsapp/pending?group=${g2.id}`)));
    expect(none.total).toBe(0);
  });

  it("一鍵批核：逐條 call 現有 approve route → confirmed；批核後清單冇咗；reject route → draft", async () => {
    await feed("p3", "聽日測試乙返夜", llmJson());
    await feed("p4", "18號測試乙返早", llmJson({ shift_raw: "早", date: { raw: "18號", kind: "absolute", iso_guess: "2026-10-18", to_iso_guess: null } }), 60);
    const rows = (await json(await pendingGet(req("/api/whatsapp/pending")))).rows as Array<{ id: string }>;
    expect(rows).toHaveLength(2);
    const ok = await approvePost(req(`/api/shift-records/${rows[0]!.id}/approve`, cookie, "POST"), params(rows[0]!.id));
    expect(ok.status).toBe(200);
    const rj = await rejectPost(req(`/api/shift-records/${rows[1]!.id}/reject`, cookie, "POST", { reason: "唔啱" }), params(rows[1]!.id));
    expect(rj.status).toBe(200);
    expect((await json(await pendingGet(req("/api/whatsapp/pending")))).total).toBe(0);
    const st = (await recs()).map((r) => r.status).sort();
    expect(st).toEqual(["confirmed", "draft"]);
  });
});

// ---------------------------------------------------------------------------
describe("W3 排更格 records API、統計、對照頁、日摘要、群組 cap", () => {
  it("records API：該盤該月 WhatsApp 記錄→原話／群／⚠；冇 site／month 400；雞頭 403", async () => {
    await feed("k1", "聽日測試乙返夜", llmJson());
    const rec = (await recs(ids.gB))[0]!;
    const r = await json(await recordsGet(req(`/api/whatsapp/records?site=${ids.site}&month=2026-10`)));
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ record_id: rec.id, text: "聽日測試乙返夜", group_label: "W3測試群", source_changed: false });
    await ingest(ev("revoked", "k1", "", 40));
    const r2 = await json(await recordsGet(req(`/api/whatsapp/records?site=${ids.site}&month=2026-10`)));
    expect(r2.rows[0]).toMatchObject({ source_changed: true, revoked: true });
    expect((await recordsGet(req("/api/whatsapp/records?month=2026-10"))).status).toBe(400);
    expect((await recordsGet(req(`/api/whatsapp/records?site=${ids.site}&month=bad`))).status).toBe(400);
    const ck = await sessionCookieForUser(fx.userIds["雞頭"]);
    expect((await recordsGet(req(`/api/whatsapp/records?site=${ids.site}&month=2026-10`, ck))).status).toBe(403);
    const other = await json(await recordsGet(req(`/api/whatsapp/records?site=other&month=2026-10`)));
    expect(other.rows).toHaveLength(0);
  });

  it("intents API auto_result＋stats auto_results：待批／已批／已拒／no-op/只係建議", async () => {
    await feed("t1", "聽日測試乙返夜", llmJson()); // 之後批核
    await feed("t2", "18號測試乙返早", llmJson({ shift_raw: "早", date: { raw: "18號", kind: "absolute", iso_guess: "2026-10-18", to_iso_guess: null } }), 60); // 保持 pending
    await feed("t3", "19號測試乙返夜", llmJson({ date: { raw: "19號", kind: "absolute", iso_guess: "2026-10-19", to_iso_guess: null } }), 120); // 之後退回
    const all = await recs(ids.gB);
    const byDate = (d: string) => all.find((r) => r.workDate.toISOString().slice(0, 10) === d)!;
    await prisma.shiftRecord.update({ where: { id: byDate("2026-10-17").id }, data: { status: "confirmed" } });
    await prisma.shiftRecord.update({ where: { id: byDate("2026-10-19").id }, data: { status: "draft" } });
    await setGroup({ autoWrite: false });
    await feed("t4", "20號測試乙返夜", llmJson({ date: { raw: "20號", kind: "absolute", iso_guess: "2026-10-20", to_iso_guess: null } }), 180);
    const ir = await json(await intentsGet(req("/api/whatsapp/intents?from=2026-10-16&to=2026-10-16")));
    const resBy = Object.fromEntries((ir.rows as Array<{ auto_result: string | null }>).map((x, i) => [i, x.auto_result]));
    expect(Object.values(resBy).sort()).toEqual(["approved", "pending", "rejected", "suggested"]);
    const sr = await json(await statsGet(req("/api/whatsapp/stats?from=2026-10-16&to=2026-10-16")));
    expect(sr.auto_results).toEqual({ written: 3, pending: 1, approved: 1, rejected: 1, no_op: 0, suggested: 1 });
  });

  it("日摘要：含『自動寫入 N、待批 M、拒絕 K』，只有數字", async () => {
    await feed("m1", "聽日測試乙返夜", llmJson());
    const next = new Date(T0.getTime() + 24 * 3600 * 1000);
    const r = await runWhatsappDailySummary(next, { force: true });
    expect(r.summary).toMatchObject({ auto_written: 1, auto_pending: 1, auto_rejected: 0 });
    const n = await prisma.appNotification.findFirstOrThrow({ where: { kind: "whatsapp_daily" } });
    expect(n.body).toContain("自動寫入 1、待批 1、拒絕 0");
    expect(n.body).not.toMatch(/測試|\d{8}/);
  });

  it("群組 PATCH auto_write_daily_cap：0–1000 接受、1001／負數 400；audit before/after 帶新欄；GET 回 auto_write_daily_cap", async () => {
    const ok = await groupsPatch(req("/api/whatsapp/groups", cookie, "PATCH", { id: groupId, auto_write_daily_cap: 20 }));
    expect(ok.status).toBe(200);
    expect((await json(ok)).auto_write_daily_cap).toBe(20);
    expect((await prisma.whatsappGroup.findUniqueOrThrow({ where: { id: groupId } })).autoWriteDailyCap).toBe(20);
    expect((await groupsPatch(req("/api/whatsapp/groups", cookie, "PATCH", { id: groupId, auto_write_daily_cap: 1001 }))).status).toBe(400);
    expect((await groupsPatch(req("/api/whatsapp/groups", cookie, "PATCH", { id: groupId, auto_write_daily_cap: -1 }))).status).toBe(400);
    const aud = await prisma.auditLog.findFirstOrThrow({ where: { tableName: "whatsapp_groups", rowId: groupId, action: "update" }, orderBy: { createdAt: "desc" } });
    expect(JSON.stringify(aud.after)).toContain("auto_write_daily_cap");
  });
});
