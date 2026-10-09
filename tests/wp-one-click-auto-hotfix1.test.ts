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
    expect(pre.warnings.some((w) => w.includes("會由本月更表自動推出 2 個更種"))).toBe(true);

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

  it("(f) 必修1：reconcile_apply 前失敗 → undo 作廢更種 → rerun：唔會有更次掛喺已作廢更種，更種復用、5 更入數", async () => {
    const site = await seed();
    const blocker = await prisma.reconcileAllRun.create({ data: { month: SEPT, status: "running", startedById: boss() } });
    const r1 = await newRun();
    await runOneClickMonthClose(r1.id, SEPT, boss(), null);
    expect((await prisma.monthCloseRun.findUniqueOrThrow({ where: { id: r1.id } })).status).toBe("failed");
    expect(await activeTypes(site.id)).toHaveLength(2);
    await undoAutoChanges(r1.id, boss(), null);
    expect(await activeTypes(site.id)).toHaveLength(0);
    // undo 之後上載行唔再指住已作廢更種
    const voidedIds = (await prisma.shiftType.findMany({ where: { siteId: site.id }, select: { id: true } })).map((x) => x.id);
    expect(await prisma.rosterUploadRow.count({ where: { shiftTypeId: { in: voidedIds } } })).toBe(0);
    await prisma.reconcileAllRun.update({ where: { id: blocker.id }, data: { status: "done", finishedAt: new Date() } });
    const r2 = await newRun();
    await runOneClickMonthClose(r2.id, SEPT, boss(), null);
    expect(await activeTypes(site.id)).toHaveLength(2);
    expect(await prisma.shiftType.count({ where: { siteId: site.id } })).toBe(2);
    expect(await prisma.shiftRecord.count({ where: { status: { not: "cancelled" }, shiftType: { voidedAt: { not: null } } } })).toBe(0);
    expect(await prisma.shiftRecord.count({ where: { siteId: site.id, workDate: { gte: SEPT }, status: { not: "cancelled" } } })).toBe(5);
  });

  it("(f2) 防線：上載行仍指住已作廢更種 → 對數當 unresolved，唔寫 shift_records", async () => {
    const site = await seed();
    const ctx = new AutoCollector(null, SEPT, boss(), null);
    await stepParseHealth(SEPT, boss(), ctx);
    // 人手作廢更種但唔 reparse（模擬舊 undo 殘留）
    await prisma.shiftType.updateMany({ where: { siteId: site.id }, data: { voidedAt: new Date() } });
    const run = await newRun();
    // 直接行對數步驟
    const { stepReconcileApply } = await import("@/lib/month-close/one-click");
    await stepReconcileApply(SEPT, boss(), null);
    void run;
    expect(await prisma.shiftRecord.count({ where: { siteId: site.id, workDate: { gte: SEPT } } })).toBe(0);
  });

  it("(g) 必修2：同盤兩個 active 上載，淨係第一個建更種 → 第二個都要 reparse 配到更種", async () => {
    const site = await seed();
    await mkGuard({ name: "測試丙", staffNo: "U90003" });
    const u2 = (
      await uploadRoster({ siteRaw: SITE + "分冊", month: SEPT, uploaderUserId: boss(), siteIdHint: null, lines: [{ broker: "HK", time: "0800-2000", staffNo: "U90003", name: "測試丙", codes: { 10: "D", 11: "D" } }] })
    ).upload;
    await prisma.rosterUpload.update({ where: { id: u2.id }, data: { siteId: site.id } });
    await prisma.rosterUploadRow.updateMany({ where: { uploadId: u2.id }, data: { resolvedSiteId: site.id } });
    const ctx = new AutoCollector(null, SEPT, boss(), null);
    await stepParseHealth(SEPT, boss(), ctx);
    expect(await activeTypes(site.id)).toHaveLength(2);
    expect(await prisma.rosterUploadRow.count({ where: { uploadId: u2.id, codeKind: "shift", shiftTypeId: null } })).toBe(0);
  });

  it("(h) C2b：上載掛母盤、格歸 0 更種子盤 → 子盤補更種，母盤唔郁", async () => {
    const parent = await prisma.site.create({ data: { canonicalName: "測試母盤乙", clientName: "x", billingModel: "per_shift", createdBy: "t" } });
    const child = await prisma.site.create({ data: { canonicalName: "測試子盤乙", clientName: "x", parentSiteId: parent.id, billingModel: "per_shift", createdBy: "t" } });
    await mkGuard({ name: "測試甲", staffNo: "U90001" });
    const up = (await uploadRoster({ siteRaw: "測試母盤乙", month: SEPT, uploaderUserId: boss(), siteIdHint: parent.id, lines: [{ broker: "HK", time: "0800-2000", staffNo: "U90001", name: "測試甲", codes: { 1: "D", 2: "D" } }] })).upload;
    await prisma.rosterUploadRow.updateMany({ where: { uploadId: up.id }, data: { resolvedSiteId: child.id, resolvedSiteManual: true } });
    const pre = await stepPrecheck(SEPT, boss(), null);
    expect(pre.warnings.some((w) => w.includes("測試子盤乙") && w.includes("會由本月更表自動推出"))).toBe(true);
    const ctx = new AutoCollector(null, SEPT, boss(), null);
    await stepParseHealth(SEPT, boss(), ctx);
    expect(await activeTypes(child.id)).toHaveLength(1);
    expect(await activeTypes(parent.id)).toHaveLength(0);
    expect(await prisma.rosterUploadRow.count({ where: { uploadId: up.id, shiftTypeId: null } })).toBe(0);
  });

  it("(i) 混合可解析／解析唔到代號：precheck info 提解析唔到嘅代號；d／D 只建一個更種", async () => {
    const site = await prisma.site.create({ data: { canonicalName: "測試混合盤", clientName: "x", billingModel: "per_shift", createdBy: "t" } });
    await mkGuard({ name: "測試甲", staffNo: "U90001" });
    await mkGuard({ name: "測試乙", staffNo: "U90002" });
    await uploadRoster({ siteRaw: "測試混合盤", month: SEPT, uploaderUserId: boss(), siteIdHint: site.id, lines: [
      { broker: "HK", time: "0800-2000", staffNo: "U90001", name: "測試甲", codes: { 1: "D", 2: "d" } },
      { broker: "HK", time: "7pm-7am", staffNo: "U90002", name: "測試乙", codes: { 3: "N" } },
    ] });
    const pre = await stepPrecheck(SEPT, boss(), null);
    expect(pre.warnings.some((w) => w.includes("會由本月更表自動推出 1 個更種") && w.includes("N"))).toBe(true);
    await stepParseHealth(SEPT, boss(), new AutoCollector(null, SEPT, boss(), null));
    expect(await prisma.shiftType.count({ where: { siteId: site.id } })).toBe(1);
  });

  async function failedRunThenUndo(siteId: string) {
    const blocker = await prisma.reconcileAllRun.create({ data: { month: SEPT, status: "running", startedById: boss() } });
    const r1 = await newRun();
    await runOneClickMonthClose(r1.id, SEPT, boss(), null);
    await undoAutoChanges(r1.id, boss(), null);
    await prisma.reconcileAllRun.update({ where: { id: blocker.id }, data: { status: "done", finishedAt: new Date() } });
    expect(await activeTypes(siteId)).toHaveLength(0);
  }

  it("(j) 人手作廢同 code 同開工時間 → 唔復原、唔另建，出分診題＋precheck 講明原因", async () => {
    const site = await seed();
    await prisma.shiftType.create({ data: { siteId: site.id, code: "D", startTime: new Date("1970-01-01T08:00:00Z"), endTime: new Date("1970-01-01T20:00:00Z"), hours: 12, createdBy: "t", voidedAt: new Date(), voidedBy: boss() } });
    const pre = await stepPrecheck(SEPT, boss(), null);
    expect(pre.needsHuman.some((h) => h.includes("人手作廢嘅更種") && h.includes("08:00-20:00"))).toBe(true);
    const ctx = new AutoCollector(null, SEPT, boss(), null);
    await stepParseHealth(SEPT, boss(), ctx);
    expect((await activeTypes(site.id)).map((s) => s.code)).toEqual(["N"]);
    expect(await prisma.shiftType.count({ where: { siteId: site.id, code: "D" } })).toBe(1);
    expect(ctx.questions.some((q) => q.groupKey === `site_shift_type_voided:${site.id}`)).toBe(true);
  });

  it("(k) 一鍵 undo 作廢、規格相同 → 復原（audit unvoid，無另建）", async () => {
    const site = await seed();
    await failedRunThenUndo(site.id);
    const pre = await stepPrecheck(SEPT, boss(), null);
    expect(pre.warnings.some((w) => w.includes("復原之前撤銷嘅 2 個更種"))).toBe(true);
    const r2 = await newRun();
    await runOneClickMonthClose(r2.id, SEPT, boss(), null);
    expect(await activeTypes(site.id)).toHaveLength(2);
    expect(await prisma.shiftType.count({ where: { siteId: site.id } })).toBe(2);
    const ids = (await prisma.shiftType.findMany({ where: { siteId: site.id }, select: { id: true } })).map((x) => x.id);
    expect(await prisma.auditLog.count({ where: { tableName: "shift_types", action: "unvoid", rowId: { in: ids } } })).toBe(2);
  });

  it("(l) 一鍵 undo 作廢但鐘數／收工時間唔同 → 唔復原、唔另建，出題", async () => {
    const site = await seed();
    await failedRunThenUndo(site.id);
    await prisma.shiftType.updateMany({ where: { siteId: site.id, code: "D" }, data: { endTime: new Date("1970-01-01T17:00:00Z"), hours: 9 } });
    const pre = await stepPrecheck(SEPT, boss(), null);
    expect(pre.needsHuman.some((h) => h.includes("一鍵結算撤銷咗嘅更種") && h.includes("9 小時"))).toBe(true);
    const r2 = await newRun();
    await runOneClickMonthClose(r2.id, SEPT, boss(), null);
    const d = await prisma.shiftType.findMany({ where: { siteId: site.id, code: "D" } });
    expect(d).toHaveLength(1);
    expect(d[0]!.voidedAt).not.toBeNull();
    expect(await prisma.shiftRecord.count({ where: { shiftType: { voidedAt: { not: null } }, status: { not: "cancelled" } } })).toBe(0);
    expect(await prisma.triageQuestion.count({ where: { groupKey: `site_shift_type_voided:${site.id}` } })).toBeGreaterThanOrEqual(1);
  });

  it("(m) 盤有其他生效更種、格仍指住已作廢更種 → precheck 出 warning（盤名＋格數），唔提示設價卡", async () => {
    const site = await seed({ preShiftTypes: true });
    const n = await prisma.shiftType.create({ data: { siteId: site.id, code: "N", startTime: new Date("1970-01-01T20:00:00Z"), endTime: new Date("1970-01-01T08:00:00Z"), hours: 12, createdBy: "t", voidedAt: new Date() } });
    await prisma.rosterUploadRow.updateMany({ where: { rawCode: "N", upload: { siteId: site.id } }, data: { shiftTypeId: n.id } });
    const pre = await stepPrecheck(SEPT, boss(), null);
    expect(pre.warnings.some((w) => w.includes(SITE) && w.includes("2 格") && w.includes("更種已作廢"))).toBe(true);
    expect(pre.needsHuman.some((h) => h.includes("「N」冇生效價卡") || h.includes("「N」冇本月生效卡"))).toBe(false);
  });

  const rowIds = async (siteId: string) => (await prisma.rosterUploadRow.findMany({ where: { upload: { siteId } }, select: { id: true }, orderBy: { id: "asc" } })).map((r) => r.id).join(",");

  it("(n)+(p) 永遠配唔到嘅格（7am-7pm 兩個候選）：run1 reparse 一次＋warning 有格數；run2／run3 唔再 reparse（row id 不變、對數決定保留）", async () => {
    const site = await prisma.site.create({ data: { canonicalName: "測試歧義盤", clientName: "x", billingModel: "per_shift", createdBy: "t" } });
    await mkGuard({ name: "測試甲", staffNo: "U90001" });
    const up = (await uploadRoster({ siteRaw: "測試歧義盤", month: SEPT, uploaderUserId: boss(), siteIdHint: site.id, lines: [{ broker: "HK", time: "7am-7pm", staffNo: "U90001", name: "測試甲", codes: { 1: "D", 2: "D" } }] })).upload;
    // 更種喺上載解析之後先建（兩個 D，開工時間唔同）
    await prisma.shiftType.create({ data: { siteId: site.id, code: "D", startTime: new Date("1970-01-01T07:00:00Z"), endTime: new Date("1970-01-01T19:00:00Z"), hours: 12, createdBy: "t" } });
    await prisma.shiftType.create({ data: { siteId: site.id, code: "D", startTime: new Date("1970-01-01T08:00:00Z"), endTime: new Date("1970-01-01T20:00:00Z"), hours: 12, createdBy: "t" } });
    const before = await rowIds(site.id);
    const r1 = await stepParseHealth(SEPT, boss(), new AutoCollector(null, SEPT, boss(), null));
    const after1 = await rowIds(site.id);
    expect(after1).not.toBe(before);
    expect(r1.warnings.some((w) => w.includes("仍有 2 格") && w.includes("測試歧義盤"))).toBe(true);
    const one = await prisma.rosterUploadRow.findFirstOrThrow({ where: { uploadId: up.id } });
    await prisma.rosterReconcileDecision.create({ data: { uploadId: up.id, reconcileKey: `row:${one.id}`, category: "unresolved", action: "exception", reason: "t", decidedBy: boss() } });
    await stepParseHealth(SEPT, boss(), new AutoCollector(null, SEPT, boss(), null));
    await stepParseHealth(SEPT, boss(), new AutoCollector(null, SEPT, boss(), null));
    expect(await rowIds(site.id)).toBe(after1);
    expect(await prisma.rosterReconcileDecision.count({ where: { uploadId: up.id } })).toBe(1);
  });

  it("(o) 人手 unvoid＋PATCH 更種之後再撳一鍵 → reparse 一次、格配到、更次入數；之後唔再 reparse", async () => {
    const site = await seed();
    const d = await prisma.shiftType.create({ data: { siteId: site.id, code: "D", startTime: new Date("1970-01-01T09:00:00Z"), endTime: new Date("1970-01-01T21:00:00Z"), hours: 12, createdBy: "t", voidedAt: new Date(), voidedBy: boss() } });
    await prisma.shiftType.create({ data: { siteId: site.id, code: "N", startTime: new Date("1970-01-01T20:00:00Z"), endTime: new Date("1970-01-01T08:00:00Z"), hours: 12, createdBy: "t" } });
    const r1 = await newRun();
    await runOneClickMonthClose(r1.id, SEPT, boss(), null);
    expect(await prisma.shiftRecord.count({ where: { siteId: site.id, workDate: { gte: SEPT }, status: { not: "cancelled" } } })).toBe(2);
    // 用戶跟分診題：unvoid＋改時間
    await prisma.shiftType.update({ where: { id: d.id }, data: { voidedAt: null, voidedBy: null, startTime: new Date("1970-01-01T08:00:00Z"), endTime: new Date("1970-01-01T20:00:00Z") } });
    const r2 = await newRun();
    await runOneClickMonthClose(r2.id, SEPT, boss(), null);
    expect(await prisma.shiftRecord.count({ where: { siteId: site.id, workDate: { gte: SEPT }, status: { not: "cancelled" } } })).toBe(5);
    const ids2 = await rowIds(site.id);
    const r3 = await newRun();
    await runOneClickMonthClose(r3.id, SEPT, boss(), null);
    expect(await rowIds(site.id)).toBe(ids2);
  });
});

