// WP-ONE-CLICK-AUTO（§31.3 E）：分診題 month_close_*——預填建議答案、一撳確認＝寫入、undo-auto 完全還原、
// 權限（雞頭 403／非擁有人 403／無「一鍵結算」權 403）、audit 帶來源、已鎖月份唔變、報告「自動處理摘要」＋「要你睇」。
import { describe, it, expect, beforeEach } from "vitest";
import type { Broker, Guard, ShiftType, Site } from "@prisma/client";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { AUG, SEPT, aug, sep, mkBroker, mkGuard, seedUploadWithRows } from "./lib/one-click-auto";
import { AutoCollector } from "@/lib/month-close/auto/context";
import { runAutoPricing } from "@/lib/month-close/auto/pricing";
import { runAutoSettlement } from "@/lib/month-close/auto/settlement";
import { autoResolveNeedsBoss, type NeedsBossIdentity } from "@/lib/month-close/auto/guard-match";
import { buildAutoReport } from "@/lib/month-close/auto/report";
import { stepParseHealth } from "@/lib/month-close/one-click";
import { GET as getSession } from "@/app/api/triage/sessions/[id]/route";
import { GET as listSessions } from "@/app/api/triage/sessions/route";
import { POST as previewRoute } from "@/app/api/triage/questions/[id]/preview/route";
import { POST as answerRoute } from "@/app/api/triage/questions/[id]/answer/route";
import { POST as undoRoute } from "@/app/api/month-close/one-click/[id]/undo-auto/route";
import { buildUnpricedSummary } from "@/lib/pricing/unpriced";
import { uploadRoster } from "./lib/one-click-auto";

const time = (hhmm: string) => new Date(`1970-01-01T${hhmm.slice(0, 2)}:${hhmm.slice(2)}:00.000Z`);
const req = (url: string, cookie: string, method = "GET", body?: unknown) => new Request(url, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });

describe("WP-ONE-CLICK-AUTO E：分診＋一撳確認＋撤銷", () => {
  let fx: Wp2Fixture;
  let K: Broker;
  let W: Broker;
  let guard: Guard;
  let site: Site;
  let d: ShiftType;
  const boss = () => fx.userIds["老闆"];

  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    K = await mkBroker("TK", "broker");
    W = await mkBroker("TW", "broker");
    guard = await mkGuard({ name: "測試甲" });
    site = await prisma.site.create({ data: { canonicalName: "測試分診盤", clientName: "測試分診客戶", billingModel: "per_shift", createdBy: "t" } });
    d = await prisma.shiftType.create({ data: { siteId: site.id, code: "D", startTime: time("0700"), endTime: time("1900"), hours: 12, createdBy: "t" } });
  });

  const rec = async (shiftTypeId: string, brokerId: string | null, day: number, g: Guard = guard, siteId = site.id, clientSnap: number | null = 900) =>
    prisma.shiftRecord.create({ data: { workDate: sep(day), siteId, shiftTypeId, guardId: g.id, settlementBrokerId: brokerId, operationalBrokerId: brokerId, recordType: "shift", status: "confirmed", source: "roster_upload", clientRateSnapshot: clientSnap, createdBy: "t" } });
  const card = (data: Record<string, unknown>) => prisma.rateCard.create({ data: { effectiveFrom: aug(1), effectiveTo: aug(31), billingModel: "per_shift", createdBy: "t", ...data } as never });
  async function mkRun(status: "running" | "done" = "done") {
    return prisma.monthCloseRun.create({ data: { month: SEPT, status, startedById: boss(), applyStartedAt: new Date(), finishedAt: status === "done" ? new Date() : null, reportJson: {} } });
  }
  const unpriced = async () => (await buildUnpricedSummary({ userId: boss(), baseRole: "老闆", brokerId: null } as never, SEPT)).count;

  // 兩個候選價（W、Z 同類雞頭唔一樣）→ propose
  async function proposeScenario() {
    const Z = await mkBroker("TZ", "broker");
    await card({ siteId: site.id, shiftTypeId: d.id, brokerId: W.id, guardWage: 700, effectiveFrom: sep(1), effectiveTo: null });
    await card({ siteId: site.id, shiftTypeId: d.id, brokerId: Z.id, guardWage: 650, effectiveFrom: sep(1), effectiveTo: null });
    for (let i = 1; i <= 4; i++) await rec(d.id, K.id, i);
  }

  async function sessionFor(runId: string, ctx: AutoCollector) {
    const report = await buildAutoReport(ctx, SEPT, runId);
    await prisma.monthCloseRun.update({ where: { id: runId }, data: { reportJson: JSON.parse(JSON.stringify({ auto: report })) } });
    return report;
  }
  async function loadQuestions(sessionId: string, cookie: string) {
    const res = await getSession(req(`http://x/api/triage/sessions/${sessionId}`, cookie), { params: Promise.resolve({ id: sessionId }) });
    expect(res.status).toBe(200);
    return ((await res.json()) as { questions: Array<{ id: string; kind: string; status: string; options: Array<{ id: string }>; mc: Record<string, unknown> }> }).questions;
  }
  async function answer(qid: string, cookie: string, ans: Record<string, unknown>) {
    const pv = await previewRoute(req(`http://x/api/triage/questions/${qid}/preview`, cookie, "POST", { answer: ans }), { params: Promise.resolve({ id: qid }) });
    if (pv.status !== 200) return { pv, res: pv };
    const { preview_hash } = (await pv.json()) as { preview_hash: string };
    const res = await answerRoute(req(`http://x/api/triage/questions/${qid}/answer`, cookie, "POST", { answer: ans, preview_hash }), { params: Promise.resolve({ id: qid }) });
    return { pv, res };
  }

  it("propose 價：session 擁有人＝撳一鍵嘅人；題目預填候選；一撳確認＝建卡＋補價＋audit；再答 409", async () => {
    await proposeScenario();
    const run = await mkRun();
    const ctx = new AutoCollector(run.id, SEPT, boss(), null);
    await runAutoPricing(ctx, SEPT);
    const report = await sessionFor(run.id, ctx);
    expect(report.review).toHaveLength(1);
    expect(report.review[0]!.confidence).toBe("propose");
    expect(report.review[0]!.questionId).toBeTruthy();
    const session = await prisma.triageSession.findUniqueOrThrow({ where: { id: report.triageSessionId! } });
    expect(session.sourceType).toBe("month_close");
    expect(session.sourceRef).toBe(run.id);
    expect(session.ownerUserId).toBe(boss());

    const cookie = await sessionCookieForUser(boss());
    const qs = await loadQuestions(session.id, cookie);
    expect(qs).toHaveLength(1);
    expect(qs[0]!.kind).toBe("month_close_pricing");
    expect(qs[0]!.options.map((o) => o.id)).toEqual(expect.arrayContaining(["mc_accept", "mc_price", "skip"]));
    expect(qs[0]!.mc.prefill_candidate_id).toBe("c0");

    const unpricedBefore = await unpriced();
    expect(unpricedBefore).toBe(4);
    const { pv, res } = await answer(qs[0]!.id, cookie, { option: "mc_accept" });
    expect(pv.status).toBe(200);
    expect(res.status).toBe(200);
    expect(await unpriced()).toBe(0);
    const created = await prisma.rateCard.findFirstOrThrow({ where: { source: `triage:${qs[0]!.id}` } });
    expect(created.brokerId).toBe(K.id);
    expect([700, 650]).toContain(Number(created.guardWage));
    const aud = await prisma.auditLog.findMany({ where: { tableName: "rate_cards", rowId: created.id } });
    expect(JSON.stringify(aud[0]!.after)).toContain(`triage:${qs[0]!.id}`);
    const ans = await prisma.auditLog.findMany({ where: { tableName: "triage_questions", rowId: qs[0]!.id, action: "triage_answer" } });
    expect(ans).toHaveLength(1);
    // 再答 → 409
    const again = await answerRoute(req(`http://x/api/triage/questions/${qs[0]!.id}/answer`, cookie, "POST", { answer: { option: "skip" } }), { params: Promise.resolve({ id: qs[0]!.id }) });
    expect(again.status).toBe(409);
    expect((await prisma.triageSession.findUniqueOrThrow({ where: { id: session.id } })).status).toBe("done");
  });

  it("unknown 價：自己輸入價錢（mc_price）→ 建卡補價；冇價 400；客價唔齊有提示", async () => {
    for (let i = 1; i <= 3; i++) await rec(d.id, K.id, i, guard, site.id, null);
    const run = await mkRun();
    const ctx = new AutoCollector(run.id, SEPT, boss(), null);
    await runAutoPricing(ctx, SEPT);
    const report = await sessionFor(run.id, ctx);
    expect(report.review[0]!.confidence).toBe("unknown");
    const cookie = await sessionCookieForUser(boss());
    const qs = await loadQuestions(report.triageSessionId!, cookie);
    expect(qs[0]!.options.map((o) => o.id)).not.toContain("mc_accept");
    const bad = await previewRoute(req(`http://x/api/triage/questions/${qs[0]!.id}/preview`, cookie, "POST", { answer: { option: "mc_price" } }), { params: Promise.resolve({ id: qs[0]!.id }) });
    expect(bad.status).toBe(400);
    const { res } = await answer(qs[0]!.id, cookie, { option: "mc_price", price: { client_rate: 880, guard_wage: 720, broker_fee: 10 } });
    expect(res.status).toBe(200);
    const c = await prisma.rateCard.findFirstOrThrow({ where: { siteId: site.id } });
    expect([Number(c.clientRate), Number(c.guardWage), Number(c.brokerFee), Number(c.payoutRate)]).toEqual([880, 720, 10, 730]);
    for (const r of await prisma.shiftRecord.findMany({ where: { siteId: site.id } })) expect([Number(r.clientRateSnapshot), Number(r.guardWageSnapshot), Number(r.brokerFeeSnapshot)]).toEqual([880, 720, 10]);
  });

  it("settlement 題：預填同盤最常見雞頭，一撳確認歸屬", async () => {
    const other = await mkGuard();
    for (const day of [1, 2, 3]) await rec(d.id, W.id, day, other);
    const target = await rec(d.id, null, 9);
    const run = await mkRun();
    const ctx = new AutoCollector(run.id, SEPT, boss(), null);
    await runAutoSettlement(ctx, SEPT);
    const report = await sessionFor(run.id, ctx);
    const cookie = await sessionCookieForUser(boss());
    const qs = await loadQuestions(report.triageSessionId!, cookie);
    expect(qs[0]!.kind).toBe("month_close_settlement");
    expect(qs[0]!.mc.needs_broker_pick).toBe(true);
    const { res } = await answer(qs[0]!.id, cookie, { option: "mc_accept" });
    expect(res.status).toBe(200);
    expect((await prisma.shiftRecord.findUniqueOrThrow({ where: { id: target.id } })).settlementBrokerId).toBe(W.id);
  });

  it("settlement 題：揀其他雞頭（mc_pick＋value）", async () => {
    const target = await rec(d.id, null, 9);
    const run = await mkRun();
    const ctx = new AutoCollector(run.id, SEPT, boss(), null);
    await runAutoSettlement(ctx, SEPT);
    const report = await sessionFor(run.id, ctx);
    const cookie = await sessionCookieForUser(boss());
    const qs = await loadQuestions(report.triageSessionId!, cookie);
    const { res } = await answer(qs[0]!.id, cookie, { option: "mc_pick", value: K.id });
    expect(res.status).toBe(200);
    expect((await prisma.shiftRecord.findUniqueOrThrow({ where: { id: target.id } })).settlementBrokerId).toBe(K.id);
  });

  it("site_alias 題：一撳確認＝加別名＋歸盤＋套用本月更次；「當新盤」＝建盤＋更種", async () => {
    await prisma.site.create({ data: { canonicalName: "測試海景花園大廈管理處甲", clientName: "x1", billingModel: "per_shift", createdBy: "t" } });
    const sB = await prisma.site.create({ data: { canonicalName: "測試海景花園大廈管理處乙", clientName: "x2", billingModel: "per_shift", createdBy: "t" } });
    const g = await mkGuard({ name: "測試乙", staffNo: "U90077" });
    await mkBroker("TKK", "broker");
    await uploadRoster({ siteRaw: "測試海景花園大廈管理處", month: SEPT, uploaderUserId: boss(), lines: [{ time: "0700-1900", staffNo: "U90077", name: "測試乙", broker: "TKK", codes: { 1: "D", 2: "D" } }] });
    const run = await mkRun();
    const ctx = new AutoCollector(run.id, SEPT, boss(), null);
    await stepParseHealth(SEPT, boss(), ctx);
    expect(ctx.questions.map((q) => q.kind)).toEqual(["month_close_site_alias"]);
    const report = await sessionFor(run.id, ctx);
    const cookie = await sessionCookieForUser(boss());
    const qs = await loadQuestions(report.triageSessionId!, cookie);
    // sB 預填未必，直接揀 sB 候選
    const cand = (qs[0]!.mc.candidates as Array<{ id: string; label: string }>).find((c) => c.label === sB.canonicalName)!;
    const st = await prisma.shiftType.create({ data: { siteId: sB.id, code: "D", startTime: time("0700"), endTime: time("1900"), hours: 12, createdBy: "t" } });
    const { res } = await answer(qs[0]!.id, cookie, { option: "mc_pick", candidate_id: cand.id });
    expect(res.status).toBe(200);
    const up = await prisma.rosterUpload.findFirstOrThrow({ where: { month: SEPT, siteNameRaw: "測試海景花園大廈管理處" } });
    expect(up.siteId).toBe(sB.id);
    expect((await prisma.site.findUniqueOrThrow({ where: { id: sB.id } })).aliases).toContain("測試海景花園大廈管理處");
    const recs = await prisma.shiftRecord.findMany({ where: { siteId: sB.id, guardId: g.id } });
    expect(recs).toHaveLength(2);
    expect(recs.every((r) => r.shiftTypeId === st.id)).toBe(true);
  });

  it("guard_match：auto（上月同盤同人已配對）；弱證據→分診預填；確認＝加別名並重新對數", async () => {
    const cand = await mkGuard({ name: "測試真名", staffNo: "U90055" });
    const site2 = await prisma.site.create({ data: { canonicalName: "測試配對盤", clientName: "x", billingModel: "per_shift", createdBy: "t" } });
    const st2 = await prisma.shiftType.create({ data: { siteId: site2.id, code: "D", startTime: time("0700"), endTime: time("1900"), hours: 12, createdBy: "t" } });
    // 上月同盤、更表姓名「測試舊稱」已配對到 cand（6 格）
    await seedUploadWithRows({ month: AUG, siteId: site2.id, siteNameRaw: site2.canonicalName, uploaderUserId: boss(), status: "confirmed", rows: Array.from({ length: 6 }, (_, i) => ({ day: i + 1, nameRaw: "測試舊稱", staffNoRaw: "U90099", guardId: cand.id })) });
    const other = await mkGuard({ name: "測試第二", staffNo: "U90056" });
    const items: NeedsBossIdentity[] = [
      { seq: "I001", staffNoRaw: "U90099", nameRaw: "測試舊稱", telRaw: null, siteLabels: [site2.canonicalName], cellCount: 5, candidateGuardIds: [cand.id], reason: "弱證據" },
      { seq: "I002", staffNoRaw: null, nameRaw: "測試無歷史", telRaw: null, siteLabels: [site2.canonicalName], cellCount: 3, candidateGuardIds: [other.id], reason: "弱證據" },
      { seq: "I003", staffNoRaw: null, nameRaw: "測試多候選", telRaw: null, siteLabels: [site2.canonicalName], cellCount: 2, candidateGuardIds: [cand.id, other.id], reason: "多候選" },
      // 修12：淨姓名（上月同盤同姓名已配對，但冇工號／電話硬鍵）唔 auto
      { seq: "I004", staffNoRaw: null, nameRaw: "測試舊稱", telRaw: null, siteLabels: [site2.canonicalName], cellCount: 4, candidateGuardIds: [cand.id], reason: "弱證據" },
      // 修12／13：plan 已判工號衝突，就算電話＋姓名一致都唔 auto，出分診題（預填候選）
      { seq: "I005", staffNoRaw: "U90098", nameRaw: "測試真名", telRaw: cand.tel, siteLabels: [site2.canonicalName], cellCount: 6, candidateGuardIds: [cand.id], reason: "更表工號已經屬 DB 另一位安員，同電話／名單判斷到嘅人唔一致，唔自動 link，交老闆睇" },
    ];
    const run = await mkRun();
    const ctx = new AutoCollector(run.id, SEPT, boss(), null);
    const res = await autoResolveNeedsBoss(ctx, SEPT, items);
    expect(res.autoLinked).toBe(1);
    expect(res.remaining).toBe(4);
    expect((await prisma.guard.findUniqueOrThrow({ where: { id: cand.id } })).nameAliases).toContain("測試舊稱");
    expect(await prisma.guardStaffNumber.count({ where: { number: "U90098" } })).toBe(0);
    expect(await prisma.guardStaffNumber.count({ where: { guardId: cand.id, number: "U90099" } })).toBe(1);
    const kinds = (await prisma.monthCloseAutoChange.findMany({ where: { runId: run.id } })).map((c) => c.kind).sort();
    expect(kinds).toEqual(["guard_alias_added", "guard_staffno_added"]);
    expect(ctx.questions.map((q) => [q.evidence.confidence, q.evidence.prefillCandidateId])).toEqual([["propose", "g0"], ["unknown", null], ["propose", "g0"], ["propose", "g0"]]);

    // 分診一撳確認 I002 → 加別名
    const report = await sessionFor(run.id, ctx);
    const cookie = await sessionCookieForUser(boss());
    const qs = await loadQuestions(report.triageSessionId!, cookie);
    const q2row = (await prisma.triageQuestion.findMany({ where: { sessionId: report.triageSessionId! } })).find((q) => (q.evidenceJson as { action: { identity?: { nameRaw: string } } }).action.identity?.nameRaw === "測試無歷史")!;
    const q2 = qs.find((q) => q.id === q2row.id)!;
    const { res: ar } = await answer(q2.id, cookie, { option: "mc_accept" });
    expect(ar.status).toBe(200);
    expect((await prisma.guard.findUniqueOrThrow({ where: { id: other.id } })).nameAliases).toContain("測試無歷史");
    void st2;

    // undo：auto 嗰個（I001）還原
    const undo = await undoRoute(req(`http://x/api/month-close/one-click/${run.id}/undo-auto`, cookie, "POST"), { params: Promise.resolve({ id: run.id }) });
    expect(undo.status).toBe(200);
    expect((await prisma.guard.findUniqueOrThrow({ where: { id: cand.id } })).nameAliases).not.toContain("測試舊稱");
    expect(await prisma.guardStaffNumber.count({ where: { number: "U90099" } })).toBe(0);
    // 分診答案（用戶明確確認）唔屬 auto，唔還原
    expect((await prisma.guard.findUniqueOrThrow({ where: { id: other.id } })).nameAliases).toContain("測試無歷史");
  });

  it("shift_variance 題：我已覆核（mc_ack）→ answered，唔寫資料", async () => {
    const run = await mkRun();
    const ctx = new AutoCollector(run.id, SEPT, boss(), null);
    ctx.addQuestion({
      kind: "month_close_shift_variance",
      groupKey: "variance:x",
      sort: 60,
      title: "測試更數差異",
      evidence: { v: 1, mc: true, runId: run.id, month: "2026-09-01", kind: "month_close_shift_variance", summary: "測試", suggestion: null, confidence: "unknown", action: { type: "shift_variance", siteId: site.id }, candidates: [], prefillCandidateId: null },
    });
    const report = await sessionFor(run.id, ctx);
    const cookie = await sessionCookieForUser(boss());
    const qs = await loadQuestions(report.triageSessionId!, cookie);
    const { res } = await answer(qs[0]!.id, cookie, { option: "mc_ack" });
    expect(res.status).toBe(200);
    const q = await prisma.triageQuestion.findUniqueOrThrow({ where: { id: qs[0]!.id } });
    expect(q.status).toBe("answered");
  });

  it("權限：雞頭 403；非擁有人會計 403；擁有人轉交俾無「一鍵結算」權嘅主管 → 睇得（導入分診）但答 403", async () => {
    await proposeScenario();
    const run = await mkRun();
    const ctx = new AutoCollector(run.id, SEPT, fx.userIds["會計"], null);
    await runAutoPricing(ctx, SEPT);
    const report = await sessionFor(run.id, ctx);
    const sid = report.triageSessionId!;
    const qid = (await prisma.triageQuestion.findFirstOrThrow({ where: { sessionId: sid } })).id;
    expect((await prisma.triageSession.findUniqueOrThrow({ where: { id: sid } })).ownerUserId).toBe(fx.userIds["會計"]);

    const brokerCookie = await sessionCookieForUser(fx.userIds["雞頭"]);
    const r1 = await getSession(req(`http://x/api/triage/sessions/${sid}`, brokerCookie), { params: Promise.resolve({ id: sid }) });
    expect(r1.status).toBe(403);
    const r2 = await previewRoute(req(`http://x/api/triage/questions/${qid}/preview`, brokerCookie, "POST", { answer: { option: "mc_accept" } }), { params: Promise.resolve({ id: qid }) });
    expect(r2.status).toBe(403);
    const r2b = await undoRoute(req(`http://x/api/month-close/one-click/${run.id}/undo-auto`, brokerCookie, "POST"), { params: Promise.resolve({ id: run.id }) });
    expect(r2b.status).toBe(403);

    // 主管（非擁有人）：睇唔到人哋嘅 session
    const supCookie = await sessionCookieForUser(fx.userIds["主管"]);
    const r3 = await getSession(req(`http://x/api/triage/sessions/${sid}`, supCookie), { params: Promise.resolve({ id: sid }) });
    expect(r3.status).toBe(403);
    const r3b = await undoRoute(req(`http://x/api/month-close/one-click/${run.id}/undo-auto`, supCookie, "POST"), { params: Promise.resolve({ id: run.id }) });
    expect(r3b.status).toBe(403);

    // 老闆將 session 轉交主管：主管睇得，但答要「一鍵結算」權 → 403
    await prisma.triageSession.update({ where: { id: sid }, data: { ownerUserId: fx.userIds["主管"] } });
    const r4 = await getSession(req(`http://x/api/triage/sessions/${sid}`, supCookie), { params: Promise.resolve({ id: sid }) });
    expect(r4.status).toBe(200);
    const r5 = await previewRoute(req(`http://x/api/triage/questions/${qid}/preview`, supCookie, "POST", { answer: { option: "mc_accept" } }), { params: Promise.resolve({ id: qid }) });
    expect(r5.status).toBe(403);
    expect(await prisma.rateCard.count({ where: { source: { startsWith: "triage:" } } })).toBe(0);

    // 擁有人會計自己（有權）→ 通過；自己 list 見到呢條
    await prisma.triageSession.update({ where: { id: sid }, data: { ownerUserId: fx.userIds["會計"] } });
    const acctCookie = await sessionCookieForUser(fx.userIds["會計"]);
    const lst = await listSessions(req("http://x/api/triage/sessions?mine=1", acctCookie));
    expect(lst.status).toBe(200);
    const body = (await lst.json()) as { sessions: Array<{ id: string; source_type: string }>; open_total: number };
    expect(body.sessions.find((s) => s.id === sid)?.source_type).toBe("month_close");
    expect(body.open_total).toBeGreaterThanOrEqual(1);
  });

  it("undo-auto：價卡作廢＋價 snapshot 還原＋alias 移除＋更種作廢（冇更次用緊先准）＋結算還原＋open 分診題作廢；全部 audit；冪等", async () => {
    // 準備：新盤（含更種、alias）＋ auto 價卡 ＋ auto 結算
    await mkBroker("TKK", "broker");
    const gNew = await mkGuard({ name: "測試新盤人", staffNo: "U90066" });
    await uploadRoster({ siteRaw: "測試撤銷新盤", month: SEPT, uploaderUserId: boss(), lines: [{ time: "0700-1900", staffNo: "U90066", name: "測試新盤人", broker: "TKK", codes: { 1: "D" } }] });
    const exact = await prisma.site.create({ data: { canonicalName: "測試撤銷現有盤 (上)", clientName: "x", billingModel: "per_shift", createdBy: "t" } });
    await uploadRoster({ siteRaw: "測試撤銷現有盤（上）", month: SEPT, uploaderUserId: boss(), lines: [{ time: "0700-1900", staffNo: "U90066", name: "測試新盤人", broker: "TKK", codes: { 2: "D" } }] });
    await card({ siteId: site.id, shiftTypeId: d.id, brokerId: K.id, clientRate: 900, guardWage: 700, brokerFee: 20 });
    for (let i = 1; i <= 3; i++) await rec(d.id, K.id, i, guard, site.id, null);
    const gDef = await mkGuard({ defaultBrokerId: W.id });
    const setRec = await rec(d.id, null, 20, gDef);
    const run = await mkRun("running");
    const ctx = new AutoCollector(run.id, SEPT, boss(), null);
    await stepParseHealth(SEPT, boss(), ctx);
    await runAutoSettlement(ctx, SEPT);
    await runAutoPricing(ctx, SEPT);
    await prisma.monthCloseRun.update({ where: { id: run.id }, data: { status: "done" } });
    await sessionFor(run.id, ctx);
    const autoCard = await prisma.rateCard.findFirstOrThrow({ where: { source: `auto:one-click:${run.id}`, siteId: site.id } });
    expect(await unpriced()).toBeLessThanOrEqual(1);
    expect((await prisma.shiftRecord.findUniqueOrThrow({ where: { id: setRec.id } })).settlementBrokerId).toBe(W.id);
    expect((await prisma.site.findUniqueOrThrow({ where: { id: exact.id } })).aliases).toContain("測試撤銷現有盤（上）");
    const newSite = await prisma.site.findUniqueOrThrow({ where: { canonicalName: "測試撤銷新盤" } });
    const newSt = await prisma.shiftType.findFirstOrThrow({ where: { siteId: newSite.id } });
    void gNew;

    const cookie = await sessionCookieForUser(boss());
    const res = await undoRoute(req(`http://x/api/month-close/one-click/${run.id}/undo-auto`, cookie, "POST"), { params: Promise.resolve({ id: run.id }) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { undone: Record<string, number>; skipped: Array<{ kind: string; reason: string }>; already_undone: boolean };
    expect(body.undone.rate_cards).toBe(1);
    expect(body.undone.price_snapshots).toBe(3);
    expect(body.undone.settlement).toBe(1);
    expect(body.undone.site_aliases).toBe(1);

    // 價卡作廢＋價 snapshot 還原為 null
    expect((await prisma.rateCard.findUniqueOrThrow({ where: { id: autoCard.id } })).voidedAt).not.toBeNull();
    for (const r of await prisma.shiftRecord.findMany({ where: { siteId: site.id, guardId: guard.id } })) expect([r.clientRateSnapshot, r.guardWageSnapshot, r.brokerFeeSnapshot]).toEqual([null, null, null]);
    // 結算還原、alias 移除
    expect((await prisma.shiftRecord.findUniqueOrThrow({ where: { id: setRec.id } })).settlementBrokerId).toBeNull();
    expect((await prisma.site.findUniqueOrThrow({ where: { id: exact.id } })).aliases).not.toContain("測試撤銷現有盤（上）");
    // 新盤更種：因為上載嘅更次已寫入？本測試冇跑 reconcile → 冇更次用緊 → 作廢
    expect((await prisma.shiftType.findUniqueOrThrow({ where: { id: newSt.id } })).voidedAt).not.toBeNull();
    expect(body.skipped.find((s) => s.kind === "shift_type_created")).toBeUndefined();
    // 舊卡（人手卡）唔郁
    expect((await prisma.rateCard.findFirstOrThrow({ where: { siteId: site.id, source: null } })).voidedAt).toBeNull();
    // audit
    const voidAudit = await prisma.auditLog.findMany({ where: { tableName: "rate_cards", rowId: autoCard.id, action: "void" } });
    expect(JSON.stringify(voidAudit[0]!.after)).toContain(`undo:one-click:${run.id}`);
    // 報告標記已還原、分診題作廢
    const after = await prisma.monthCloseRun.findUniqueOrThrow({ where: { id: run.id } });
    expect((after.reportJson as { auto: { undone: boolean } }).auto.undone).toBe(true);
    expect(await prisma.triageQuestion.count({ where: { session: { sourceRef: run.id }, status: "open" } })).toBe(0);
    // 冪等
    const again = await undoRoute(req(`http://x/api/month-close/one-click/${run.id}/undo-auto`, cookie, "POST"), { params: Promise.resolve({ id: run.id }) });
    const b2 = (await again.json()) as { already_undone: boolean; undone: Record<string, number> };
    expect(b2.already_undone).toBe(true);
    expect(Object.values(b2.undone)).toHaveLength(0);
  });

  it("undo-auto：更種仍有更次用緊 → 唔作廢（skipped）；已鎖月份 409 唔變；running 409", async () => {
    await mkBroker("TKK", "broker");
    await mkGuard({ name: "測試新盤人", staffNo: "U90066" });
    await uploadRoster({ siteRaw: "測試撤銷新盤2", month: SEPT, uploaderUserId: boss(), lines: [{ time: "0700-1900", staffNo: "U90066", name: "測試新盤人", broker: "TKK", codes: { 1: "D" } }] });
    const run = await mkRun("running");
    const ctx = new AutoCollector(run.id, SEPT, boss(), null);
    await stepParseHealth(SEPT, boss(), ctx);
    const newSite = await prisma.site.findUniqueOrThrow({ where: { canonicalName: "測試撤銷新盤2" } });
    const newSt = await prisma.shiftType.findFirstOrThrow({ where: { siteId: newSite.id } });
    const g = await prisma.guard.findFirstOrThrow({ where: { staffNo: "U90066" } });
    await prisma.shiftRecord.create({ data: { workDate: sep(1), siteId: newSite.id, shiftTypeId: newSt.id, guardId: g.id, recordType: "shift", status: "confirmed", source: "roster_upload", createdBy: "t" } });
    const cookie = await sessionCookieForUser(boss());
    const r0 = await undoRoute(req(`http://x/api/month-close/one-click/${run.id}/undo-auto`, cookie, "POST"), { params: Promise.resolve({ id: run.id }) });
    expect(r0.status).toBe(409); // running
    await prisma.monthCloseRun.update({ where: { id: run.id }, data: { status: "done" } });
    await prisma.monthClose.create({ data: { month: SEPT, lockedAt: new Date(), lockedBy: boss(), createdBy: "t" } });
    const r1 = await undoRoute(req(`http://x/api/month-close/one-click/${run.id}/undo-auto`, cookie, "POST"), { params: Promise.resolve({ id: run.id }) });
    expect(r1.status).toBe(409);
    expect((await prisma.shiftType.findUniqueOrThrow({ where: { id: newSt.id } })).voidedAt).toBeNull();
    await prisma.monthClose.deleteMany({ where: { month: SEPT } });
    const r2 = await undoRoute(req(`http://x/api/month-close/one-click/${run.id}/undo-auto`, cookie, "POST"), { params: Promise.resolve({ id: run.id }) });
    expect(r2.status).toBe(200);
    const b = (await r2.json()) as { skipped: Array<{ kind: string; reason: string }> };
    expect(b.skipped.map((s) => s.kind)).toEqual(["shift_type_created"]);
    expect(b.skipped[0]!.reason).toContain("仍然有 1 更用緊");
    expect((await prisma.shiftType.findUniqueOrThrow({ where: { id: newSt.id } })).voidedAt).toBeNull();
  });

  it("已鎖月份：答分診題 409，唔建卡", async () => {
    await proposeScenario();
    const run = await mkRun();
    const ctx = new AutoCollector(run.id, SEPT, boss(), null);
    await runAutoPricing(ctx, SEPT);
    const report = await sessionFor(run.id, ctx);
    await prisma.monthClose.create({ data: { month: SEPT, lockedAt: new Date(), lockedBy: boss(), createdBy: "t" } });
    const cookie = await sessionCookieForUser(boss());
    const qid = (await prisma.triageQuestion.findFirstOrThrow({ where: { sessionId: report.triageSessionId! } })).id;
    const pv = await previewRoute(req(`http://x/api/triage/questions/${qid}/preview`, cookie, "POST", { answer: { option: "mc_accept" } }), { params: Promise.resolve({ id: qid }) });
    expect(pv.status).toBe(409);
    expect(await prisma.rateCard.count({ where: { source: { startsWith: "triage:" } } })).toBe(0);
    expect(AUG).toBeTruthy();
  });

  it("重新執行同一個 run：已答題保留、open 題刷新、唔再出現嘅 open 題作廢", async () => {
    await proposeScenario();
    const run = await mkRun();
    let ctx = new AutoCollector(run.id, SEPT, boss(), null);
    await runAutoPricing(ctx, SEPT);
    const r1 = await sessionFor(run.id, ctx);
    const qid = (await prisma.triageQuestion.findFirstOrThrow({ where: { sessionId: r1.triageSessionId! } })).id;
    ctx = new AutoCollector(run.id, SEPT, boss(), null);
    await runAutoPricing(ctx, SEPT);
    const r2 = await sessionFor(run.id, ctx);
    expect(r2.triageSessionId).toBe(r1.triageSessionId);
    expect(await prisma.triageQuestion.count({ where: { sessionId: r1.triageSessionId!, status: "open" } })).toBe(1);
    expect((await prisma.triageQuestion.findFirstOrThrow({ where: { sessionId: r1.triageSessionId! } })).id).toBe(qid);
    // 之後問題已經解決（人手補卡），再跑 → 題目作廢
    await prisma.shiftRecord.updateMany({ where: { siteId: site.id }, data: { guardWageSnapshot: 700, brokerFeeSnapshot: 0 } });
    ctx = new AutoCollector(run.id, SEPT, boss(), null);
    await runAutoPricing(ctx, SEPT);
    await sessionFor(run.id, ctx);
    expect((await prisma.triageQuestion.findUniqueOrThrow({ where: { id: qid } })).status).toBe("superseded");
  });

  it("修8：並發答同一題——只一個成功、DB 只得一張卡；寫失敗退返 open；新 run 作廢舊 run 同月 open 題", async () => {
    await proposeScenario();
    const run = await mkRun();
    const ctx = new AutoCollector(run.id, SEPT, boss(), null);
    await runAutoPricing(ctx, SEPT);
    const report = await sessionFor(run.id, ctx);
    const cookie = await sessionCookieForUser(boss());
    const qid = (await prisma.triageQuestion.findFirstOrThrow({ where: { sessionId: report.triageSessionId! } })).id;
    const ans = { option: "mc_accept" };
    const pv = await previewRoute(req(`http://x/p`, cookie, "POST", { answer: ans }), { params: Promise.resolve({ id: qid }) });
    const { preview_hash } = (await pv.json()) as { preview_hash: string };
    const go = () => answerRoute(req(`http://x/a`, cookie, "POST", { answer: ans, preview_hash }), { params: Promise.resolve({ id: qid }) });
    const results = await Promise.all([go(), go(), go()]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(2);
    expect(await prisma.rateCard.count({ where: { source: { startsWith: "triage:" } } })).toBe(1);

    // 新 run 作廢舊 run 同月 open 題
    const run2 = await mkRun();
    await prisma.rateCard.updateMany({ data: { voidedAt: new Date() } });
    await prisma.shiftRecord.updateMany({ data: { guardWageSnapshot: null, brokerFeeSnapshot: null } });
    const ctx2 = new AutoCollector(run2.id, SEPT, boss(), null);
    await runAutoPricing(ctx2, SEPT);
    const r2 = await sessionFor(run2.id, ctx2);
    expect(r2.triageSessionId).not.toBe(report.triageSessionId);
    const run3 = await mkRun();
    const ctx3 = new AutoCollector(run3.id, SEPT, boss(), null);
    await runAutoPricing(ctx3, SEPT);
    await sessionFor(run3.id, ctx3);
    expect(await prisma.triageQuestion.count({ where: { sessionId: r2.triageSessionId!, status: "open" } })).toBe(0);
    expect(await prisma.triageQuestion.count({ where: { sessionId: r2.triageSessionId!, status: "superseded" } })).toBeGreaterThan(0);
  });

  it("修8：寫入失敗 → 題目退返 open（可 retry）", async () => {
    for (let i = 1; i <= 3; i++) await rec(d.id, K.id, i, guard, site.id, null);
    const run = await mkRun();
    const ctx = new AutoCollector(run.id, SEPT, boss(), null);
    await runAutoPricing(ctx, SEPT);
    const report = await sessionFor(run.id, ctx);
    const cookie = await sessionCookieForUser(boss());
    const qid = (await prisma.triageQuestion.findFirstOrThrow({ where: { sessionId: report.triageSessionId! } })).id;
    const ans = { option: "mc_price", price: { client_rate: 880, guard_wage: 720 } };
    const pv = await previewRoute(req(`http://x/p`, cookie, "POST", { answer: ans }), { params: Promise.resolve({ id: qid }) });
    const { preview_hash } = (await pv.json()) as { preview_hash: string };
    // 令寫入失敗：預覽之後鎖月以外嘅方式——直接令 rate_cards 唔可寫（刪咗個 site 嘅 shift type 引用會 FK 失敗）
    const before = await prisma.triageQuestion.findUniqueOrThrow({ where: { id: qid } });
    const { SimpleWriter } = await import("@/lib/month-close/auto/context");
    const spy = (await import("vitest")).vi.spyOn(SimpleWriter.prototype, "audit").mockRejectedValueOnce(new Error("boom")); // 建卡後 audit 失敗＝寫到一半死
    const res = await answerRoute(req(`http://x/a`, cookie, "POST", { answer: ans, preview_hash }), { params: Promise.resolve({ id: qid }) });
    spy.mockRestore();
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect((await prisma.triageQuestion.findUniqueOrThrow({ where: { id: qid } })).status).toBe(before.status);
    const ok = await answerRoute(req(`http://x/a`, cookie, "POST", { answer: ans, preview_hash }), { params: Promise.resolve({ id: qid }) });
    expect(ok.status).toBe(200);
    expect(await prisma.rateCard.count({ where: { source: `triage:${qid}` } })).toBe(1); // retry 重用咗已建嗰張，冇重複
  });
});
