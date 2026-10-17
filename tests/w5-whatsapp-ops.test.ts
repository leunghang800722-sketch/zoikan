// W5：WhatsApp 運維——健康告警 job、口語對照（含請假覆寫）、指標 API。
// 全部假資料：測試甲／乙、測試盤W5、假群 w5-g*@g.us、假電話 9000001x。唔打真 WAHA（fetch 全部係 fake）。
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import type { RoleName } from "@/lib/rbac/matrix";
import { runWhatsappHealth } from "@/lib/jobs/whatsapp-health";
import { runWhatsappParse } from "@/lib/jobs/whatsapp-parse";
import { runWhatsappDailySummary } from "@/lib/jobs/whatsapp-parse";
import { ingestEvent } from "@/lib/whatsapp/ingest";
import type { NormalizedWaEvent } from "@/lib/whatsapp/schema";
import type { LlmClient } from "@/lib/ai/llm";
import { mapLeaveCode } from "@/lib/whatsapp/resolve";
import { GET as groupsGet, PATCH as groupsPatch } from "@/app/api/whatsapp/groups/route";
import { GET as healthGet } from "@/app/api/whatsapp/health/route";
import { GET as metricsGet } from "@/app/api/whatsapp/metrics/route";

// HK 2026-10-16（星期五）13:00
const NOW = new Date("2026-10-16T05:00:00Z");
const G1 = "w5-g1@g.us";
const G2 = "w5-g2@g.us";
const H = 3600 * 1000;

const BASE = "http://test.local";
function req(path: string, cookie: string | null, method = "GET", body?: unknown) {
  return new Request(`${BASE}${path}`, { method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
}
const wahaFetch = (status: string | Error): typeof fetch =>
  (async () => {
    if (status instanceof Error) throw status;
    return new Response(JSON.stringify({ name: "default", status }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;

let fx: Wp2Fixture;
const cookies = {} as Record<RoleName, string>;

async function mkMsg(chat: string, id: string, over: Record<string, unknown> = {}) {
  return prisma.whatsappMessage.create({ data: { session: "default", chatJid: chat, messageId: id, senderJid: "85290000011@c.us", ts: NOW, text: "x", ...over } });
}
const alerts = () => prisma.appNotification.findMany({ where: { kind: "whatsapp_health" }, orderBy: { createdAt: "asc" } });

beforeEach(async () => {
  await clearAll();
  fx = await seedWp2Fixture();
  for (const r of ["老闆", "主管", "會計", "雞頭", "安員"] as RoleName[]) cookies[r] = await sessionCookieForUser(fx.userIds[r]);
  process.env.WAHA_BASE_URL = "http://waha.test:3000";
  process.env.WAHA_SESSION = "default";
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.WAHA_BASE_URL;
  delete process.env.WAHA_SESSION;
  delete process.env.WA_ENABLED;
});

describe("W5 健康 job：WAHA session 狀態", () => {
  it("總開關未開 → skipped；唔 call WAHA", async () => {
    const f = vi.fn(wahaFetch("FAILED"));
    const r = await runWhatsappHealth(NOW, { fetchImpl: f as unknown as typeof fetch });
    expect(r).toMatchObject({ status: "skipped", summary: { enabled: false } });
    expect(f).not.toHaveBeenCalled();
    expect(await alerts()).toHaveLength(0);
  });

  it("WORKING 平時 → 冇告警、冇恢復訊息", async () => {
    const r = await runWhatsappHealth(NOW, { force: true, fetchImpl: wahaFetch("WORKING") });
    expect(r.summary).toMatchObject({ waha_state: "WORKING", waha_alerted: false, recovered: false });
    expect(await alerts()).toHaveLength(0);
  });

  for (const st of ["FAILED", "STOPPED", "SCAN_QR_CODE"]) {
    it(`${st} → 通知老闆（站內路徑 /whatsapp、無 PII）`, async () => {
      const r = await runWhatsappHealth(NOW, { force: true, fetchImpl: wahaFetch(st) });
      expect(r.summary).toMatchObject({ waha_state: st, waha_alerted: true });
      const [n] = await alerts();
      expect(n).toMatchObject({ audience: ["老闆"], href: "/whatsapp" });
      expect(n!.body).toContain(st);
    });
  }

  it("連唔到 WAHA（fetch 拋錯）→ UNREACHABLE 告警；唔洩漏 URL", async () => {
    const r = await runWhatsappHealth(NOW, { force: true, fetchImpl: wahaFetch(new Error("ECONNREFUSED http://waha.test:3000")) });
    expect(r.summary).toMatchObject({ waha_state: "UNREACHABLE", waha_alerted: true });
    const [n] = await alerts();
    expect(`${n!.title}${n!.body}`).not.toContain("waha.test");
  });

  it("WAHA_BASE_URL 未設 → 唔檢查 session（waha_state null）", async () => {
    delete process.env.WAHA_BASE_URL;
    const r = await runWhatsappHealth(NOW, { force: true, fetchImpl: wahaFetch("FAILED") });
    expect(r.summary).toMatchObject({ waha_state: null });
    expect(await alerts()).toHaveLength(0);
  });

  it("同一狀態 6 小時內只通知一次；滿 6 小時再通知；唔同狀態獨立計", async () => {
    const f = wahaFetch("FAILED");
    await runWhatsappHealth(NOW, { force: true, fetchImpl: f });
    const r2 = await runWhatsappHealth(new Date(NOW.getTime() + 15 * 60_000), { force: true, fetchImpl: f });
    expect(r2.summary).toMatchObject({ waha_alerted: false });
    const r3 = await runWhatsappHealth(new Date(NOW.getTime() + 5.9 * H), { force: true, fetchImpl: f });
    expect(r3.summary).toMatchObject({ waha_alerted: false });
    expect(await alerts()).toHaveLength(1);
    const r4 = await runWhatsappHealth(new Date(NOW.getTime() + 6.1 * H), { force: true, fetchImpl: f });
    expect(r4.summary).toMatchObject({ waha_alerted: true });
    const r5 = await runWhatsappHealth(new Date(NOW.getTime() + 6.2 * H), { force: true, fetchImpl: wahaFetch("STOPPED") });
    expect(r5.summary).toMatchObject({ waha_alerted: true });
    expect(await alerts()).toHaveLength(3);
  });

  it("異常後恢復 WORKING → 一條「已恢復」（只一條）", async () => {
    await runWhatsappHealth(NOW, { force: true, fetchImpl: wahaFetch("FAILED") });
    const t1 = new Date(NOW.getTime() + 30 * 60_000);
    const r = await runWhatsappHealth(t1, { force: true, fetchImpl: wahaFetch("WORKING") });
    expect(r.summary).toMatchObject({ waha_state: "WORKING", recovered: true });
    const again = await runWhatsappHealth(new Date(t1.getTime() + 15 * 60_000), { force: true, fetchImpl: wahaFetch("WORKING") });
    expect(again.summary).toMatchObject({ recovered: false });
    const list = await alerts();
    expect(list.map((n) => n.title)).toEqual([expect.stringContaining("異常"), "WhatsApp 橋接已恢復"]);
    // 再出事再恢復 → 再有一條
    await runWhatsappHealth(new Date(NOW.getTime() + 7 * H), { force: true, fetchImpl: wahaFetch("FAILED") });
    const r6 = await runWhatsappHealth(new Date(NOW.getTime() + 7.5 * H), { force: true, fetchImpl: wahaFetch("WORKING") });
    expect(r6.summary).toMatchObject({ recovered: true });
  });
});

describe("W5 健康 job：工作日冇訊息", () => {
  beforeEach(async () => {
    delete process.env.WAHA_BASE_URL;
    await prisma.whatsappGroup.createMany({
      data: [
        { groupJid: G1, label: "W5群一", kind: "multi_site", createdBy: "test:w5" },
        { groupJid: G2, label: "W5群二（略過）", kind: "ignored", createdBy: "test:w5" },
      ],
    });
  });
  const run = (now: Date) => runWhatsappHealth(now, { force: true });
  const silent = async () => (await alerts()).filter((n) => n.title.includes("可能斷線"));

  it("週五 13:00、已綁定群 6 小時冇訊息 → 通知；同日再跑唔重覆；翌日（週六）再通知", async () => {
    expect((await run(NOW)).summary).toMatchObject({ silence_alerted: true });
    expect((await run(new Date(NOW.getTime() + H))).summary).toMatchObject({ silence_alerted: false });
    expect((await run(new Date(NOW.getTime() + 24 * H))).summary).toMatchObject({ silence_alerted: true }); // 週六 13:00
    expect(await silent()).toHaveLength(2);
  });

  it("6 小時內有訊息（任何已綁定群、任何狀態）→ 唔通知；剛過 6 小時 → 通知", async () => {
    await mkMsg(G1, "w5-a", { createdAt: new Date(NOW.getTime() - 5 * H) });
    expect((await run(NOW)).summary).toMatchObject({ silence_alerted: false });
    expect((await run(new Date(NOW.getTime() + 1.5 * H))).summary).toMatchObject({ silence_alerted: true });
  });

  it("只有「略過」群有訊息唔算；冇任何已綁定群 → 唔通知", async () => {
    await mkMsg(G2, "w5-b", { createdAt: new Date(NOW.getTime() - 1 * H) });
    expect((await run(NOW)).summary).toMatchObject({ silence_alerted: true });
    await prisma.whatsappGroup.update({ where: { groupJid: G1 }, data: { active: false } });
    expect((await run(new Date(NOW.getTime() + 24 * H))).summary).toMatchObject({ silence_alerted: false });
  });

  it("星期日、香港 07:00 前、23:00 後唔檢查", async () => {
    const sunday = new Date("2026-10-18T05:00:00Z"); // HK 星期日 13:00
    const early = new Date("2026-10-15T22:30:00Z"); // HK 06:30 週五
    const late = new Date("2026-10-16T15:00:00Z"); // HK 23:00 週五
    for (const t of [sunday, early, late]) expect((await run(t)).summary).toMatchObject({ silence_alerted: false });
    const justOpen = new Date("2026-10-15T23:00:00Z"); // HK 07:00 週五
    expect((await run(justOpen)).summary).toMatchObject({ silence_alerted: true });
    expect(await silent()).toHaveLength(1);
  });
});

describe("W5 健康 job：解析積壓", () => {
  beforeEach(() => {
    delete process.env.WAHA_BASE_URL;
  });
  const backlogAlerts = async () => (await alerts()).filter((n) => n.title.includes("積壓"));

  it("received 超過 200 條 → 通知；剛好 200 且夠新 → 唔通知", async () => {
    await prisma.whatsappMessage.createMany({ data: Array.from({ length: 200 }, (_, i) => ({ session: "default", chatJid: G1, messageId: `w5-bk-${i}`, senderJid: "85290000011@c.us", ts: NOW, text: "x", createdAt: new Date(NOW.getTime() - 60_000) })) });
    expect((await runWhatsappHealth(NOW, { force: true })).summary).toMatchObject({ backlog: 200, backlog_alerted: false });
    await mkMsg(G1, "w5-bk-200", { createdAt: new Date(NOW.getTime() - 60_000) });
    expect((await runWhatsappHealth(NOW, { force: true })).summary).toMatchObject({ backlog: 201, backlog_alerted: true });
    // 6 小時內唔重覆
    expect((await runWhatsappHealth(new Date(NOW.getTime() + H), { force: true })).summary).toMatchObject({ backlog_alerted: false });
    expect(await backlogAlerts()).toHaveLength(1);
  });

  it("最舊 received 等咗超過 30 分鐘 → 通知；29 分鐘唔通知；已處理／已撤回唔計", async () => {
    await mkMsg(G1, "w5-old", { createdAt: new Date(NOW.getTime() - 29 * 60_000) });
    await mkMsg(G1, "w5-done", { status: "routed", createdAt: new Date(NOW.getTime() - 5 * H) });
    await mkMsg(G1, "w5-rev", { revokedAt: NOW, createdAt: new Date(NOW.getTime() - 5 * H) });
    expect((await runWhatsappHealth(NOW, { force: true })).summary).toMatchObject({ backlog: 1, backlog_alerted: false });
    const r = await runWhatsappHealth(new Date(NOW.getTime() + 2 * 60_000), { force: true });
    expect(r.summary).toMatchObject({ backlog_alerted: true, oldest_age_min: 31 });
    const [n] = await backlogAlerts();
    expect(n!.body).toContain("31 分鐘");
  });
});

describe("W5 health API：最近告警", () => {
  it("recent_alerts 最多 5 條、新到舊、只含 whatsapp_health", async () => {
    for (let i = 0; i < 7; i++) {
      await prisma.appNotification.create({ data: { kind: "whatsapp_health", title: `告警${i}`, body: "b", audience: ["老闆"], dedupeKey: `t:${i}`, createdAt: new Date(NOW.getTime() + i * 1000) } });
    }
    await prisma.appNotification.create({ data: { kind: "month_opened", title: "其他", body: "b", audience: ["老闆"], dedupeKey: "t:other" } });
    const res = await healthGet(req("/api/whatsapp/health", cookies["主管"]));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { recent_alerts: { title: string }[] };
    expect(body.recent_alerts.map((a) => a.title)).toEqual(["告警6", "告警5", "告警4", "告警3", "告警2"]);
  });
});

describe("W5 口語對照 API", () => {
  async function seedGroup() {
    const site = await prisma.site.create({ data: { canonicalName: "測試盤W5", clientName: "測試客戶W5", billingModel: "per_shift", createdBy: "test:w5" } });
    await prisma.shiftType.createMany({ data: [{ siteId: site.id, code: "A", label: "早更", createdBy: "test:w5" }, { siteId: site.id, code: "N", label: "夜更", createdBy: "test:w5" }] });
    await prisma.shiftType.create({ data: { siteId: site.id, code: "OLD", label: "舊", createdBy: "test:w5", voidedAt: new Date() } });
    const g = await prisma.whatsappGroup.create({ data: { groupJid: G1, label: "W5群一", kind: "site", siteId: site.id, createdBy: "test:w5" } });
    return { site, g };
  }
  const patch = (id: string, over: Record<string, unknown>, who: RoleName = "老闆") => groupsPatch(req("/api/whatsapp/groups", cookies[who], "PATCH", { id, ...over }));

  it("GET：每盤有效更碼（唔含作廢）＋請假碼選項；唔含價錢欄", async () => {
    const { site } = await seedGroup();
    const res = await groupsGet(req("/api/whatsapp/groups", cookies["老闆"]));
    const body = (await res.json()) as { shift_code_options: { site_id: string; codes: { code: string }[] }[]; leave_code_options: string[]; rows: { leave_word_map: unknown[] }[] };
    const mine = body.shift_code_options.find((x) => x.site_id === site.id)!;
    expect(mine.codes.map((c) => c.code).sort()).toEqual(["A", "N"]);
    expect(body.leave_code_options).toEqual(["SL", "AL", "NL", "RD", "SH"]);
    expect(body.rows[0]!.leave_word_map).toEqual([]);
    // 會計（view only）攞唔到選項
    const acc = (await (await groupsGet(req("/api/whatsapp/groups", cookies["會計"]))).json()) as { shift_code_options: unknown[]; leave_code_options: unknown[] };
    expect(acc.shift_code_options).toEqual([]);
    expect(acc.leave_code_options).toEqual(["SL", "AL", "NL", "RD", "SH"]); // 請假碼係固定清單，唔係敏感資料
  });

  it("PATCH leave_word_map：儲存、讀返、audit；清空；非老闆 403", async () => {
    const { g } = await seedGroup();
    const res = await patch(g.id, { leave_word_map: [{ word: "病", code: "AL" }, { word: "放假", code: "RD" }] });
    expect(res.status).toBe(200);
    const row = await prisma.whatsappGroup.findUniqueOrThrow({ where: { id: g.id } });
    expect(row.leaveWordMap).toEqual({ 病: "AL", 放假: "RD" });
    const list = (await (await groupsGet(req("/api/whatsapp/groups", cookies["老闆"]))).json()) as { rows: { leave_word_map: { word: string; code: string }[] }[] };
    expect([...list.rows[0]!.leave_word_map].sort((a, b) => a.word.localeCompare(b.word))).toEqual([{ word: "放假", code: "RD" }, { word: "病", code: "AL" }]);
    const au = await prisma.auditLog.findFirst({ where: { tableName: "whatsapp_groups", rowId: g.id, action: "update" }, orderBy: { createdAt: "desc" } });
    expect(JSON.stringify(au!.after)).toContain("leave_word_map");
    expect((await patch(g.id, { leave_word_map: [] })).status).toBe(200);
    expect((await prisma.whatsappGroup.findUniqueOrThrow({ where: { id: g.id } })).leaveWordMap).toEqual({});
    expect((await patch(g.id, { leave_word_map: [{ word: "病", code: "SL" }] }, "主管")).status).toBe(403);
  });

  it("驗證：請假碼要在清單內；詞重覆（含全形／半形）；空詞；超過 30 行 → 400，原值不變", async () => {
    const { g } = await seedGroup();
    await patch(g.id, { leave_word_map: [{ word: "病", code: "SL" }], shift_word_map: [{ word: "夜", code: "N" }] });
    const bad = async (over: Record<string, unknown>) => expect((await patch(g.id, over)).status, JSON.stringify(over)).toBe(400);
    await bad({ leave_word_map: [{ word: "病", code: "XX" }] });
    await bad({ leave_word_map: [{ word: "病", code: "SL" }, { word: "病", code: "AL" }] });
    await bad({ leave_word_map: [{ word: "ＳＬ", code: "SL" }, { word: "SL", code: "AL" }] });
    await bad({ shift_word_map: [{ word: "ＯＴ", code: "A" }, { word: "OT", code: "N" }] });
    await bad({ leave_word_map: [{ word: "", code: "SL" }] });
    await bad({ leave_word_map: Array.from({ length: 31 }, (_, i) => ({ word: `詞${i}`, code: "SL" })) });
    const row = await prisma.whatsappGroup.findUniqueOrThrow({ where: { id: g.id } });
    expect(row.leaveWordMap).toEqual({ 病: "SL" });
    expect(row.shiftWordMap).toEqual({ 夜: "N" });
  });

  it("詞先 NFKC 正規化再存（ＯＴ → OT）", async () => {
    const { g } = await seedGroup();
    await patch(g.id, { shift_word_map: [{ word: "ＯＴ", code: "N" }] });
    expect((await prisma.whatsappGroup.findUniqueOrThrow({ where: { id: g.id } })).shiftWordMap).toEqual({ OT: "N" });
  });
});

describe("W5 請假詞覆寫優先於內建（mapLeaveCode＋端到端）", () => {
  it("mapLeaveCode：覆寫全字／包含優先；冇覆寫仍用內建", () => {
    expect(mapLeaveCode("病假").code).toBe("SL");
    expect(mapLeaveCode("病假", { 病假: "AL" })).toMatchObject({ code: "AL", ambiguous: false });
    expect(mapLeaveCode("今日病假", { 病假: "AL" }).code).toBe("AL");
    expect(mapLeaveCode("今日病假", { 病: "NL", 病假: "AL" }).code).toBe("AL"); // 最長詞優先
    expect(mapLeaveCode("年假", { 病假: "AL" }).code).toBe("AL"); // 無關覆寫 → 內建年假 AL
    expect(mapLeaveCode("事假", { 病假: "AL" }).code).toBe("NL");
    expect(mapLeaveCode("放假", { 放假: "RD" }).code).toBe("RD"); // 內建 unclear，群組覆寫成 RD
    expect(mapLeaveCode("放假", {})).toMatchObject({ code: null, unclear: true });
  });

  async function setup(leaveWordMap: Record<string, string>) {
    const broker = await prisma.broker.create({ data: { code: "TEST-W5B", name: "測試判頭W5", kind: "broker", settlementType: "cash", createdBy: "test:w5" } });
    const site = await prisma.site.create({ data: { canonicalName: "測試盤W5", clientName: "測試客戶W5", billingModel: "per_shift", createdBy: "test:w5" } });
    await prisma.shiftType.create({ data: { siteId: site.id, code: "A", label: "早更", startTime: new Date("1970-01-01T07:00:00Z"), endTime: new Date("1970-01-01T15:00:00Z"), hours: 8, createdBy: "test:w5" } });
    const guard = await prisma.guard.create({ data: { nameZh: "測試甲", employmentType: "cash_casual", tel: "90000011", defaultBrokerId: broker.id, createdBy: "test:w5" } });
    await prisma.whatsappGroup.create({ data: { groupJid: G1, label: "W5群一", kind: "site", siteId: site.id, leaveWordMap, createdBy: "test:w5" } });
    return { guard };
  }
  const leaveLlm: LlmClient = {
    async chat() {
      return { text: JSON.stringify({ noise: false, intents: [{ type: "leave", date: { raw: "聽日17號", kind: "absolute", iso_guess: "2026-10-17", to_iso_guess: null }, site_raw: null, persons: [], self_reference: true, shift_raw: null, shift_code_guess: null, hours: null, leave_raw: "病假", leave_code_guess: "SL", confidence: 0.9, evidence: "x" }] }), toolsUsed: [], inputTokens: 100, outputTokens: 30, provider: "fake", model: "fake-m" };
    },
  };
  const ev = (mid: string): NormalizedWaEvent => ({ kind: "message", session: "default", messageId: mid, chatJid: G1, senderJid: "85290000011@c.us", fromMe: false, ts: new Date(NOW.getTime() - 3600_000), text: "我聽日17號病假", mediaType: null, quotedMessageId: null, eventId: `${mid}-e` });

  it("群組覆寫「病假→AL」→ intent.leaveCode＝AL；冇覆寫＝SL", async () => {
    await setup({ 病假: "AL" });
    await ingestEvent(ev("w5-m1"), NOW);
    await runWhatsappParse(NOW, { llm: [leaveLlm], force: true });
    const [i] = await prisma.whatsappIntent.findMany({ where: { messageId: "w5-m1" } });
    expect(i).toMatchObject({ kind: "leave", leaveCode: "AL" });
    await prisma.whatsappGroup.update({ where: { groupJid: G1 }, data: { leaveWordMap: {} } });
    await ingestEvent(ev("w5-m2"), NOW);
    await runWhatsappParse(NOW, { llm: [leaveLlm], force: true });
    const [j] = await prisma.whatsappIntent.findMany({ where: { messageId: "w5-m2" } });
    expect(j).toMatchObject({ kind: "leave", leaveCode: "SL" });
  });
});

describe("W5 指標 API", () => {
  const metrics = async (q = "", who: RoleName = "老闆") => metricsGet(req(`/api/whatsapp/metrics${q}`, cookies[who]));
  type M = { received: number; filtered: number; parsed: number; auto_judged: number; auto_written: number; pending: number; approved: number; rejected: number; triage_opened: number; triage_answered: number; consistency_rate: number | null; llm_calls: number; llm_tokens_in: number; llm_tokens_out: number; errors: number };
  type Res = { days: number; from: string; to: string; totals: M; groups: (M & { group_id: string | null; label: string })[] };

  it("RBAC：老闆／會計／主管 200；雞頭／安員 403；未登入 401；days 驗證", async () => {
    for (const r of ["老闆", "會計", "主管"] as RoleName[]) expect((await metrics("", r)).status).toBe(200);
    for (const r of ["雞頭", "安員"] as RoleName[]) expect((await metrics("", r)).status).toBe(403);
    expect((await metricsGet(req("/api/whatsapp/metrics", null))).status).toBe(401);
    for (const q of ["?days=0", "?days=91", "?days=x", "?days=1.5"]) expect((await metrics(q)).status, q).toBe(400);
    const ok7 = (await (await metrics()).json()) as Res;
    expect(ok7.days).toBe(7);
    expect(ok7.from < ok7.to).toBe(true);
  });

  it("冇數據 → 全 0、一致率 null、groups 空", async () => {
    const b = (await (await metrics("?days=30")).json()) as Res;
    expect(b.days).toBe(30);
    expect(b.totals).toMatchObject({ received: 0, parsed: 0, auto_judged: 0, auto_written: 0, triage_opened: 0, errors: 0, consistency_rate: null, llm_tokens_in: 0 });
    expect(b.groups).toEqual([]);
  });

  it("數字：收／過濾／解析／token／錯誤／Triage 開題＋已答／按群細分；days 界線", async () => {
    // 用真時間做 "今日"：metrics 以現在時間計 N 日窗口
    const now = Date.now();
    const at = (daysAgo: number) => new Date(now - daysAgo * 86400_000);
    await prisma.whatsappGroup.createMany({ data: [{ groupJid: G1, label: "W5群一", kind: "multi_site", createdBy: "test:w5" }, { groupJid: G2, label: "W5群二", kind: "multi_site", createdBy: "test:w5" }] });
    await mkMsg(G1, "w5-1", { ts: at(0.1), status: "routed", llmProvider: "fake", llmTokensIn: 100, llmTokensOut: 30 });
    await mkMsg(G1, "w5-2", { ts: at(0.2), status: "routed", llmProvider: "fake", llmTokensIn: 50, llmTokensOut: 10 });
    await mkMsg(G1, "w5-3", { ts: at(0.3), status: "ignored", ignoreReason: "filtered_out" });
    await mkMsg(G1, "w5-4", { ts: at(0.4), status: "error", error: "process_failed" });
    await mkMsg(G2, "w5-5", { ts: at(10), status: "routed", llmProvider: "fake", llmTokensIn: 7, llmTokensOut: 3 }); // 7 日外、30 日內
    await mkMsg(G2, "w5-6", { ts: at(40), status: "routed", llmProvider: "fake", llmTokensIn: 999, llmTokensOut: 999 }); // 30 日外
    // intents：w5-1 一條 auto_write（冇記錄→suggested）、w5-2 一條 triage（開題）
    await prisma.whatsappIntent.create({ data: { messageId: "w5-1", messageRevision: 1, idx: 0, kind: "leave", routed: "auto_write", resolution: {} } });
    await prisma.whatsappIntent.create({ data: { messageId: "w5-2", messageRevision: 1, idx: 0, kind: "shift", routed: "triage", resolution: {} } });
    const owner = fx.userIds["老闆"];
    const sess = await prisma.triageSession.create({ data: { sourceType: "whatsapp", sourceRef: "w5-sess", ownerUserId: owner, createdBy: owner, statsJson: {} } });
    const q = (key: string, mid: string, over: Record<string, unknown> = {}) => prisma.triageQuestion.create({ data: { sessionId: sess.id, kind: "wa_person_unknown", groupKey: key, title: "t", evidenceJson: { message: { message_id: mid } }, ...over } });
    await q("k1", "w5-2");
    await q("k2", "w5-2", { status: "answered", answeredAt: new Date(now), createdAt: at(1) });
    await q("k3", "w5-5", { createdAt: at(10) }); // 7 日外
    await q("k4", "w5-2", { kind: "name_not_confirmed" }); // 非 wa_ 題唔計

    const b7 = (await (await metrics("?days=7")).json()) as Res;
    expect(b7.totals).toMatchObject({ received: 4, filtered: 1, parsed: 2, llm_calls: 2, llm_tokens_in: 150, llm_tokens_out: 40, errors: 1, auto_judged: 1, triage_opened: 2, triage_answered: 1 });
    expect(b7.groups.map((g) => [g.label, g.received])).toEqual([["W5群一", 4]]);
    expect(b7.groups[0]).toMatchObject({ group_id: expect.any(String), llm_tokens_in: 150, triage_opened: 2, triage_answered: 1, errors: 1 });

    const b30 = (await (await metrics("?days=30")).json()) as Res;
    expect(b30.totals).toMatchObject({ received: 5, parsed: 3, llm_tokens_in: 157, triage_opened: 3, triage_answered: 1 });
    expect(b30.groups.map((g) => g.label)).toEqual(["W5群一", "W5群二"]);
    expect(b30.groups[1]).toMatchObject({ received: 1, llm_tokens_in: 7, triage_opened: 1, triage_answered: 0 });
    // 只有數字／標籤：回應冇原文
    expect(JSON.stringify(b30)).not.toContain("測試");
  });
});

describe("W5 日摘要：保留一致率", () => {
  it("日摘要內容含「對照一致率」（無數據顯示 —）", async () => {
    await prisma.whatsappGroup.create({ data: { groupJid: G1, label: "W5群一", kind: "multi_site", createdBy: "test:w5" } });
    await mkMsg(G1, "w5-d1", { ts: new Date("2026-10-15T04:00:00Z"), status: "ignored", ignoreReason: "filtered_out" });
    const r = await runWhatsappDailySummary(NOW, { force: true });
    expect(r.summary).toMatchObject({ day: "2026-10-15", received: 1 });
    const n = await prisma.appNotification.findFirstOrThrow({ where: { kind: "whatsapp_daily" } });
    expect(n.body).toContain("對照一致率 —");
  });
});
