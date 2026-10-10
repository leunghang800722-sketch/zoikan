// WP-POSTORDER-FREE（§34）：由 Postorder 一次過補齊價目卡（A）、盤預設雞頭（B）、報告「冇 Postorder 都計到嘅比例」（C）。
// 全部合成資料：盤名「測試補齊X」、雞頭代號 TK／TW、Postorder 係合成 CSV，冇 PII。
import { describe, it, expect, beforeEach } from "vitest";
import { Client } from "pg";
import fs from "node:fs";
import path from "node:path";
import type { Broker, Guard } from "@prisma/client";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { SEPT, sep, mkBroker, mkGuard, seedPostorder, postorderCsv, rosterCsv } from "./lib/one-click-auto";
import { AutoCollector } from "@/lib/month-close/auto/context";
import { runAutoPricing } from "@/lib/month-close/auto/pricing";
import { runAutoSettlement } from "@/lib/month-close/auto/settlement";
import { buildAutoReport } from "@/lib/month-close/auto/report";
import { stepPricingCheck } from "@/lib/month-close/one-click";
import { buildUnpricedSummary } from "@/lib/pricing/unpriced";
import { ensureAiRole, AI_RO_ROLE } from "../scripts/db/ensure-ai-role";
import { POST as backfillRoute, GET as backfillStatusRoute } from "@/app/api/rate-cards/backfill-from-postorder/route";
import { GET as getSession } from "@/app/api/triage/sessions/[id]/route";
import { POST as previewRoute } from "@/app/api/triage/questions/[id]/preview/route";
import { POST as answerRoute } from "@/app/api/triage/questions/[id]/answer/route";
import { POST as undoBackfillRoute } from "@/app/api/triage/questions/[id]/undo-backfill/route";
import { PATCH as patchSite } from "@/app/api/sites/[id]/route";
import { GET as listSites } from "@/app/api/sites/route";
import { GET as suggestRoute } from "@/app/api/sites/[id]/default-broker-suggestion/route";

const time = (hhmm: string) => new Date(`1970-01-01T${hhmm.slice(0, 2)}:${hhmm.slice(2)}:00.000Z`);
const req = (url: string, cookie: string, method = "GET", body?: unknown) => new Request(url, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUV".split(""); // 22 個盤：A–L 自動卡、M–S Postorder 有價但未定價（propose）、T–V 冇參考

describe("WP-POSTORDER-FREE A＋C：補齊價目卡＋報告比例（合成 9 月形狀）", () => {
  let fx: Wp2Fixture;
  let W: Broker;
  let guard: Guard;
  let boss: string;
  let bossCookie: string;
  const siteName = (l: string) => `測試補齊${l}`;

  beforeEach(async () => {
    await clearAll();
    // clearAll 唔清 triage 表；補齊 session 一個月一個（source_ref=2026-09），逐 test 清走先唔會撈到上一個 test 嘅題。
    await prisma.triageQuestion.deleteMany({ where: { session: { sourceType: "postorder_backfill" } } });
    await prisma.triageSession.deleteMany({ where: { sourceType: "postorder_backfill" } });
    fx = await seedWp2Fixture();
    boss = fx.userIds["老闆"];
    bossCookie = await sessionCookieForUser(boss);
    W = await mkBroker("TW", "broker");
    await mkBroker("TK", "broker"); // Postorder 專屬行嘅尾 token 要對得上一個雞頭先會被當「其他雞頭行」
    guard = await mkGuard();
  });

  async function mkSiteWithRecords(name: string, days = 3, brokerId: string | null = W.id) {
    const site = await prisma.site.create({ data: { canonicalName: name, clientName: `${name}客戶`, billingModel: "per_shift", createdBy: "t" } });
    const d = await prisma.shiftType.create({ data: { siteId: site.id, code: "D", startTime: time("0700"), endTime: time("1900"), hours: 12, createdBy: "t" } });
    for (let i = 1; i <= days; i++) {
      await prisma.shiftRecord.create({ data: { workDate: sep(i), siteId: site.id, shiftTypeId: d.id, guardId: guard.id, settlementBrokerId: brokerId, operationalBrokerId: brokerId, recordType: "shift", status: "confirmed", source: "roster_upload", createdBy: "t" } });
    }
    return { site, d };
  }

  /** 9 月形狀：A–L（12 組）Postorder 單一價 → 一鍵 auto 卡；M–S（7 組）Postorder 有泛用價但同崗位有 TK 專屬行 → propose（未定價）；T–V（3 組）冇參考。 */
  async function seedSeptShape() {
    const lines: Parameters<typeof postorderCsv>[0] = [];
    for (const l of LETTERS.slice(0, 12)) lines.push({ label: siteName(l), prop: l, shift: "Day", client: 900, payout: 700, time: "0700-1900", total: 3 });
    for (const l of LETTERS.slice(12, 19)) {
      lines.push({ label: siteName(l), prop: l, shift: "Day", client: 900, payout: 700, time: "0700-1900", total: 3 });
      lines.push({ label: `${siteName(l)} TK`, prop: l, shift: "Day", client: 900, payout: 650, time: "0700-1900", total: 3 });
    }
    await seedPostorder(SEPT, boss, { postorderCsv: postorderCsv(lines) });
    const sites: Record<string, { id: string }> = {};
    for (const l of LETTERS) sites[l] = (await mkSiteWithRecords(siteName(l))).site;
    const run1 = await prisma.monthCloseRun.create({ data: { month: SEPT, status: "running", startedById: boss, applyStartedAt: new Date() } });
    const ctx1 = new AutoCollector(run1.id, SEPT, boss, null);
    const pr = await runAutoPricing(ctx1, SEPT);
    await stepPricingCheck(SEPT, boss, ctx1);
    await prisma.monthCloseRun.update({ where: { id: run1.id }, data: { status: "done", finishedAt: new Date() } });
    return { run1, ctx1, pr, sites };
  }

  async function sessionQuestions(sessionId: string) {
    const res = await getSession(req(`http://x/api/triage/sessions/${sessionId}`, bossCookie), { params: Promise.resolve({ id: sessionId }) });
    expect(res.status).toBe(200);
    return (await res.json()) as { session: { source_type: string; status: string }; questions: Array<{ id: string; kind: string; status: string; title: string; options: Array<{ id: string }>; mc: { action_type: string; prefill_candidate_id: string | null; candidates: Array<{ evidence: string | null }> } }> };
  }
  async function answer(qid: string, ans: Record<string, unknown>, cookie = bossCookie) {
    const pv = await previewRoute(req(`http://x/api/triage/questions/${qid}/preview`, cookie, "POST", { answer: ans }), { params: Promise.resolve({ id: qid }) });
    if (pv.status !== 200) return { pv, res: pv };
    const { preview_hash } = (await pv.json()) as { preview_hash: string };
    const res = await answerRoute(req(`http://x/api/triage/questions/${qid}/answer`, cookie, "POST", { answer: ans, preview_hash }), { params: Promise.resolve({ id: qid }) });
    return { pv, res };
  }
  const callBackfill = async (cookie = bossCookie, month = "2026-09") => backfillRoute(req("http://x/api/rate-cards/backfill-from-postorder", cookie, "POST", { month }));
  const unpricedCount = async () => (await buildUnpricedSummary({ userId: boss, baseRole: "老闆", brokerId: null } as never, SEPT)).count;

  it("前置：一鍵自動定價出 12 張 auto 卡（次序 2）＋7 題 propose＋3 組冇參考；報告 postorderDependency 同 journal 一致", async () => {
    const { run1, ctx1, pr } = await seedSeptShape();
    expect(pr.autoGroups).toBe(12);
    expect(pr.proposeGroups).toBe(7);
    expect(pr.unknownGroups).toBe(3);
    expect(await prisma.rateCard.count({ where: { source: { startsWith: "auto:one-click:" }, voidedAt: null } })).toBe(12);
    expect(await unpricedCount()).toBe(30); // 7×3＋3×3
    const report = await buildAutoReport(ctx1, SEPT, run1.id);
    const dep = report.summary.postorderDependency!;
    expect(dep.pricing.total).toBe(66);
    expect(dep.pricing.unpriced).toBe(30);
    expect(dep.pricing.byStep["2"]).toBe(36);
    expect(dep.pricing.byStep["1"] + dep.pricing.byStep["3"] + dep.pricing.byStep["4"] + dep.pricing.byStep["5"]).toBe(0);
    expect(dep.pricing.byStep.existing).toBe(0);
    expect(dep.pricing.withoutPostorder).toBe(0);
    // 同 journal 逐更統計一致
    const j = await prisma.monthCloseAutoChange.findMany({ where: { runId: run1.id, kind: "price_snapshots" } });
    const ids = new Set(j.flatMap((x) => ((x.detailJson as { rows: Array<{ id: string }> }).rows ?? []).map((r) => r.id)));
    expect(ids.size).toBe(dep.pricing.byStep["2"]);
    expect(dep.settlement.total).toBe(66);
    expect(dep.settlement.byReason.roster).toBe(66);
    expect(dep.settlement.byReason.unresolved).toBe(0);
    expect(dep.settlement.withoutPostorder).toBe(66);
  });

  it("A：backfill 出 19 題（12 自動卡＋7 Postorder）；全部確認 → 19 張 triage 卡、12 張 auto 卡 void；再跑一鍵 0 靠 Postorder；再 backfill 0 題", async () => {
    const { run1, ctx1 } = await seedSeptShape();
    await buildAutoReport(ctx1, SEPT, run1.id);
    const res = await callBackfill();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { session_id: string; created: number; skipped_existing: number; from_auto_cards: number; from_postorder: number };
    expect(body.created).toBe(19);
    expect(body.skipped_existing).toBe(0);
    expect(body.from_auto_cards).toBe(12);
    expect(body.from_postorder).toBe(7);
    // 只出題，冇寫任何價
    expect(await prisma.rateCard.count({ where: { source: { startsWith: "triage:" } } })).toBe(0);
    expect(await prisma.rateCard.count({ where: { source: { startsWith: "auto:one-click:" }, voidedAt: null } })).toBe(12);
    expect(await unpricedCount()).toBe(30);
    const sess = await prisma.triageSession.findUniqueOrThrow({ where: { id: body.session_id } });
    expect(sess.sourceType).toBe("postorder_backfill");
    expect(sess.sourceRef).toBe("2026-09");
    expect(sess.ownerUserId).toBe(boss);
    const { questions, session } = await sessionQuestions(body.session_id);
    expect(session.source_type).toBe("postorder_backfill");
    expect(questions).toHaveLength(19);
    expect(questions.every((q) => q.kind === "month_close_pricing" && q.mc.action_type === "pricing" && q.mc.prefill_candidate_id === "c0")).toBe(true);
    expect(questions.filter((q) => (q.mc.candidates[0]?.evidence ?? "").includes("一鍵自動卡")).length).toBe(12);
    expect(questions.filter((q) => (q.mc.candidates[0]?.evidence ?? "").includes("第")).length).toBeGreaterThanOrEqual(7);
    // 冪等：再跑 0 新題
    const again = (await (await callBackfill()).json()) as { created: number; skipped_existing: number; session_id: string };
    expect(again.created).toBe(0);
    expect(again.skipped_existing).toBe(19);
    expect(again.session_id).toBe(body.session_id);

    // 逐題一撳確認
    for (const q of questions) {
      const { res: r } = await answer(q.id, { option: "mc_accept" });
      expect(r.status, q.title).toBe(200);
    }
    const triageCards = await prisma.rateCard.findMany({ where: { source: { startsWith: "triage:" }, voidedAt: null } });
    expect(triageCards).toHaveLength(19);
    expect(triageCards.every((c) => c.effectiveFrom.toISOString().slice(0, 10) === "2026-09-01" && c.effectiveTo === null && c.confidence === "confirmed")).toBe(true);
    const autoCards = await prisma.rateCard.findMany({ where: { source: { startsWith: "auto:one-click:" } } });
    expect(autoCards).toHaveLength(12);
    expect(autoCards.every((c) => c.voidedAt !== null)).toBe(true);
    // journal 存喺題目 apply_result_json
    const answered = await prisma.triageQuestion.findMany({ where: { sessionId: body.session_id, status: "answered" } });
    expect(answered).toHaveLength(19);
    expect(answered.filter((q) => (q.applyResultJson as { backfill?: { voided_card_id: string | null } }).backfill?.voided_card_id).length).toBe(12);
    // 一鍵結算 M–S 嘅 open 定價題被取代（唔會重複答）
    const mcOpen = await prisma.triageQuestion.count({ where: { session: { sourceType: "month_close" }, status: "open", kind: "month_close_pricing" } });
    expect(mcOpen).toBe(3); // 只剩 T–V 冇參考嗰 3 題
    // 價錢：M–S 補到價；只剩 T–V（9 更）未定價
    expect(await unpricedCount()).toBe(9);

    // 再跑一鍵（run2）：自動定價只剩冇參考嗰 3 組，auto 卡 0 張新建
    const run2 = await prisma.monthCloseRun.create({ data: { month: SEPT, status: "running", startedById: boss, applyStartedAt: new Date() } });
    const ctx2 = new AutoCollector(run2.id, SEPT, boss, null);
    const pr2 = await runAutoPricing(ctx2, SEPT);
    expect(pr2.groups).toBe(3);
    expect(pr2.autoGroups).toBe(0);
    expect(pr2.proposeGroups).toBe(0);
    expect(pr2.unknownGroups).toBe(3);
    expect(ctx2.summary.cardsCreated).toBe(0);
    await stepPricingCheck(SEPT, boss, ctx2);
    const report2 = await buildAutoReport(ctx2, SEPT, run2.id);
    const dep2 = report2.summary.postorderDependency!;
    expect(dep2.pricing.byStep["2"]).toBe(0); // 步驟 2（Postorder）計數 0
    expect(dep2.pricing.unpriced).toBe(9);
    expect(dep2.pricing.withoutPostorder).toBe(57);
    expect(dep2.pricing.byStep.existing).toBe(57);

    // 再 backfill：0 題
    const third = (await (await callBackfill()).json()) as { created: number; skipped_existing: number };
    expect(third.created).toBe(0);
    expect(third.skipped_existing).toBe(0);
  });

  it("A：撤銷一題 → 作廢新卡、恢復 auto 卡、題目回 open；之後 backfill 唔會重複出", async () => {
    const { run1, ctx1 } = await seedSeptShape();
    await buildAutoReport(ctx1, SEPT, run1.id);
    const body = (await (await callBackfill()).json()) as { session_id: string };
    const { questions } = await sessionQuestions(body.session_id);
    const q = questions.find((x) => (x.mc.candidates[0]?.evidence ?? "").includes("一鍵自動卡"))!;
    expect((await answer(q.id, { option: "mc_accept" })).res.status).toBe(200);
    const row = await prisma.triageQuestion.findUniqueOrThrow({ where: { id: q.id } });
    const j = (row.applyResultJson as { backfill: { card_id: string; voided_card_id: string } }).backfill;
    expect((await prisma.rateCard.findUniqueOrThrow({ where: { id: j.voided_card_id } })).voidedAt).not.toBeNull();
    const r = await undoBackfillRoute(req(`http://x/api/triage/questions/${q.id}/undo-backfill`, bossCookie, "POST"), { params: Promise.resolve({ id: q.id }) });
    expect(r.status).toBe(200);
    expect((await prisma.rateCard.findUniqueOrThrow({ where: { id: j.voided_card_id } })).voidedAt).toBeNull();
    expect((await prisma.rateCard.findUniqueOrThrow({ where: { id: j.card_id } })).voidedAt).not.toBeNull();
    const after = await prisma.triageQuestion.findUniqueOrThrow({ where: { id: q.id } });
    expect(after.status).toBe("open");
    // 再撤銷 409
    const r2 = await undoBackfillRoute(req(`http://x/api/triage/questions/${q.id}/undo-backfill`, bossCookie, "POST"), { params: Promise.resolve({ id: q.id }) });
    expect(r2.status).toBe(409);
    // 可以再答一次
    expect((await answer(q.id, { option: "mc_accept" })).res.status).toBe(200);
    // backfill：該組合 auto 卡已再次被作廢，唔會重複出題
    const again = (await (await callBackfill()).json()) as { created: number };
    expect(again.created).toBe(0);
  });

  it("A：自己輸入價錢 → 用新價建卡並覆蓋 auto 填過嘅價；撤銷後更價錢還原", async () => {
    const { run1, ctx1, sites } = await seedSeptShape();
    await buildAutoReport(ctx1, SEPT, run1.id);
    const body = (await (await callBackfill()).json()) as { session_id: string };
    const { questions } = await sessionQuestions(body.session_id);
    const target = siteName("A");
    const q = questions.find((x) => x.title.includes(target))!;
    const before = await prisma.shiftRecord.findMany({ where: { siteId: sites["A"]!.id }, select: { id: true, clientRateSnapshot: true, guardWageSnapshot: true } });
    expect(Number(before[0]!.clientRateSnapshot)).toBe(900);
    expect((await answer(q.id, { option: "mc_price", price: { client_rate: 950, guard_wage: 700, broker_fee: 0 } })).res.status).toBe(200);
    const mid = await prisma.shiftRecord.findMany({ where: { siteId: sites["A"]!.id }, select: { clientRateSnapshot: true } });
    expect(mid.every((r) => Number(r.clientRateSnapshot) === 950)).toBe(true);
    expect((await undoBackfillRoute(req(`http://x/api/triage/questions/${q.id}/undo-backfill`, bossCookie, "POST"), { params: Promise.resolve({ id: q.id }) })).status).toBe(200);
    const end = await prisma.shiftRecord.findMany({ where: { siteId: sites["A"]!.id }, select: { clientRateSnapshot: true } });
    expect(end.every((r) => Number(r.clientRateSnapshot) === 900)).toBe(true);
  });

  it("A：權限（會計得；主管／雞頭／安員 403）＋已鎖月 409＋月份格式 400；GET 狀態", async () => {
    const { run1, ctx1 } = await seedSeptShape();
    await buildAutoReport(ctx1, SEPT, run1.id);
    for (const role of ["主管", "雞頭", "安員"] as const) {
      const c = await sessionCookieForUser(fx.userIds[role]);
      expect((await callBackfill(c)).status, role).toBe(403);
    }
    expect((await callBackfill(await sessionCookieForUser(fx.userIds["會計"]))).status).toBe(200);
    expect((await backfillRoute(req("http://x/api/rate-cards/backfill-from-postorder", bossCookie, "POST", {}))).status).toBe(400);
    const st = await backfillStatusRoute(req("http://x/api/rate-cards/backfill-from-postorder?month=2026-09", bossCookie));
    expect(st.status).toBe(200);
    const sj = (await st.json()) as { session_id: string; open: number; total: number };
    expect(sj.open).toBe(19);
    expect(sj.total).toBe(19);
    // 鎖月：409，且答題亦 409
    const q = await prisma.triageQuestion.findFirstOrThrow({ where: { sessionId: sj.session_id } });
    await prisma.monthClose.create({ data: { month: SEPT, lockedAt: new Date(), lockedBy: boss, createdBy: "test" } });
    expect((await callBackfill()).status).toBe(409);
    expect((await answer(q.id, { option: "mc_accept" })).res.status).toBe(409);
    expect(await prisma.rateCard.count({ where: { source: { startsWith: "triage:" } } })).toBe(0);
    // 8 月（鎖月前）唔做
    expect((await callBackfill(bossCookie, "2026-07")).status).toBe(400);
  });

  it("A：組合已有人手卡 → 唔出題（skipped_has_card）", async () => {
    const { run1, ctx1, sites } = await seedSeptShape();
    await buildAutoReport(ctx1, SEPT, run1.id);
    const st = await prisma.shiftType.findFirstOrThrow({ where: { siteId: sites["A"]!.id } });
    // 先作廢 auto 卡、再人手建一張同組合卡（模擬有人先手動處理）
    await prisma.rateCard.updateMany({ where: { siteId: sites["A"]!.id, source: { startsWith: "auto:one-click:" } }, data: { voidedAt: new Date() } });
    await prisma.rateCard.create({ data: { siteId: sites["A"]!.id, shiftTypeId: st.id, brokerId: W.id, clientRate: 900, guardWage: 700, brokerFee: 0, payoutRate: 700, billingModel: "per_shift", effectiveFrom: SEPT, effectiveTo: null, source: "manual", createdBy: "t" } });
    const body = (await (await callBackfill()).json()) as { created: number };
    expect(body.created).toBe(18); // 11 張 auto 卡＋7 Postorder
  });
});

describe("WP-POSTORDER-FREE B：盤預設雞頭", () => {
  let fx: Wp2Fixture;
  let W: Broker;
  let K: Broker;
  let boss: string;
  let bossCookie: string;

  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    boss = fx.userIds["老闆"];
    bossCookie = await sessionCookieForUser(boss);
    W = await mkBroker("TW", "broker");
    K = await mkBroker("TK", "broker");
  });

  async function mkSite(name: string, defaultBrokerId: string | null = null) {
    const site = await prisma.site.create({ data: { canonicalName: name, clientName: `${name}客戶`, billingModel: "per_shift", defaultSettlementBrokerId: defaultBrokerId, createdBy: "t" } });
    const d = await prisma.shiftType.create({ data: { siteId: site.id, code: "D", startTime: time("0700"), endTime: time("1900"), hours: 12, createdBy: "t" } });
    return { site, d };
  }
  const rec = (siteId: string, shiftTypeId: string, guardId: string, day: number, settlementBrokerId: string | null = null) =>
    prisma.shiftRecord.create({ data: { workDate: sep(day), siteId, shiftTypeId, guardId, settlementBrokerId, operationalBrokerId: settlementBrokerId, recordType: "shift", status: "confirmed", source: "roster_upload", createdBy: "t" } });
  const noSettlement = async () => (await buildUnpricedSummary({ userId: boss, baseRole: "老闆", brokerId: null } as never, SEPT)).noSettlementCount;

  it("設咗盤預設雞頭 → 一鍵歸屬 no_settlement 0，reason「盤預設雞頭」；冇設嘅盤行為不變；安員預設雞頭優先、歷史排後", async () => {
    const withDefault = await mkSite("測試預設盤甲", W.id);
    const noDefault = await mkSite("測試預設盤乙");
    const g = await mkGuard();
    const gDef = await mkGuard({ defaultBrokerId: K.id });
    const gHist = await mkGuard();
    const histSite = await mkSite("測試預設盤丙", W.id);
    // 歷史：gHist 8 月喺丙盤結算雞頭 K（多數決）——盤預設雞頭 W 排在歷史之前，所以 9 月歸 W
    await prisma.shiftRecord.create({ data: { workDate: new Date(Date.UTC(2026, 7, 10)), siteId: histSite.site.id, shiftTypeId: histSite.d.id, guardId: gHist.id, settlementBrokerId: K.id, operationalBrokerId: K.id, recordType: "shift", status: "confirmed", source: "roster_upload", createdBy: "t" } });
    await rec(withDefault.site.id, withDefault.d.id, g.id, 1);
    await rec(withDefault.site.id, withDefault.d.id, g.id, 2);
    await rec(withDefault.site.id, withDefault.d.id, gDef.id, 3); // 安員預設雞頭 K 優先過盤預設 W
    await rec(histSite.site.id, histSite.d.id, gHist.id, 4);
    await rec(noDefault.site.id, noDefault.d.id, g.id, 5); // 冇設盤預設、冇歷史 → 仍然冇歸屬
    const run = await prisma.monthCloseRun.create({ data: { month: SEPT, status: "running", startedById: boss, applyStartedAt: new Date() } });
    const ctx = new AutoCollector(run.id, SEPT, boss, null);
    const out = await runAutoSettlement(ctx, SEPT);
    expect(out.assigned).toBe(4);
    expect(out.unresolved).toBe(1);
    const recs = await prisma.shiftRecord.findMany({ orderBy: [{ siteId: "asc" }, { workDate: "asc" }], where: { workDate: { gte: SEPT } } });
    const byDay = new Map(recs.map((r) => [`${r.siteId}:${r.workDate.getUTCDate()}`, r.settlementBrokerId]));
    expect(byDay.get(`${withDefault.site.id}:1`)).toBe(W.id);
    expect(byDay.get(`${withDefault.site.id}:2`)).toBe(W.id);
    expect(byDay.get(`${withDefault.site.id}:3`)).toBe(K.id);
    expect(byDay.get(`${histSite.site.id}:4`)).toBe(W.id);
    expect(byDay.get(`${noDefault.site.id}:5`)).toBeNull();
    const j = await prisma.monthCloseAutoChange.findMany({ where: { runId: run.id, kind: "settlement_set" } });
    expect(j.some((x) => (x.detailJson as { reason: string }).reason === "盤預設雞頭")).toBe(true);
    expect(await noSettlement()).toBe(1);
    // 只得設咗預設嘅盤：no_settlement 0
    await prisma.shiftRecord.deleteMany({ where: { siteId: noDefault.site.id } });
    expect(await noSettlement()).toBe(0);
  });

  it("PATCH default_settlement_broker_id：設／null 清走／唔存在雞頭 400；GET /api/sites 回傳新欄", async () => {
    const { site } = await mkSite("測試預設盤丁");
    const patch = (body: unknown) => patchSite(req(`http://x/api/sites/${site.id}`, bossCookie, "PATCH", body), { params: Promise.resolve({ id: site.id }) });
    let r = await patch({ default_settlement_broker_id: W.id });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { default_settlement_broker_id: string }).default_settlement_broker_id).toBe(W.id);
    const list = (await (await listSites(req("http://x/api/sites?take=500", bossCookie))).json()) as { rows: Array<{ id: string; default_settlement_broker_id: string | null }> };
    expect(list.rows.find((x) => x.id === site.id)!.default_settlement_broker_id).toBe(W.id);
    r = await patch({ default_settlement_broker_id: "00000000-0000-4000-8000-000000000000" });
    expect(r.status).toBe(400);
    await prisma.broker.update({ where: { id: K.id }, data: { status: "inactive" } });
    expect((await patch({ default_settlement_broker_id: K.id })).status).toBe(400);
    r = await patch({ default_settlement_broker_id: null });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { default_settlement_broker_id: string | null }).default_settlement_broker_id).toBeNull();
    expect((await prisma.site.findUniqueOrThrow({ where: { id: site.id } })).defaultSettlementBrokerId).toBeNull();
    // 雞頭角色改唔到
    expect((await patchSite(req(`http://x/api/sites/${site.id}`, await sessionCookieForUser(fx.userIds["雞頭"]), "PATCH", { default_settlement_broker_id: W.id }), { params: Promise.resolve({ id: site.id }) })).status).toBe(403);
  });

  it("建議：Roster 同盤逐日雞頭值唯一先建議；唔唯一／無 Postorder 就冇建議；只讀（唔改 DB）", async () => {
    const { site } = await mkSite("測試建議盤");
    const other = await mkSite("測試建議盤二");
    const call = async (id: string, month?: string) => {
      const r = await suggestRoute(req(`http://x/api/sites/${id}/default-broker-suggestion${month ? `?month=${month}` : ""}`, bossCookie), { params: Promise.resolve({ id }) });
      expect(r.status).toBe(200);
      return (await r.json()) as { reason: string; month: string | null; current_broker_id: string | null; suggestion: { broker_id: string; broker_code: string; days: number } | null };
    };
    expect((await call(site.id)).reason).toBe("no_postorder");
    await seedPostorder(SEPT, boss, {
      postorderCsv: postorderCsv([
        { label: "測試建議盤", prop: "建議甲", shift: "Day", client: 900, payout: 700, time: "0700-1900", total: 3 },
        { label: "測試建議盤二", prop: "建議乙", shift: "Day", client: 900, payout: 700, time: "0700-1900", total: 3 },
      ]),
      rosterCsv: rosterCsv([
        { label: "測試建議盤", prop: "建議甲", shift: "Day", days: { 1: "(2) TW", 2: "(2) TW", 3: "(8) 長工" } },
        { label: "測試建議盤二", prop: "建議乙", shift: "Day", days: { 1: "(2) TW", 2: "(2) TK" } },
      ]),
    });
    const a = await call(site.id, "2026-09");
    expect(a.reason).toBe("unique");
    expect(a.suggestion?.broker_id).toBe(W.id);
    expect(a.suggestion?.broker_code).toBe("TW");
    expect(a.suggestion?.days).toBe(2); // 長工格唔計
    expect(a.month).toBe("2026-09-01");
    const b = await call(other.site.id, "2026-09");
    expect(b.reason).toBe("not_unique");
    expect(b.suggestion).toBeNull();
    // 唔指定月份＝最新 Postorder 上載嗰個月
    expect((await call(site.id)).suggestion?.broker_code).toBe("TW");
    expect((await prisma.site.findUniqueOrThrow({ where: { id: site.id } })).defaultSettlementBrokerId).toBeNull();
    // 盤主檔 hint：current_broker_id 回傳
    await prisma.site.update({ where: { id: site.id }, data: { defaultSettlementBrokerId: K.id } });
    expect((await call(site.id)).current_broker_id).toBe(K.id);
  });
});

describe("WP-POSTORDER-FREE：migration／AI 隔離", () => {
  const sqlPath = path.resolve(process.cwd(), "prisma/migrations/20261010000000_wp_postorder_free_site_default_broker/migration.sql");
  const runSql = async (sql: string) => {
    const c = new Client({ connectionString: process.env.DATABASE_URL });
    await c.connect();
    try {
      await c.query(sql);
    } finally {
      await c.end();
    }
  };
  const colExists = async () => (await prisma.$queryRawUnsafe<Array<{ n: number }>>(`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name='sites' AND column_name='default_settlement_broker_id'`))[0]!.n === 1;
  const fkExists = async () => (await prisma.$queryRawUnsafe<Array<{ n: number }>>(`SELECT count(*)::int AS n FROM pg_constraint WHERE conname='sites_default_settlement_broker_id_fkey'`))[0]!.n === 1;

  it("空庫已套用（欄＋FK）；再跑兩次唔 abort；半套（冇 FK／冇欄）重跑補返", async () => {
    const sql = fs.readFileSync(sqlPath, "utf-8");
    expect(await colExists()).toBe(true);
    expect(await fkExists()).toBe(true);
    await runSql(sql);
    await runSql(sql);
    expect(await colExists()).toBe(true);
    await runSql(`ALTER TABLE sites DROP CONSTRAINT sites_default_settlement_broker_id_fkey`);
    expect(await fkExists()).toBe(false);
    await runSql(sql);
    expect(await fkExists()).toBe(true);
    await runSql(`ALTER TABLE sites DROP COLUMN default_settlement_broker_id`);
    expect(await colExists()).toBe(false);
    await runSql(sql);
    expect(await colExists()).toBe(true);
    expect(await fkExists()).toBe(true);
  });

  it("髒數據唔影響 migration；刪雞頭 → 盤預設雞頭 SET NULL；migration 無 gen_random_uuid／RAISE／硬編碼 id", async () => {
    const sql = fs.readFileSync(sqlPath, "utf-8");
    expect(sql).not.toMatch(/gen_random_uuid|RAISE|[0-9a-f]{8}-[0-9a-f]{4}-/i);
    await clearAll();
    const b = await mkBroker("TD", "broker");
    const s = await prisma.site.create({ data: { canonicalName: "測試SETNULL盤", clientName: "測試客", billingModel: "per_shift", defaultSettlementBrokerId: b.id, createdBy: "t" } });
    await runSql(sql);
    await prisma.broker.delete({ where: { id: b.id } });
    expect((await prisma.site.findUniqueOrThrow({ where: { id: s.id } })).defaultSettlementBrokerId).toBeNull();
  });

  it("AI 角色讀唔到新欄：ai.sites 冇呢欄、public.sites permission denied", async () => {
    const pw = "test-ai-ro-password-0123456789";
    await ensureAiRole({ databaseUrl: process.env.DATABASE_URL!, password: pw });
    const url = new URL(process.env.DATABASE_URL!);
    url.username = AI_RO_ROLE;
    url.password = pw;
    const ai = new Client({ connectionString: url.toString() });
    await ai.connect();
    try {
      await expect(ai.query("SELECT default_settlement_broker_id FROM ai.sites LIMIT 1")).rejects.toThrow(/does not exist/i);
      await expect(ai.query("SELECT default_settlement_broker_id FROM public.sites LIMIT 1")).rejects.toThrow(/permission denied/i);
      const cols = await ai.query("SELECT column_name FROM information_schema.columns WHERE table_schema='ai' AND table_name='sites'");
      expect(cols.rows.map((r: { column_name: string }) => r.column_name)).not.toContain("default_settlement_broker_id");
    } finally {
      await ai.end();
    }
  });
});
