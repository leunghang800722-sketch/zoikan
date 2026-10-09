// WP-ONE-CLICK-AUTO hotfix1：現有盤有效更種 = 0（舊版一鍵結算建咗盤但冇更種）→ 一鍵結算自動由本月上載格推更種，
// 同一 run 嘅 reconcile_apply 套用到；冪等；undo 跟現有規則；全部合成資料。
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { AUG, SEPT, mkBroker, mkGuard, uploadRoster } from "./lib/one-click-auto";
import { runOneClickMonthClose, stepParseHealth, stepPrecheck } from "@/lib/month-close/one-click";
import { AutoCollector } from "@/lib/month-close/auto/context";
import { undoAutoChanges } from "@/lib/month-close/auto/undo";

describe("WP-ONE-CLICK-AUTO hotfix1：0 更種現有盤自我修復", () => {
  let fx: Wp2Fixture;
  const boss = () => fx.userIds["老闆"];
  const SITE = "測試補更種盤";

  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    await prisma.monthClose.create({ data: { month: AUG, lockedAt: new Date(), lockedBy: boss(), createdBy: "t" } });
    await mkBroker("HK", "broker");
  });

  async function seed(opts: { dTime?: string; nTime?: string; preShiftTypes?: boolean } = {}) {
    const site = await prisma.site.create({ data: { canonicalName: SITE, clientName: "測試客", billingModel: "per_shift", createdBy: "t" } });
    if (opts.preShiftTypes) await prisma.shiftType.create({ data: { siteId: site.id, code: "D", startTime: new Date("1970-01-01T08:00:00Z"), endTime: new Date("1970-01-01T20:00:00Z"), hours: 12, createdBy: "t" } });
    await mkGuard({ name: "測試甲", staffNo: "U90001" });
    await mkGuard({ name: "測試乙", staffNo: "U90002" });
    await uploadRoster({
      siteRaw: SITE,
      month: SEPT,
      uploaderUserId: boss(),
      siteIdHint: site.id,
      lines: [
        { broker: "HK", time: opts.dTime ?? "0800-2000", staffNo: "U90001", name: "測試甲", codes: { 1: "D", 2: "D", 3: "D" } },
        { broker: "HK", time: opts.nTime ?? "2000-0800", staffNo: "U90002", name: "測試乙", codes: { 4: "N", 5: "N" } },
      ],
    });
    return site;
  }
  const activeTypes = (siteId: string) => prisma.shiftType.findMany({ where: { siteId, voidedAt: null }, orderBy: { code: "asc" } });
  const newRun = () => prisma.monthCloseRun.create({ data: { month: SEPT, status: "running", startedById: boss(), applyStartedAt: new Date() } });

  it("(a) 盤已存在、0 更種：一鍵後建 2 更種、5 更 applied、summary.shiftTypesCreated=2、journal 2 行", async () => {
    const site = await seed();
    const pre = await stepPrecheck(SEPT, boss(), null);
    expect(pre.needsHuman.some((h) => h.includes("完全未設更種"))).toBe(false);
    expect(pre.warnings.some((w) => w.includes("已由本月更表自動推出 2 個更種"))).toBe(true);

    const run = await newRun();
    await runOneClickMonthClose(run.id, SEPT, boss(), null);
    const sts = await activeTypes(site.id);
    expect(sts.map((s) => s.code)).toEqual(["D", "N"]);
    expect(Number(sts[0]!.hours)).toBe(12);
    expect(await prisma.shiftRecord.count({ where: { siteId: site.id, workDate: { gte: SEPT }, status: { not: "cancelled" } } })).toBe(5);
    const journal = await prisma.monthCloseAutoChange.findMany({ where: { runId: run.id, kind: "shift_type_created" } });
    expect(journal).toHaveLength(2);
    expect(journal.every((j) => j.undoable)).toBe(true);
    const done = await prisma.monthCloseRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(JSON.stringify(done.reportJson)).toContain("shiftTypesCreated");
  });

  it("(b) rerun 冇重複更種／journal", async () => {
    const site = await seed();
    const run = await newRun();
    await runOneClickMonthClose(run.id, SEPT, boss(), null);
    await prisma.monthCloseRun.update({ where: { id: run.id }, data: { status: "running", applyStartedAt: new Date(), finishedAt: null } });
    await runOneClickMonthClose(run.id, SEPT, boss(), null);
    expect(await activeTypes(site.id)).toHaveLength(2);
    expect(await prisma.monthCloseAutoChange.count({ where: { runId: run.id, kind: "shift_type_created" } })).toBe(2);
    const run2 = await newRun();
    await runOneClickMonthClose(run2.id, SEPT, boss(), null);
    expect(await prisma.shiftType.count({ where: { siteId: site.id } })).toBe(2);
    expect(await prisma.shiftRecord.count({ where: { siteId: site.id, workDate: { gte: SEPT }, status: { not: "cancelled" } } })).toBe(5);
  });

  it("(c) undo：未有更次用緊就 void（唔 delete）；已有更次用緊就跟現有規則 skip", async () => {
    const site = await seed();
    // 只行 parse_health（未套用更次）→ undo 作廢更種
    const run = await newRun();
    const ctx = new AutoCollector(run.id, SEPT, boss(), null);
    await stepParseHealth(SEPT, boss(), ctx);
    expect(ctx.summary.shiftTypesCreated).toBe(2);
    await prisma.monthCloseRun.update({ where: { id: run.id }, data: { status: "done", finishedAt: new Date() } });
    const u = await undoAutoChanges(run.id, boss(), null);
    expect(u.undone.shift_types).toBe(2);
    expect(await activeTypes(site.id)).toHaveLength(0);
    expect(await prisma.shiftType.count({ where: { siteId: site.id } })).toBe(2);

    // 全跑（更次已套用）→ undo skip
    await prisma.shiftType.deleteMany({ where: { siteId: site.id } });
    const run2 = await newRun();
    await runOneClickMonthClose(run2.id, SEPT, boss(), null);
    expect(await activeTypes(site.id)).toHaveLength(2);
    await prisma.monthCloseRun.update({ where: { id: run2.id }, data: { status: "done" } });
    const u2 = await undoAutoChanges(run2.id, boss(), null);
    expect(u2.skipped.filter((s) => s.kind === "shift_type_created").length).toBe(2);
    expect(await activeTypes(site.id)).toHaveLength(2);
  });

  it("(d) 時段全部解析唔到（7am-7pm）→ 0 更種、precheck 同 parse_health 出 needsHuman 講明原因", async () => {
    const site = await seed({ dTime: "7am-7pm", nTime: "7pm-7am" });
    const pre = await stepPrecheck(SEPT, boss(), null);
    expect(pre.needsHuman.some((h) => h.includes("完全未設更種") && h.includes("時段解析唔到"))).toBe(true);
    const ctx = new AutoCollector(null, SEPT, boss(), null);
    const res = await stepParseHealth(SEPT, boss(), ctx);
    expect(await activeTypes(site.id)).toHaveLength(0);
    expect(ctx.summary.shiftTypesCreated).toBe(0);
    expect(res.needsHuman.some((h) => h.includes("時段解析唔到"))).toBe(true);
  });

  it("(e) 盤已有 1 個更種 → 唔郁", async () => {
    const site = await seed({ preShiftTypes: true });
    const ctx = new AutoCollector(null, SEPT, boss(), null);
    await stepParseHealth(SEPT, boss(), ctx);
    expect(ctx.summary.shiftTypesCreated).toBe(0);
    expect((await activeTypes(site.id)).map((s) => s.code)).toEqual(["D"]);
    expect(await prisma.monthCloseAutoChange.count({ where: { kind: "shift_type_created" } })).toBe(0);
  });
});
