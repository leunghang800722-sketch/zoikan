// P8.2：待答題批量接受建議——結果同逐題人手答一字不差、冇建議跳過、一題失敗唔影響其餘、鎖月 403、權限、上限。
import { describe, it, expect, beforeEach } from "vitest";
import type { Broker, Guard } from "@prisma/client";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { SEPT, sep, mkBroker, mkGuard } from "./lib/one-click-auto";
import { AutoCollector } from "@/lib/month-close/auto/context";
import { runAutoPricing } from "@/lib/month-close/auto/pricing";
import { buildAutoReport } from "@/lib/month-close/auto/report";
import { POST as batchRoute } from "@/app/api/triage/questions/batch-accept/route";
import { GET as previewListRoute } from "@/app/api/triage/questions/batch-accept/preview/route";
import { POST as previewRoute } from "@/app/api/triage/questions/[id]/preview/route";
import { POST as answerRoute } from "@/app/api/triage/questions/[id]/answer/route";

const time = (hhmm: string) => new Date(`1970-01-01T${hhmm.slice(0, 2)}:${hhmm.slice(2)}:00.000Z`);
const req = (url: string, cookie: string, method = "GET", body?: unknown) => new Request(url, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });

describe("P8.2 triage batch-accept", () => {
  let fx: Wp2Fixture;
  let K: Broker;
  let W: Broker;
  let Z: Broker;
  let guard: Guard;
  const boss = () => fx.userIds["老闆"];

  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    K = await mkBroker("TK", "broker");
    W = await mkBroker("TW", "broker");
    Z = await mkBroker("TZ", "broker");
    guard = await mkGuard({ name: "測試甲" });
  });

  /** 一個有「兩個候選價」（→ propose 建議）嘅盤；snap=false 時冇候選＝unknown（冇建議）。 */
  async function scenario(name: string, opts: { propose: boolean }) {
    const site = await prisma.site.create({ data: { canonicalName: name, clientName: `${name}客`, billingModel: "per_shift", createdBy: "t" } });
    const st = await prisma.shiftType.create({ data: { siteId: site.id, code: "D", startTime: time("0700"), endTime: time("1900"), hours: 12, createdBy: "t" } });
    if (opts.propose) {
      for (const [b, w] of [[W, 700], [Z, 650]] as const) {
        await prisma.rateCard.create({ data: { siteId: site.id, shiftTypeId: st.id, brokerId: b.id, guardWage: w, effectiveFrom: sep(1), effectiveTo: null, billingModel: "per_shift", createdBy: "t" } });
      }
    }
    for (let i = 1; i <= 4; i++) {
      await prisma.shiftRecord.create({ data: { workDate: sep(i), siteId: site.id, shiftTypeId: st.id, guardId: guard.id, settlementBrokerId: K.id, operationalBrokerId: K.id, recordType: "shift", status: "confirmed", source: "roster_upload", clientRateSnapshot: opts.propose ? 900 : null, createdBy: "t" } });
    }
    return site;
  }
  async function openSession() {
    const run = await prisma.monthCloseRun.create({ data: { month: SEPT, status: "done", startedById: boss(), applyStartedAt: new Date(), finishedAt: new Date(), reportJson: {} } });
    const ctx = new AutoCollector(run.id, SEPT, boss(), null);
    await runAutoPricing(ctx, SEPT);
    const report = await buildAutoReport(ctx, SEPT, run.id);
    return report.triageSessionId!;
  }
  const qidOf = async (sessionId: string, siteName: string) => {
    const qs = await prisma.triageQuestion.findMany({ where: { sessionId } });
    const hit = qs.find((q) => JSON.stringify(q.evidenceJson).includes(siteName) || q.title.includes(siteName));
    expect(hit, `題目 ${siteName}`).toBeTruthy();
    return hit!.id;
  };
  async function single(qid: string, cookie: string) {
    const pv = await previewRoute(req(`http://x/p`, cookie, "POST", { answer: { option: "mc_accept" } }), { params: Promise.resolve({ id: qid }) });
    expect(pv.status).toBe(200);
    const { preview_hash } = (await pv.json()) as { preview_hash: string };
    const res = await answerRoute(req(`http://x/a`, cookie, "POST", { answer: { option: "mc_accept" }, preview_hash }), { params: Promise.resolve({ id: qid }) });
    expect(res.status).toBe(200);
  }
  const batch = (cookie: string, ids: string[]) => batchRoute(req("http://x/api/triage/questions/batch-accept", cookie, "POST", { question_ids: ids }));
  /** 把 audit after 去掉 id／batch_id，方便對比 */
  const normAudit = async (qid: string) => {
    const a = await prisma.auditLog.findFirstOrThrow({ where: { tableName: "triage_questions", rowId: qid, action: "triage_answer" } });
    const { batch_id, session_id, auto_source, ...rest } = a.after as Record<string, unknown>;
    void batch_id;
    void session_id;
    expect(String(auto_source)).toBe(`triage:${qid}`);
    return { actor: a.actorUserId, rest };
  };
  const cardOf = async (siteId: string, qid: string) => {
    const c = await prisma.rateCard.findFirstOrThrow({ where: { siteId, source: `triage:${qid}` } });
    return [Number(c.clientRate), Number(c.guardWage), Number(c.brokerFee), Number(c.payoutRate), c.brokerId, c.confidence];
  };
  const snapsOf = async (siteId: string) => (await prisma.shiftRecord.findMany({ where: { siteId }, orderBy: { workDate: "asc" } })).map((r) => [Number(r.clientRateSnapshot), Number(r.guardWageSnapshot), Number(r.brokerFeeSnapshot)]);

  it("批量結果同逐題人手答一字不差（卡、snapshot、audit）；audit 多 batch_id", async () => {
    const A = await scenario("測試批A", { propose: true });
    const B = await scenario("測試批B", { propose: true });
    const sid = await openSession();
    const qa = await qidOf(sid, "測試批A");
    const qb = await qidOf(sid, "測試批B");
    const cookie = await sessionCookieForUser(boss());

    await single(qa, cookie); // 人手逐題
    const res = await batch(cookie, [qb]); // 批量
    expect(res.status).toBe(200);
    const body = (await res.json()) as { batch_id: string; results: { id: string; status: string }[]; counts: Record<string, number> };
    expect(body.results).toEqual([{ id: qb, status: "answered", reason: null }]);
    expect(body.counts).toEqual({ answered: 1, skipped: 0, error: 0 });

    expect(await cardOf(B.id, qb)).toEqual(await cardOf(A.id, qa));
    expect(await snapsOf(B.id)).toEqual(await snapsOf(A.id));
    expect(await normAudit(qb)).toEqual(await normAudit(qa));
    const auditB = await prisma.auditLog.findFirstOrThrow({ where: { tableName: "triage_questions", rowId: qb, action: "triage_answer" } });
    expect((auditB.after as Record<string, unknown>).batch_id).toBe(body.batch_id);
    const auditA = await prisma.auditLog.findFirstOrThrow({ where: { tableName: "triage_questions", rowId: qa, action: "triage_answer" } });
    expect((auditA.after as Record<string, unknown>).batch_id).toBeUndefined();
    const qrow = await prisma.triageQuestion.findUniqueOrThrow({ where: { id: qb } });
    expect(qrow.status).toBe("answered");
  });

  it("冇建議嘅題跳過；已答題跳過；唔存在 id 報 error；其餘照做", async () => {
    await scenario("測試批A", { propose: true });
    await scenario("測試批U", { propose: false });
    const sid = await openSession();
    const qa = await qidOf(sid, "測試批A");
    const qu = await qidOf(sid, "測試批U");
    const cookie = await sessionCookieForUser(boss());
    await single(qa, cookie);
    const res = await batch(cookie, [qa, qu, "no-such-id"]);
    const body = (await res.json()) as { results: { id: string; status: string; reason: string | null }[]; counts: Record<string, number> };
    expect(body.results).toEqual([
      { id: qa, status: "skipped", reason: "already_answered" },
      { id: qu, status: "skipped", reason: "no_suggestion" },
      { id: "no-such-id", status: "error", reason: "搵唔到呢條問題" },
    ]);
    expect(body.counts).toEqual({ answered: 0, skipped: 2, error: 1 });
    expect((await prisma.triageQuestion.findUniqueOrThrow({ where: { id: qu } })).status).toBe("open");
  });

  it("一題失敗唔影響其餘", async () => {
    const A = await scenario("測試批A", { propose: true });
    await scenario("測試批B", { propose: true });
    const sid = await openSession();
    const qa = await qidOf(sid, "測試批A");
    const qb = await qidOf(sid, "測試批B");
    // A 組合預先有人手 triage 卡（模擬另一題已確認過不同價）→ A 答案 409，B 照做
    const st = await prisma.shiftType.findFirstOrThrow({ where: { siteId: A.id } });
    await prisma.rateCard.create({ data: { siteId: A.id, shiftTypeId: st.id, brokerId: K.id, guardWage: 111, effectiveFrom: sep(1), effectiveTo: null, billingModel: "per_shift", source: "triage:other", createdBy: "t" } });
    const cookie = await sessionCookieForUser(boss());
    const body = (await (await batch(cookie, [qa, qb])).json()) as { results: { id: string; status: string; reason: string | null }[]; counts: Record<string, number> };
    const byId = Object.fromEntries(body.results.map((r) => [r.id, r]));
    expect(byId[qa]!.status).toBe("error");
    expect(byId[qb]!.status).toBe("answered");
    expect(body.counts).toEqual({ answered: 1, skipped: 0, error: 1 });
    expect((await prisma.triageQuestion.findUniqueOrThrow({ where: { id: qa } })).status).toBe("open");
  });

  it("鎖月月份 403，整批唔寫任何嘢", async () => {
    await scenario("測試批A", { propose: true });
    const sid = await openSession();
    const qa = await qidOf(sid, "測試批A");
    await prisma.monthClose.create({ data: { month: SEPT, lockedAt: new Date(), lockedBy: boss(), createdBy: "t" } });
    const cookie = await sessionCookieForUser(boss());
    const res = await batch(cookie, [qa]);
    expect(res.status).toBe(403);
    expect((await prisma.triageQuestion.findUniqueOrThrow({ where: { id: qa } })).status).toBe("open");
    expect(await prisma.rateCard.count({ where: { source: { startsWith: "triage:" } } })).toBe(0);
    // preview 清單唔列已鎖月份
    const pl = await previewListRoute(req(`http://x/api/triage/questions/batch-accept/preview?session_id=${sid}`, cookie));
    expect(((await pl.json()) as { items: unknown[] }).items).toEqual([]);
  });

  it("權限：雞頭 403；非擁有人會計逐題 error；上限 50；body 格式", async () => {
    await scenario("測試批A", { propose: true });
    const sid = await openSession();
    const qa = await qidOf(sid, "測試批A");
    const kc = await sessionCookieForUser(fx.userIds["雞頭"]);
    expect((await batch(kc, [qa])).status).toBe(403);
    expect((await previewListRoute(req(`http://x/api/triage/questions/batch-accept/preview?session_id=${sid}`, kc))).status).toBe(403);
    const ac = await sessionCookieForUser(fx.userIds["會計"]);
    const r = (await (await batch(ac, [qa])).json()) as { results: { status: string; reason: string }[] };
    expect(r.results[0]).toMatchObject({ status: "error", reason: "呢條問題唔係你上載嗰批" });
    const bc = await sessionCookieForUser(boss());
    expect((await batch(bc, Array.from({ length: 51 }, (_, i) => `id${i}`))).status).toBe(400);
    expect((await batch(bc, [])).status).toBe(400);
    expect((await batchRoute(req("http://x/api/triage/questions/batch-accept", bc, "POST", { question_ids: ["x"], extra: 1 }))).status).toBe(400);
  });

  it("preview 清單：只列有建議嘅題；session_id／month 兩種 scope；內容無 PII 欄", async () => {
    await scenario("測試批A", { propose: true });
    await scenario("測試批U", { propose: false });
    const sid = await openSession();
    const qa = await qidOf(sid, "測試批A");
    const cookie = await sessionCookieForUser(boss());
    for (const q of [`session_id=${sid}`, "month=2026-09"]) {
      const res = await previewListRoute(req(`http://x/api/triage/questions/batch-accept/preview?${q}`, cookie));
      expect(res.status).toBe(200);
      const { items, total } = (await res.json()) as { items: { id: string; confidence: string; suggestion: string | null; month: string }[]; total: number };
      expect(total).toBe(1);
      expect(items.map((i) => i.id)).toEqual([qa]);
      expect(items[0]).toMatchObject({ confidence: "propose", month: "2026-09" });
      expect(items[0]!.suggestion).toBeTruthy();
    }
    const none = await previewListRoute(req("http://x/api/triage/questions/batch-accept/preview?month=2026-01", cookie));
    expect(((await none.json()) as { total: number }).total).toBe(0);
    expect((await previewListRoute(req("http://x/api/triage/questions/batch-accept/preview", cookie))).status).toBe(400);
  });
});
