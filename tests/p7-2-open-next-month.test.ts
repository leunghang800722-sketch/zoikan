// P7.2：月頭自動開新月——冪等、價錢有變／新組合唔自動寫、鎖月跳過、通知 dedupe、audit by_job。
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { openNextMonthJob, runOpenNextMonth } from "@/lib/jobs/open-next-month";
import { classifyCopyCandidates, findCopyLastMonthCandidates } from "@/lib/pricing/copy-last-month-cards";
import { ensureJobRows, runJob, tick } from "@/lib/scheduler/runner";

const d = (y: number, m: number, day: number) => new Date(Date.UTC(y, m - 1, day));
const hk = (s: string) => new Date(`${s}+08:00`);
const TARGET = d(2026, 10, 1); // 2026-10（未鎖）；來源 2026-09

describe("P7.2 open_next_month", () => {
  let fx: Wp2Fixture;
  let siteId: string;
  const sts: Record<string, string> = {};

  async function card(key: string, from: Date, to: Date, client: number, wage = 70) {
    return prisma.rateCard.create({ data: { siteId, shiftTypeId: sts[key]!, clientRate: client, guardWage: wage, effectiveFrom: from, effectiveTo: to, createdBy: "test" } });
  }

  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    const site = await prisma.site.create({ data: { canonicalName: "P7測試盤", clientName: "P7客", billingModel: "per_shift", createdBy: "test" } });
    siteId = site.id;
    for (const code of ["N", "D", "E", "X", "M"]) {
      sts[code] = (await prisma.shiftType.create({ data: { siteId, code, label: `P7-${code}`, hours: 12, createdBy: "test" } })).id;
    }
    // 來源月 2026-09 嘅結構
    await prisma.brokerSiteAssignment.create({ data: { brokerId: fx.brokerA.id, siteId, month: d(2026, 9, 1), createdBy: "test" } });
    await prisma.quota.create({ data: { month: d(2026, 9, 1), siteId, shiftTypeId: sts.N!, brokerId: fx.brokerA.id, targetShifts: 10, createdBy: "test" } });
    await prisma.dailyRequirement.create({ data: { siteId, shiftTypeId: sts.N!, workDate: d(2026, 9, 5), headcountRequired: 2, createdBy: "test" } });
    // 價卡
    await card("N", d(2026, 8, 1), d(2026, 8, 31), 100); // 上上月
    await card("N", d(2026, 9, 1), d(2026, 9, 30), 100); //  N：價錢一樣 → 自動
    await card("D", d(2026, 8, 1), d(2026, 8, 31), 100);
    await card("D", d(2026, 9, 1), d(2026, 9, 30), 120); //  D：加價 → 待確認
    await card("E", d(2026, 9, 1), d(2026, 9, 30), 100); //  E：新組合（上上月冇）→ 待確認
    await card("X", d(2026, 7, 1), d(2026, 9, 30), 100); //  X：一張卡跨過上上月 → 自動
    await card("M", d(2026, 8, 1), d(2026, 9, 14), 100); //  M：月中改價（9/15 起新價）→ 待確認
    await card("M", d(2026, 9, 15), d(2026, 9, 30), 100);
  });

  it("分類：same／rate_changed／new／changed_in_month", async () => {
    const cands = await findCopyLastMonthCandidates("2026-10", siteId);
    const cls = await classifyCopyCandidates("2026-10", cands);
    const byCode = Object.fromEntries(cls.map((c) => [c.candidate.shiftTypeCode, c.cls]));
    expect(byCode).toEqual({ N: "same", D: "rate_changed", E: "new", X: "same", M: "changed_in_month" });
  });

  it("跑一次：開月＋只複製價錢冇變嘅卡；其餘通知待確認；audit by_job", async () => {
    const r = await runOpenNextMonth(TARGET);
    expect(r.status).toBeUndefined();
    expect(r.summary).toMatchObject({ month: "2026-10", broker_site_assignments_created: 1, quotas_created: 1, daily_requirements_created: 1, cards_auto_copied: 2, cards_pending: 3 });
    expect(await prisma.quota.count({ where: { month: TARGET, siteId } })).toBe(1);
    const oct = await prisma.rateCard.findMany({ where: { siteId, effectiveFrom: TARGET } });
    expect(oct.map((c) => c.shiftTypeId).sort()).toEqual([sts.N, sts.X].sort());
    expect(oct.every((c) => c.source === "copy_last_month" && c.createdBy === "job:open_next_month" && Number(c.clientRate) === 100)).toBe(true);
    // audit：actor null、帶 by_job
    const audits = await prisma.auditLog.findMany({ where: { tableName: "rate_cards", rowId: { in: oct.map((c) => c.id) }, action: "create" } });
    expect(audits).toHaveLength(2);
    expect(audits.every((a) => a.actorUserId === null && (a.after as Record<string, unknown>).by_job === "open_next_month")).toBe(true);
    const qa = await prisma.auditLog.findMany({ where: { tableName: "quotas", action: "create" } });
    expect(qa.some((a) => a.actorUserId === null && (a.after as Record<string, unknown>).by_job === "open_next_month")).toBe(true);
    // 通知
    const ns = await prisma.appNotification.findMany({ orderBy: { kind: "asc" } });
    expect(ns.map((n) => n.kind)).toEqual(["month_opened", "rate_cards_pending"]);
    const opened = ns[0]!;
    expect(opened.body).toBe("2026-10 已開好：掛盤 1／配額 1／每日需求 1／價卡自動複製 2、待確認 3");
    expect(opened.audience).toEqual(["老闆", "主管", "會計"]);
    const pending = ns[1]!;
    expect(pending.title).toBe("3 張價卡要你確認");
    expect(pending.href).toBe("/rate-cards?month=2026-10&pending=1");
  });

  it("冪等：跑第二次 0 新增、通知唔重複", async () => {
    await runOpenNextMonth(TARGET);
    const cardsBefore = await prisma.rateCard.count();
    const notiBefore = await prisma.appNotification.count();
    const r2 = await runOpenNextMonth(TARGET);
    expect(r2.summary).toMatchObject({ broker_site_assignments_created: 0, quotas_created: 0, daily_requirements_created: 0, cards_auto_copied: 0, cards_pending: 3, already_open: true });
    expect(await prisma.rateCard.count()).toBe(cardsBefore);
    expect(await prisma.appNotification.count()).toBe(notiBefore);
  });

  it("人手確認後（待確認卡被複製）再跑：pending 變 0，唔再寫", async () => {
    await runOpenNextMonth(TARGET);
    // 模擬老闆喺價卡頁確認 D／E／M
    for (const code of ["D", "E", "M"]) await prisma.rateCard.create({ data: { siteId, shiftTypeId: sts[code]!, clientRate: 130, guardWage: 70, effectiveFrom: TARGET, createdBy: "boss" } });
    const r = await runOpenNextMonth(TARGET);
    expect(r.summary).toMatchObject({ cards_auto_copied: 0, cards_pending: 0 });
  });

  it("目標月已鎖：跳過、零寫入、通知一條（dedupe）", async () => {
    await prisma.monthClose.create({ data: { month: TARGET, lockedAt: new Date(), lockedBy: fx.userIds["老闆"], createdBy: "test" } });
    const r = await runOpenNextMonth(TARGET);
    expect(r.status).toBe("skipped");
    expect(r.summary).toMatchObject({ reason: "month_locked" });
    expect(await prisma.quota.count({ where: { month: TARGET } })).toBe(0);
    expect(await prisma.rateCard.count({ where: { effectiveFrom: TARGET } })).toBe(0);
    await runOpenNextMonth(TARGET);
    const ns = await prisma.appNotification.findMany();
    expect(ns).toHaveLength(1);
    expect(ns[0]!.dedupeKey).toBe("month_opened:2026-10:locked");
  });

  it("經排程：25 號 09:00 HKT tick 開下個月；之後 tick 唔重跑；run-now 手動亦冪等", async () => {
    await ensureJobRows([openNextMonthJob], hk("2026-09-20T12:00:00"));
    expect(await tick([openNextMonthJob], hk("2026-09-24T09:00:00"))).toBe(0);
    expect(await tick([openNextMonthJob], hk("2026-09-25T09:00:10"))).toBe(1);
    expect(await prisma.quota.count({ where: { month: TARGET, siteId } })).toBe(1);
    expect(await tick([openNextMonthJob], hk("2026-09-25T09:01:10"))).toBe(0);
    const row = await prisma.scheduledJob.findUniqueOrThrow({ where: { jobKey: "open_next_month" } });
    expect(row.nextRunAt).toEqual(hk("2026-10-25T09:00:00"));
    expect(row.lastStatus).toBe("ok");
    const n = await prisma.appNotification.count();
    const man = await runJob(openNextMonthJob, { trigger: "manual", now: hk("2026-09-25T10:00:00") });
    expect(man.outcome).toBe("ran");
    expect(await prisma.appNotification.count()).toBe(n);
  });

  it("通知內容無 PII（盤名唔入通知）", async () => {
    await runOpenNextMonth(TARGET);
    const all = JSON.stringify(await prisma.appNotification.findMany());
    expect(all).not.toContain("P7測試盤");
  });
});
