// WA-9 (7)：真數據強化——多日累積名單幂等、相 caption 開工／收工、預定更表、代班／多日假期／月度摘要／純問句。全部合成假名。
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { runWhatsappParse } from "@/lib/jobs/whatsapp-parse";
import { ingestEvent } from "@/lib/whatsapp/ingest";
import type { NormalizedWaEvent } from "@/lib/whatsapp/schema";
import type { LlmClient } from "@/lib/ai/llm";
import { computeMetrics } from "@/lib/whatsapp/metrics";

const T0 = new Date("2026-10-05T05:00:00Z"); // HK 2026-10-05 13:00
const NOW = new Date(T0.getTime() + 60_000);
const G1 = "wa9-7-g1@g.us";
const A = "孫測壹";
const B = "陳測貳";
const C = "許測叁";
const D = "黃測肆";
const E = "謝測伍"; // 系統內繁體；名單用簡體「谢测伍」
let fx: Wp2Fixture;
let ids: { site: string; tD: string; tN: string; guards: Record<string, string> };
let llmCalled = 0;
const guardLlm: LlmClient = { async chat() { llmCalled++; throw new Error("LLM 唔應該被呼叫"); } };
const ev = (mid: string, text: string, off = 0, over: Partial<NormalizedWaEvent> = {}): NormalizedWaEvent => ({ kind: "message", session: "default", messageId: mid, chatJid: G1, senderJid: "85290008888@c.us", fromMe: false, ts: new Date(T0.getTime() + off * 1000), text, mediaType: null, quotedMessageId: null, eventId: `${mid}-${off}-${text.length}-${over.kind ?? "m"}`, ...over });
const ingest = (e: NormalizedWaEvent) => ingestEvent(e, new Date(Math.max(NOW.getTime(), (e.ts?.getTime() ?? 0) + 60_000)));
const run = (now = NOW) => runWhatsappParse(now, { llm: [guardLlm], force: true });
const recs = () => prisma.shiftRecord.findMany({ where: { siteId: ids.site, workDate: { gte: new Date("2026-10-01T00:00:00Z") } }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
const live = async () => (await recs()).filter((r) => r.status !== "cancelled");
const openQs = () => prisma.triageQuestion.findMany({ where: { status: "open", session: { sourceType: "whatsapp" } } });
const msg = (mid: string) => prisma.whatsappMessage.findUniqueOrThrow({ where: { messageId: mid } });
const ymd = (r: { workDate: Date }) => r.workDate.toISOString().slice(0, 10);

/** 累積名單：標題＋逐日「*dd/10/2026* ＋尾空格」＋名行 */
const L = (days: Record<number, string[]>): string => "*10月 報開工要自己打名，傳送簽到*\n\n" + Object.entries(days).map(([d, n]) => `*${String(d).padStart(2, "0")}/10/2026* \n${n.join("  ")}`).join("\n");

beforeEach(async () => {
  await clearAll();
  await prisma.triageQuestion.deleteMany({});
  await prisma.triageSession.deleteMany({});
  llmCalled = 0;
  fx = await seedWp2Fixture();
  const site = await prisma.site.create({ data: { canonicalName: "測試盤W97", clientName: "測試客戶W97", billingModel: "per_shift", createdBy: "test:w97" } });
  const tD = await prisma.shiftType.create({ data: { siteId: site.id, code: "D", label: "日更", startTime: new Date("1970-01-01T08:00:00Z"), endTime: new Date("1970-01-01T20:00:00Z"), hours: 12, createdBy: "test:w97" } as never });
  const tN = await prisma.shiftType.create({ data: { siteId: site.id, code: "N", label: "夜更", startTime: new Date("1970-01-01T20:00:00Z"), endTime: new Date("1970-01-01T08:00:00Z"), hours: 12, createdBy: "test:w97" } as never });
  const guards: Record<string, string> = {};
  for (const [i, n] of [A, B, C, D, E].entries()) guards[n] = (await prisma.guard.create({ data: { nameZh: n, employmentType: "cash_casual", tel: `9000007${i}`, createdBy: "test:w97" } })).id;
  ids = { site: site.id, tD: tD.id, tN: tN.id, guards };
  for (const gid of Object.values(guards)) await prisma.shiftRecord.create({ data: { workDate: new Date("2026-09-10T00:00:00Z"), siteId: site.id, shiftTypeId: tD.id, guardId: gid, recordType: "shift", status: "confirmed", createdBy: "test:w97" } as never });
  await prisma.whatsappGroup.create({ data: { groupJid: G1, label: "W97群", kind: "site", siteId: site.id, shiftWordMap: { 開工: "D" }, autoWrite: true, createdBy: fx.userIds["老闆"] } });
});

describe("WA-9 (7) 多日累積名單：幂等", () => {
  it("只處理窗口內（今日 −2 至今日）嘅日子（1/10 太舊）；舊日子只計 skipped_old；配唔到嘅名開一張題", async () => {
    await ingest(ev("m1", L({ 1: [A, B], 3: [A, B, C], 4: [A], 5: [A, B, "周查無此人"] })));
    await run();
    expect(llmCalled).toBe(0);
    const rs = await live();
    expect(rs.map((r) => `${ymd(r)}|${r.guardId}`).sort()).toEqual([`2026-10-03|${ids.guards[A]}`, `2026-10-03|${ids.guards[B]}`, `2026-10-03|${ids.guards[C]}`, `2026-10-04|${ids.guards[A]}`, `2026-10-05|${ids.guards[A]}`, `2026-10-05|${ids.guards[B]}`].sort());
    const qs = await openQs();
    expect(qs).toHaveLength(1);
    expect(qs[0]!.kind).toBe("wa_person_unknown");
    const m = await msg("m1");
    expect(m.llmProvider).toBe("roster");
    expect(m.parsedJson).toMatchObject({ roster: { days: 3, names: 7, new: 7, already: 0, unmatched_new: 1, skipped_old: 1, lists: 1 } });
    expect(JSON.stringify(m.parsedJson)).not.toContain(A);
  });

  it("重發（新訊息、多一個名）→ 只新增嗰一個；配唔到嘅名重發唔再開題", async () => {
    await ingest(ev("m1", L({ 3: [A, B, C], 4: [A], 5: [A, B, "周查無此人"] })));
    await run();
    for (const [i, mid] of ["m2", "m3", "m4", "m5", "m6"].entries()) {
      await ingest(ev(mid, L({ 3: [A, B, C], 4: [A], 5: [A, B, "周查無此人", ...(i === 0 ? [D] : [D])] }), 60 * (i + 1)));
      await run(new Date(NOW.getTime() + 60_000 * (i + 2)));
    }
    expect(await live()).toHaveLength(7); // 6 + D 一條
    expect(await openQs()).toHaveLength(1); // 6 次重發都只得一張「配唔到」題
    expect(await prisma.whatsappIntent.count({ where: { message: { chatJid: G1 } } })).toBe(8); // m1: 6 記錄＋1 題；m2: D；m3–m6: 零 intent
    expect((await msg("m2")).parsedJson).toMatchObject({ roster: { new: 1, already: 6, unmatched_dup: 1, unmatched_new: 0 } });
    expect((await msg("m3")).parsedJson).toMatchObject({ roster: { new: 0, already: 7, unmatched_dup: 1 } });
    const mt = await computeMetrics(7, new Date(T0.getTime() + 3600_000));
    expect(mt.totals).toMatchObject({ roster_list_msgs: 6, roster_names_unmatched: 1 });
    expect(mt.totals.roster_names_already).toBeGreaterThan(30);
  });

  it("編輯同一條累積名單（加人）→ 自己舊 pending 記錄照留（取消後重建），唔重複", async () => {
    await ingest(ev("m1", L({ 4: [A], 5: [A, B] })));
    await run();
    expect(await live()).toHaveLength(3);
    await ingest(ev("m1", L({ 4: [A], 5: [A, B, C] }), 30, { kind: "edited", eventId: "m1-edit" }));
    await run();
    const l = await live();
    expect(l).toHaveLength(4);
    expect(new Set(l.map((r) => `${ymd(r)}|${r.guardId}`)).size).toBe(4);
  });

  it("簡體／繁體：谢测伍 配到系統內嘅 謝測伍；黏名（孫測壹陳測貳）用已知名集拆開", async () => {
    await ingest(ev("m1", L({ 5: [`${A}${B}`, "谢测伍", C] })));
    await run();
    expect((await live()).map((r) => r.guardId).sort()).toEqual([ids.guards[A], ids.guards[B], ids.guards[E], ids.guards[C]].sort());
    expect(await openQs()).toHaveLength(0);
  });

  it("已有（未取消）記錄嘅人 → 已有，唔另建", async () => {
    await ingest(ev("m1", L({ 5: [A, C] })));
    await run();
    const r = (await live()).find((x) => x.guardId === ids.guards[A])!;
    await prisma.shiftRecord.update({ where: { id: r!.id }, data: { status: "confirmed" } });
    await ingest(ev("m2", L({ 5: [A, B] }), 60));
    await run(new Date(NOW.getTime() + 120_000));
    expect((await live()).map((x) => x.guardId).sort()).toEqual([ids.guards[A], ids.guards[B], ids.guards[C]].sort());
    expect((await msg("m2")).parsedJson).toMatchObject({ roster: { new: 1, already: 1 } });
  });
});

describe("WA-9 (7) 撤回後重發／同人同日不同更（Opus 第二輪 M2／S1）", () => {
  it("M2：p1（A＋配唔到嘅名）→ 撤回 p1 → 重發 p2：A 有記錄、配唔到嘅名再開題（唔無聲消失）", async () => {
    await ingest(ev("p1", L({ 5: [A, "周查無人"] })));
    await run();
    expect(await live()).toHaveLength(1);
    expect(await openQs()).toHaveLength(1);
    await ingest(ev("p1", "", 30, { kind: "revoked", eventId: "p1-revoke" }));
    await run(new Date(NOW.getTime() + 60_000));
    expect(await live()).toHaveLength(0);
    expect(await openQs()).toHaveLength(0);
    await ingest(ev("p2", L({ 5: [A, "周查無人"] }), 120));
    await run(new Date(NOW.getTime() + 180_000));
    expect((await live()).map((r) => r.guardId)).toEqual([ids.guards[A]]);
    expect((await openQs()).map((q) => q.kind)).toEqual(["wa_person_unknown"]);
    expect((await msg("p2")).parsedJson).toMatchObject({ roster: { unmatched_new: 1, unmatched_dup: 0 } });
  });

  it("S1：同一人同日報 D 之後再報 N → 唔會當「已有」丟走（撞更出題）；重發唔再開", async () => {
    await ingest(ev("n1", L({ 5: [A, B] })));
    await run();
    expect(await live()).toHaveLength(2);
    await ingest(ev("n2", L({ 5: [`${A} N`, B] }), 60));
    await run(new Date(NOW.getTime() + 120_000));
    const qs = await openQs();
    expect(qs).toHaveLength(1);
    expect((await msg("n2")).parsedJson).toMatchObject({ roster: { new: 1, already: 1 } });
    await ingest(ev("n3", L({ 5: [`${A} N`, B] }), 180));
    await run(new Date(NOW.getTime() + 240_000));
    expect(await openQs()).toHaveLength(1);
    expect((await msg("n3")).parsedJson).toMatchObject({ roster: { new: 0, already: 2 } });
  });
});

describe("WA-9 (7) assume_today 上限＋指標（Opus S3）", () => {
  it("判頭群冇日期報工：每群每日超過上限就降級 ignore（assume_today_cap）；指標 routed／llm_hit", async () => {
    process.env.WA_ASSUME_TODAY_DAILY_CAP = "2";
    try {
      await prisma.site.update({ where: { id: ids.site }, data: { aliases: ["測試場"] } });
      const broker = await prisma.broker.create({ data: { code: "T-W97", name: "測試判頭W97", kind: "broker", settlementType: "cash" } });
      await prisma.whatsappGroup.update({ where: { groupJid: G1 }, data: { kind: "broker", siteId: null, brokerId: broker.id } });
      const shiftJson = JSON.stringify({ noise: false, intents: [{ type: "shift", date: null, site_raw: "測試場", persons: [{ raw: A, role: "worker" }], self_reference: false, shift_raw: "日更", shift_code_guess: "D", confidence: 0.9 }] });
      let calls = 0;
      const llm: LlmClient = { async chat() { calls++; return { text: calls === 1 ? shiftJson : JSON.stringify({ noise: true, intents: [] }), toolsUsed: [], inputTokens: 1, outputTokens: 1, provider: "fake", model: "m" }; } };
      for (const [i, mid] of ["t1", "t2", "t3"].entries()) await ingest(ev(mid, `${A}測試場日更`, i * 10));
      await runWhatsappParse(NOW, { llm: [llm], force: true });
      expect(calls).toBe(2);
      expect((await msg("t3")).ignoreReason).toBe("assume_today_cap");
      expect((await msg("t1")).parsedJson).toBeTruthy();
      const mt = await computeMetrics(7, new Date(T0.getTime() + 3600_000));
      expect(mt.totals).toMatchObject({ assume_today_routed: 2, assume_today_llm_hit: 1 });
    } finally {
      delete process.env.WA_ASSUME_TODAY_DAILY_CAP;
    }
  });
});

describe("WA-9 (7) 盤別名：字形折疊、盤口群以綁定盤為準", () => {
  const shiftJson = (siteRaw: string) => JSON.stringify({ noise: false, intents: [{ type: "shift", date: { raw: "今日", kind: "relative" }, site_raw: siteRaw, persons: [{ raw: A, role: "worker" }], self_reference: false, shift_raw: "開工", shift_code_guess: "D", confidence: 0.9 }] });
  const llmOf = (siteRaw: string): LlmClient => ({ async chat() { return { text: shiftJson(siteRaw), toolsUsed: [], inputTokens: 1, outputTokens: 1, provider: "fake", model: "m" }; } });

  it("盤口群：文字寫多盤共用嘅區域別名（例：「數碼港」掛喺兩個盤）→ 以群綁定嘅盤為準，唔改盤、唔出盤題", async () => {
    // 「數碼港乙」係區域名，同時掛喺群盤同另一個盤（多盤共用）→ 以群盤為準
    await prisma.site.update({ where: { id: ids.site }, data: { aliases: ["數碼港乙"] } });
    const other = await prisma.site.create({ data: { canonicalName: "測試乙盤", clientName: "測試客戶W97", billingModel: "per_shift", aliases: ["數碼港乙"], createdBy: "test:w97" } });
    await ingest(ev("a1", `${A}今日數碼港乙日更`));
    await runWhatsappParse(NOW, { llm: [llmOf("數碼港乙")], force: true });
    const rs = await prisma.shiftRecord.findMany({ where: { guardId: ids.guards[A], workDate: { gte: new Date("2026-10-05T00:00:00Z") } } });
    expect(rs.map((r) => r.siteId)).toEqual([ids.site]);
    expect(rs.some((r) => r.siteId === other.id)).toBe(false);
    expect(await openQs()).toHaveLength(0);
  });

  it("判頭／多盤群（冇綁定盤）：用別名配盤，異體字「厚徳商場」配到別名「厚德商場」", async () => {
    await prisma.site.update({ where: { id: ids.site }, data: { aliases: ["厚德商場"] } });
    const broker = await prisma.broker.create({ data: { code: "T-W97B", name: "測試判頭W97B", kind: "broker", settlementType: "cash" } });
    await prisma.whatsappGroup.update({ where: { groupJid: G1 }, data: { kind: "broker", siteId: null, brokerId: broker.id } });
    await ingest(ev("a2", `${A}今日厚徳商場日更`));
    await runWhatsappParse(NOW, { llm: [llmOf("厚徳商場")], force: true });
    const rs = await prisma.shiftRecord.findMany({ where: { guardId: ids.guards[A], workDate: { gte: new Date("2026-10-05T00:00:00Z") } } });
    expect(rs.map((r) => r.siteId)).toEqual([ids.site]);
  });
});

describe("WA-9 (7) 範圍外唯一同名（Opus M3）", () => {
  it("全系統唯一同名、但近 60 日冇喺該盤出現 → 唔自動寫，揀人題（單一候選）；重發唔再開", async () => {
    const out = await prisma.guard.create({ data: { nameZh: "趙測陸", employmentType: "cash_casual", tel: "90000999", createdBy: "test:w97" } });
    await ingest(ev("o1", L({ 5: [A, "趙測陸"] })));
    await run();
    expect((await live()).map((r) => r.guardId)).toEqual([ids.guards[A]]);
    const qs = await openQs();
    expect(qs.map((q) => q.kind)).toEqual(["wa_person_ambiguous"]);
    expect((qs[0]!.evidenceJson as { candidates: { guard_ids: string[] } }).candidates.guard_ids).toEqual([out.id]);
    await ingest(ev("o2", L({ 5: [A, "趙測陸"] }), 60));
    await run(new Date(NOW.getTime() + 120_000));
    expect(await openQs()).toHaveLength(1);
  });
});

describe("WA-9 (7) 相 caption 姓名報工", () => {
  const photo = (mid: string, text: string, off: number) => ev(mid, text, off, { mediaType: "image" });
  it("開工 → 當日一條 pending 記錄（零 LLM）；重發唔重複", async () => {
    await ingest(photo("c1", `${A}報開工`, 0));
    await run();
    const rs = await live();
    expect(rs).toHaveLength(1);
    expect(rs[0]).toMatchObject({ guardId: ids.guards[A], shiftTypeId: ids.tD, status: "pending_approval" });
    expect(ymd(rs[0]!)).toBe("2026-10-05");
    expect((await msg("c1")).llmProvider).toBe("rule");
    await ingest(photo("c2", `${A}報開工`, 120));
    await run(new Date(NOW.getTime() + 180_000));
    expect(await live()).toHaveLength(1);
    expect(llmCalled).toBe(0);
  });

  it("收工 → 補同一條嘅 reported_time_off，永不建第二條（日更當日；HKT 12:00 前提早收工補返當日嗰條，唔補去尋日）", async () => {
    await ingest(photo("c1", `${A}報開工`, 0));
    await run();
    const upd0 = (await live())[0]!.updatedAt.getTime();
    await ingest(photo("c2", `${A}收工`, 7 * 3600 + 5 * 60)); // HK 20:05
    await run(new Date(T0.getTime() + 8 * 3600 * 1000));
    const rs = await live();
    expect(rs).toHaveLength(1);
    expect(rs[0]!.updatedAt.getTime()).toBe(upd0); // 補 provenance 唔當記錄被編輯（updated_at 不變）
    expect(rs[0]!.provenance).toMatchObject({ reported_time_off: "20:05" });
    // 日更人：昨日有日更記錄、今朝 10:00（HKT 12:00 前）提早收工，今日有自己嘅日更記錄 → 補今日嗰條，唔改尋日
    const day = (d: string) => new Date(`${d}T00:00:00Z`);
    await prisma.shiftRecord.create({ data: { workDate: day("2026-10-05"), siteId: ids.site, shiftTypeId: ids.tD, guardId: ids.guards[B], recordType: "shift", status: "pending_approval", createdBy: "test:w97" } as never });
    await prisma.shiftRecord.create({ data: { workDate: day("2026-10-06"), siteId: ids.site, shiftTypeId: ids.tD, guardId: ids.guards[B], recordType: "shift", status: "pending_approval", createdBy: "test:w97" } as never });
    await ingest(photo("c3", `${B}收工`, 21 * 3600)); // HK 2026-10-06 10:00
    await run(new Date(T0.getTime() + 22 * 3600 * 1000));
    const bs = (await recs()).filter((r) => r.guardId === ids.guards[B]);
    expect(bs.find((r) => ymd(r) === "2026-10-06")!.provenance).toMatchObject({ reported_time_off: "10:00" });
    expect((bs.find((r) => ymd(r) === "2026-10-05")!.provenance as Record<string, unknown> | null)?.reported_time_off).toBeUndefined();
  });

  it("夜更人：凌晨收工補前一晚嗰條跨夜更", async () => {
    await prisma.shiftRecord.create({ data: { workDate: new Date("2026-10-05T00:00:00Z"), siteId: ids.site, shiftTypeId: ids.tN, guardId: ids.guards[C], recordType: "shift", status: "pending_approval", createdBy: "test:w97" } as never });
    await ingest(photo("c4", `${C}報收工`, 18 * 3600 + 30 * 60)); // HK 2026-10-06 07:30
    await run(new Date(T0.getTime() + 19 * 3600 * 1000));
    const rs = (await recs()).filter((r) => r.guardId === ids.guards[C]);
    expect(rs).toHaveLength(1);
    expect(rs[0]!.provenance).toMatchObject({ reported_time_off: "07:30" });
  });

  it("M3：鎖月記錄唔被收工補時間（note locked_month_skip）；交叉核實 setReported 同樣唔改鎖月記錄", async () => {
    await prisma.shiftRecord.create({ data: { workDate: new Date("2026-10-05T00:00:00Z"), siteId: ids.site, shiftTypeId: ids.tD, guardId: ids.guards[A], recordType: "shift", status: "confirmed", createdBy: "test:w97" } as never });
    await prisma.monthClose.create({ data: { month: new Date("2026-10-01"), lockedAt: new Date(), lockedBy: fx.userIds["老闆"], createdBy: "t" } });
    await ingest(photo("c5", `${A}收工`, 7 * 3600));
    await run(new Date(T0.getTime() + 8 * 3600 * 1000));
    const [r] = (await recs()).filter((x) => x.guardId === ids.guards[A]);
    expect((r!.provenance as Record<string, unknown> | null)?.reported_time_off).toBeUndefined();
    expect((await msg("c5")).parsedJson).toMatchObject({ caption: { updated: false, note: "locked_month_skip" } });
    const { prismaCrossCheckDeps } = await import("@/lib/whatsapp/roster-crosscheck");
    const x = await prismaCrossCheckDeps().setReported({ messageId: "none", guardId: ids.guards[A]!, day: "2026-10-05", timeOn: "08:00", timeOff: null });
    expect(x).toEqual({ updated: 0, locked: 0 }); // 冇 message_id 對得上嘅記錄
    await prisma.shiftRecord.update({ where: { id: r!.id }, data: { provenance: { message_id: "mm" } } });
    expect(await prismaCrossCheckDeps().setReported({ messageId: "mm", guardId: ids.guards[A]!, day: "2026-10-05", timeOn: "08:00", timeOff: null })).toEqual({ updated: 0, locked: 1 });
    expect((await prisma.shiftRecord.findUniqueOrThrow({ where: { id: r!.id } })).provenance).toEqual({ message_id: "mm" });
  });

  it("收工但冇開工記錄 → 唔出題、唔建記錄，只記 note", async () => {
    await ingest(photo("c1", `${B}收工`, 0));
    await run();
    expect(await live()).toHaveLength(0);
    expect(await openQs()).toHaveLength(0);
    expect((await msg("c1")).parsedJson).toMatchObject({ caption: { action: "checkout", matched: true, updated: false, note: "checkout_without_checkin" } });
  });

  it("caption 名配唔到 → 揀人題（開工）", async () => {
    await ingest(photo("c1", "周查無人報開工", 0));
    await run();
    expect(await live()).toHaveLength(0);
    expect((await openQs()).map((q) => q.kind)).toEqual(["wa_person_unknown"]);
  });
});

describe("WA-9 (7) 其他純 code 類型", () => {
  it("預定更表（日序名單）：唔建 shift、唔出題，只記計數", async () => {
    await ingest(ev("p1", `20 ${A} ${B} ${C}\n\n31 ${A} ${D} ${C}`));
    await run();
    expect(await recs()).toHaveLength(0);
    expect(await openQs()).toHaveLength(0);
    const m = await msg("p1");
    expect(m.llmProvider).toBe("roster_plan");
    expect(m.parsedJson).toMatchObject({ roster_plan: { days: 2, names: 6, dates: ["2026-10-20", "2026-10-31"] } });
    const mt = await computeMetrics(7, new Date(T0.getTime() + 3600_000));
    expect(mt.totals.roster_plans).toBe(1);
  });

  it("代班「A代B」→ 一個 cover intent（走 wa_cover 確認題）；純問句 → 忽略（零 intent）；多日假期 → N 個 leave intent；月度摘要 → 只記錄", async () => {
    await ingest(ev("s1", `${B}代${A}`, 0));
    await ingest(ev("q1", `請問今早${A}有無返`, 10));
    await ingest(ev("l1", `${C}10月份假期8,12`, 20));
    await ingest(ev("a1", `${D}10月份返測試盤考勤紀錄，休息3日：2，11，12`, 30));
    await run();
    expect(llmCalled).toBe(0);
    const kinds = async (mid: string) => (await prisma.whatsappIntent.findMany({ where: { messageId: mid }, orderBy: { idx: "asc" } })).map((i) => i.kind);
    expect(await kinds("s1")).toEqual(["cover"]);
    expect(await kinds("l1")).toEqual(["leave", "leave"]);
    expect(await kinds("a1")).toEqual([]);
    expect((await msg("a1")).parsedJson).toMatchObject({ rule: { kind: "attendance_summary", month: 10, rest_days: 3, claimed: 3 } });
    const q = await msg("q1");
    expect(q.status).toBe("ignored");
    expect(q.filterReasons).toContain("plain_question");
    expect(await kinds("q1")).toEqual([]);
  });
});
