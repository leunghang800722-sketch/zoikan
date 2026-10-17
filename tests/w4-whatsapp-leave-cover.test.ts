// W4：WhatsApp 請假（AL／SL／NL／RD／SH、range、同日已有更）、病假接現有「醫生紙待確認」流程（批核後先計）、
// 替更兩段式（wa_cover：兩人配對／候選、被替者冇更、替更者撞更、同 tx 回滾、權限）、取消（wa_cancel）、batch-accept 排除。
// 全部假資料（測試甲／乙／丙／丁、假群、假電話）；LLM 用腳本化 fake；首階段替更／取消一律 Triage。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { runWhatsappParse } from "@/lib/jobs/whatsapp-parse";
import { ingestEvent } from "@/lib/whatsapp/ingest";
import type { NormalizedWaEvent } from "@/lib/whatsapp/schema";
import type { LlmClient, LlmChatParams } from "@/lib/ai/llm";
import { scoreMessage } from "@/lib/whatsapp/filter";
import { waQuestionViews } from "@/lib/whatsapp/triage-answer";
import { generateLongtermInputDrafts } from "@/lib/longterm-payroll/drafts";
import { countSlPending, listSlPending } from "@/lib/longterm-payroll/sl-confirm";
import { POST as previewPost } from "@/app/api/triage/questions/[id]/preview/route";
import { POST as answerPost } from "@/app/api/triage/questions/[id]/answer/route";
import { GET as batchPreviewGet } from "@/app/api/triage/questions/batch-accept/preview/route";
import { POST as batchPost } from "@/app/api/triage/questions/batch-accept/route";
import { GET as intentsGet } from "@/app/api/whatsapp/intents/route";
import { POST as approvePost } from "@/app/api/shift-records/[id]/approve/route";

const T0 = new Date("2026-10-16T05:00:00Z"); // HK 2026-10-16 13:00 星期五
const NOW = new Date(T0.getTime() + 60_000);
const G1 = "w4-g1@g.us";
const SENDER_A = "85290000011@c.us"; // 測試甲（已知）
const BASE = "http://test.local";
const MONTH = new Date("2026-10-01T00:00:00Z");

let fx: Wp2Fixture;
let ids: { site: string; tA: string; tN: string; gA: string; gB: string; gC: string; gD: string; gM1: string; gM2: string; gH1: string; gH2: string };
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
const J = (over: Record<string, unknown> = {}) => JSON.stringify({ noise: false, intents: [intent(over)] });
const leaveJ = (leave_raw: string, over: Record<string, unknown> = {}) => J({ type: "leave", persons: [], self_reference: true, shift_raw: null, leave_raw, ...over });
const coverJ = (worker: string, replaced: string, over: Record<string, unknown> = {}) => J({ type: "cover", persons: [{ raw: worker, role: "worker" }, { raw: replaced, role: "replaced" }], ...over });
const cancelJ = (over: Record<string, unknown> = {}) => J({ type: "cancel", persons: [], self_reference: true, shift_raw: null, ...over });

function fakeLlm(script: (text: string) => string): LlmClient {
  return {
    async chat(params: LlmChatParams) {
      const text = (JSON.parse(params.userMessage) as { text: string }).text;
      return { text: script(text), toolsUsed: [], inputTokens: 10, outputTokens: 5, provider: "fake", model: "fake-m" };
    },
  };
}
function ev(mid: string, text: string, tsOffsetSec = 0): NormalizedWaEvent {
  return { kind: "message", session: "default", messageId: mid, chatJid: G1, senderJid: SENDER_A, fromMe: false, ts: new Date(T0.getTime() + tsOffsetSec * 1000), text, mediaType: null, quotedMessageId: null, eventId: `${mid}-${tsOffsetSec}-${text.length}` };
}
async function feed(mid: string, text: string, json: string, offset = 0) {
  const e = ev(mid, text, offset);
  await ingestEvent(e, new Date(Math.max(NOW.getTime(), (e.ts?.getTime() ?? 0) + 60_000)));
  await runWhatsappParse(NOW, { llm: [fakeLlm(() => json)], force: true });
}
const qsOf = (mid: string) => prisma.triageQuestion.findMany({ where: { session: { sourceType: "whatsapp" }, evidenceJson: { path: ["message", "message_id"], equals: mid } }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
const intentsOf = (mid: string) => prisma.whatsappIntent.findMany({ where: { messageId: mid }, orderBy: [{ messageRevision: "asc" }, { idx: "asc" }] });
const evidence = (q: { evidenceJson: unknown }) => q.evidenceJson as { round: number; reasons: string[]; candidates: { guard_ids: string[]; existing_record_ids: string[] }; cover?: { replaced_guard_id: string | null; replaced_candidate_ids: string[]; replaced_record_ids: string[] } };
const optIds = (q: { optionsJson: unknown }) => (q.optionsJson as Array<{ id: string }>).map((o) => o.id);

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
async function confirm(qid: string, ans: Record<string, unknown>) {
  const pv = await preview(qid, ans);
  expect(pv.status).toBe(200);
  return answer(qid, ans, pv.body.preview_hash);
}
const day = (iso: string) => new Date(`${iso}T00:00:00Z`);
const recsOf = (guardId: string, iso: string) => prisma.shiftRecord.findMany({ where: { guardId, workDate: day(iso) }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
const mkRec = (guardId: string, iso: string, shiftTypeId: string, over: Record<string, unknown> = {}) =>
  prisma.shiftRecord.create({ data: { workDate: day(iso), siteId: ids.site, shiftTypeId, guardId, recordType: "shift", status: "confirmed", createdBy: "test:w4", ...over } as never });
const voidAudit = (rowId: string) => prisma.auditLog.findMany({ where: { tableName: "shift_records", rowId, action: "void" } });

beforeEach(async () => {
  await clearAll();
  fx = await seedWp2Fixture();
  boss = fx.userIds["老闆"];
  cookie = await sessionCookieForUser(boss);
  const site = await prisma.site.create({ data: { canonicalName: "測試盤W4", clientName: "測試客戶W4", billingModel: "per_shift", createdBy: "test:w4" } });
  const tA = await prisma.shiftType.create({ data: { siteId: site.id, code: "A", label: "早更", startTime: new Date("1970-01-01T07:00:00Z"), endTime: new Date("1970-01-01T15:00:00Z"), hours: 8, createdBy: "test:w4" } });
  const tN = await prisma.shiftType.create({ data: { siteId: site.id, code: "N", label: "夜更", startTime: new Date("1970-01-01T19:00:00Z"), endTime: new Date("1970-01-01T07:00:00Z"), hours: 12, createdBy: "test:w4" } });
  const mk = (nameZh: string, tel: string, extra: Record<string, unknown> = {}) => prisma.guard.create({ data: { nameZh, employmentType: "cash_casual", tel, createdBy: "test:w4", ...extra } as never });
  const gA = await mk("測試甲", "90000011");
  const gB = await mk("測試乙", "90000012");
  const gC = await mk("測試丙", "90000015");
  const gD = await mk("測試丁", "90000016");
  const gM1 = await mk("測試明一", "90000013", { nameAliases: ["阿明"] });
  const gM2 = await mk("測試明二", "90000014", { nameAliases: ["阿明"] });
  const gH1 = await mk("測試華一", "90000017", { nameAliases: ["阿華"] });
  const gH2 = await mk("測試華二", "90000018", { nameAliases: ["阿華"] });
  ids = { site: site.id, tA: tA.id, tN: tN.id, gA: gA.id, gB: gB.id, gC: gC.id, gD: gD.id, gM1: gM1.id, gM2: gM2.id, gH1: gH1.id, gH2: gH2.id };
  await prisma.whatsappGroup.create({ data: { groupJid: G1, label: "W4測試群", kind: "site", siteId: site.id, shiftWordMap: { 早: "A", 夜: "N" }, autoWrite: true, createdBy: boss } });
});
afterEach(async () => {
  await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS w4_fail_trg ON audit_log`);
  await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS w4_fail()`);
});
async function failShiftCreateAudit() {
  await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION w4_fail() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'w4 forced failure'; END; $$ LANGUAGE plpgsql`);
  await prisma.$executeRawUnsafe(`CREATE TRIGGER w4_fail_trg BEFORE INSERT ON audit_log FOR EACH ROW WHEN (NEW.table_name = 'shift_records' AND NEW.action = 'create') EXECUTE FUNCTION w4_fail()`);
}
async function asManagerOwner(q: { sessionId: string }, off: Array<"void" | "update">) {
  const mgr = fx.userIds["主管"];
  await prisma.triageSession.update({ where: { id: q.sessionId }, data: { ownerUserId: mgr } });
  for (const a of off) {
    const perm = await prisma.permission.findFirstOrThrow({ where: { module: "更表", action: a } });
    await prisma.rolePermission.updateMany({ where: { roleId: fx.roleIds["主管"], permissionId: perm.id }, data: { granted: false } });
  }
  return sessionCookieForUser(mgr);
}

// ---------------------------------------------------------------------------
describe("W4 請假：各碼寫入、放假、range、同日已有更", () => {
  it("AL／SL／NL／RD／SH 各自寫 leave 記錄（pending_approval、source=whatsapp）；『放假』仍 leave_code_unclear → Triage 唔寫", async () => {
    const cases: Array<[string, string, string]> = [["年假", "AL", "18"], ["病假", "SL", "19"], ["事假", "NL", "20"], ["例假", "RD", "21"], ["公假", "SH", "22"]];
    let off = 0;
    for (const [raw, code, dd] of cases) {
      await feed(`l-${code}`, `我${dd}號${raw}`, leaveJ(raw, { date: { raw: `${dd}號`, kind: "absolute" } }), off++ * 600);
      const r = await recsOf(ids.gA, `2026-10-${dd}`);
      expect(r).toHaveLength(1);
      expect(r[0]).toMatchObject({ recordType: "leave", leaveCode: code, status: "pending_approval", source: "whatsapp" });
      expect((await intentsOf(`l-${code}`))[0]).toMatchObject({ routed: "auto_write", resultRef: r[0]!.id });
    }
    await feed("l-off", "我23號放假", leaveJ("放假", { date: { raw: "23號", kind: "absolute" } }), off * 600);
    expect(await recsOf(ids.gA, "2026-10-23")).toHaveLength(0);
    const [q] = await qsOf("l-off");
    expect(q!.kind).toBe("wa_unparsed");
    expect(evidence(q!).reasons).toContain("leave_code_unclear");
    expect((await intentsOf("l-off"))[0]).toMatchObject({ routed: "triage" });
  });

  it("請假 range（17-19 號）展開逐日寫入（3 條 intent、3 條 leave 記錄）", async () => {
    await feed("rg1", "我17-19號病假", leaveJ("病假", { date: { raw: "17-19號", kind: "range" } }));
    const its = await intentsOf("rg1");
    expect(its.map((i) => [i.idx, i.routed, i.workDate?.toISOString().slice(0, 10)])).toEqual([[0, "auto_write", "2026-10-17"], [1, "auto_write", "2026-10-18"], [2, "auto_write", "2026-10-19"]]);
    const rows = await prisma.shiftRecord.findMany({ where: { guardId: ids.gA, source: "whatsapp" }, orderBy: { workDate: "asc" } });
    expect(rows.map((r) => [r.workDate.toISOString().slice(0, 10), r.recordType, r.leaveCode])).toEqual([["2026-10-17", "leave", "SL"], ["2026-10-18", "leave", "SL"], ["2026-10-19", "leave", "SL"]]);
  });

  it("range 其中一日已有更 → 該日逐日開 wa_shift_conflict 題，其餘照寫", async () => {
    await mkRec(ids.gA, "2026-10-18", ids.tN);
    await feed("rg2", "我17-19號病假", leaveJ("病假", { date: { raw: "17-19號", kind: "range" } }));
    const its = await intentsOf("rg2");
    expect(its.map((i) => i.routed)).toEqual(["auto_write", "triage", "auto_write"]);
    const qs = await qsOf("rg2");
    expect(qs).toHaveLength(1);
    expect(qs[0]).toMatchObject({ kind: "wa_shift_conflict", groupKey: "rg2:1:1" });
    expect(evidence(qs[0]!).reasons).toContain("conflict_shift_vs_leave");
    expect((await recsOf(ids.gA, "2026-10-18")).filter((r) => r.source === "whatsapp")).toHaveLength(0);
  });

  it("同日已有更而報請假（聽日病假返唔到）→ 唔自動；題卡顯示『會取消 10 月 17 日 N 更』；以 WhatsApp 為準＝取消該更＋寫 leave 同 tx", async () => {
    const old = await mkRec(ids.gA, "2026-10-17", ids.tN);
    await feed("lc1", "聽日病假返唔到", leaveJ("病假"));
    const [q] = await qsOf("lc1");
    expect(q).toMatchObject({ kind: "wa_shift_conflict", status: "open" });
    expect((await prisma.shiftRecord.findUniqueOrThrow({ where: { id: old.id } })).status).toBe("confirmed");
    expect(optIds(q!)).toContain("wa_use_whatsapp");
    const [v] = await waQuestionViews([q!], { canSee: true, canWrite: true });
    expect(v!.wa.cancel_preview).toHaveLength(1);
    expect(v!.wa.cancel_preview[0]).toContain("會取消");
    expect(v!.wa.cancel_preview[0]).toContain("10 月 17 日");
    expect(v!.wa.cancel_preview[0]).toContain("N 更");
    expect(v!.wa.existing[0]).toMatchObject({ work_date: "2026-10-17", shift_code: "N" });
    const pv = await preview(q!.id, { option: "wa_use_whatsapp" });
    expect(pv.status).toBe(200);
    expect(pv.body.impact.summary.join("")).toContain("同時取消 1 條舊記錄");
    expect((await answer(q!.id, { option: "wa_use_whatsapp" }, pv.body.preview_hash)).status).toBe(200);
    expect((await prisma.shiftRecord.findUniqueOrThrow({ where: { id: old.id } })).status === "cancelled" || (await recsOf(ids.gA, "2026-10-17")).some((r) => r.recordType === "leave")).toBe(true);
    const all = await recsOf(ids.gA, "2026-10-17");
    expect(all.filter((r) => r.status !== "cancelled")).toHaveLength(1);
    expect(all.find((r) => r.status !== "cancelled")).toMatchObject({ recordType: "leave", leaveCode: "SL", status: "pending_approval", source: "whatsapp" });
    expect((await voidAudit(old.id)).length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe("W4 病假接現有確認流程（批核後先計、要人手確認醫生紙）", () => {
  async function longtermA() {
    await prisma.guardLongtermContract.create({ data: { guardId: ids.gA, monthlySalary: 15500, effectiveFrom: new Date("2020-01-01"), effectiveTo: null, source: "manual", createdBy: boss } });
  }

  it("WhatsApp SL：未批核唔出草稿；批核後出『病假待確認』（status=draft、醫生紙未核），唔自動確認", async () => {
    await longtermA();
    await feed("sl1", "聽日病假", leaveJ("病假"));
    const [rec] = await recsOf(ids.gA, "2026-10-17");
    expect(rec).toMatchObject({ recordType: "leave", leaveCode: "SL", status: "pending_approval", source: "whatsapp" });
    await generateLongtermInputDrafts(MONTH, boss);
    expect(await prisma.longtermPayrollInput.count({ where: { guardId: ids.gA, kind: "leave" } })).toBe(0); // 未批核唔出
    expect((await countSlPending(MONTH)).segments).toBe(0);
    const ok = await approvePost(new Request(`${BASE}/api/shift-records/${rec!.id}/approve`, { method: "POST", headers: { cookie } }), params(rec!.id));
    expect(ok.status).toBe(200);
    await generateLongtermInputDrafts(MONTH, boss);
    const drafts = await prisma.longtermPayrollInput.findMany({ where: { guardId: ids.gA, kind: "leave" } });
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ status: "draft", doctorNoteVerified: false, draftSource: "roster_leave:SL", dateFrom: "2026-10-17", dateTo: "2026-10-17" });
    const pending = await listSlPending(MONTH);
    expect(pending.segment_count).toBe(1);
    expect(pending.segments[0]).toMatchObject({ date_from: "2026-10-17", roster_days: 1 });
    expect((await countSlPending(MONTH)).segments).toBe(1);
  });

  it("群組 auto_confirm=true（記錄直接 confirmed）→ 草稿照出但仍然 status=draft（醫生紙要人手確認，唔自動當已確認）", async () => {
    await longtermA();
    await prisma.whatsappGroup.update({ where: { groupJid: G1 }, data: { autoConfirm: true } });
    await feed("sl2", "聽日病假", leaveJ("病假"));
    expect((await recsOf(ids.gA, "2026-10-17"))[0]).toMatchObject({ status: "confirmed", source: "whatsapp" });
    await generateLongtermInputDrafts(MONTH, boss);
    const drafts = await prisma.longtermPayrollInput.findMany({ where: { guardId: ids.gA, kind: "leave" } });
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ status: "draft", doctorNoteVerified: false });
  });

  it("其他來源嘅 pending_approval SL 照舊出草稿（只限 WhatsApp 未批核唔計）", async () => {
    await longtermA();
    await mkRec(ids.gA, "2026-10-12", ids.tA, { recordType: "leave", leaveCode: "SL", status: "pending_approval", source: "manual" });
    await generateLongtermInputDrafts(MONTH, boss);
    expect(await prisma.longtermPayrollInput.count({ where: { guardId: ids.gA, kind: "leave", status: "draft" } })).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe("W4 替更（wa_cover）：首階段一律 Triage", () => {
  it("兩人都配對到：產 wa_cover 題（evidence 含兩人、被替者該更；options；唔寫）；確認替更＝被替者該更 cancelled（covered_by_whatsapp）＋替更者 pending_approval 同 tx", async () => {
    const recB = await mkRec(ids.gB, "2026-10-17", ids.tN);
    await feed("c1", "測試丁頂測試乙聽日夜更", coverJ("測試丁", "測試乙"));
    const qs = await qsOf("c1");
    expect(qs).toHaveLength(1);
    const q = qs[0]!;
    expect(q).toMatchObject({ kind: "wa_cover", status: "open", groupKey: "c1:1:0" });
    const e = evidence(q);
    expect(e.cover).toMatchObject({ replaced_guard_id: ids.gB, replaced_record_ids: [recB.id] });
    expect(optIds(q)).toEqual(["wa_cover_confirm", "wa_cover_add_only", "wa_manual", "skip"]);
    expect((await intentsOf("c1"))[0]).toMatchObject({ routed: "triage", guardId: ids.gD, resultRef: q.id });
    expect(await prisma.shiftRecord.count({ where: { source: "whatsapp" } })).toBe(0);
    const [v] = await waQuestionViews([q], { canSee: true, canWrite: true });
    expect(v!.kind_label).toContain("替更");
    expect(v!.wa.cover?.replaced).toMatchObject({ guard_id: ids.gB, name: "測試乙" });
    expect(v!.wa.cover?.worker).toMatchObject({ guard_id: ids.gD, name: "測試丁" });
    expect(v!.wa.cancel_preview[0]).toContain("測試乙");
    expect(v!.wa.cancel_preview[0]).toContain("10 月 17 日");

    const pv = await preview(q.id, { option: "wa_cover_confirm" });
    expect(pv.status).toBe(200);
    expect(pv.body.writes).toBe(true);
    expect(await prisma.shiftRecord.count({ where: { source: "whatsapp" } })).toBe(0); // 預覽唔寫
    const res = await answer(q.id, { option: "wa_cover_confirm" }, pv.body.preview_hash);
    expect(res.status).toBe(200);
    expect(res.body.result.cancelled).toBe(1);
    const b = await prisma.shiftRecord.findUniqueOrThrow({ where: { id: recB.id } });
    expect(b.status).toBe("cancelled");
    const aud = await voidAudit(recB.id);
    expect(aud).toHaveLength(1);
    expect(JSON.stringify(aud[0]!.after)).toContain("covered_by_whatsapp");
    const [d] = await recsOf(ids.gD, "2026-10-17");
    expect(d).toMatchObject({ status: "pending_approval", source: "whatsapp", recordType: "shift", shiftTypeId: ids.tN, siteId: ids.site });
    expect(d!.provenance).toMatchObject({ message_id: "c1", revision: 1, triage_question_id: q.id, cover: { replaced_guard_id: ids.gB } });
    expect(await prisma.triageQuestion.findUniqueOrThrow({ where: { id: q.id } })).toMatchObject({ status: "answered", answeredBy: boss });
    // 被替者唔係 leave：冇多出 leave 記錄
    expect((await recsOf(ids.gB, "2026-10-17")).filter((r) => r.recordType === "leave")).toHaveLength(0);
    // 重覆作答 409
    expect((await answer(q.id, { option: "wa_cover_confirm" }, pv.body.preview_hash)).status).toBe(409);
  });

  it("只加替更者（wa_cover_add_only）：被替者記錄不變", async () => {
    const recB = await mkRec(ids.gB, "2026-10-17", ids.tN);
    await feed("c2", "測試丁頂測試乙聽日夜更", coverJ("測試丁", "測試乙"));
    const [q] = await qsOf("c2");
    expect((await confirm(q!.id, { option: "wa_cover_add_only" })).status).toBe(200);
    expect((await prisma.shiftRecord.findUniqueOrThrow({ where: { id: recB.id } })).status).toBe("confirmed");
    expect((await recsOf(ids.gD, "2026-10-17"))[0]).toMatchObject({ status: "pending_approval", source: "whatsapp" });
    expect(await voidAudit(recB.id)).toHaveLength(0);
  });

  it("被替者冇當日更 → 只寫替更者更，預覽提示；替更者已有同一更 → 唔重覆入，仍取消被替者", async () => {
    await feed("c3", "測試丁頂測試乙聽日夜更", coverJ("測試丁", "測試乙"));
    const [q] = await qsOf("c3");
    const pv = await preview(q!.id, { option: "wa_cover_confirm" });
    expect(pv.body.impact.notes.join("")).toContain("冇呢一更");
    expect((await answer(q!.id, { option: "wa_cover_confirm" }, pv.body.preview_hash)).status).toBe(200);
    expect((await recsOf(ids.gD, "2026-10-17")).filter((r) => r.source === "whatsapp")).toHaveLength(1);
    expect(await recsOf(ids.gB, "2026-10-17")).toHaveLength(0);
    // 替更者本身已有同一更
    const recC = await mkRec(ids.gC, "2026-10-18", ids.tN);
    await mkRec(ids.gA, "2026-10-18", ids.tN);
    await feed("c3b", "測試甲頂測試丙18號夜更", coverJ("測試甲", "測試丙", { date: { raw: "18號", kind: "absolute" } }), 700);
    const [q2] = await qsOf("c3b");
    expect(evidence(q2!).reasons).not.toContain("conflict_other_shift");
    const r2 = await confirm(q2!.id, { option: "wa_cover_confirm" });
    expect(r2.status).toBe(200);
    expect((await prisma.shiftRecord.findUniqueOrThrow({ where: { id: recC.id } })).status).toBe("cancelled");
    expect((await recsOf(ids.gA, "2026-10-18")).filter((r) => r.source === "whatsapp")).toHaveLength(0);
  });

  it("任一人唔確定 → 同一題兩個候選列；答案要帶齊兩人；揀候選以外 / 漏揀 → 400；兩人確定後寫入", async () => {
    const recH1 = await mkRec(ids.gH1, "2026-10-17", ids.tN);
    await feed("c4", "阿明頂阿華聽日夜更", coverJ("阿明", "阿華"));
    const [q] = await qsOf("c4");
    expect(q!.kind).toBe("wa_cover");
    const e = evidence(q!);
    expect([...e.candidates.guard_ids].sort()).toEqual([ids.gM1, ids.gM2].sort());
    expect([...(e.cover?.replaced_candidate_ids ?? [])].sort()).toEqual([ids.gH1, ids.gH2].sort());
    const [v] = await waQuestionViews([q!], { canSee: true, canWrite: true });
    expect(v!.wa.guard_candidates).toHaveLength(2);
    expect(v!.wa.cover?.replaced_candidates).toHaveLength(2);
    expect(v!.wa.cover?.replaced.guard_id).toBeNull();
    // 漏揀
    expect((await preview(q!.id, { option: "wa_cover_confirm" })).status).toBe(400);
    expect((await preview(q!.id, { option: "wa_cover_confirm", guard_id: ids.gM1 })).status).toBe(400);
    // 候選以外
    expect((await preview(q!.id, { option: "wa_cover_confirm", guard_id: ids.gC, replaced_guard_id: ids.gH1 })).status).toBe(400);
    expect((await preview(q!.id, { option: "wa_cover_confirm", guard_id: ids.gM1, replaced_guard_id: ids.gC })).status).toBe(400);
    // 同一人
    expect((await preview(q!.id, { option: "wa_cover_add_only", guard_id: ids.gM1, replaced_guard_id: ids.gM1 })).status).toBe(400);
    // 只加替更者（唔使揀被替者）
    const addOnly = await preview(q!.id, { option: "wa_cover_add_only", guard_id: ids.gM2 });
    expect(addOnly.status).toBe(200);
    expect(await prisma.shiftRecord.count({ where: { source: "whatsapp" } })).toBe(0);
    const ans = { option: "wa_cover_confirm", guard_id: ids.gM1, replaced_guard_id: ids.gH1 };
    expect((await confirm(q!.id, ans)).status).toBe(200);
    expect((await prisma.shiftRecord.findUniqueOrThrow({ where: { id: recH1.id } })).status).toBe("cancelled");
    expect((await recsOf(ids.gM1, "2026-10-17"))[0]).toMatchObject({ status: "pending_approval", source: "whatsapp" });
  });

  it("替更者同日已有其他更 → 撞更規則：題內顯示、無『確認替更』、只有『以 WhatsApp 為準』；用咗就連替更者原有記錄一齊取消", async () => {
    const recB = await mkRec(ids.gB, "2026-10-17", ids.tN);
    const recDA = await mkRec(ids.gD, "2026-10-17", ids.tA);
    await feed("c5", "測試丁頂測試乙聽日夜更", coverJ("測試丁", "測試乙"));
    const [q] = await qsOf("c5");
    expect(evidence(q!).reasons).toContain("conflict_other_shift");
    expect(evidence(q!).candidates.existing_record_ids).toEqual([recDA.id]);
    expect(optIds(q!)).toEqual(["wa_use_whatsapp", "wa_manual", "skip"]);
    const [v] = await waQuestionViews([q!], { canSee: true, canWrite: true });
    expect(v!.wa.cancel_preview).toHaveLength(2);
    expect((await preview(q!.id, { option: "wa_cover_confirm" })).status).toBe(400); // 唔屬於選項
    expect(await prisma.shiftRecord.count({ where: { source: "whatsapp" } })).toBe(0);
    expect((await confirm(q!.id, { option: "wa_use_whatsapp" })).status).toBe(200);
    expect((await prisma.shiftRecord.findUniqueOrThrow({ where: { id: recB.id } })).status).toBe("cancelled");
    expect((await prisma.shiftRecord.findUniqueOrThrow({ where: { id: recDA.id } })).status).toBe("cancelled");
    expect((await recsOf(ids.gD, "2026-10-17")).filter((r) => r.status === "pending_approval")).toHaveLength(1);
  });

  it("替更者撞更：選人後先發現撞更（候選題）→ 預覽 can_confirm=false、確認 409，記錄不變", async () => {
    await mkRec(ids.gB, "2026-10-17", ids.tN);
    await mkRec(ids.gM2, "2026-10-17", ids.tA);
    await feed("c6", "阿明頂測試乙聽日夜更", coverJ("阿明", "測試乙"));
    const [q] = await qsOf("c6");
    expect(optIds(q!)).toContain("wa_cover_confirm");
    const pv = await preview(q!.id, { option: "wa_cover_confirm", guard_id: ids.gM2 });
    expect(pv.status).toBe(200);
    expect(pv.body.impact.can_confirm).toBe(false);
    expect(pv.body.writes).toBe(false);
    expect((await answer(q!.id, { option: "wa_cover_confirm", guard_id: ids.gM2 }, pv.body.preview_hash)).status).toBe(409);
    expect(await prisma.shiftRecord.count({ where: { source: "whatsapp" } })).toBe(0);
    // 揀冇撞更嗰位照寫
    expect((await confirm(q!.id, { option: "wa_cover_confirm", guard_id: ids.gM1 })).status).toBe(200);
  });

  it("同 tx 回滾：寫入替更者失敗 → 被替者該更取消亦 rollback，題仍 open", async () => {
    const recB = await mkRec(ids.gB, "2026-10-17", ids.tN);
    await feed("c7", "測試丁頂測試乙聽日夜更", coverJ("測試丁", "測試乙"));
    const [q] = await qsOf("c7");
    const pv = await preview(q!.id, { option: "wa_cover_confirm" });
    await failShiftCreateAudit();
    const res = await answer(q!.id, { option: "wa_cover_confirm" }, pv.body.preview_hash);
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect((await prisma.shiftRecord.findUniqueOrThrow({ where: { id: recB.id } })).status).toBe("confirmed");
    expect(await voidAudit(recB.id)).toHaveLength(0);
    expect(await prisma.shiftRecord.count({ where: { source: "whatsapp" } })).toBe(0);
    expect((await prisma.triageQuestion.findUniqueOrThrow({ where: { id: q!.id } })).status).toBe("open");
  });

  it("權限：取消舊記錄要『更表:void』（缺→403，記錄不變）；會計 403", async () => {
    const recB = await mkRec(ids.gB, "2026-10-17", ids.tN);
    await feed("c8", "測試丁頂測試乙聽日夜更", coverJ("測試丁", "測試乙"));
    const [q] = await qsOf("c8");
    const ck = await asManagerOwner(q!, ["void"]);
    expect((await preview(q!.id, { option: "wa_cover_confirm" }, ck)).status).toBe(403);
    expect((await answer(q!.id, { option: "wa_cover_confirm" }, "0".repeat(64), ck)).status).toBe(403);
    expect((await prisma.shiftRecord.findUniqueOrThrow({ where: { id: recB.id } })).status).toBe("confirmed");
    // 冇 void 都可以揀『只加替更者』
    expect((await preview(q!.id, { option: "wa_cover_add_only" }, ck)).status).toBe(200);
    const acc = await sessionCookieForUser(fx.userIds["會計"]);
    expect((await preview(q!.id, { option: "wa_cover_confirm" }, acc)).status).toBe(403);
  });

  it("日子唔肯定 → 先答日子 → 下一題係 wa_cover（唔會因輪次變 wa_unparsed）→ 確認寫入", async () => {
    await mkRec(ids.gB, "2026-10-17", ids.tN);
    await feed("c9", "測試丁頂測試乙今晚夜更", coverJ("測試丁", "測試乙", { date: { raw: "今晚", kind: "relative" } }), 13 * 3600);
    const [q1] = await qsOf("c9");
    expect(q1!.kind).toBe("wa_date_ambiguous");
    const r1 = await confirm(q1!.id, { option: "wa_set_date", value: "2026-10-17" });
    expect(r1.status).toBe(200);
    expect(r1.body.result.next_kind).toBe("wa_cover");
    const qs = await qsOf("c9");
    const q2 = qs.find((x) => x.status === "open")!;
    expect(q2.kind).toBe("wa_cover");
    expect(evidence(q2).round).toBe(2);
    expect(evidence(q2).cover?.replaced_record_ids).toHaveLength(1);
    expect((await confirm(q2.id, { option: "wa_cover_confirm" })).status).toBe(200);
    expect((await recsOf(ids.gD, "2026-10-17"))[0]).toMatchObject({ status: "pending_approval", source: "whatsapp" });
  });

  it("鎖月 → 答題 400 固定字串，題保持 open", async () => {
    await mkRec(ids.gB, "2026-10-17", ids.tN);
    await feed("c10", "測試丁頂測試乙聽日夜更", coverJ("測試丁", "測試乙"));
    const [q] = await qsOf("c10");
    await prisma.monthClose.create({ data: { month: MONTH, lockedAt: new Date(), createdBy: "test:w4" } });
    const r = await preview(q!.id, { option: "wa_cover_confirm" });
    expect(r.status).toBe(400);
    expect((await prisma.triageQuestion.findUniqueOrThrow({ where: { id: q!.id } })).status).toBe("open");
  });

  it("batch-accept 唔收 wa_cover／wa_cancel：preview 唔列；直接 POST → skipped(no_suggestion)", async () => {
    await mkRec(ids.gB, "2026-10-17", ids.tN);
    await mkRec(ids.gA, "2026-10-17", ids.tA);
    await feed("c11", "測試丁頂測試乙聽日夜更", coverJ("測試丁", "測試乙"));
    await feed("c11b", "我聽日唔返", cancelJ(), 700);
    const [cq] = await qsOf("c11");
    const [xq] = await qsOf("c11b");
    expect(cq!.kind).toBe("wa_cover");
    expect(xq!.kind).toBe("wa_cancel");
    const pvRes = await batchPreviewGet(get("/api/triage/questions/batch-accept/preview?month=2026-10"));
    expect(((await pvRes.json()) as { items: unknown[] }).items).toHaveLength(0);
    const res = await batchPost(post("/api/triage/questions/batch-accept", { question_ids: [cq!.id, xq!.id] }));
    const out = (await res.json()) as { results: Array<{ status: string; reason: string }> };
    expect(out.results.map((r) => [r.status, r.reason])).toEqual([["skipped", "no_suggestion"], ["skipped", "no_suggestion"]]);
    expect(await prisma.shiftRecord.count({ where: { source: "whatsapp" } })).toBe(0);
  });

  it("對照頁 API：cover 顯示被替者配對／該更數；cancel 顯示將取消記錄數", async () => {
    await mkRec(ids.gB, "2026-10-17", ids.tN);
    await mkRec(ids.gA, "2026-10-17", ids.tA);
    await feed("c12", "測試丁頂測試乙聽日夜更", coverJ("測試丁", "測試乙"));
    await feed("c12b", "我聽日唔返", cancelJ(), 700);
    const res = await intentsGet(get("/api/whatsapp/intents?from=2026-10-01&to=2026-10-31"));
    const body = (await res.json()) as { rows: Array<Record<string, unknown>> };
    const cover = body.rows.find((r) => r.kind === "cover")!;
    const cancel = body.rows.find((r) => r.kind === "cancel")!;
    expect(cover).toMatchObject({ replaced_guard_name: "測試乙", has_replaced: true, replaced_shift_count: 1, routed: "triage" });
    expect(cancel).toMatchObject({ cancel_target_count: 1, routed: "triage" });
  });
});

// ---------------------------------------------------------------------------
describe("W4 取消（wa_cancel）：一律 Triage", () => {
  it("取消自己當日更：產 wa_cancel 題（顯示將取消嘅記錄）；『取消該更』＝cancelled（cancelled_by_whatsapp）、唔新增記錄", async () => {
    const rec = await mkRec(ids.gA, "2026-10-17", ids.tN);
    await feed("x1", "聽日唔返", cancelJ());
    const [q] = await qsOf("x1");
    expect(q).toMatchObject({ kind: "wa_cancel", status: "open" });
    expect(optIds(q!)).toEqual(["wa_cancel_apply", "wa_cancel_to_leave", "wa_manual", "skip"]);
    expect(evidence(q!).candidates.existing_record_ids).toEqual([rec.id]);
    expect((await intentsOf("x1"))[0]).toMatchObject({ routed: "triage", resultRef: q!.id });
    const [v] = await waQuestionViews([q!], { canSee: true, canWrite: true });
    expect(v!.wa.cancel_preview[0]).toContain("10 月 17 日");
    expect(v!.wa.cancel_preview[0]).toContain("N 更");
    expect((await prisma.shiftRecord.findUniqueOrThrow({ where: { id: rec.id } })).status).toBe("confirmed"); // 唔自動
    const pv = await preview(q!.id, { option: "wa_cancel_apply" });
    expect(pv.status).toBe(200);
    expect(pv.body.impact.notes.join("")).toContain("已確認"); // 已確認記錄警示
    expect((await answer(q!.id, { option: "wa_cancel_apply" }, pv.body.preview_hash)).status).toBe(200);
    expect((await prisma.shiftRecord.findUniqueOrThrow({ where: { id: rec.id } })).status).toBe("cancelled");
    expect(JSON.stringify((await voidAudit(rec.id))[0]!.after)).toContain("cancelled_by_whatsapp");
    expect(await prisma.shiftRecord.count({ where: { source: "whatsapp" } })).toBe(0);
  });

  it("改為請假（揀碼）：取消該更＋寫 leave（pending_approval、source=whatsapp）同 tx；請假碼要合法", async () => {
    const rec = await mkRec(ids.gA, "2026-10-17", ids.tN);
    await feed("x2", "聽日唔返", cancelJ());
    const [q] = await qsOf("x2");
    expect((await preview(q!.id, { option: "wa_cancel_to_leave" })).status).toBe(400);
    expect((await preview(q!.id, { option: "wa_cancel_to_leave", value: "XX" })).status).toBe(400);
    expect((await confirm(q!.id, { option: "wa_cancel_to_leave", value: "AL" })).status).toBe(200);
    const all = await recsOf(ids.gA, "2026-10-17");
    expect(all.filter((r) => r.status !== "cancelled")).toHaveLength(1);
    expect(all.find((r) => r.status !== "cancelled")).toMatchObject({ recordType: "leave", leaveCode: "AL", status: "pending_approval", source: "whatsapp" });
    expect((await voidAudit(rec.id)).length).toBe(1);
  });

  it("改為請假：寫入失敗 → 取消亦 rollback", async () => {
    // 令請假落另一個更種（A：最近用過）→ 新行 create → 觸發 audit 失敗
    const rec = await mkRec(ids.gA, "2026-10-17", ids.tN);
    await mkRec(ids.gA, "2026-10-20", ids.tA);
    await feed("x3", "聽日唔返", cancelJ());
    const [q] = await qsOf("x3");
    const pv = await preview(q!.id, { option: "wa_cancel_to_leave", value: "NL" });
    expect(pv.status).toBe(200);
    await failShiftCreateAudit();
    const res = await answer(q!.id, { option: "wa_cancel_to_leave", value: "NL" }, pv.body.preview_hash);
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect((await prisma.shiftRecord.findUniqueOrThrow({ where: { id: rec.id } })).status).toBe("confirmed");
    expect((await prisma.triageQuestion.findUniqueOrThrow({ where: { id: q!.id } })).status).toBe("open");
  });

  it("取消自己當日請假；已經係同一請假碼 → 『改為請假』當處理咗", async () => {
    const lv = await mkRec(ids.gA, "2026-10-17", ids.tA, { recordType: "leave", leaveCode: "SL", status: "pending_approval", source: "whatsapp" });
    await feed("x4", "聽日唔返", cancelJ());
    const [q] = await qsOf("x4");
    const same = await confirm(q!.id, { option: "wa_cancel_to_leave", value: "SL" });
    expect(same.status).toBe(200);
    expect((await prisma.shiftRecord.findUniqueOrThrow({ where: { id: lv.id } })).status).toBe("pending_approval");
    await feed("x4b", "聽日唔返", cancelJ(), 700);
    const q2 = (await qsOf("x4b")).find((x) => x.status === "open")!;
    expect(q2.kind).toBe("wa_cancel");
    expect((await confirm(q2.id, { option: "wa_cancel_apply" })).status).toBe(200);
    expect((await prisma.shiftRecord.findUniqueOrThrow({ where: { id: lv.id } })).status).toBe("cancelled");
  });

  it("冇可取消記錄 → wa_unparsed（只有人手／忽略／略過）", async () => {
    await feed("x5", "聽日唔返", cancelJ());
    const [q] = await qsOf("x5");
    expect(q!.kind).toBe("wa_unparsed");
    expect(optIds(q!)).toEqual(["wa_manual", "wa_ignore", "skip"]);
    expect(evidence(q!).reasons).toContain("no_cancel_target");
  });

  it("人唔確定 → 先揀人 → 下一題 wa_cancel → 取消；權限：缺『更表:void』→ 403", async () => {
    const rec = await mkRec(ids.gM1, "2026-10-17", ids.tN);
    await feed("x6", "阿明聽日唔返", cancelJ({ self_reference: false, persons: [{ raw: "阿明", role: "worker" }] }));
    const [q1] = await qsOf("x6");
    expect(q1!.kind).toBe("wa_person_ambiguous");
    const r1 = await confirm(q1!.id, { option: "wa_pick_guard", guard_id: ids.gM1 });
    expect(r1.status).toBe(200);
    expect(r1.body.result.next_kind).toBe("wa_cancel");
    const q2 = (await qsOf("x6")).find((x) => x.status === "open")!;
    expect(evidence(q2).candidates.existing_record_ids).toEqual([rec.id]);
    const ck = await asManagerOwner(q2, ["void"]);
    expect((await preview(q2.id, { option: "wa_cancel_apply" }, ck)).status).toBe(403);
    expect((await prisma.shiftRecord.findUniqueOrThrow({ where: { id: rec.id } })).status).toBe("confirmed");
    expect((await confirm(q2.id, { option: "wa_cancel_apply" })).status).toBe(200);
    expect((await prisma.shiftRecord.findUniqueOrThrow({ where: { id: rec.id } })).status).toBe("cancelled");
  });

  it("鎖月 → 400；人手處理／略過／忽略唔寫", async () => {
    const rec = await mkRec(ids.gA, "2026-10-17", ids.tN);
    await feed("x7", "聽日唔返", cancelJ());
    const [q] = await qsOf("x7");
    expect((await answer(q!.id, { option: "wa_manual" })).body.result.manual).toBe(true);
    await feed("x7b", "聽日唔返", cancelJ(), 700);
    const q2 = (await qsOf("x7b")).find((x) => x.status === "open")!;
    await prisma.monthClose.create({ data: { month: MONTH, lockedAt: new Date(), createdBy: "test:w4" } });
    expect((await preview(q2.id, { option: "wa_cancel_apply" })).status).toBe(400);
    expect((await prisma.shiftRecord.findUniqueOrThrow({ where: { id: rec.id } })).status).toBe("confirmed");
  });
});

describe("W4 過濾層：RD／SH／NPL 口語唔會被丟棄", () => {
  it("例假／公假／休假／RD／SH 連日期＋已知發訊人 → candidate", () => {
    for (const t of ["我21號例假", "22號公假", "我聽日休假", "23號 RD", "24號 SH", "25號 NPL"]) {
      expect(scoreMessage({ text: t, senderKnown: true, groupKind: "site", groupActive: true, siteAliases: [] }).decision, t).toBe("candidate");
    }
  });
});
