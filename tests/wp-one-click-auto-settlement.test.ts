// WP-ONE-CLICK-AUTO（§31.3 D）：結算雞頭自動歸屬——次序 Postorder 同崗位同日雞頭 → 長工 → 預設雞頭 →
// 近 3 個月同盤多數決（保安員或同一更表姓名）→ 分診（預填最可能候選）；external 永遠分開計。
import { describe, it, expect, beforeEach } from "vitest";
import type { Broker } from "@prisma/client";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { AUG, SEPT, aug, sep, mkBroker, mkGuard, seedPostorder, postorderCsv, rosterCsv, seedUploadWithRows } from "./lib/one-click-auto";
import { AutoCollector } from "@/lib/month-close/auto/context";
import { runAutoSettlement } from "@/lib/month-close/auto/settlement";
import { undoAutoChanges } from "@/lib/month-close/auto/undo";

const time = (hhmm: string) => new Date(`1970-01-01T${hhmm.slice(0, 2)}:${hhmm.slice(2)}:00.000Z`);

describe("WP-ONE-CLICK-AUTO D：結算雞頭歸屬", () => {
  let fx: Wp2Fixture;
  let K: Broker;
  let W: Broker;
  let B07: Broker;
  let B10: Broker;

  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    K = await mkBroker("SK", "broker", { aliases: ["測試淦"] });
    W = await mkBroker("SW", "broker");
    B07 = await mkBroker("SB07", "internal_longterm");
    B10 = await mkBroker("SB10", "external", { aliases: ["Wilson Guard"] });
  });

  async function mkSite(name: string) {
    const site = await prisma.site.create({ data: { canonicalName: name, clientName: `${name}客戶`, billingModel: "per_shift", createdBy: "t" } });
    const d = await prisma.shiftType.create({ data: { siteId: site.id, code: "D", startTime: time("0700"), endTime: time("1900"), hours: 12, createdBy: "t" } });
    return { site, d };
  }
  const rec = (siteId: string, shiftTypeId: string, guardId: string, workDate: Date, settlementBrokerId: string | null = null) =>
    prisma.shiftRecord.create({ data: { workDate, siteId, shiftTypeId, guardId, settlementBrokerId, operationalBrokerId: settlementBrokerId, recordType: "shift", status: "confirmed", source: "roster_upload", createdBy: "t" } });
  async function runCtx() {
    const run = await prisma.monthCloseRun.create({ data: { month: SEPT, status: "running", startedById: fx.userIds["老闆"], applyStartedAt: new Date() } });
    return { run, ctx: new AutoCollector(run.id, SEPT, fx.userIds["老闆"], null) };
  }

  it("次序 2：Postorder 同崗位同日雞頭（別名 → K）；長工格「(8) 長工」唔計；雞頭唔唯一就唔用", async () => {
    const { site, d } = await mkSite("測試歸屬盤A");
    const g = await mkGuard();
    await seedPostorder(SEPT, fx.userIds["老闆"], {
      postorderCsv: postorderCsv([{ label: "測試歸屬盤A", prop: "歸A", shift: "Day", client: 900, payout: 800, time: "0700-1900", total: 10 }]),
      rosterCsv: rosterCsv([
        { label: "測試歸屬盤A", prop: "歸A", shift: "Day", days: { 5: "(2) 測試淦", 6: "(2) 測試淦", 7: "(2) SW" } },
        { label: "測試歸屬盤A", prop: "歸A", shift: "Day", days: { 6: "(8) 長工", 7: "(2) SK" } },
      ]),
    });
    await rec(site.id, d.id, g.id, sep(5));
    await rec(site.id, d.id, g.id, sep(6));
    await rec(site.id, d.id, g.id, sep(7)); // SW + SK 兩個雞頭 → 唔唯一
    const { ctx, run } = await runCtx();
    const res = await runAutoSettlement(ctx, SEPT);
    expect(res.assigned).toBe(2); // 5、6 號（6 號有長工格但長工唔計）
    const rs = await prisma.shiftRecord.findMany({ where: { siteId: site.id }, orderBy: { workDate: "asc" } });
    expect(rs[0]!.settlementBrokerId).toBe(K.id);
    expect(rs[1]!.settlementBrokerId).toBe(K.id);
    expect(rs[2]!.settlementBrokerId).toBeNull();
    expect(ctx.summary.recordsSettled).toBe(2);
    const j = await prisma.monthCloseAutoChange.findMany({ where: { runId: run.id, kind: "settlement_set" } });
    expect(j.length).toBeGreaterThan(0);
    const aud = await prisma.auditLog.findMany({ where: { tableName: "shift_records", rowId: { startsWith: "auto_settlement:" } } });
    expect(aud.some((a) => JSON.stringify(a.after).includes(`auto:one-click:${run.id}`))).toBe(true);
  });

  it("次序 3：長工 → B07；external 類 → 唯一 external 雞頭", async () => {
    const { site, d } = await mkSite("測試歸屬盤B");
    const lt = await mkGuard({ employmentType: "longterm_autopay" });
    const ex = await mkGuard({ employmentType: "external" });
    await rec(site.id, d.id, lt.id, sep(1));
    await rec(site.id, d.id, ex.id, sep(1));
    const { ctx } = await runCtx();
    await runAutoSettlement(ctx, SEPT);
    expect((await prisma.shiftRecord.findFirstOrThrow({ where: { guardId: lt.id } })).settlementBrokerId).toBe(B07.id);
    expect((await prisma.shiftRecord.findFirstOrThrow({ where: { guardId: ex.id } })).settlementBrokerId).toBe(B10.id);
  });

  it("次序 4：保安員預設雞頭", async () => {
    const { site, d } = await mkSite("測試歸屬盤C");
    const g = await mkGuard({ defaultBrokerId: W.id });
    await rec(site.id, d.id, g.id, sep(2));
    const { ctx } = await runCtx();
    await runAutoSettlement(ctx, SEPT);
    expect((await prisma.shiftRecord.findFirstOrThrow({ where: { guardId: g.id } })).settlementBrokerId).toBe(W.id);
  });

  it("次序 5：近 3 個月同盤結算雞頭多數決（唯一）；打和就唔自動", async () => {
    const { site, d } = await mkSite("測試歸屬盤D");
    const g = await mkGuard();
    const tie = await mkGuard();
    for (const day of [1, 2, 3]) await rec(site.id, d.id, g.id, aug(day), W.id);
    await rec(site.id, d.id, g.id, aug(4), K.id);
    await rec(site.id, d.id, tie.id, aug(1), W.id);
    await rec(site.id, d.id, tie.id, aug(2), K.id);
    await rec(site.id, d.id, g.id, sep(10));
    await rec(site.id, d.id, tie.id, sep(10));
    const { ctx } = await runCtx();
    const res = await runAutoSettlement(ctx, SEPT);
    expect((await prisma.shiftRecord.findFirstOrThrow({ where: { guardId: g.id, workDate: sep(10) } })).settlementBrokerId).toBe(W.id);
    expect((await prisma.shiftRecord.findFirstOrThrow({ where: { guardId: tie.id, workDate: sep(10) } })).settlementBrokerId).toBeNull();
    expect(res.assigned).toBe(1);
    expect(res.unresolved).toBe(1);
  });

  it("修11：新保安員（冇歷史）唔准靠更表姓名跨保安員回溯 → 唔自動歸屬，入分診", async () => {
    const { site, d } = await mkSite("測試歸屬盤E");
    const oldGuard = await mkGuard({ name: "測試舊人" });
    const newGuard = await mkGuard({ name: "測試新人（同一個人）" });
    await seedUploadWithRows({ month: AUG, siteId: site.id, siteNameRaw: site.canonicalName, uploaderUserId: fx.userIds["老闆"], status: "confirmed", rows: Array.from({ length: 6 }, (_, i) => ({ day: i + 1, nameRaw: "測試舊名", staffNoRaw: "U9888", guardId: oldGuard.id, settlementBrokerId: W.id })) });
    await seedUploadWithRows({ month: SEPT, siteId: site.id, siteNameRaw: site.canonicalName, uploaderUserId: fx.userIds["老闆"], rows: [{ day: 3, nameRaw: "測試舊名", staffNoRaw: "U9888", guardId: newGuard.id, settlementBrokerId: null }] });
    await rec(site.id, d.id, newGuard.id, sep(3));
    const { ctx } = await runCtx();
    const res = await runAutoSettlement(ctx, SEPT);
    expect(res.assigned).toBe(0);
    expect(res.unresolved).toBe(1);
    expect((await prisma.shiftRecord.findFirstOrThrow({ where: { guardId: newGuard.id } })).settlementBrokerId).toBeNull();
    expect(ctx.questions).toHaveLength(1);
  });

  it("次序 6：全部冇 → 分診題 month_close_settlement，預填同盤本月最常見雞頭（唯一先預填）", async () => {
    const { site, d } = await mkSite("測試歸屬盤F");
    const known = await mkGuard();
    const g = await mkGuard();
    for (const day of [1, 2, 3]) await rec(site.id, d.id, known.id, sep(day), K.id);
    await rec(site.id, d.id, g.id, sep(9));
    const { ctx } = await runCtx();
    const res = await runAutoSettlement(ctx, SEPT);
    expect(res.unresolved).toBe(1);
    expect(ctx.questions).toHaveLength(1);
    const q = ctx.questions[0]!;
    expect(q.kind).toBe("month_close_settlement");
    expect(q.evidence.candidates[0]!.refId).toBe(K.id);
    expect(q.evidence.prefillCandidateId).toBe("c0");
    expect(q.evidence.confidence).toBe("propose");
    expect((await prisma.shiftRecord.findFirstOrThrow({ where: { guardId: g.id } })).settlementBrokerId).toBeNull();
  });

  it("undo：自動歸屬還原（之後人手改過嘅唔郁）", async () => {
    const { site, d } = await mkSite("測試歸屬盤G");
    const g = await mkGuard({ defaultBrokerId: W.id });
    const r1 = await rec(site.id, d.id, g.id, sep(1));
    const r2 = await rec(site.id, d.id, g.id, sep(2));
    const { ctx, run } = await runCtx();
    await runAutoSettlement(ctx, SEPT);
    await prisma.monthCloseRun.update({ where: { id: run.id }, data: { status: "done" } });
    // 人手將 r2 改去 K
    await prisma.shiftRecord.update({ where: { id: r2.id }, data: { settlementBrokerId: K.id } });
    const res = await undoAutoChanges(run.id, fx.userIds["老闆"], null);
    expect(res.undone.settlement).toBe(1);
    expect((await prisma.shiftRecord.findUniqueOrThrow({ where: { id: r1.id } })).settlementBrokerId).toBeNull();
    expect((await prisma.shiftRecord.findUniqueOrThrow({ where: { id: r2.id } })).settlementBrokerId).toBe(K.id);
    const again = await undoAutoChanges(run.id, fx.userIds["老闆"], null);
    expect(again.alreadyUndone).toBe(true);
    expect(Object.values(again.undone).reduce((a, b) => a + b, 0)).toBe(0);
  });
});
