// WA-9：文字名單端到端——「1/10/2026 名 名 名…」→ 偵測（唔 call LLM）→ N 條 shift 記錄（pending_approval）；配唔到／同名多人嘅名先出題；
// 編輯＝整批取消再重做、撤回＝整批退回；指標。全部合成資料（假名、假電話）。
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { runWhatsappParse } from "@/lib/jobs/whatsapp-parse";
import { ingestEvent } from "@/lib/whatsapp/ingest";
import type { NormalizedWaEvent } from "@/lib/whatsapp/schema";
import type { LlmClient } from "@/lib/ai/llm";
import { computeMetrics } from "@/lib/whatsapp/metrics";

const T0 = new Date("2026-10-01T05:00:00Z"); // HK 2026-10-01 13:00
const NOW = new Date(T0.getTime() + 60_000);
const G1 = "wa9-roster-g1@g.us";
const NAMES = ["陳測甲", "李測乙", "張測丙", "黃測丁"];
let fx: Wp2Fixture;
let ids: { site: string; tD: string; guards: Record<string, string> };

const noLlm: LlmClient = { async chat() { throw new Error("LLM 唔應該被呼叫（文字名單純 code 路徑）"); } };
let llmCalled = 0;
const guardLlm: LlmClient = { async chat(p) { llmCalled++; return noLlm.chat(p); } };
const ev = (kind: "message" | "edited" | "revoked", mid: string, text: string, off = 0): NormalizedWaEvent => ({ kind, session: "default", messageId: mid, chatJid: G1, senderJid: "85290008888@c.us", fromMe: false, ts: new Date(T0.getTime() + off * 1000), text, mediaType: null, quotedMessageId: null, eventId: `${mid}-${kind}-${off}-${text.length}` });
const ingest = (e: NormalizedWaEvent) => ingestEvent(e, new Date(Math.max(NOW.getTime(), (e.ts?.getTime() ?? 0) + 60_000)));
const run = () => runWhatsappParse(NOW, { llm: [guardLlm], force: true });
const recs = () => prisma.shiftRecord.findMany({ where: { siteId: ids.site }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
const qs = (mid: string) => prisma.triageQuestion.findMany({ where: { status: "open", session: { sourceType: "whatsapp" }, evidenceJson: { path: ["message", "message_id"], equals: mid } } });

beforeEach(async () => {
  await clearAll();
  await prisma.triageQuestion.deleteMany({});
  await prisma.triageSession.deleteMany({});
  llmCalled = 0;
  fx = await seedWp2Fixture();
  const site = await prisma.site.create({ data: { canonicalName: "測試盤W9", clientName: "測試客戶W9", billingModel: "per_shift", createdBy: "test:w9" } });
  const tD = await prisma.shiftType.create({ data: { siteId: site.id, code: "D", label: "日更", startTime: new Date("1970-01-01T08:00:00Z"), endTime: new Date("1970-01-01T20:00:00Z"), hours: 12, createdBy: "test:w9" } as never });
  const guards: Record<string, string> = {};
  for (const [i, n] of NAMES.entries()) guards[n] = (await prisma.guard.create({ data: { nameZh: n, employmentType: "cash_casual", tel: `9000009${i}`, createdBy: "test:w9" } })).id;
  ids = { site: site.id, tD: tD.id, guards };
  await prisma.whatsappGroup.create({ data: { groupJid: G1, label: "W9名單群", kind: "site", siteId: site.id, shiftWordMap: { 開工: "D" }, autoWrite: true, createdBy: fx.userIds["老闆"] } });
});

describe("WA-9 文字名單端到端", () => {
  it("N 個名 → N 條 pending_approval 記錄（同一 message_id 追溯），冇 call LLM；日期＝名單日期；指標", async () => {
    await ingest(ev("message", "r1", `1/10/2026 ${NAMES.join(" ")}`));
    await run();
    expect(llmCalled).toBe(0);
    const rs = await recs();
    expect(rs).toHaveLength(4);
    expect(rs.every((r) => r.status === "pending_approval" && r.source === "whatsapp" && r.shiftTypeId === ids.tD)).toBe(true);
    expect(rs.every((r) => r.workDate.toISOString().slice(0, 10) === "2026-10-01")).toBe(true);
    expect(rs.every((r) => (r.provenance as { message_id?: string }).message_id === "r1")).toBe(true);
    expect(new Set(rs.map((r) => r.guardId))).toEqual(new Set(Object.values(ids.guards)));
    expect(await qs("r1")).toHaveLength(0);
    const m = await prisma.whatsappMessage.findUniqueOrThrow({ where: { messageId: "r1" } });
    expect(m).toMatchObject({ status: "routed", llmProvider: "roster" });
    expect(JSON.stringify(m.parsedJson)).not.toContain("陳測甲"); // 只記計數
    expect(m.filterReasons).toEqual(["roster_list"]);
    const mt = await computeMetrics(7, new Date(T0.getTime() + 3600_000));
    expect(mt.totals).toMatchObject({ roster_list_msgs: 1, roster_names: 4, roster_names_matched: 4, roster_names_triage: 0 });
  });

  it("只有配唔到／同名多人嘅名先出題；其餘照寫；更碼後綴（N）帶去更別", async () => {
    await prisma.guard.create({ data: { nameZh: "李測乙", employmentType: "cash_casual", tel: "90000099", createdBy: "test:w9" } }); // 同名
    await ingest(ev("message", "r2", "1/10/2026 陳測甲 李測乙 周查無此人 張測丙"));
    await run();
    expect(llmCalled).toBe(0);
    expect((await recs()).map((r) => r.guardId).sort()).toEqual([ids.guards["陳測甲"], ids.guards["張測丙"]].sort());
    const open = await qs("r2");
    expect(open.map((q) => q.kind).sort()).toEqual(["wa_person_ambiguous", "wa_person_unknown"]);
    const amb = open.find((q) => q.kind === "wa_person_ambiguous")!;
    expect((amb.evidenceJson as { src: { person_raw: string }; candidates: { guard_ids: string[] } }).src.person_raw).toBe("李測乙");
    expect((amb.evidenceJson as { candidates: { guard_ids: string[] } }).candidates.guard_ids).toHaveLength(2);
    const mt = await computeMetrics(7, new Date(T0.getTime() + 3600_000));
    expect(mt.totals).toMatchObject({ roster_names: 4, roster_names_triage: 2, roster_names_matched: 2 });
  });

  it("請假句／普通訊息照舊 LLM 路徑（唔當名單）", async () => {
    await ingest(ev("message", "r3", "1/10/2026 陳測甲 李測乙 病假"));
    await runWhatsappParse(NOW, { llm: [{ async chat() { llmCalled++; return { text: JSON.stringify({ noise: true, intents: [] }), toolsUsed: [], inputTokens: 1, outputTokens: 1, provider: "fake", model: "m" }; } }], force: true });
    expect(llmCalled).toBe(1);
    expect((await prisma.whatsappMessage.findUniqueOrThrow({ where: { messageId: "r3" } })).llmProvider).not.toBe("roster");
  });

  it("編輯名單＝整批重做：被刪走嘅名其 pending 記錄取消，其餘照留；撤回＝整批退回", async () => {
    await ingest(ev("message", "r4", `1/10/2026 ${NAMES.join(" ")}`));
    await run();
    expect((await recs()).filter((r) => r.status === "pending_approval")).toHaveLength(4);
    await ingest(ev("edited", "r4", `1/10/2026 ${NAMES.slice(0, 3).join(" ")}`, 30));
    await run();
    const after = await recs();
    expect(after.filter((r) => r.status === "pending_approval").map((r) => r.guardId).sort()).toEqual(NAMES.slice(0, 3).map((n) => ids.guards[n]).sort());
    expect(after.filter((r) => r.status === "cancelled").map((r) => r.guardId)).toEqual([ids.guards["黃測丁"]]);
    await ingest(ev("revoked", "r4", "", 90));
    const res = await run();
    expect(res.summary).toMatchObject({ revoked_rejected: 3 });
    expect((await recs()).every((r) => r.status === "cancelled")).toBe(true);
  });

  it("同日重覆貼同一份名單（另一條訊息）→ 已存在 no-op，唔重複寫", async () => {
    await ingest(ev("message", "r5", `1/10/2026 ${NAMES.join(" ")}`));
    await run();
    await ingest(ev("message", "r6", `1/10/2026 ${NAMES.join(" ")}`, 120));
    await run();
    expect(await recs()).toHaveLength(4);
    expect(await qs("r6")).toHaveLength(0);
  });
});
