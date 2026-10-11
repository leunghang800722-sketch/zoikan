// P9.1：長工糧人手輸入草稿——更表 SL → 病假段草稿（不帶金額）；草稿唔計糧；確認後先計；更表改變只更新未確認草稿；
// 鎖月唔生成；勤工獎合資格清單（唔填金額）；通知無 PII；audit by_job；PATCH／confirm-batch／GET status API。
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { buildLongtermPayrollInputs } from "@/lib/longterm-payroll/aggregate";
import { generateLongtermInputDrafts, listAttendanceBonusEligible, groupConsecutive } from "@/lib/longterm-payroll/drafts";
import { runLongtermInputDrafts, longtermInputDraftsJob, LONGTERM_INPUT_DRAFTS_KEY } from "@/lib/jobs/longterm-input-drafts";
import { JOBS } from "@/lib/jobs/registry";
import { withJobLock } from "@/lib/scheduler/lock";
import { runAutoOneClick, autoOneClickJob, AUTO_ONE_CLICK_KEY } from "@/lib/jobs/auto-one-click";
import { ensureJobRows } from "@/lib/scheduler/runner";
import { mergeJobState } from "@/lib/scheduler/state";
import { ensureSystemUser } from "@/lib/system-user";
import { assertNoPii } from "@/lib/notify/create";
import { GET as listInputs } from "@/app/api/longterm/inputs/route";
import { PATCH as patchInput, DELETE as deleteInput } from "@/app/api/longterm/inputs/[id]/route";
import { POST as confirmBatch } from "@/app/api/longterm/inputs/confirm-batch/route";
import { GET as bonusRoute } from "@/app/api/longterm/attendance-bonus-eligible/route";

const AUG = (d: number) => new Date(Date.UTC(2026, 7, d));
const AUG_MONTH = new Date(Date.UTC(2026, 7, 1));
const NOW = new Date("2026-09-05T13:30:00.000Z");

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
async function leave(b: Base, guardId: string, days: number[], code: "SL" | "AL" | "NL" | "NPL" | "RD", uploadId?: string) {
  for (const d of days)
    await prisma.shiftRecord.create({
      data: { workDate: AUG(d), siteId: b.site.id, shiftTypeId: b.st.id, guardId, recordType: "leave", leaveCode: code, provenance: uploadId ? { upload_id: uploadId } : undefined, createdBy: "test" },
    });
}
const drafts = (guardId: string) => prisma.longtermPayrollInput.findMany({ where: { guardId, status: "draft", voidedAt: null }, orderBy: { dateFrom: "asc" } });
function req(url: string, cookie: string, method = "GET", body?: unknown) {
  return new Request(url, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
}

describe("groupConsecutive", () => {
  it("連續日合併、斷開就分段", () => {
    expect(groupConsecutive(["2026-08-03", "2026-08-04", "2026-08-05", "2026-08-10", "2026-08-12", "2026-08-13"])).toEqual([["2026-08-03", "2026-08-04", "2026-08-05"], ["2026-08-10"], ["2026-08-12", "2026-08-13"]]);
    expect(groupConsecutive([])).toEqual([]);
    expect(groupConsecutive(["2026-08-31"])).toEqual([["2026-08-31"]]);
  });
});

describe("P9.1 草稿生成", () => {
  let b: Base;
  beforeEach(async () => {
    b = await base();
  });

  it("SL 連續段合併成一條草稿；金額空、醫生紙未核、證據只有日期＋上載 id；重跑冪等", async () => {
    const g = await mkGuard(b, "測試甲");
    await work(b, g.id, [1, 2, 6, 7, 8, 9, 11]);
    await leave(b, g.id, [3, 4, 5, 10, 12, 13], "SL", "up-1");
    const r1 = await generateLongtermInputDrafts(AUG_MONTH, b.actorUserId);
    expect(r1.created).toBe(3);
    const ds = await drafts(g.id);
    expect(ds.map((d) => [d.dateFrom, d.dateTo])).toEqual([
      ["2026-08-03", "2026-08-05"],
      ["2026-08-10", "2026-08-10"],
      ["2026-08-12", "2026-08-13"],
    ]);
    for (const d of ds) {
      expect(d.kind).toBe("leave");
      expect(d.amount).toBeNull();
      expect(d.doctorNoteVerified).toBe(false);
      expect(d.draftSource).toBe("roster_leave:SL");
      expect(JSON.stringify(d.draftEvidence)).not.toContain("測試甲");
      expect((d.draftEvidence as { roster_upload_ids: string[] }).roster_upload_ids).toEqual(["up-1"]);
    }
    const r2 = await generateLongtermInputDrafts(AUG_MONTH, b.actorUserId);
    expect(r2.created + r2.updated + r2.voided).toBe(0);
    expect(await drafts(g.id)).toHaveLength(3);
  });

  it("AL／NL／NPL 唔生成草稿（aggregate 已自動計）", async () => {
    const g = await mkGuard(b, "測試乙");
    await leave(b, g.id, [3, 4], "AL");
    await leave(b, g.id, [10], "NL");
    await leave(b, g.id, [11], "NPL");
    const r = await generateLongtermInputDrafts(AUG_MONTH, b.actorUserId);
    expect(r.created).toBe(0);
    expect(await prisma.longtermPayrollInput.count()).toBe(0);
  });

  it("草稿對 Gross 零影響；確認（醫生紙未核）金額不變；確認後會計核實醫生紙先改變 4/5", async () => {
    const g = await mkGuard(b, "測試丙");
    await work(b, g.id, [1, 2, 3, 4, 5, 6, 7, 8]);
    await leave(b, g.id, [10, 11, 12, 13, 14], "SL");
    const before = (await buildLongtermPayrollInputs(AUG_MONTH)).lines[0]!;
    await generateLongtermInputDrafts(AUG_MONTH, b.actorUserId);
    const [d] = await drafts(g.id);
    const withDraft = (await buildLongtermPayrollInputs(AUG_MONTH)).lines[0]!;
    expect(withDraft.gross).toBe(before.gross);
    expect(withDraft.sl45Amount).toBe(before.sl45Amount);
    expect(withDraft.notes).toEqual(before.notes);
    // 確認但醫生紙未核：同冇輸入（當無薪假）一樣
    await prisma.longtermPayrollInput.update({ where: { id: d!.id }, data: { status: "confirmed" } });
    const confirmedUnverified = (await buildLongtermPayrollInputs(AUG_MONTH)).lines[0]!;
    expect(confirmedUnverified.gross).toBe(before.gross);
    // 核實醫生紙 → 4/5 生效，Gross 變
    await prisma.longtermPayrollInput.update({ where: { id: d!.id }, data: { doctorNoteVerified: true } });
    const verified = (await buildLongtermPayrollInputs(AUG_MONTH)).lines[0]!;
    expect(verified.sl45Amount).toBeGreaterThan(0);
    expect(verified.gross).toBeGreaterThan(before.gross);
  });

  it("更表改變 → 更新未確認草稿；已確認唔郁並出通知；刪走嘅草稿唔再出；改過嘅草稿唔覆蓋", async () => {
    const g = await mkGuard(b, "測試丁");
    await leave(b, g.id, [3, 4, 5], "SL");
    await leave(b, g.id, [20, 21], "SL");
    await generateLongtermInputDrafts(AUG_MONTH, b.actorUserId);
    let ds = await drafts(g.id);
    expect(ds).toHaveLength(2);
    // 更表去咗 8/5
    await prisma.shiftRecord.deleteMany({ where: { guardId: g.id, workDate: AUG(5) } });
    const r = await generateLongtermInputDrafts(AUG_MONTH, b.actorUserId);
    expect(r.updated).toBe(1);
    ds = await drafts(g.id);
    expect(ds.map((d) => [d.dateFrom, d.dateTo])).toEqual([
      ["2026-08-03", "2026-08-04"],
      ["2026-08-20", "2026-08-21"],
    ]);
    // 確認 8/3–8/4，之後更表再改
    await prisma.longtermPayrollInput.update({ where: { id: ds[0]!.id }, data: { status: "confirmed" } });
    await prisma.shiftRecord.deleteMany({ where: { guardId: g.id, workDate: AUG(4) } });
    const r2 = await generateLongtermInputDrafts(AUG_MONTH, b.actorUserId);
    expect(r2.mismatches).toBe(1);
    const kept = await prisma.longtermPayrollInput.findUniqueOrThrow({ where: { id: ds[0]!.id } });
    expect([kept.dateFrom, kept.dateTo, kept.status]).toEqual(["2026-08-03", "2026-08-04", "confirmed"]);
    // 會計刪走 8/20–8/21 草稿 → 唔再生成
    await prisma.longtermPayrollInput.update({ where: { id: ds[1]!.id }, data: { voidedAt: new Date(), voidedBy: b.actorUserId } });
    const r3 = await generateLongtermInputDrafts(AUG_MONTH, b.actorUserId);
    expect(r3.created).toBe(0);
    expect(r3.rejected_skipped).toBe(1);
    // 改過嘅草稿（edited）唔被覆蓋
    await leave(b, g.id, [25], "SL");
    await generateLongtermInputDrafts(AUG_MONTH, b.actorUserId);
    const [d25] = await drafts(g.id);
    await prisma.longtermPayrollInput.update({ where: { id: d25!.id }, data: { dateTo: "2026-08-26", draftEvidence: { dates: ["2026-08-25"], roster_upload_ids: [], edited: true } } });
    await leave(b, g.id, [26], "SL");
    const r4 = await generateLongtermInputDrafts(AUG_MONTH, b.actorUserId);
    expect(r4.created + r4.updated + r4.voided).toBe(0);
    const still = await prisma.longtermPayrollInput.findUniqueOrThrow({ where: { id: d25!.id } });
    expect(still.dateTo).toBe("2026-08-26");
  });

  it("已有確認嘅人手病假段覆蓋咗嘅日子唔再出草稿", async () => {
    const g = await mkGuard(b, "測試戊");
    await leave(b, g.id, [3, 4, 5], "SL");
    await prisma.longtermPayrollInput.create({ data: { month: AUG_MONTH, guardId: g.id, kind: "leave", dateFrom: "2026-08-03", dateTo: "2026-08-05", doctorNoteVerified: true, createdBy: b.actorUserId } });
    const r = await generateLongtermInputDrafts(AUG_MONTH, b.actorUserId);
    expect(r.created).toBe(0);
  });

  it("鎖月唔生成", async () => {
    const g = await mkGuard(b, "測試己");
    await leave(b, g.id, [3, 4], "SL");
    await prisma.monthClose.create({ data: { month: AUG_MONTH, lockedAt: new Date(), lockedBy: b.actorUserId } });
    const r = await generateLongtermInputDrafts(AUG_MONTH, b.actorUserId);
    expect(r.locked).toBe(true);
    expect(await prisma.longtermPayrollInput.count()).toBe(0);
  });
});

describe("P9.1 勤工獎合資格清單", () => {
  it("冇 SL／NL／NPL 先合資格；AL 唔影響；有確認津貼標記已填；唔建 input", async () => {
    const b = await base();
    const a = await mkGuard(b, "測試甲");
    const sl = await mkGuard(b, "測試乙");
    const nl = await mkGuard(b, "測試丙");
    const npl = await mkGuard(b, "測試丁");
    const al = await mkGuard(b, "測試戊");
    await leave(b, sl.id, [3], "SL");
    await leave(b, nl.id, [3], "NL");
    await leave(b, npl.id, [3], "NPL");
    await leave(b, al.id, [3], "AL");
    await prisma.longtermPayrollInput.create({ data: { month: AUG_MONTH, guardId: a.id, kind: "special_allowance", amount: 300, createdBy: b.actorUserId } });
    const before = await prisma.longtermPayrollInput.count();
    const res = await listAttendanceBonusEligible(AUG_MONTH);
    expect(res.eligible.map((e) => e.guard_name).sort()).toEqual(["測試甲", "測試戊"].sort());
    expect(res.eligible.find((e) => e.guard_name === "測試甲")!.already_filled).toBe(true);
    expect(res.eligible.find((e) => e.guard_name === "測試戊")!.already_filled).toBe(false);
    expect(res.late_checked).toBe(false);
    expect(await prisma.longtermPayrollInput.count()).toBe(before);
  });
});

describe("P9.1 job", () => {
  it("登記、通知（會計、無 PII、同日 dedupe）、audit by_job、系統帳號、鎖月 skipped", async () => {
    const b = await base();
    expect(JOBS.some((j) => j.key === LONGTERM_INPUT_DRAFTS_KEY)).toBe(true);
    expect(longtermInputDraftsJob.defaultSchedule).toBe("30 21 * * *");
    const g1 = await mkGuard(b, "測試甲");
    await mkGuard(b, "測試乙");
    await leave(b, g1.id, [3, 4], "SL");
    const r = await runLongtermInputDrafts(NOW, [AUG_MONTH]);
    expect(r.status).toBe("ok");
    const ns = await prisma.appNotification.findMany({ orderBy: { createdAt: "asc" } });
    const kinds = ns.map((n) => n.kind).sort();
    expect(kinds).toEqual(["longterm_bonus_eligible", "longterm_drafts"]);
    for (const n of ns) {
      expect(n.audience).toEqual(["會計"]);
      expect(() => assertNoPii(n.title, n.body)).not.toThrow();
      expect(n.title + n.body).not.toContain("測試");
    }
    expect(ns.find((n) => n.kind === "longterm_drafts")!.body).toContain("1 條草稿待確認");
    expect(ns.find((n) => n.kind === "longterm_bonus_eligible")!.title).toBe("2026-08 勤工獎合資格 1 人");
    const sysId = await ensureSystemUser();
    const d = (await drafts(g1.id))[0]!;
    const audit = await prisma.auditLog.findFirst({ where: { tableName: "longterm_payroll_inputs", rowId: d.id, action: "create" } });
    expect(audit?.actorUserId).toBe(sysId);
    expect((audit?.after as Record<string, unknown>).by_job).toBe(LONGTERM_INPUT_DRAFTS_KEY);
    // 再跑：冇改動 → skipped，通知唔重複
    const r2 = await runLongtermInputDrafts(NOW, [AUG_MONTH]);
    expect(r2.status).toBe("skipped");
    expect(await prisma.appNotification.count()).toBe(2);
    // 鎖月
    await prisma.monthClose.create({ data: { month: AUG_MONTH, lockedAt: new Date(), lockedBy: b.actorUserId } });
    const r3 = await runLongtermInputDrafts(NOW, [AUG_MONTH]);
    expect((r3.summary as { months: Record<string, { locked: boolean }> }).months["2026-08"]!.locked).toBe(true);
  });
});

describe("P9.1 API", () => {
  it("GET ?status=draft、PATCH 確認、改過標 edited、confirm-batch（≤50、鎖月 403、權限）", async () => {
    const b = await base();
    const owner = await sessionCookieForUser(b.fx.userIds["老闆"]);
    const acct = await sessionCookieForUser(b.fx.userIds["會計"]);
    const broker = await sessionCookieForUser(b.fx.userIds["雞頭"]);
    const g = await mkGuard(b, "測試甲");
    await leave(b, g.id, [3, 10, 20], "SL");
    await generateLongtermInputDrafts(AUG_MONTH, b.actorUserId);
    const list = await (await listInputs(req("http://t/api/longterm/inputs?month=2026-08-01&status=draft", acct))).json();
    expect(list.rows).toHaveLength(3);
    expect(list.rows[0].status).toBe("draft");
    expect(list.rows[0].draft_source).toBe("roster_leave:SL");
    expect((await listInputs(req("http://t/api/longterm/inputs?status=bad", acct))).status).toBe(400);
    expect((await listInputs(req("http://t/api/longterm/inputs?month=2026-08-01&status=confirmed", acct)).then((r) => r.json())).rows).toHaveLength(0);

    const [d1, d2, d3] = list.rows as { id: string }[];
    // 單條確認
    const p1 = await patchInput(req("http://t/x", acct, "PATCH", { status: "confirmed" }), { params: Promise.resolve({ id: d1!.id }) });
    expect(p1.status).toBe(200);
    const c1 = await prisma.longtermPayrollInput.findUniqueOrThrow({ where: { id: d1!.id } });
    expect(c1.status).toBe("confirmed");
    expect(c1.confirmedBy).toBe(b.fx.userIds["會計"]);
    // 改咗再確認 → edited 標記
    const p2 = await patchInput(req("http://t/x", acct, "PATCH", { doctor_note_verified: true, status: "confirmed" }), { params: Promise.resolve({ id: d2!.id }) });
    expect(p2.status).toBe(200);
    const c2 = await prisma.longtermPayrollInput.findUniqueOrThrow({ where: { id: d2!.id } });
    expect(c2.doctorNoteVerified).toBe(true);
    expect((c2.draftEvidence as { edited?: boolean }).edited).toBe(true);
    // status=draft 唔接受
    expect((await patchInput(req("http://t/x", acct, "PATCH", { status: "draft" }), { params: Promise.resolve({ id: d3!.id }) })).status).toBe(400);
    // 批量
    expect((await confirmBatch(req("http://t/x", broker, "POST", { ids: [d3!.id] }))).status).toBe(403);
    expect((await confirmBatch(req("http://t/x", owner, "POST", { ids: [] }))).status).toBe(400);
    expect((await confirmBatch(req("http://t/x", owner, "POST", { ids: Array.from({ length: 51 }, (_, i) => `id-${i}`) }))).status).toBe(400);
    const bt = await (await confirmBatch(req("http://t/x", owner, "POST", { ids: [d1!.id, d3!.id, "nope"] }))).json();
    expect(bt.counts).toEqual({ confirmed: 1, skipped: 2 });
    expect((await prisma.longtermPayrollInput.findUniqueOrThrow({ where: { id: d3!.id } })).status).toBe("confirmed");
    // 刪走草稿（DELETE＝作廢）
    await leave(b, g.id, [25], "SL");
    await generateLongtermInputDrafts(AUG_MONTH, b.actorUserId);
    const [d4] = await drafts(g.id);
    expect((await deleteInput(req("http://t/x", acct, "DELETE"), { params: Promise.resolve({ id: d4!.id }) })).status).toBe(200);
    // 鎖月 → 批量 403，草稿仍係草稿
    await leave(b, g.id, [27], "SL");
    await generateLongtermInputDrafts(AUG_MONTH, b.actorUserId);
    const [d5] = await drafts(g.id);
    await prisma.monthClose.create({ data: { month: AUG_MONTH, lockedAt: new Date(), lockedBy: b.actorUserId } });
    expect((await confirmBatch(req("http://t/x", owner, "POST", { ids: [d5!.id] }))).status).toBe(403);
    expect((await prisma.longtermPayrollInput.findUniqueOrThrow({ where: { id: d5!.id } })).status).toBe("draft");
  });

  it("GET /api/longterm/attendance-bonus-eligible：會計可讀、雞頭 403、缺 month 400", async () => {
    const b = await base();
    const acct = await sessionCookieForUser(b.fx.userIds["會計"]);
    const broker = await sessionCookieForUser(b.fx.userIds["雞頭"]);
    await mkGuard(b, "測試甲");
    const ok = await (await bonusRoute(req("http://t/x?month=2026-08-01", acct))).json();
    expect(ok.eligible).toHaveLength(1);
    expect(ok.late_checked).toBe(false);
    expect((await bonusRoute(req("http://t/x?month=2026-08-01", broker))).status).toBe(403);
    expect((await bonusRoute(req("http://t/x", acct))).status).toBe(400);
  });
});

describe("P9 驗收修正 M1：確認草稿唔可以同已確認病假段重疊", () => {
  it("PATCH 409、batch skipped、人手新增重疊 409；Gross 不變；改走日期後可確認", async () => {
    const b = await base();
    const owner = await sessionCookieForUser(b.fx.userIds["老闆"]);
    const g = await mkGuard(b, "測試甲");
    await work(b, g.id, [1, 2, 3, 4, 5, 6, 7, 8]);
    await leave(b, g.id, [10, 11, 12, 13, 14], "SL");
    await generateLongtermInputDrafts(AUG_MONTH, b.actorUserId);
    const [d] = await drafts(g.id);
    await prisma.longtermPayrollInput.create({ data: { month: AUG_MONTH, guardId: g.id, kind: "leave", dateFrom: "2026-08-10", dateTo: "2026-08-14", doctorNoteVerified: false, createdBy: b.actorUserId } });
    const gross = (await buildLongtermPayrollInputs(AUG_MONTH)).lines[0]!.gross;
    const p = await patchInput(req("http://t/x", owner, "PATCH", { status: "confirmed" }), { params: Promise.resolve({ id: d!.id }) });
    expect(p.status).toBe(409);
    expect((await p.json()).error).toBe("overlaps_confirmed_leave");
    const bt = await (await confirmBatch(req("http://t/x", owner, "POST", { ids: [d!.id] }))).json();
    expect(bt.counts).toEqual({ confirmed: 0, skipped: 1 });
    expect(bt.results[0].reason).toBe("同已確認病假段重疊");
    expect((await buildLongtermPayrollInputs(AUG_MONTH)).lines[0]!.gross).toBe(gross);
    const { POST: createInput } = await import("@/app/api/longterm/inputs/route");
    const c = await createInput(req("http://t/x", owner, "POST", { month: "2026-08-01", guard_id: g.id, kind: "leave", date_from: "2026-08-12", date_to: "2026-08-12" }));
    expect(c.status).toBe(409);
    // 改走日期（唔重疊）再確認 → 成功
    const ok = await patchInput(req("http://t/x", owner, "PATCH", { date_from: "2026-08-20", date_to: "2026-08-20", status: "confirmed" }), { params: Promise.resolve({ id: d!.id }) });
    expect(ok.status).toBe(200);
  });
});

describe("P9 驗收修正：edited 唔誤報、勤工獎通知只發上月", () => {
  it("改短日期再確認 → 更表比對 mismatches=0", async () => {
    const b = await base();
    const owner = await sessionCookieForUser(b.fx.userIds["老闆"]);
    const g = await mkGuard(b, "測試乙");
    await leave(b, g.id, [3, 4, 5], "SL");
    await generateLongtermInputDrafts(AUG_MONTH, b.actorUserId);
    const [d] = await drafts(g.id);
    const r = await patchInput(req("http://t/x", owner, "PATCH", { date_from: "2026-08-03", date_to: "2026-08-04", status: "confirmed" }), { params: Promise.resolve({ id: d!.id }) });
    expect(r.status).toBe(200);
    const res = await generateLongtermInputDrafts(AUG_MONTH, b.actorUserId);
    expect(res.mismatches).toBe(0);
  });

  it("本月唔推勤工獎通知，上月先推", async () => {
    const b = await base();
    await mkGuard(b, "測試丙");
    const SEP = new Date(Date.UTC(2026, 8, 1));
    await runLongtermInputDrafts(NOW, [SEP]); // NOW＝2026-09-05（HK）→ 本月＝9 月
    expect(await prisma.appNotification.count({ where: { kind: "longterm_bonus_eligible" } })).toBe(0);
    await runLongtermInputDrafts(NOW, [AUG_MONTH]);
    expect(await prisma.appNotification.count({ where: { kind: "longterm_bonus_eligible" } })).toBe(1);
  });
});

describe("P9 驗收修正：auto_one_click 觸發草稿要攞 job lock", () => {
  it("lock 俾排程 job 持住 → 跳過草稿（summary 記 skipped_locked），一鍵結算照跑", async () => {
    const b = await base();
    const NOW2 = new Date();
    await ensureJobRows([autoOneClickJob], NOW2);
    await mergeJobState(AUTO_ONE_CLICK_KEY, { last_trigger_upload_at: {} });
    const DEC = new Date(Date.UTC(2026, 11, 1));
    const bytes = Buffer.from("fake");
    await prisma.rosterUpload.create({ data: { month: DEC, siteNameRaw: "A1", uploaderUserId: b.actorUserId, fileName: "A1.xlsx", fileSha256: "0".repeat(64), fileBytes: new Uint8Array(bytes), fileSize: bytes.length, status: "parsed", uploadedAt: new Date(NOW2.getTime() - 15 * 60_000) } });
    const held = await withJobLock(LONGTERM_INPUT_DRAFTS_KEY, async () => runAutoOneClick(NOW2));
    expect(held.acquired).toBe(true);
    const sum = (held as unknown as { value: { summary: { triggered: Record<string, { status: string; drafts?: string }> } } }).value.summary;
    expect(sum.triggered["2026-12"]!.status).toBe("done");
    expect(sum.triggered["2026-12"]!.drafts).toBe("skipped_locked");
  });
});
