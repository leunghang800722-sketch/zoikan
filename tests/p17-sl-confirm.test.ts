// P17（老闆 2026-10-14）：病假「更表有 SL → 一定要人手確認醫生紙先出津貼」。
// 驗證：確認後計算（短段照出、未確認無薪）、通知 dedupe／無 PII、逐段決定 API、作廢草稿唔再生成、
// 一鍵結算 needs_human、鎖月被擋＋老闆覆蓋（audit）。
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { buildLongtermPayrollInputs } from "@/lib/longterm-payroll/aggregate";
import { generateLongtermInputDrafts } from "@/lib/longterm-payroll/drafts";
import { countSlPending, listSlPending, notifySlDraftsPending, slPendingDedupeKey } from "@/lib/longterm-payroll/sl-confirm";
import { stepLongtermSettlement } from "@/lib/month-close/one-click";
import { ensureSystemUser } from "@/lib/system-user";
import { assertNoPii } from "@/lib/notify/create";
import { GET as slPendingRoute } from "@/app/api/longterm/inputs/sl-pending/route";
import { POST as slDecision } from "@/app/api/longterm/inputs/[id]/sl-decision/route";
import { POST as confirmBatch } from "@/app/api/longterm/inputs/confirm-batch/route";
import { POST as monthCloseLock } from "@/app/api/month-closes/[id]/lock/route";

const AUG = (d: number) => new Date(Date.UTC(2026, 7, d));
const AUG_MONTH = new Date(Date.UTC(2026, 7, 1));

afterAll(async () => {
  await clearAll();
  await prisma.$disconnect();
});

interface Base {
  site: { id: string };
  st: { id: string };
  b07: { id: string };
  actorUserId: string;
  fx: Wp2Fixture;
}
async function base(): Promise<Base> {
  await clearAll();
  const fx = await seedWp2Fixture();
  const site = await prisma.site.create({ data: { canonicalName: `測試長工盤-${Math.random().toString(36).slice(2, 8)}`, clientName: "測試客戶", billingModel: "per_shift", createdBy: "test" } });
  const st = await prisma.shiftType.create({ data: { siteId: site.id, code: "N", hours: 12, createdBy: "test" } });
  const b07 = await prisma.broker.create({ data: { code: `T-B07-${Math.random().toString(36).slice(2, 6)}`, name: "測試內部長工桶", kind: "internal_longterm", settlementType: "salary", createdBy: "test" } });
  return { site, st, b07, actorUserId: fx.userIds["老闆"], fx };
}
async function mkGuard(b: Base, name: string) {
  const g = await prisma.guard.create({ data: { nameZh: name, employmentType: "longterm_autopay", hireDate: new Date("2020-01-01"), createdBy: "test" } });
  await prisma.guardLongtermContract.create({ data: { guardId: g.id, monthlySalary: 15500, effectiveFrom: new Date("2020-01-01"), effectiveTo: null, annualLeaveDays: 7, source: "manual", createdBy: b.actorUserId } });
  return g;
}
async function work(b: Base, guardId: string, days: number[]) {
  for (const d of days) await prisma.shiftRecord.create({ data: { workDate: AUG(d), siteId: b.site.id, shiftTypeId: b.st.id, guardId, settlementBrokerId: b.b07.id, operationalBrokerId: b.b07.id, recordType: "shift", createdBy: "test" } });
}
async function sl(b: Base, guardId: string, days: number[]) {
  for (const d of days) await prisma.shiftRecord.create({ data: { workDate: AUG(d), siteId: b.site.id, shiftTypeId: b.st.id, guardId, recordType: "leave", leaveCode: "SL", createdBy: "test" } });
}
const pendingDrafts = (guardId: string) => prisma.longtermPayrollInput.findMany({ where: { guardId, status: "draft", voidedAt: null }, orderBy: { dateFrom: "asc" } });
function req(url: string, cookie: string, method = "GET", body?: unknown) {
  return new Request(url, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
}
const idp = (id: string) => ({ params: Promise.resolve({ id }) });

describe("P17 確認後計算：未確認＝無薪；人手確認短段（<4 日）照出 4/5", () => {
  it("4 日病假：草稿（未確認）當無薪；確認後出 4/5、不再扣日薪", async () => {
    const b = await base();
    const owner = await sessionCookieForUser(b.fx.userIds["老闆"]);
    const sysId = await ensureSystemUser();
    const g = await mkGuard(b, "測試甲");
    await work(b, g.id, [1, 2, 3, 4, 5, 6, 7, 8]);
    await sl(b, g.id, [10, 11, 12, 13]);
    await generateLongtermInputDrafts(AUG_MONTH, sysId);
    const unconfirmed = (await buildLongtermPayrollInputs(AUG_MONTH)).lines[0]!;
    expect(unconfirmed.sl45Amount).toBe(0);
    expect(unconfirmed.npslDays).toBe(4);
    const [d] = await pendingDrafts(g.id);
    const res = await slDecision(req("http://t/x", owner, "POST", { decision: "confirm" }), idp(d!.id));
    expect(res.status).toBe(200);
    const row = await prisma.longtermPayrollInput.findUniqueOrThrow({ where: { id: d!.id } });
    expect(row).toMatchObject({ status: "confirmed", doctorNoteVerified: true, confirmedBy: b.actorUserId });
    const confirmed = (await buildLongtermPayrollInputs(AUG_MONTH)).lines[0]!;
    expect(confirmed.sl45Amount).toBeGreaterThan(0);
    expect(confirmed.npslDays).toBe(0);
    expect(confirmed.gross).toBeGreaterThan(unconfirmed.gross);
  });
});

describe("P17 sl-pending 清單／通知", () => {
  it("逐段資料（連續日數、夠唔夠 4 日、結餘、預計金額）；無 PII 通知、dedupe 按 id 集合", async () => {
    const b = await base();
    const owner = await sessionCookieForUser(b.fx.userIds["老闆"]);
    const sysId = await ensureSystemUser();
    const g1 = await mkGuard(b, "測試甲");
    const g2 = await mkGuard(b, "測試乙");
    await prisma.guardAvgWage.create({ data: { guardId: g1.id, month: AUG_MONTH, avgDailyWage: 500, source: "test" } });
    await sl(b, g1.id, [3, 4, 5, 6]);
    await sl(b, g1.id, [12]);
    await sl(b, g2.id, [20, 21, 22, 23]);
    await generateLongtermInputDrafts(AUG_MONTH, sysId);

    const list = await listSlPending(AUG_MONTH);
    expect(list.segment_count).toBe(3);
    expect(list.guard_count).toBe(2);
    const seg4 = list.segments.find((s) => s.date_from === "2026-08-03")!;
    expect(seg4).toMatchObject({ roster_days: 4, span_days: 4, meets_consecutive: true, within_balance: true, expected_amount: 1600 });
    const seg1 = list.segments.find((s) => s.date_from === "2026-08-12")!;
    expect(seg1).toMatchObject({ roster_days: 1, meets_consecutive: false, expected_amount: 400 }); // 短段確認後照出（SL_CONFIRMED_SHORT_PAID=true）
    const segNoAvg = list.segments.find((s) => s.guard_name === "測試乙")!;
    expect(segNoAvg.expected_amount).toBeNull();

    const r1 = await notifySlDraftsPending(AUG_MONTH);
    expect(r1).toMatchObject({ notified: true, segments: 3, guards: 2 });
    const r2 = await notifySlDraftsPending(AUG_MONTH);
    expect(r2.notified).toBe(false); // 同一集合 dedupe
    const ns = await prisma.appNotification.findMany({ where: { kind: "sl_drafts_pending" } });
    expect(ns).toHaveLength(1);
    expect(ns[0]!.title).toBe("2026-08 3 段病假要你確認醫生紙（2 人）");
    expect(ns[0]!.audience).toEqual(["老闆", "會計"]);
    expect(ns[0]!.href).toBe("/reports/longterm-payroll?month=2026-08&focus=sl-drafts");
    expect(() => assertNoPii(ns[0]!.title, ns[0]!.body)).not.toThrow();
    expect(ns[0]!.title + ns[0]!.body).not.toContain("測試");

    // 處理咗一段 → 集合變 → 新通知；全部處理完 → 唔再發
    const [first] = await pendingDrafts(g1.id);
    await slDecision(req("http://t/x", owner, "POST", { decision: "confirm" }), idp(first!.id));
    const r3 = await notifySlDraftsPending(AUG_MONTH);
    expect(r3).toMatchObject({ notified: true, segments: 2 });
    expect(await prisma.appNotification.count({ where: { kind: "sl_drafts_pending" } })).toBe(2);
    expect(slPendingDedupeKey("2026-08", ["b", "a"])).toBe(slPendingDedupeKey("2026-08", ["a", "b"]));

    // API：會計可讀、雞頭 403、缺 month 400
    const acct = await sessionCookieForUser(b.fx.userIds["會計"]);
    const broker = await sessionCookieForUser(b.fx.userIds["雞頭"]);
    const ok = await (await slPendingRoute(req("http://t/x?month=2026-08", acct))).json();
    expect(ok.segment_count).toBe(2);
    expect((await slPendingRoute(req("http://t/x?month=2026-08", broker))).status).toBe(403);
    expect((await slPendingRoute(req("http://t/x", acct))).status).toBe(400);
  });
});

describe("P17 逐段決定", () => {
  it("冇醫生紙，當無薪＝作廢草稿記原因；重新生成唔會再出同一段；仍當無薪；無「全部確認」自動路徑", async () => {
    const b = await base();
    const owner = await sessionCookieForUser(b.fx.userIds["老闆"]);
    const broker = await sessionCookieForUser(b.fx.userIds["雞頭"]);
    const sysId = await ensureSystemUser();
    const g = await mkGuard(b, "測試丙");
    await work(b, g.id, [1, 2, 3, 4, 5, 6, 7, 8]);
    await sl(b, g.id, [10, 11, 12, 13]);
    await generateLongtermInputDrafts(AUG_MONTH, sysId);
    const [d] = await pendingDrafts(g.id);
    expect((await slDecision(req("http://t/x", broker, "POST", { decision: "unpaid" }), idp(d!.id))).status).toBe(403);
    expect((await slDecision(req("http://t/x", owner, "POST", { decision: "maybe" }), idp(d!.id))).status).toBe(400);
    const res = await slDecision(req("http://t/x", owner, "POST", { decision: "unpaid", reason: "員工冇交紙" }), idp(d!.id));
    expect(res.status).toBe(200);
    const row = await prisma.longtermPayrollInput.findUniqueOrThrow({ where: { id: d!.id } });
    expect(row.voidedAt).not.toBeNull();
    expect(row.voidedBy).toBe(b.actorUserId);
    expect((row.draftEvidence as { decline_reason: string }).decline_reason).toBe("員工冇交紙");
    const audit = await prisma.auditLog.findFirst({ where: { tableName: "longterm_payroll_inputs", rowId: d!.id, action: "void" } });
    expect(audit?.actorUserId).toBe(b.actorUserId);
    const re = await generateLongtermInputDrafts(AUG_MONTH, sysId);
    expect(re.created).toBe(0);
    expect(re.rejected_skipped).toBe(1);
    expect(await pendingDrafts(g.id)).toHaveLength(0);
    const line = (await buildLongtermPayrollInputs(AUG_MONTH)).lines[0]!;
    expect(line.sl45Amount).toBe(0);
    expect(line.npslDays).toBe(4); // 更表有 SL 但冇已確認輸入涵蓋＝當無薪
    // 已處理再決定 → 409
    expect((await slDecision(req("http://t/x", owner, "POST", { decision: "confirm" }), idp(d!.id))).status).toBe(409);
  });

  it("鎖月 403；同已確認病假段重疊 confirm 409", async () => {
    const b = await base();
    const owner = await sessionCookieForUser(b.fx.userIds["老闆"]);
    const sysId = await ensureSystemUser();
    const g = await mkGuard(b, "測試丁");
    await sl(b, g.id, [10, 11, 12, 13]);
    await generateLongtermInputDrafts(AUG_MONTH, sysId);
    const [d] = await pendingDrafts(g.id);
    await prisma.longtermPayrollInput.create({ data: { month: AUG_MONTH, guardId: g.id, kind: "leave", dateFrom: "2026-08-10", dateTo: "2026-08-14", doctorNoteVerified: false, createdBy: b.actorUserId } });
    const ov = await slDecision(req("http://t/x", owner, "POST", { decision: "confirm" }), idp(d!.id));
    expect(ov.status).toBe(409);
    expect((await ov.json()).error).toBe("overlaps_confirmed_leave");
    await prisma.monthClose.create({ data: { month: AUG_MONTH, lockedAt: new Date(), lockedBy: b.actorUserId } });
    expect((await slDecision(req("http://t/x", owner, "POST", { decision: "unpaid" }), idp(d!.id))).status).toBe(403);
  });
});

describe("P17 一鍵結算 needs_human", () => {
  it("stepLongtermSettlement：有未確認 SL → needsHuman＋通知；冇 SL → 無", async () => {
    const b = await base();
    const g = await mkGuard(b, "測試戊");
    const none = await stepLongtermSettlement(AUG_MONTH, b.actorUserId);
    expect(none.needsHuman).toEqual([]);
    await sl(b, g.id, [10, 11]);
    const r = await stepLongtermSettlement(AUG_MONTH, b.actorUserId);
    expect(r.needsHuman).toHaveLength(1);
    expect(r.needsHuman[0]).toContain("病假 1 段未確認（1 人）");
    expect(r.needsHuman[0]).toContain("未確認唔會出津貼");
    expect(r.numbers.slDraftsPending).toBe(1);
    expect(await prisma.appNotification.count({ where: { kind: "sl_drafts_pending" } })).toBe(1);
    expect((await countSlPending(AUG_MONTH)).segments).toBe(1);
  });
});

describe("P17 鎖月：未確認 SL 草稿擋鎖，老闆可「全部當無薪」覆蓋（audit）", () => {
  let b: Base;
  let mcId: string;
  beforeEach(async () => {
    b = await base();
    const sysId = await ensureSystemUser();
    const g = await mkGuard(b, "測試己");
    await sl(b, g.id, [10, 11, 12, 13]);
    await generateLongtermInputDrafts(AUG_MONTH, sysId);
    mcId = (await prisma.monthClose.create({ data: { month: AUG_MONTH, createdBy: "test" } })).id;
  });
  const lock = (cookie: string, body: unknown) => monthCloseLock(req(`http://t/x/${mcId}`, cookie, "POST", body), idp(mcId));

  it("force 都擋（SL 檢查獨立）→ 409 sl_drafts_pending；會計帶覆蓋 403；老闆缺原因 400；老闆帶原因 200＋audit；草稿保持未確認", async () => {
    const owner = await sessionCookieForUser(b.fx.userIds["老闆"]);
    const blocked = await lock(owner, { force: true });
    expect(blocked.status).toBe(409);
    expect((await blocked.json()).error).toBe("sl_drafts_pending");
    const perm = await prisma.permission.findFirstOrThrow({ where: { module: "月結鎖定解鎖", action: "void" } });
    const role = await prisma.role.findFirstOrThrow({ where: { name: "會計" } });
    await prisma.rolePermission.upsert({ where: { roleId_permissionId: { roleId: role.id, permissionId: perm.id } }, create: { roleId: role.id, permissionId: perm.id, granted: true }, update: { granted: true } });
    const acct = await sessionCookieForUser(b.fx.userIds["會計"]);
    expect((await lock(acct, { sl_unpaid_override: true, sl_unpaid_reason: "x" })).status).toBe(403);
    expect((await lock(owner, { force: true, sl_unpaid_override: true })).status).toBe(400);
    const ok = await lock(owner, { force: true, sl_unpaid_override: true, sl_unpaid_reason: "員工冇交紙，全部當無薪" });
    expect(ok.status).toBe(200);
    const audit = await prisma.auditLog.findFirst({ where: { tableName: "month_closes", rowId: mcId, action: "lock_month" }, orderBy: { createdAt: "desc" } });
    expect((audit!.after as Record<string, unknown>).sl_unpaid_override).toEqual({ segments: 1, guards: 1, reason: "員工冇交紙，全部當無薪" });
    expect(await prisma.longtermPayrollInput.count({ where: { month: AUG_MONTH, status: "draft", draftSource: "roster_leave:SL", voidedAt: null } })).toBe(1); // 唔自動確認＝仍當無薪
    // P18 補充：已鎖月份（含覆蓋鎖月）唔再提示——計數／通知／sl-pending locked 旗
    expect((await countSlPending(AUG_MONTH)).segments).toBe(0);
    expect(await notifySlDraftsPending(AUG_MONTH)).toEqual({ notified: false, segments: 0, guards: 0 });
    const pend = await (await slPendingRoute(req("http://t/x?month=2026-08", owner, "GET"))).json();
    expect(pend.locked).toBe(true);
  });

  it("confirm-batch 拒收 roster_leave:SL 草稿（400，提示 sl-decision），草稿保持未確認", async () => {
    const owner = await sessionCookieForUser(b.fx.userIds["老闆"]);
    const g = await prisma.guard.findFirstOrThrow({ where: { nameZh: "測試己" } });
    const [d] = await pendingDrafts(g.id);
    const res = await confirmBatch(req("http://t/x", owner, "POST", { ids: [d!.id] }));
    expect(res.status).toBe(400);
    expect((await res.json()).message).toContain("sl-decision");
    expect((await prisma.longtermPayrollInput.findUniqueOrThrow({ where: { id: d!.id } })).status).toBe("draft");
  });

  it("逐段處理完（當無薪）之後唔再擋", async () => {
    const owner = await sessionCookieForUser(b.fx.userIds["老闆"]);
    const g = await prisma.guard.findFirstOrThrow({ where: { nameZh: "測試己" } });
    const [d] = await pendingDrafts(g.id);
    await slDecision(req("http://t/x", owner, "POST", { decision: "unpaid" }), idp(d!.id));
    const ok = await lock(owner, { force: true });
    expect(ok.status).toBe(200);
    const audit = await prisma.auditLog.findFirst({ where: { tableName: "month_closes", rowId: mcId, action: "lock_month" }, orderBy: { createdAt: "desc" } });
    expect((audit!.after as Record<string, unknown>).sl_unpaid_override).toBeUndefined();
  });
});
