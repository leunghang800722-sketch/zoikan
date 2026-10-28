// WA-9 (8) D：同一人同日，短訊（LLM）路徑同名單（roster）路徑嘅「揀人」題共用 (群,日,名) key，兩個方向都唔重複出題。全部合成假名。
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { runWhatsappParse } from "@/lib/jobs/whatsapp-parse";
import { ingestEvent } from "@/lib/whatsapp/ingest";
import type { NormalizedWaEvent } from "@/lib/whatsapp/schema";
import type { LlmClient } from "@/lib/ai/llm";
import { rosterNameKey } from "@/lib/whatsapp/name-key";
import { supersedeRevokedWaQuestions } from "@/lib/whatsapp/triage";

const T0 = new Date("2026-10-05T05:00:00Z"); // HK 2026-10-05 13:00
const NOW = new Date(T0.getTime() + 60_000);
const G1 = "wa9-8-g1@g.us";
const DUP = "徐測展"; // 兩個同名 guard → 揀人題
let fx: Wp2Fixture;
let llmCalls = 0;
const llm: LlmClient = {
  async chat(p) {
    llmCalls++;
    const who = (JSON.stringify(p) ?? "").includes("孫測壹今日") ? "孫測壹" : DUP; // 睇文字回人名，編輯做另一個人先真係改人
    const out = { noise: false, intents: [{ type: "shift", date: { raw: "今日", kind: "relative" }, site_raw: null, persons: [{ raw: who, role: "worker" }], self_reference: false, shift_raw: "開工", shift_code_guess: null, hours: null, leave_raw: null, leave_code_guess: null, confidence: 0.9, evidence: null }] };
    return { text: JSON.stringify(out), toolsUsed: [], inputTokens: 1, outputTokens: 1, provider: "fake", model: "m" };
  },
};
const ev = (mid: string, text: string, off = 0): NormalizedWaEvent => ({ kind: "message", session: "default", messageId: mid, chatJid: G1, senderJid: "85290008888@c.us", fromMe: false, ts: new Date(T0.getTime() + off * 1000), text, mediaType: null, quotedMessageId: null, eventId: `${mid}-${off}` });
const ingest = (e: NormalizedWaEvent) => ingestEvent(e, new Date(Math.max(NOW.getTime(), (e.ts?.getTime() ?? 0) + 60_000)));
const run = (now = NOW) => runWhatsappParse(now, { llm: [llm], force: true });
const personQs = () => prisma.triageQuestion.findMany({ where: { status: { in: ["open", "answered", "skipped"] }, kind: { in: ["wa_person_ambiguous", "wa_person_unknown"] }, session: { sourceType: "whatsapp" } } });
const ROSTER = "*10月 報開工要自己打名，傳送簽到*\n\n*05/10/2026* \n" + DUP + "  孫測壹";
const SHORT = `${DUP}今日開工`;
let groupId: string;

beforeEach(async () => {
  await clearAll();
  await prisma.triageQuestion.deleteMany({});
  await prisma.triageSession.deleteMany({});
  llmCalls = 0;
  fx = await seedWp2Fixture();
  const site = await prisma.site.create({ data: { canonicalName: "測試盤W98", clientName: "測試客戶W98", billingModel: "per_shift", createdBy: "test:w98" } });
  const tD = await prisma.shiftType.create({ data: { siteId: site.id, code: "D", label: "日更", startTime: new Date("1970-01-01T08:00:00Z"), endTime: new Date("1970-01-01T20:00:00Z"), hours: 12, createdBy: "test:w98" } as never });
  for (const [i, n] of [DUP, DUP, "孫測壹"].entries()) {
    const g = await prisma.guard.create({ data: { nameZh: n, employmentType: "cash_casual", tel: `9000098${i}`, createdBy: "test:w98" } });
    await prisma.shiftRecord.create({ data: { workDate: new Date("2026-09-10T00:00:00Z"), siteId: site.id, shiftTypeId: tD.id, guardId: g.id, recordType: "shift", status: "confirmed", createdBy: "test:w98" } as never });
  }
  const grp = await prisma.whatsappGroup.create({ data: { groupJid: G1, label: "W98群", kind: "site", siteId: site.id, shiftWordMap: { 開工: "D" }, autoWrite: true, createdBy: fx.userIds["老闆"] } });
  groupId = grp.id;
});

describe("WA-9 (8) D：跨路徑 (群,日,名) 去重", () => {
  it("短訊先出題（LLM 路徑）→ 之後名單重發同一個名：唔再開題；題 groupKey 係 rn: key", async () => {
    await ingest(ev("s1", SHORT));
    await run();
    expect(llmCalls).toBe(1);
    const first = await personQs();
    expect(first).toHaveLength(1);
    expect(first[0]!.kind).toBe("wa_person_ambiguous");
    expect(first[0]!.groupKey).toBe(rosterNameKey(groupId, "2026-10-05", DUP));
    await ingest(ev("r1", ROSTER, 60));
    await run(new Date(NOW.getTime() + 120_000));
    expect(await personQs()).toHaveLength(1);
  });

  it("名單先出題（roster 路徑）→ 之後短訊同一個人同日：唔再開題", async () => {
    await ingest(ev("r1", ROSTER));
    await run();
    expect((await prisma.whatsappMessage.findUniqueOrThrow({ where: { messageId: "r1" } })).llmProvider).toBe("roster");
    const first = await personQs();
    expect(first).toHaveLength(1);
    expect(first[0]!.groupKey).toBe(rosterNameKey(groupId, "2026-10-05", DUP));
    await ingest(ev("s1", SHORT, 60));
    await run(new Date(NOW.getTime() + 120_000));
    expect(llmCalls).toBe(1);
    expect(await personQs()).toHaveLength(1);
    // 短訊 intent 仍然記錄落去（指向既有題），唔會無聲消失
    const it = await prisma.whatsappIntent.findFirst({ where: { message: { messageId: "s1" } } });
    expect(it?.resultRef).toBe(first[0]!.id);
  });

  it("短訊編輯（新 revision）→ 舊題 superseded，可以用同一把 key 重開（唔變成永遠唔出題）", async () => {
    await ingest(ev("s1", SHORT));
    await run();
    expect(await personQs()).toHaveLength(1);
    await ingestEvent({ ...ev("s1", `${SHORT} `, 30), kind: "edited", eventId: "s1-edit" }, new Date(NOW.getTime() + 120_000));
    await run(new Date(NOW.getTime() + 120_000));
    const live = await personQs();
    expect(live).toHaveLength(1);
    expect(live[0]!.groupKey).toBe(rosterNameKey(groupId, "2026-10-05", DUP));
  });

  // M1：兩條訊息共用同一條 rn: 題；其中一條撤回／編輯，另一條唔可以靜靜雞冇題
  const revoke = async (mid: string, off: number) => {
    await ingest({ ...ev(mid, "", off), kind: "revoked", eventId: `${mid}-revoke` });
    await run(new Date(NOW.getTime() + (off + 60) * 1000));
    await supersedeRevokedWaQuestions();
  };
  const expectSharedSurvives = async (survivor: string) => {
    const open = await prisma.triageQuestion.findMany({ where: { status: "open", kind: "wa_person_ambiguous", session: { sourceType: "whatsapp" } } });
    expect(open).toHaveLength(1);
    const it = await prisma.whatsappIntent.findFirst({ where: { message: { messageId: survivor }, kind: "shift" } });
    expect(it?.resultRef).toBe(open[0]!.id);
  };
  it("M1：名單先開題、短訊併入 → 撤回名單 → 仍有 1 條 open 題，歸屬改去短訊，短訊 resultRef 指住佢", async () => {
    await ingest(ev("r1", ROSTER));
    await run();
    await ingest(ev("s1", SHORT, 60));
    await run(new Date(NOW.getTime() + 120_000));
    await revoke("r1", 120);
    await expectSharedSurvives("s1");
    const open = await prisma.triageQuestion.findMany({ where: { status: "open", session: { sourceType: "whatsapp" } } });
    expect((open[0]!.evidenceJson as { message: { message_id: string } }).message.message_id).toBe("s1"); // 歸屬改去短訊
  });
  it("M1：短訊先開題、名單併入 → 撤回短訊 → 仍有 1 條 open 題，歸屬改去名單", async () => {
    await ingest(ev("s1", SHORT));
    await run();
    await ingest(ev("r1", ROSTER, 60));
    await run(new Date(NOW.getTime() + 120_000));
    await revoke("s1", 120);
    const open = await prisma.triageQuestion.findMany({ where: { status: "open", kind: "wa_person_ambiguous", session: { sourceType: "whatsapp" } } });
    expect(open).toHaveLength(1);
    expect((open[0]!.evidenceJson as { message: { message_id: string } }).message.message_id).toBe("r1");
  });
  it("M1：名單先開題、短訊併入 → 編輯名單（revision+1，唔再含該人）→ 仍有 1 條 open 題，歸屬改去短訊", async () => {
    await ingest(ev("r1", ROSTER));
    await run();
    await ingest(ev("s1", SHORT, 60));
    await run(new Date(NOW.getTime() + 120_000));
    await ingest({ ...ev("r1", "*10月 報開工要自己打名，傳送簽到*\n\n*05/10/2026* \n孫測壹", 120), kind: "edited", eventId: "r1-edit" });
    await run(new Date(NOW.getTime() + 240_000));
    await supersedeRevokedWaQuestions();
    await expectSharedSurvives("s1");
  });
  it("M1：短訊先開題、名單併入 → 編輯短訊（revision+1，改做另一個人）→ 仍有 1 條 open 題，歸屬改去名單", async () => {
    await ingest(ev("s1", SHORT));
    await run();
    await ingest(ev("r1", ROSTER, 60));
    await run(new Date(NOW.getTime() + 120_000));
    await ingest({ ...ev("s1", "孫測壹今日開工", 120), kind: "edited", eventId: "s1-edit" });
    await run(new Date(NOW.getTime() + 240_000));
    const open = await prisma.triageQuestion.findMany({ where: { status: "open", kind: "wa_person_ambiguous", session: { sourceType: "whatsapp" } } });
    expect(open).toHaveLength(1);
    expect((open[0]!.evidenceJson as { message: { message_id: string } }).message.message_id).toBe("r1");
  });

  it("M2：名單開題、短訊併入、撤回名單（題改歸屬去短訊）→ 編輯短訊做另一個人 → 舊題作廢，冇孤兒 open 題", async () => {
    await ingest(ev("r1", ROSTER));
    await run();
    await ingest(ev("s1", SHORT, 60));
    await run(new Date(NOW.getTime() + 120_000));
    await revoke("r1", 120);
    await expectSharedSurvives("s1");
    await ingest({ ...ev("s1", "孫測壹今日開工", 200), kind: "edited", eventId: "s1-edit2" });
    await run(new Date(NOW.getTime() + 400_000));
    const open = await prisma.triageQuestion.findMany({ where: { status: "open", kind: "wa_person_ambiguous", session: { sourceType: "whatsapp" } } });
    expect(open).toHaveLength(0);
  });
});
