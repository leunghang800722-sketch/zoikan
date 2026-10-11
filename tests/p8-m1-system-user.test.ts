// P8 驗收 M1：排程系統帳號——冪等建立、inactive 唔可登入（401）、權限；系統帳號擁有嘅分診 session 有權限嘅人都答得；audit 白名單收窄。
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { SEPT, sep, mkBroker, mkGuard } from "./lib/one-click-auto";
import { ensureSystemUser, getSystemUserId, SYSTEM_USER_TEL } from "@/lib/system-user";
import { getJobReaderSession } from "@/lib/jobs/session";
import { writeAudit } from "@/lib/audit";
import { AutoCollector } from "@/lib/month-close/auto/context";
import { runAutoPricing } from "@/lib/month-close/auto/pricing";
import { buildAutoReport } from "@/lib/month-close/auto/report";
import { POST as loginRoute } from "@/app/api/auth/login/route";
import { GET as getSession } from "@/app/api/triage/sessions/[id]/route";
import { GET as listSessions } from "@/app/api/triage/sessions/route";
import { POST as batchRoute } from "@/app/api/triage/questions/batch-accept/route";
import { POST as answerRoute } from "@/app/api/triage/questions/[id]/answer/route";
import { POST as previewRoute } from "@/app/api/triage/questions/[id]/preview/route";

const time = (hhmm: string) => new Date(`1970-01-01T${hhmm.slice(0, 2)}:${hhmm.slice(2)}:00.000Z`);
const req = (url: string, cookie: string, method = "GET", body?: unknown) => new Request(url, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });

describe("P8 M1 系統帳號", () => {
  let fx: Wp2Fixture;
  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
  });

  it("冪等建立：inactive、老闆權限、永遠 match 唔到嘅 hash；重複 call 同一個 id", async () => {
    const id = await ensureSystemUser();
    expect(await ensureSystemUser()).toBe(id);
    expect(await getSystemUserId()).toBe(id);
    const u = await prisma.user.findUniqueOrThrow({ where: { id }, include: { role: true } });
    expect(u).toMatchObject({ tel: SYSTEM_USER_TEL, name: "系統排程", status: "inactive" });
    expect(u.role.baseRole).toBe("老闆");
    expect(u.passwordHash.startsWith("$2")).toBe(false);
    // 被人手改回 active／改 hash → 再 ensure 校正
    await prisma.user.update({ where: { id }, data: { status: "active" } });
    await ensureSystemUser();
    expect((await prisma.user.findUniqueOrThrow({ where: { id } })).status).toBe("inactive");
    const s = await getJobReaderSession();
    expect(s).toMatchObject({ userId: id, baseRole: "老闆", name: "系統排程" });
  });

  it("系統帳號登入 401（唔論邊個密碼）", async () => {
    await ensureSystemUser();
    for (const password of ["", "x", "Passw0rd1", "!system-account-no-login"]) {
      const res = await loginRoute(new Request("http://x/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tel: SYSTEM_USER_TEL, password: password || "abc" }) }));
      expect(res.status).toBe(401);
    }
  });

  async function systemOwnedSession() {
    const K = await mkBroker("TK", "broker");
    const W = await mkBroker("TW", "broker");
    const Z = await mkBroker("TZ", "broker");
    const guard = await mkGuard({ name: "測試甲" });
    const site = await prisma.site.create({ data: { canonicalName: "測試系統盤", clientName: "測試系統客", billingModel: "per_shift", createdBy: "t" } });
    const st = await prisma.shiftType.create({ data: { siteId: site.id, code: "D", startTime: time("0700"), endTime: time("1900"), hours: 12, createdBy: "t" } });
    for (const [b, w] of [[W, 700], [Z, 650]] as const) await prisma.rateCard.create({ data: { siteId: site.id, shiftTypeId: st.id, brokerId: b.id, guardWage: w, effectiveFrom: sep(1), effectiveTo: null, billingModel: "per_shift", createdBy: "t" } });
    for (let i = 1; i <= 4; i++) await prisma.shiftRecord.create({ data: { workDate: sep(i), siteId: site.id, shiftTypeId: st.id, guardId: guard.id, settlementBrokerId: K.id, operationalBrokerId: K.id, recordType: "shift", status: "confirmed", source: "roster_upload", clientRateSnapshot: 900, createdBy: "t" } });
    const sysId = await ensureSystemUser();
    const run = await prisma.monthCloseRun.create({ data: { month: SEPT, status: "done", startedById: sysId, applyStartedAt: new Date(), finishedAt: new Date(), reportJson: {} } });
    const ctx = new AutoCollector(run.id, SEPT, sysId, null);
    ctx.triageOwnerUserId = sysId; // 自動 run 揾唔到合資格上載者
    await runAutoPricing(ctx, SEPT);
    const report = await buildAutoReport(ctx, SEPT, run.id);
    return { sessionId: report.triageSessionId!, sysId };
  }

  it("系統帳號擁有嘅 month_close session：會計（非擁有人）睇得、列表有、答得（單題＋批量）；主管冇「一鍵結算:create」答唔到", async () => {
    const { sessionId, sysId } = await systemOwnedSession();
    const session = await prisma.triageSession.findUniqueOrThrow({ where: { id: sessionId } });
    expect(session.ownerUserId).toBe(sysId);
    const acc = await sessionCookieForUser(fx.userIds["會計"]);
    const g = await getSession(req(`http://x/s`, acc), { params: Promise.resolve({ id: sessionId }) });
    expect(g.status).toBe(200);
    const list = (await (await listSessions(req("http://x/api/triage/sessions", acc))).json()) as { sessions: { id: string }[]; open_total: number };
    expect(list.sessions.map((s) => s.id)).toContain(sessionId);
    expect(list.open_total).toBeGreaterThan(0);
    const qid = (await prisma.triageQuestion.findFirstOrThrow({ where: { sessionId } })).id;
    // 單題
    const pv = await previewRoute(req("http://x/p", acc, "POST", { answer: { option: "mc_accept" } }), { params: Promise.resolve({ id: qid }) });
    expect(pv.status).toBe(200);
    const { preview_hash } = (await pv.json()) as { preview_hash: string };
    const ans = await answerRoute(req("http://x/a", acc, "POST", { answer: { option: "mc_accept" }, preview_hash }), { params: Promise.resolve({ id: qid }) });
    expect(ans.status).toBe(200);
    const q = await prisma.triageQuestion.findUniqueOrThrow({ where: { id: qid } });
    expect(q.status).toBe("answered");
    expect(q.answeredBy).toBe(fx.userIds["會計"]);
    // 批量（再開一條題：同 session 已無，改驗 batch 對已答題 skipped，且唔 403）
    const b = await batchRoute(req("http://x/b", acc, "POST", { question_ids: [qid] }));
    expect(b.status).toBe(200);
    expect(((await b.json()) as { results: { reason: string }[] }).results[0]!.reason).toBe("already_answered");
    // 主管：冇「一鍵結算:create」→ 答唔到（403／error），但 session 唔係擁有人限制
    const mgr = await sessionCookieForUser(fx.userIds["主管"]);
    const mp = await previewRoute(req("http://x/p", mgr, "POST", { answer: { option: "skip" } }), { params: Promise.resolve({ id: qid }) });
    expect([403, 409]).toContain(mp.status);
  });

  it("其他人（會計）擁有嘅 session，另一位會計仍然 403（系統帳號例外唔洩露到其他 owner）", async () => {
    const { sessionId } = await systemOwnedSession();
    await prisma.triageSession.update({ where: { id: sessionId }, data: { ownerUserId: fx.userIds["主管"] } });
    const acc = await sessionCookieForUser(fx.userIds["會計"]);
    expect((await getSession(req("http://x/s", acc), { params: Promise.resolve({ id: sessionId }) })).status).toBe(403);
  });

  it("audit 未登記 DTO 表嘅 passthrough 收窄到 by_job／auto_source／batch_id", async () => {
    const id = "unmapped-row-1";
    await writeAudit({ actorUserId: null, tableName: "month_close_runs", rowId: id, action: "create", after: { id, by_job: "j", auto_source: "a", batch_id: "b", import_via: "x", copied_from: "c", unlock_reason: "u", other: 1 } });
    const a = await prisma.auditLog.findFirstOrThrow({ where: { rowId: id } });
    expect(a.after).toEqual({ id, by_job: "j", auto_source: "a", batch_id: "b" });
  });
});
