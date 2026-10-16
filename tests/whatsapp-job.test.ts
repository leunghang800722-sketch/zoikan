// W1：whatsapp_parse job 端到端（fake LLM，真 DB）：received → filter → parse → resolve → intents；
// 編輯 revision supersede、撤回、重試 3 次、stale、quoted 上下文、衝突（DB repo）、日摘要通知、保留期清 parsed_json。
// 全部假資料：測試甲／乙、測試盤W1、假電話 9000001x、假群 w1-g*@g.us。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { prisma as appPrisma } from "@/lib/db"; // 應用程式用嘅 client（spy 要打呢個）
import { runWhatsappParse, runWhatsappDailySummary } from "@/lib/jobs/whatsapp-parse";
import { runWhatsappRetention } from "@/lib/jobs/whatsapp-retention";
import { ingestEvent } from "@/lib/whatsapp/ingest";
import type { NormalizedWaEvent } from "@/lib/whatsapp/schema";
import { LlmUnavailableError, type LlmClient, type LlmChatParams } from "@/lib/ai/llm";
import { markRevokedIntents } from "@/lib/whatsapp/process";

const T0 = new Date("2026-10-16T05:00:00Z"); // HK 2026-10-16 13:00 星期五
const NOW = new Date(T0.getTime() + 60_000);
const G1 = "w1-g1@g.us";
const G2 = "w1-g2@g.us";
const SENDER_A = "85290000011@c.us"; // 測試甲
const SENDER_X = "85290009999@c.us"; // 未知

let ids: { site: string; guardA: string; guardB: string; tA: string; tN: string; broker: string };
let calls: LlmChatParams[];

const leaveJson = (raw = "聽日17號") =>
  JSON.stringify({ noise: false, intents: [{ type: "leave", date: { raw, kind: "absolute", iso_guess: "2026-10-17", to_iso_guess: null }, site_raw: null, persons: [], self_reference: true, shift_raw: null, shift_code_guess: null, hours: null, leave_raw: "病假", leave_code_guess: "SL", confidence: 0.9, evidence: "x" }] });
const shiftJson = (person = "測試乙", date = "聽日", shift = "夜") =>
  JSON.stringify({ noise: false, intents: [{ type: "shift", date: { raw: date, kind: "relative", iso_guess: null, to_iso_guess: null }, site_raw: null, persons: [{ raw: person, role: "worker" }], self_reference: false, shift_raw: shift, shift_code_guess: null, hours: null, leave_raw: null, leave_code_guess: null, confidence: 0.85, evidence: "y" }] });

/** 按訊息 text 腳本化嘅 fake LLM；記錄每次 params。 */
function fakeLlm(script: (text: string, params: LlmChatParams) => string | Error): LlmClient {
  return {
    async chat(params) {
      calls.push(params);
      const text = (JSON.parse(params.userMessage) as { text: string }).text;
      const out = script(text, params);
      if (out instanceof Error) throw out;
      return { text: out, toolsUsed: [], inputTokens: 100, outputTokens: 30, provider: "fake", model: "fake-m" };
    },
  };
}

function ev(kind: "message" | "edited" | "revoked", mid: string, text: string, tsOffsetSec = 0, over: Partial<NormalizedWaEvent> = {}): NormalizedWaEvent {
  return { kind, session: "default", messageId: mid, chatJid: G1, senderJid: SENDER_A, fromMe: false, ts: new Date(T0.getTime() + tsOffsetSec * 1000), text, mediaType: null, quotedMessageId: null, eventId: `${mid}-${kind}-${tsOffsetSec}-${text.length}`, ...over };
}
const ingest = (e: NormalizedWaEvent) => ingestEvent(e, new Date(Math.max(NOW.getTime(), (e.ts?.getTime() ?? 0) + 60_000)));
const msgRow = (mid: string) => prisma.whatsappMessage.findUniqueOrThrow({ where: { messageId: mid } });
const intentsOf = (mid: string) => prisma.whatsappIntent.findMany({ where: { messageId: mid }, orderBy: [{ messageRevision: "asc" }, { idx: "asc" }] });
const run = (llm: LlmClient, opts: { budgetMs?: number } = {}) => runWhatsappParse(NOW, { llm: [llm], force: true, ...opts });

beforeEach(async () => {
  await clearAll();
  calls = [];
  const broker = await prisma.broker.create({ data: { code: "TEST-W1B", name: "測試判頭W1", kind: "broker", settlementType: "cash", createdBy: "test:w1" } });
  const site = await prisma.site.create({ data: { canonicalName: "測試盤W1", clientName: "測試客戶W1", billingModel: "per_shift", createdBy: "test:w1" } });
  const tA = await prisma.shiftType.create({ data: { siteId: site.id, code: "A", label: "早更", startTime: new Date("1970-01-01T07:00:00Z"), endTime: new Date("1970-01-01T15:00:00Z"), hours: 8, createdBy: "test:w1" } });
  const tN = await prisma.shiftType.create({ data: { siteId: site.id, code: "N", label: "夜更", startTime: new Date("1970-01-01T19:00:00Z"), endTime: new Date("1970-01-01T07:00:00Z"), hours: 12, createdBy: "test:w1" } });
  const guardA = await prisma.guard.create({ data: { nameZh: "測試甲", employmentType: "cash_casual", tel: "90000011", defaultBrokerId: broker.id, createdBy: "test:w1" } });
  const guardB = await prisma.guard.create({ data: { nameZh: "測試乙", employmentType: "cash_casual", tel: "90000012", nameAliases: ["阿乙"], createdBy: "test:w1" } });
  ids = { site: site.id, guardA: guardA.id, guardB: guardB.id, tA: tA.id, tN: tN.id, broker: broker.id };
  await prisma.whatsappGroup.create({ data: { groupJid: G1, label: "W1測試群一", kind: "site", siteId: site.id, shiftWordMap: { 早: "A", 夜: "N" }, createdBy: "test:w1" } });
});
afterEach(() => {
  delete process.env.WA_ENABLED;
});

describe("W1 job：總開關", () => {
  it("WA_ENABLED 未開 → skipped，唔處理任何訊息", async () => {
    await ingest(ev("message", "m1", "我聽日18號病假"));
    const r = await runWhatsappParse(NOW, { llm: [fakeLlm(() => leaveJson())] });
    expect(r).toMatchObject({ status: "skipped", summary: { enabled: false } });
    expect((await msgRow("m1")).status).toBe("received");
    expect(calls.length).toBe(0);
  });
  it("WA_ENABLED=1 → 處理", async () => {
    process.env.WA_ENABLED = "1";
    await ingest(ev("message", "m1", "我聽日18號病假"));
    const r = await runWhatsappParse(NOW, { llm: [fakeLlm(() => leaveJson())] });
    expect(r.summary).toMatchObject({ processed: 1, routed: 1 });
  });
});

describe("W1 job：received → intents", () => {
  it("請假＋報更＋雜訊：status、filter、LLM 用量、intents、routed 判定", async () => {
    const triageBefore = await prisma.triageQuestion.count();
    await ingest(ev("message", "m-leave", "我聽日18號病假，返唔到", 0));
    await ingest(ev("message", "m-shift", "聽日測試乙返夜", 10, { senderJid: SENDER_X }));
    await ingest(ev("message", "m-ack", "收到", 20));
    const llm = fakeLlm((t) => (t.includes("病假") ? leaveJson() : shiftJson()));
    const r = await run(llm);
    expect(r.summary).toMatchObject({ processed: 3, routed: 2, ignored: 1, intents: 2, auto_write: 2, triage: 0, backlog: 0, llm_tokens_in: 200, llm_tokens_out: 60 });
    expect(calls.length).toBe(2); // 「收到」被第 0 層擋住，唔食 LLM

    const leave = await msgRow("m-leave");
    expect(leave).toMatchObject({ status: "routed", llmProvider: "fake", llmModel: "fake-m", llmTokensIn: 100, llmTokensOut: 30, parseAttempts: 0, error: null });
    expect(leave.filterScore).toBeGreaterThanOrEqual(40);
    expect(Array.isArray(leave.filterReasons)).toBe(true);
    expect(leave.parsedJson).toMatchObject({ noise: false });
    const [li] = await intentsOf("m-leave");
    expect(li).toMatchObject({ kind: "leave", leaveCode: "SL", guardId: ids.guardA, siteId: ids.site, routed: "auto_write", messageRevision: 1, idx: 0 });
    expect(li!.workDate!.toISOString().slice(0, 10)).toBe("2026-10-17");
    expect(JSON.stringify(li!.resolution)).not.toMatch(/測試|病假/);

    const [si] = await intentsOf("m-shift");
    expect(si).toMatchObject({ kind: "shift", guardId: ids.guardB, shiftTypeId: ids.tN, routed: "auto_write" });

    const ack = await msgRow("m-ack");
    expect(ack).toMatchObject({ status: "ignored", ignoreReason: "filtered_out" });
    expect(ack.filterScore).toBeLessThan(40);
    expect(await intentsOf("m-ack")).toHaveLength(0);
    // W1 唔寫更表、唔開分流題
    expect(await prisma.shiftRecord.count()).toBe(0);
    expect(await prisma.triageQuestion.count()).toBe(triageBefore);
  });
  it("LLM 只見訊息原文＋更碼表＋口語對照，冇保安員名單", async () => {
    process.env.WA_ENABLED = "1";
    await ingest(ev("message", "m1", "我聽日18號病假"));
    await run(fakeLlm(() => leaveJson()));
    const p = calls[0]!;
    const u = JSON.parse(p.userMessage) as Record<string, unknown>;
    expect(Object.keys(u).sort()).toEqual(["group_kind", "message_time_hk", "quoted_text", "shift_table", "shift_words", "text"]);
    expect(u.shift_table).toEqual([{ code: "A", label: "早更", time: "07:00-15:00" }, { code: "N", label: "夜更", time: "19:00-07:00" }]);
    expect(u.shift_words).toEqual({ 早: "A", 夜: "N" });
    expect(p.userMessage).not.toContain("測試甲");
    expect(p.userMessage).not.toContain("90000011");
    expect(p.structured).toMatchObject({ format: "json_object", maxTokens: 2000, temperature: 0, reasoningEffort: "low" });
  });
  it("未綁定群組／ignored 群組 → ignored（group_unbound／group_ignored），唔食 LLM", async () => {
    await prisma.whatsappGroup.create({ data: { groupJid: G2, label: "略過群", kind: "ignored", createdBy: "test:w1" } });
    await ingest(ev("message", "u1", "聽日測試乙返夜", 0, { chatJid: "w1-unbound@g.us" }));
    await ingest(ev("message", "u2", "聽日測試乙返夜", 5, { chatJid: G2 }));
    await run(fakeLlm(() => shiftJson()));
    expect(await msgRow("u1")).toMatchObject({ status: "ignored", ignoreReason: "group_unbound" });
    expect(await msgRow("u2")).toMatchObject({ status: "ignored", ignoreReason: "group_ignored" });
    expect(calls.length).toBe(0);
  });
  it("群組閾值覆寫 filter_threshold 生效", async () => {
    await prisma.whatsappGroup.update({ where: { groupJid: G1 }, data: { filterThreshold: 90 } });
    await ingest(ev("message", "t1", "聽日測試乙返夜"));
    await run(fakeLlm(() => shiftJson()));
    expect(await msgRow("t1")).toMatchObject({ status: "ignored", ignoreReason: "filtered_out" });
    expect(calls.length).toBe(0);
  });
  it("LLM 判 noise → ignored(llm_noise)，無 intents，parsed_json 保留", async () => {
    await ingest(ev("message", "n1", "聽日大家早啲返工呀"));
    await run(fakeLlm(() => JSON.stringify({ noise: true, intents: [] })));
    expect(await msgRow("n1")).toMatchObject({ status: "ignored", ignoreReason: "llm_noise", llmProvider: "fake" });
    expect(await intentsOf("n1")).toHaveLength(0);
  });
  it("壞 JSON → 一條 unclear（triage，wa_unparsed），訊息 routed，parsed_json 記錯誤碼", async () => {
    await ingest(ev("message", "b1", "我聽日18號病假"));
    const r = await run(fakeLlm(() => "唔係 JSON"));
    expect(r.summary).toMatchObject({ routed: 1, triage: 1 });
    const [i] = await intentsOf("b1");
    expect(i).toMatchObject({ kind: "unclear", routed: "triage" });
    expect((i!.resolution as { notes: string[] }).notes).toContain("llm_bad_output");
    expect((await msgRow("b1")).parsedJson).toEqual({ error: "bad_json" });
  });
  it("noise=false 但冇 intent → unclear triage；question_only → ignored", async () => {
    await ingest(ev("message", "e1", "聽日測試乙返夜", 0));
    await ingest(ev("message", "e2", "邊個返聽日夜更？", 5));
    await run(fakeLlm((t) => (t.startsWith("邊個") ? JSON.stringify({ noise: false, intents: [{ type: "question_only", confidence: 0.9 }] }) : JSON.stringify({ noise: false, intents: [] }))));
    expect((await intentsOf("e1"))[0]).toMatchObject({ kind: "unclear", routed: "triage" });
    expect((await intentsOf("e2"))[0]).toMatchObject({ kind: "question_only", routed: "ignored" });
  });
  it("凌晨「今晚」→ date_ambiguous，候選兩日，唔自動", async () => {
    await ingest(ev("message", "d1", "今晚測試乙返夜", 13 * 3600)); // T0+13h = HK 02:00 星期六
    await run(fakeLlm(() => shiftJson("測試乙", "今晚")));
    const [i] = await intentsOf("d1");
    expect(i).toMatchObject({ routed: "triage", workDate: null });
    expect(i!.resolution).toMatchObject({ reasons: expect.arrayContaining(["date_ambiguous"]), candidates: { dates: ["2026-10-17", "2026-10-16"] } });
  });
  it("多人＋range 展開成多條 intent，idx 連續", async () => {
    await ingest(ev("message", "r1", "17-19號測試乙測試甲返夜"));
    await run(fakeLlm(() => JSON.stringify({ noise: false, intents: [{ type: "shift", date: { raw: "17-19號", kind: "range" }, persons: [{ raw: "測試乙", role: "worker" }, { raw: "阿乙", role: "worker" }], shift_raw: "夜", confidence: 0.8 }] })));
    const rows = await intentsOf("r1");
    expect(rows.map((x) => x.idx)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(rows.filter((x) => x.routed === "auto_write")).toHaveLength(3); // 同一人兩個名 → 後面三條 duplicate_in_message
    expect(rows.filter((x) => x.routed === "ignored")).toHaveLength(3);
  });
});

describe("W1 job：衝突（真 DB repo）", () => {
  const rec = (over: Record<string, unknown>) => prisma.shiftRecord.create({ data: { workDate: new Date("2026-10-17T00:00:00Z"), siteId: ids.site, shiftTypeId: ids.tN, guardId: ids.guardB, recordType: "shift", status: "confirmed", createdBy: "test:w1", ...over } as never });
  it("同更已存在 → ignored(already_exists)", async () => {
    await rec({});
    await ingest(ev("message", "c1", "聽日測試乙返夜"));
    await run(fakeLlm(() => shiftJson()));
    const [i] = await intentsOf("c1");
    expect(i).toMatchObject({ routed: "ignored" });
    expect((i!.resolution as { reasons: string[] }).reasons).toEqual(["already_exists"]);
  });
  it("同日另一更／請假 → triage", async () => {
    await rec({ shiftTypeId: ids.tA });
    await ingest(ev("message", "c2", "聽日測試乙返夜"));
    await run(fakeLlm(() => shiftJson()));
    expect((await intentsOf("c2"))[0]!.resolution).toMatchObject({ reasons: ["conflict_other_shift"] });
  });
  it("鎖月 → month_locked", async () => {
    await prisma.monthClose.create({ data: { month: new Date("2026-10-01T00:00:00Z"), lockedAt: new Date(), createdBy: "test:w1" } });
    await ingest(ev("message", "c3", "聽日測試乙返夜"));
    await run(fakeLlm(() => shiftJson()));
    expect((await intentsOf("c3"))[0]).toMatchObject({ routed: "triage" });
    expect((await intentsOf("c3"))[0]!.resolution).toMatchObject({ reasons: ["month_locked"] });
  });
  it("額滿（DailyRequirement）→ slot_full；quota 滿 → quota_full", async () => {
    await prisma.dailyRequirement.create({ data: { siteId: ids.site, shiftTypeId: ids.tN, workDate: new Date("2026-10-17T00:00:00Z"), headcountRequired: 1, createdBy: "test:w1" } });
    await rec({ guardId: ids.guardA });
    await ingest(ev("message", "c4", "聽日測試乙返夜"));
    await run(fakeLlm(() => shiftJson()));
    expect((await intentsOf("c4"))[0]!.resolution).toMatchObject({ reasons: ["slot_full"] });
    // quota：測試甲（預設判頭）
    await prisma.dailyRequirement.deleteMany({});
    await prisma.shiftRecord.deleteMany({});
    await prisma.quota.create({ data: { month: new Date("2026-10-01T00:00:00Z"), siteId: ids.site, shiftTypeId: ids.tN, brokerId: ids.broker, targetShifts: 1, createdBy: "test:w1" } });
    await rec({ guardId: ids.guardB, workDate: new Date("2026-10-20T00:00:00Z"), settlementBrokerId: ids.broker });
    await ingest(ev("message", "c5", "我聽日返夜", 30));
    await run(fakeLlm(() => JSON.stringify({ noise: false, intents: [{ type: "shift", date: { raw: "聽日", kind: "relative" }, self_reference: true, shift_raw: "夜", confidence: 0.9 }] })));
    expect((await intentsOf("c5"))[0]!.resolution).toMatchObject({ reasons: ["quota_full"] });
  });
});

describe("W1 job：重試與 stale", () => {
  it("LLM 暫時連唔到：前兩次留低 received（attempts 1／2），第三次 → error（原因碼，唔含原文）", async () => {
    await ingest(ev("message", "x1", "我聽日18號病假"));
    const down = fakeLlm(() => new LlmUnavailableError());
    const r1 = await run(down);
    expect(r1.summary).toMatchObject({ retry: 1, backlog: 1 });
    expect(await msgRow("x1")).toMatchObject({ status: "received", parseAttempts: 1, error: "llm_unavailable" });
    await run(down);
    expect(await msgRow("x1")).toMatchObject({ status: "received", parseAttempts: 2 });
    const r3 = await run(down);
    expect(r3.summary).toMatchObject({ error: 1, backlog: 0 });
    expect(await msgRow("x1")).toMatchObject({ status: "error", parseAttempts: 3, error: "llm_unavailable" });
    // error 之後唔再被撈
    const r4 = await run(down);
    expect(r4.status).toBe("skipped");
  });
  it("重試成功 → attempts 歸零", async () => {
    await ingest(ev("message", "x2", "我聽日18號病假"));
    await run(fakeLlm(() => new LlmUnavailableError()));
    await run(fakeLlm(() => leaveJson()));
    expect(await msgRow("x2")).toMatchObject({ status: "routed", parseAttempts: 0, error: null });
  });
  it("處理期間訊息被編輯 → stale（唔寫 intents），下一輪用新 revision", async () => {
    await ingest(ev("message", "s1", "我聽日18號病假"));
    let edited = false;
    const sneaky: LlmClient = {
      async chat(params) {
        if (!edited) {
          edited = true;
          await ingest(ev("edited", "s1", "我聽日19號病假", 30));
        }
        calls.push(params);
        return { text: leaveJson(), toolsUsed: [], inputTokens: 1, outputTokens: 1, provider: "fake", model: "fake-m" };
      },
    };
    const r1 = await run(sneaky);
    expect(r1.summary).toMatchObject({ stale: 1 });
    expect(await intentsOf("s1")).toHaveLength(0);
    expect(await msgRow("s1")).toMatchObject({ status: "received", revision: 2 });
    await run(fakeLlm(() => leaveJson("19號")));
    expect((await intentsOf("s1")).map((i) => i.messageRevision)).toEqual([2]);
  });
});

describe("W1 job：任何例外都計失敗（唔無限重試）", () => {
  it("落結果 transaction 持續拋錯 → 3 次後 status=error，LLM 只叫 3 次，之後唔再叫", async () => {
    await ingest(ev("message", "pf1", "我聽日18號病假"));
    const holder = appPrisma as unknown as { $transaction: unknown };
    const orig = holder.$transaction;
    holder.$transaction = async () => {
      throw new Error("db boom");
    };
    try {
      const llm = fakeLlm(() => leaveJson());
      for (let i = 0; i < 5; i++) await run(llm);
    } finally {
      holder.$transaction = orig;
    }
    expect(calls.length).toBe(3);
    expect(await msgRow("pf1")).toMatchObject({ status: "error", parseAttempts: 3, error: "process_failed" });
  });
});

describe("W1 job：編輯／撤回", () => {
  it("編輯 → 新 revision 重新走一次；舊 revision intents 標 superseded_by_revision", async () => {
    await ingest(ev("message", "ed1", "我聽日18號病假"));
    await run(fakeLlm(() => leaveJson()));
    expect((await intentsOf("ed1")).map((i) => [i.messageRevision, i.supersededByRevision])).toEqual([[1, null]]);
    expect(await ingest(ev("edited", "ed1", "我聽日夜更改返嚟上班", 60))).toBe("edited");
    expect((await intentsOf("ed1"))[0]!.sourceChanged).toBe(true); // W0 已標
    await run(fakeLlm(() => shiftJson("測試乙", "聽日", "夜")));
    const rows = await intentsOf("ed1");
    expect(rows.map((i) => [i.messageRevision, i.supersededByRevision, i.kind])).toEqual([[1, 2, "leave"], [2, null, "shift"]]);
    expect(await msgRow("ed1")).toMatchObject({ status: "routed", revision: 2 });
  });
  it("編輯後新文字被過濾 → 舊 intents 一樣標被取代", async () => {
    await ingest(ev("message", "ed2", "我聽日18號病假"));
    await run(fakeLlm(() => leaveJson()));
    await ingest(ev("edited", "ed2", "唔使喇多謝", 60));
    await run(fakeLlm(() => leaveJson()));
    expect((await intentsOf("ed2"))[0]!.supersededByRevision).toBe(2);
    expect(await msgRow("ed2")).toMatchObject({ status: "ignored", ignoreReason: "filtered_out" });
  });
  it("A→B→A 合法編輯：revision 3 重新解析", async () => {
    await ingest(ev("message", "ed3", "我聽日18號病假"));
    await run(fakeLlm(() => leaveJson()));
    await ingest(ev("edited", "ed3", "我聽日19號病假", 60));
    await run(fakeLlm(() => leaveJson("19號")));
    await ingest(ev("edited", "ed3", "我聽日18號病假", 120));
    await run(fakeLlm(() => leaveJson()));
    expect((await intentsOf("ed3")).map((i) => [i.messageRevision, i.supersededByRevision])).toEqual([[1, 2], [2, 3], [3, null]]);
  });
  it("撤回 → intents 標 revoked_at；之後唔再處理", async () => {
    await ingest(ev("message", "rv1", "我聽日18號病假"));
    await run(fakeLlm(() => leaveJson()));
    expect(await ingest(ev("revoked", "rv1", "", 60))).toBe("revoked");
    const r = await run(fakeLlm(() => leaveJson()));
    expect(r.summary).toMatchObject({ revoked_marked: 1 });
    const [i] = await intentsOf("rv1");
    expect(i!.revokedAt).not.toBeNull();
    expect(i!.sourceChanged).toBe(true);
    expect((await msgRow("rv1")).status).toBe("revoked");
    expect(calls.length).toBe(1);
    expect(await markRevokedIntents(NOW)).toBe(0); // 冪等
  });
  it("未處理就撤回 → 唔食 LLM", async () => {
    await ingest(ev("message", "rv2", "我聽日18號病假"));
    await ingest(ev("revoked", "rv2", "", 30));
    await run(fakeLlm(() => leaveJson()));
    expect(calls.length).toBe(0);
  });
});

describe("W1 job：被回覆上下文（quoted）", () => {
  it("同群 24 小時內 → 傳 quoted_text；超過 24 小時 → 唔傳", async () => {
    await ingest(ev("message", "q0", "聽日夜更測試乙有冇人返？", -3600, { senderJid: SENDER_X })); // 1 小時前
    await ingest(ev("message", "q-old", "舊嘅通知文字", -30 * 3600, { senderJid: SENDER_X }));
    await ingest(ev("message", "q1", "好，我頂", 0, { quotedMessageId: "q0" }));
    await ingest(ev("message", "q2", "好，我頂呀", 5, { quotedMessageId: "q-old" }));
    // q0／q-old 本身交 LLM 解析（唔關今次斷言）；只睇 q1／q2 嘅 quoted_text
    const llm = fakeLlm((t) => (t === "好，我頂" || t === "好，我頂呀" ? shiftJson() : JSON.stringify({ noise: true, intents: [] })));
    await prisma.whatsappMessage.updateMany({ where: { messageId: "q-old" }, data: { status: "ignored" } }); // q-old 太舊（>72h 窗口外唔會）；直接略過
    await run(llm);
    const byText = (t: string) => calls.find((c) => (JSON.parse(c.userMessage) as { text: string }).text === t);
    expect((JSON.parse(byText("好，我頂")!.userMessage) as { quoted_text: string | null }).quoted_text).toBe("聽日夜更測試乙有冇人返？");
    // q-old 喺 q2 之前 30 小時，超出 24 小時窗口 → 冇 quoted；而且短回覆因此被第 0 層過濾（冇上下文）
    expect(byText("好，我頂呀")).toBeUndefined();
    expect(await msgRow("q2")).toMatchObject({ status: "ignored", ignoreReason: "filtered_out" });
  });
});

describe("W1 job：日摘要、保留期", () => {
  it("日摘要：通知老闆、只有數字、同日冪等", async () => {
    process.env.WA_ENABLED = "1";
    await ingest(ev("message", "sm1", "我聽日18號病假", 0));
    await ingest(ev("message", "sm2", "收到", 10));
    await run(fakeLlm(() => leaveJson()));
    const next = new Date("2026-10-17T01:30:00Z"); // HK 2026-10-17 09:30 → 前一日 = 10-16
    const r = await runWhatsappDailySummary(next);
    expect(r.summary).toMatchObject({ day: "2026-10-16", received: 2, filtered: 1, parsed: 1, auto_write: 1 });
    const n = await prisma.appNotification.findFirstOrThrow({ where: { kind: "whatsapp_daily" } });
    expect(n.audience).toEqual(["老闆"]);
    expect(n.body).toMatch(/收 2、過濾 1、解析 1/);
    expect(n.body).not.toMatch(/測試|病假/);
    await runWhatsappDailySummary(next);
    expect(await prisma.appNotification.count({ where: { kind: "whatsapp_daily" } })).toBe(1);
  });
  it("日摘要：冇訊息 → skipped；總開關關 → skipped", async () => {
    expect((await runWhatsappDailySummary(new Date("2026-10-17T01:30:00Z"), { force: true })).status).toBe("skipped");
    expect((await runWhatsappDailySummary(new Date("2026-10-17T01:30:00Z"))).status).toBe("skipped");
  });
  it("保留期 job 一併清走 parsed_json（含原話片段），intents 保留", async () => {
    await ingest(ev("message", "rt1", "我聽日18號病假"));
    await run(fakeLlm(() => leaveJson()));
    expect((await msgRow("rt1")).parsedJson).not.toBeNull();
    const far = new Date(T0.getTime() + 100 * 86400000);
    await runWhatsappRetention(far);
    const m = await msgRow("rt1");
    expect(m.text).toBe("");
    expect(m.parsedJson).toBeNull();
    expect(await intentsOf("rt1")).toHaveLength(1);
  });
});
