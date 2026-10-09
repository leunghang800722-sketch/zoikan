// WP-ONE-CLICK-AUTO（§31.3 C）：自動定價——次序 1–6 各一；auto 卡金額＝來源值（唔平均／唔估）、
// reprice 生效；propose／unknown 入分診；未定價唔當 0（估算缺口分開列）；OT 淨係配同 OT 更種卡。
import { describe, it, expect, beforeEach } from "vitest";
import type { Broker, Guard, Site, ShiftType } from "@prisma/client";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { AUG, SEPT, aug, sep, mkBroker, mkGuard, seedPostorder, postorderCsv } from "./lib/one-click-auto";
import { AutoCollector } from "@/lib/month-close/auto/context";
import { runAutoPricing, estimateUnpricedGap, createCardAndPrice } from "@/lib/month-close/auto/pricing";
import { SimpleWriter } from "@/lib/month-close/auto/context";
import { buildUnpricedSummary } from "@/lib/pricing/unpriced";
import { stepAutoPricing } from "@/lib/month-close/one-click";

const time = (hhmm: string) => new Date(`1970-01-01T${hhmm.slice(0, 2)}:${hhmm.slice(2)}:00.000Z`);

describe("WP-ONE-CLICK-AUTO C：自動定價", () => {
  let fx: Wp2Fixture;
  let K: Broker;
  let W: Broker;
  let Z: Broker;
  let Y: Broker;
  let guard: Guard;
  let n = 0;

  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    K = await mkBroker("PK", "broker");
    W = await mkBroker("PW", "broker");
    Z = await mkBroker("PZ", "broker");
    Y = await mkBroker("PY", "internal_cash");
    guard = await mkGuard();
    n = 0;
  });

  async function mkSite(name: string, extra: { clientName?: string } = {}): Promise<{ site: Site; d: ShiftType; nn: ShiftType }> {
    const site = await prisma.site.create({ data: { canonicalName: name, clientName: extra.clientName ?? `${name}客戶`, billingModel: "per_shift", createdBy: "t" } });
    const d = await prisma.shiftType.create({ data: { siteId: site.id, code: "D", startTime: time("0700"), endTime: time("1900"), hours: 12, createdBy: "t" } });
    const nn = await prisma.shiftType.create({ data: { siteId: site.id, code: "N", startTime: time("1900"), endTime: time("0700"), hours: 12, createdBy: "t" } });
    return { site, d, nn };
  }
  async function mkRecords(siteId: string, shiftTypeId: string, brokerId: string | null, count: number, opts: { ot?: boolean; guardId?: string; clientSnap?: number } = {}) {
    for (let i = 0; i < count; i++) {
      n++;
      await prisma.shiftRecord.create({
        data: {
          workDate: sep((n % 28) + 1),
          siteId,
          shiftTypeId,
          guardId: opts.guardId ?? guard.id,
          settlementBrokerId: brokerId,
          operationalBrokerId: brokerId,
          recordType: opts.ot ? "ot" : "shift",
          otHours: opts.ot ? 2 : null,
          clientRateSnapshot: opts.clientSnap ?? null,
          status: "confirmed",
          source: "roster_upload",
          createdBy: "t",
        },
      });
      // 同一 guard+日+更種唯一：每條用唔同日；超過 28 條就換 guard
      if (n % 28 === 0) guard = await mkGuard();
    }
  }
  async function runCtx() {
    const run = await prisma.monthCloseRun.create({ data: { month: SEPT, status: "running", startedById: fx.userIds["老闆"], applyStartedAt: new Date() } });
    return { run, ctx: new AutoCollector(run.id, SEPT, fx.userIds["老闆"], null) };
  }
  const card = (data: Record<string, unknown>) => prisma.rateCard.create({ data: { effectiveFrom: aug(1), effectiveTo: aug(31), billingModel: "per_shift", createdBy: "t", ...data } as never });
  const snap = async (siteId: string) => (await prisma.shiftRecord.findMany({ where: { siteId, status: { not: "cancelled" } } })).map((r) => [Number(r.clientRateSnapshot ?? NaN), Number(r.guardWageSnapshot ?? NaN), Number(r.brokerFeeSnapshot ?? NaN)]);
  const unpriced = async () => (await buildUnpricedSummary({ userId: fx.userIds["老闆"], baseRole: "老闆", brokerId: null } as never, SEPT)).count;

  it("次序 1：同盤同更種同雞頭上月卡 → auto 沿用（金額＝上月卡），卡 effective_from＝本月 1 號，reprice 生效", async () => {
    const { site, d } = await mkSite("測試價盤1");
    await card({ siteId: site.id, shiftTypeId: d.id, brokerId: K.id, clientRate: 900, guardWage: 700, brokerFee: 20, payoutRate: 720 });
    // 更早一張（平啲）——必須用最近一張，唔平均
    await card({ siteId: site.id, shiftTypeId: d.id, brokerId: K.id, clientRate: 700, guardWage: 500, brokerFee: 10, payoutRate: 510, effectiveFrom: new Date(Date.UTC(2026, 5, 1)), effectiveTo: new Date(Date.UTC(2026, 6, 31)) });
    await mkRecords(site.id, d.id, K.id, 5);
    expect(await unpriced()).toBe(5);
    const { run, ctx } = await runCtx();
    const res = await runAutoPricing(ctx, SEPT);
    expect(res.autoGroups).toBe(1);
    const created = await prisma.rateCard.findFirstOrThrow({ where: { source: `auto:one-click:${run.id}` } });
    expect(created.effectiveFrom.toISOString().slice(0, 10)).toBe("2026-09-01");
    expect(created.effectiveTo?.toISOString().slice(0, 10)).toBe("2026-09-30");
    expect([Number(created.clientRate), Number(created.guardWage), Number(created.brokerFee), Number(created.payoutRate)]).toEqual([900, 700, 20, 720]);
    expect(created.brokerId).toBe(K.id);
    expect(created.evidence).toContain("沿用同盤同更種");
    expect(created.confidence).toBe("auto");
    for (const s of await snap(site.id)) expect(s).toEqual([900, 700, 20]);
    expect(await unpriced()).toBe(0);
    expect(ctx.summary.cardsCreated).toBe(1);
    expect(ctx.summary.recordsPriced).toBe(5);
    const j = await prisma.monthCloseAutoChange.findMany({ where: { runId: run.id }, orderBy: { createdAt: "asc" } });
    expect(j.map((x) => x.kind)).toEqual(["rate_card_created", "price_snapshots"]);
    const audit = await prisma.auditLog.findMany({ where: { tableName: "rate_cards", rowId: created.id } });
    expect(JSON.stringify(audit[0]!.after)).toContain(`auto:one-click:${run.id}`);
    // 冪等：再跑唔會再建卡
    const again = await runAutoPricing(ctx, SEPT);
    expect(again.groups).toBe(0);
    expect(await prisma.rateCard.count({ where: { source: `auto:one-click:${run.id}` } })).toBe(1);
  });

  it("次序 1：只喺最近 3 個月內完結先沿用（4 個月前嘅卡唔沿用 → 落去冇依據）", async () => {
    const { site, d } = await mkSite("測試價盤1b");
    await card({ siteId: site.id, shiftTypeId: d.id, brokerId: K.id, clientRate: 900, guardWage: 700, effectiveFrom: new Date(Date.UTC(2026, 3, 1)), effectiveTo: new Date(Date.UTC(2026, 4, 31)) });
    await mkRecords(site.id, d.id, K.id, 3);
    const { ctx } = await runCtx();
    const res = await runAutoPricing(ctx, SEPT);
    expect(res.autoGroups).toBe(0);
    expect(res.unknownGroups).toBe(1);
    expect(await prisma.rateCard.count({ where: { source: { startsWith: "auto:one-click:" } } })).toBe(0);
  });

  it("次序 2：Postorder 同盤同崗位同雞頭外判價／上單價（唯一值）→ auto；逐人特價行唔計；金額＝Postorder 值", async () => {
    const { site } = await mkSite("測試價盤2");
    const d = await prisma.shiftType.findFirstOrThrow({ where: { siteId: site.id, code: "D" } });
    await seedPostorder(SEPT, fx.userIds["老闆"], {
      postorderCsv: postorderCsv([
        { label: "測試價盤2 PK", prop: "測試價2", shift: "Day", client: 880, payout: 760, time: "0700-1900", total: 30 },
        { label: "測試價盤2 PK", prop: "測試價2", shift: "Day", client: 880, payout: 760, time: "0700-1900", total: 10 },
        { label: "測試價盤2 陳大文", prop: "測試價2", shift: "Day", client: 880, payout: 601, time: "0700-1900", total: 25 },
        { label: "測試價盤2 PW", prop: "測試價2", shift: "Day", client: 880, payout: 777, time: "0700-1900", total: 25 },
      ]),
    });
    await mkRecords(site.id, d.id, K.id, 4);
    const { ctx } = await runCtx();
    const res = await runAutoPricing(ctx, SEPT);
    expect(res.autoGroups).toBe(1);
    const created = await prisma.rateCard.findFirstOrThrow({ where: { siteId: site.id } });
    expect(Number(created.clientRate)).toBe(880);
    expect(Number(created.payoutRate)).toBe(760);
    expect(created.guardWage).toBeNull();
    expect(created.evidence).toContain("Postorder");
    expect(created.evidence).toContain("PK");
    for (const s of await snap(site.id)) expect(s).toEqual([880, 760, 0]);
  });

  it("次序 2：同雞頭嘅 Postorder 價唔唯一 → 唔 auto（落後面次序／分診）", async () => {
    const { site, d } = await mkSite("測試價盤2b");
    await seedPostorder(SEPT, fx.userIds["老闆"], {
      postorderCsv: postorderCsv([
        { label: "測試價盤2b PK", prop: "測試價2b", shift: "Day", client: 880, payout: 760, time: "0700-1900", total: 30 },
        { label: "測試價盤2b PK", prop: "測試價2b", shift: "Day", client: 880, payout: 800, time: "0700-1900", total: 10 },
      ]),
    });
    await mkRecords(site.id, d.id, K.id, 2);
    const { ctx } = await runCtx();
    const res = await runAutoPricing(ctx, SEPT);
    expect(res.autoGroups).toBe(0);
    expect(await prisma.rateCard.count({ where: { siteId: site.id } })).toBe(0);
  });

  it("次序 2：Postorder 只得泛用行（冇任何雞頭專屬行）、值唯一 → auto（崗位價唔按雞頭分）", async () => {
    const { site, d } = await mkSite("測試價盤2c");
    await seedPostorder(SEPT, fx.userIds["老闆"], {
      postorderCsv: postorderCsv([{ label: "測試價盤2c", prop: "測試價2c", shift: "Day", client: 850, payout: 740, time: "0700-1900", total: 30 }]),
    });
    await mkRecords(site.id, d.id, K.id, 2);
    const { ctx } = await runCtx();
    const res = await runAutoPricing(ctx, SEPT);
    expect(res.autoGroups).toBe(1);
    const created = await prisma.rateCard.findFirstOrThrow({ where: { siteId: site.id } });
    expect([Number(created.clientRate), Number(created.payoutRate)]).toEqual([850, 740]);
    expect(created.evidence).toContain("冇按雞頭分價");
  });

  it("次序 2：泛用行唯一，但有其他雞頭專屬行（價可能因雞頭而異）而呢個雞頭冇 → propose（唔自動）", async () => {
    const { site, d } = await mkSite("測試價盤2d");
    await seedPostorder(SEPT, fx.userIds["老闆"], {
      postorderCsv: postorderCsv([
        { label: "測試價盤2d", prop: "測試價2d", shift: "Day", client: 850, payout: 740, time: "0700-1900", total: 30 },
        { label: "測試價盤2d PW", prop: "測試價2d", shift: "Day", client: 850, payout: 700, time: "0700-1900", total: 30 },
      ]),
    });
    await mkRecords(site.id, d.id, K.id, 2);
    const { ctx } = await runCtx();
    const res = await runAutoPricing(ctx, SEPT);
    expect(res.autoGroups).toBe(0);
    expect(res.proposeGroups).toBe(1);
    expect(ctx.questions[0]!.evidence.candidates[0]!.values?.payoutRate).toBe(740);
    expect(ctx.questions[0]!.evidence.confidence).toBe("propose");
    expect(await prisma.rateCard.count({ where: { siteId: site.id } })).toBe(0);
  });

  it("次序 3：其他同類雞頭嘅卡全部一樣 → auto（淨補出街價，唔帶客價）", async () => {
    const { site, d } = await mkSite("測試價盤3");
    await card({ siteId: site.id, shiftTypeId: d.id, brokerId: null, clientRate: 900, effectiveFrom: aug(1), effectiveTo: null });
    await card({ siteId: site.id, shiftTypeId: d.id, brokerId: W.id, guardWage: 700, brokerFee: 20, effectiveFrom: sep(1), effectiveTo: null });
    await card({ siteId: site.id, shiftTypeId: d.id, brokerId: Z.id, guardWage: 700, brokerFee: 20, effectiveFrom: sep(1), effectiveTo: null });
    await mkRecords(site.id, d.id, K.id, 3, { clientSnap: 900 });
    const { ctx } = await runCtx();
    const res = await runAutoPricing(ctx, SEPT);
    expect(res.autoGroups).toBe(1);
    const created = await prisma.rateCard.findFirstOrThrow({ where: { siteId: site.id, brokerId: K.id } });
    expect(created.clientRate).toBeNull();
    expect([Number(created.guardWage), Number(created.brokerFee)]).toEqual([700, 20]);
    expect(created.evidence).toContain("其他同類雞頭");
    const rs = await prisma.shiftRecord.findMany({ where: { siteId: site.id } });
    for (const r of rs) expect([Number(r.guardWageSnapshot), Number(r.brokerFeeSnapshot), Number(r.clientRateSnapshot)]).toEqual([700, 20, 900]);
  });

  it("次序 3：其他同類雞頭嘅卡唔一樣 → propose，列候選，唔建卡；公司兵只同公司兵比（唔借雞頭價）", async () => {
    const { site, d } = await mkSite("測試價盤3b");
    await card({ siteId: site.id, shiftTypeId: d.id, brokerId: null, clientRate: 900, effectiveFrom: aug(1), effectiveTo: null });
    await card({ siteId: site.id, shiftTypeId: d.id, brokerId: W.id, guardWage: 700, effectiveFrom: sep(1), effectiveTo: null });
    await card({ siteId: site.id, shiftTypeId: d.id, brokerId: Z.id, guardWage: 650, effectiveFrom: sep(1), effectiveTo: null });
    await mkRecords(site.id, d.id, K.id, 3, { clientSnap: 900 });
    await mkRecords(site.id, d.id, Y.id, 2, { clientSnap: 900 });
    const { ctx } = await runCtx();
    const res = await runAutoPricing(ctx, SEPT);
    expect(res.autoGroups).toBe(0);
    expect(await prisma.rateCard.count({ where: { siteId: site.id, source: { startsWith: "auto:one-click:" } } })).toBe(0);
    const qK = ctx.questions.find((q) => q.groupKey.includes(`:${d.id}:${K.id}:`));
    expect(qK?.evidence.candidates.map((c) => c.values?.guardWage).sort()).toEqual([650, 700]);
    expect(qK?.evidence.confidence).toBe("propose");
    // 公司兵：冇同類（internal_cash）卡 → unknown，唔會借 W／Z 嘅價
    const qY = ctx.questions.find((q) => q.groupKey.includes(`:${d.id}:${Y.id}:`));
    expect(qY?.evidence.candidates).toHaveLength(0);
    expect(qY?.evidence.confidence).toBe("unknown");
  });

  it("次序 4：同雞頭同盤其他更種、鐘數相同 → propose（唔 auto）", async () => {
    const { site, d, nn } = await mkSite("測試價盤4");
    await card({ siteId: site.id, shiftTypeId: null, brokerId: null, clientRate: 900, effectiveFrom: aug(1), effectiveTo: null });
    await card({ siteId: site.id, shiftTypeId: nn.id, brokerId: K.id, guardWage: 710, effectiveFrom: sep(1), effectiveTo: null });
    await mkRecords(site.id, d.id, K.id, 2, { clientSnap: 900 });
    const { ctx } = await runCtx();
    const res = await runAutoPricing(ctx, SEPT);
    expect(res.autoGroups).toBe(0);
    expect(res.proposeGroups).toBe(1);
    const q = ctx.questions[0]!;
    expect(q.evidence.candidates[0]!.values?.guardWage).toBe(710);
    expect(q.evidence.candidates[0]!.label).toContain("N");
    expect(q.evidence.prefillCandidateId).toBe("c0");
  });

  it("次序 5：盤通用客價＋同客戶群其他盤該雞頭嘅常見外判價 → propose", async () => {
    const a = await mkSite("測試價盤5A", { clientName: "測試同客戶群" });
    const b = await mkSite("測試價盤5B", { clientName: "測試同客戶群" });
    await card({ siteId: a.site.id, shiftTypeId: null, brokerId: null, clientRate: 950, effectiveFrom: aug(1), effectiveTo: null });
    await card({ siteId: b.site.id, shiftTypeId: b.nn.id, brokerId: K.id, guardWage: 800, effectiveFrom: sep(1), effectiveTo: null });
    await card({ siteId: b.site.id, shiftTypeId: b.d.id, brokerId: K.id, guardWage: 800, effectiveFrom: sep(1), effectiveTo: null });
    await mkRecords(a.site.id, a.d.id, K.id, 2, { clientSnap: 950 });
    const { ctx } = await runCtx();
    const res = await runAutoPricing(ctx, SEPT);
    expect(res.autoGroups).toBe(0);
    const q = ctx.questions.find((x) => x.evidence.action.type === "pricing")!;
    expect(q.evidence.candidates.map((c) => c.values?.guardWage)).toContain(800);
    expect(q.evidence.candidates.find((c) => c.values?.guardWage === 800)?.evidence).toContain("同客戶群");
    expect(await prisma.rateCard.count({ where: { siteId: a.site.id, source: { startsWith: "auto:one-click:" } } })).toBe(0);
  });

  it("次序 6：完全冇依據 → unknown 分診題（冇預填），唔建卡；未定價唔當 0 成本——估算缺口分開列", async () => {
    const { site, d } = await mkSite("測試價盤6");
    // 久遠舊卡（>3 個月）只做估算缺口參考，唔會自動沿用
    await card({ siteId: site.id, shiftTypeId: d.id, brokerId: K.id, clientRate: 900, guardWage: 700, brokerFee: 20, effectiveFrom: new Date(Date.UTC(2026, 0, 1)), effectiveTo: new Date(Date.UTC(2026, 2, 31)) });
    await mkRecords(site.id, d.id, K.id, 4);
    const { ctx } = await runCtx();
    const res = await runAutoPricing(ctx, SEPT);
    expect(res.autoGroups).toBe(0);
    expect(res.unknownGroups).toBe(1);
    expect(ctx.questions).toHaveLength(1);
    expect(ctx.questions[0]!.kind).toBe("month_close_pricing");
    expect(ctx.questions[0]!.evidence.confidence).toBe("unknown");
    expect(ctx.questions[0]!.evidence.prefillCandidateId).toBeNull();
    expect(await unpriced()).toBe(4);
    for (const s of await snap(site.id)) expect(s.every((x) => Number.isNaN(x))).toBe(true); // 仍然係 null，唔係 0
    const gap = await estimateUnpricedGap(SEPT);
    expect(gap.records).toBe(4);
    expect(gap.clientGapEstimate).toBe(3600);
    expect(gap.payoutGapEstimate).toBe(2880);
    expect(gap.noReferenceRecords).toBe(0);
  });

  it("新盤冇任何價可推 → 一條 site_new 題（唔係逐組 pricing 題）", async () => {
    const { site, d, nn } = await mkSite("測試價盤6new");
    await mkRecords(site.id, d.id, K.id, 2);
    await mkRecords(site.id, nn.id, K.id, 2);
    const { ctx } = await runCtx();
    ctx.newSiteIds.add(site.id);
    await runAutoPricing(ctx, SEPT);
    expect(ctx.questions.map((q) => q.kind)).toEqual(["month_close_site_new"]);
    expect(ctx.questions[0]!.evidence.action.type === "site_new" && ctx.questions[0]!.evidence.action.groups).toHaveLength(2);
  });

  it("OT：只配同一個 OT 更種上月卡（金額＝每小時價）；冇卡 → unknown，唔借正更卡", async () => {
    const { site, d } = await mkSite("測試價盤OT");
    const ot = await prisma.shiftType.create({ data: { siteId: site.id, code: "OT2", hours: 2, createdBy: "t" } });
    await card({ siteId: site.id, shiftTypeId: d.id, brokerId: K.id, clientRate: 900, guardWage: 700, brokerFee: 20 });
    await mkRecords(site.id, ot.id, K.id, 2, { ot: true });
    let { ctx } = await runCtx();
    let res = await runAutoPricing(ctx, SEPT);
    expect(res.autoGroups).toBe(0);
    expect(ctx.questions[0]!.evidence.confidence).toBe("unknown");
    // 有同一個 OT 更種上月卡 → auto
    await card({ siteId: site.id, shiftTypeId: ot.id, brokerId: K.id, clientRate: 85, guardWage: 73, brokerFee: 0, payoutRate: 73 });
    ({ ctx } = await runCtx());
    res = await runAutoPricing(ctx, SEPT);
    expect(res.autoGroups).toBe(1);
    const rs = await prisma.shiftRecord.findMany({ where: { siteId: site.id, recordType: "ot" } });
    for (const r of rs) expect([Number(r.clientRateSnapshot), Number(r.guardWageSnapshot)]).toEqual([170, 146]); // 2 小時 × 85／73
  });

  it("stepAutoPricing：冇結算雞頭嘅更唔入 pricing（交俾結算歸屬）；2026-08 之前唔做", async () => {
    const { site, d } = await mkSite("測試價盤noset");
    await card({ siteId: site.id, shiftTypeId: d.id, brokerId: null, clientRate: 900, effectiveTo: null });
    await mkRecords(site.id, d.id, null, 3);
    const { ctx } = await runCtx();
    const res = await runAutoPricing(ctx, SEPT);
    expect(res.groups).toBe(0); // 客價按現有生效卡補咗；冇雞頭嘅出街價唔喺度處理
    for (const r of await prisma.shiftRecord.findMany({ where: { siteId: site.id } })) expect(Number(r.clientRateSnapshot)).toBe(900);
    expect(ctx.summary.recordsPriced).toBe(3);
    const early = await stepAutoPricing(new Date(Date.UTC(2026, 6, 1)), fx.userIds["老闆"], ctx);
    expect(early.numbers).toEqual({ skipped: true });
  });

  it("createCardAndPrice：已鎖月份拒絕；價錢唔齊拒絕", async () => {
    const { site, d } = await mkSite("測試價盤lock");
    await mkRecords(site.id, d.id, K.id, 1);
    const writer = new SimpleWriter("triage:test", fx.userIds["老闆"], null);
    await expect(createCardAndPrice(writer, { month: SEPT, group: { siteId: site.id, shiftTypeId: d.id, brokerId: K.id, ot: false }, need: { client: true, payout: true }, values: { clientRate: 900, guardWage: null, brokerFee: null, payoutRate: null }, evidence: "t", note: "t", confidence: "confirmed" })).rejects.toThrow(/價錢唔齊/);
    await prisma.monthClose.create({ data: { month: SEPT, lockedAt: new Date(), lockedBy: fx.userIds["老闆"], createdBy: "t" } });
    await expect(createCardAndPrice(writer, { month: SEPT, group: { siteId: site.id, shiftTypeId: d.id, brokerId: K.id, ot: false }, need: { client: true, payout: true }, values: { clientRate: 900, guardWage: 700, brokerFee: null, payoutRate: 700 }, evidence: "t", note: "t", confidence: "confirmed" })).rejects.toThrow(/已鎖定/);
    expect(await prisma.rateCard.count({ where: { siteId: site.id } })).toBe(0);
    void AUG;
  });

  // ---- Opus 驗收修正 ----
  it("修3：公司兵（internal_cash）一律唔用 Postorder 泛用行（只 propose）；泛用行 + 逐人行 → 外判雞頭亦只 propose", async () => {
    const { site, d } = await mkSite("測試價盤3x");
    await seedPostorder(SEPT, fx.userIds["老闆"], {
      postorderCsv: postorderCsv([{ label: "測試價盤3x", prop: "測3x", shift: "Day", client: 850, payout: 740, time: "0700-1900", total: 30 }]),
    });
    await mkRecords(site.id, d.id, Y.id, 2);
    let { ctx } = await runCtx();
    let res = await runAutoPricing(ctx, SEPT);
    expect(res.autoGroups).toBe(0);
    expect(await prisma.rateCard.count({ where: { siteId: site.id } })).toBe(0);
    // 泛用行＋逐人行：K 亦只 propose
    const b = await mkSite("測試價盤3y");
    await prisma.postorderUpload.deleteMany({});
    await seedPostorder(SEPT, fx.userIds["老闆"], {
      postorderCsv: postorderCsv([
        { label: "測試價盤3y", prop: "測3y", shift: "Day", client: 850, payout: 740, time: "0700-1900", total: 30 },
        { label: "測試價盤3y 陳大文", prop: "測3y", shift: "Day", client: 850, payout: 601, time: "0700-1900", total: 20 },
      ]),
    });
    await mkRecords(b.site.id, b.d.id, K.id, 2);
    ({ ctx } = await runCtx());
    res = await runAutoPricing(ctx, SEPT);
    expect(res.autoGroups).toBe(0);
    expect(await prisma.rateCard.count({ where: { siteId: b.site.id } })).toBe(0);
  });

  it("修4：淨缺客價——同雞頭卡優先；其他雞頭卡要全部一致先 auto 而且卡帶該雞頭 brokerId；通用卡來源先可以建通用卡", async () => {
    const mk = async (name: string, cards: Array<Record<string, unknown>>) => {
      const x = await mkSite(name);
      for (const c of cards) await card({ siteId: x.site.id, shiftTypeId: x.d.id, ...c });
      // 淨缺客價：出街價已有
      for (let i = 0; i < 2; i++) {
        n++;
        await prisma.shiftRecord.create({ data: { workDate: sep((n % 28) + 1), siteId: x.site.id, shiftTypeId: x.d.id, guardId: guard.id, settlementBrokerId: K.id, operationalBrokerId: K.id, recordType: "shift", status: "confirmed", guardWageSnapshot: 700, brokerFeeSnapshot: 0, createdBy: "t" } });
        if (n % 28 === 0) guard = await mkGuard();
      }
      return x;
    };
    // a. 同雞頭卡 880 + W 900 → 用 K 自己 880，卡 brokerId=K
    const a = await mk("測試價盤4a", [{ brokerId: K.id, clientRate: 880 }, { brokerId: W.id, clientRate: 900 }]);
    // b. 其他雞頭一致 → auto，brokerId=K（唔係 null）
    const b = await mk("測試價盤4b", [{ brokerId: W.id, clientRate: 900 }, { brokerId: Z.id, clientRate: 900 }]);
    // c. 其他雞頭唔一致 → propose，唔建卡
    const c = await mk("測試價盤4c", [{ brokerId: W.id, clientRate: 900 }, { brokerId: Z.id, clientRate: 950 }]);
    // d. 來源係通用卡 → 通用卡
    const dd = await mk("測試價盤4d", [{ brokerId: null, clientRate: 870 }]);
    const { ctx } = await runCtx();
    await runAutoPricing(ctx, SEPT);
    const get = (id: string) => prisma.rateCard.findFirst({ where: { siteId: id, source: { startsWith: "auto:one-click:" } } });
    const ca = await get(a.site.id);
    expect([Number(ca?.clientRate), ca?.brokerId]).toEqual([880, K.id]);
    const cb = await get(b.site.id);
    expect([Number(cb?.clientRate), cb?.brokerId]).toEqual([900, K.id]);
    expect(await get(c.site.id)).toBeNull();
    expect(ctx.questions.some((q) => q.groupKey.includes(c.site.id))).toBe(true);
    const cd = await get(dd.site.id);
    expect([Number(cd?.clientRate), cd?.brokerId]).toEqual([870, null]);
  });

  it("修5：上月 auto 卡（未經人確認）唔做 auto 來源，最多 propose", async () => {
    const { site, d } = await mkSite("測試價盤5x");
    await card({ siteId: site.id, shiftTypeId: d.id, brokerId: K.id, clientRate: 900, guardWage: 700, brokerFee: 0, source: "auto:one-click:old-run" });
    await mkRecords(site.id, d.id, K.id, 3);
    const { ctx } = await runCtx();
    const res = await runAutoPricing(ctx, SEPT);
    expect(res.autoGroups).toBe(0);
    expect(res.proposeGroups).toBe(1);
    expect(ctx.questions[0]!.evidence.candidates[0]!.label).toContain("自動定價卡");
  });

  it("修6：卡建咗但更次仍然未定價 → 重跑唔重複建卡（同盤同更種同雞頭同期已有 auto 卡），只再補價", async () => {
    const { site, d } = await mkSite("測試價盤6x");
    await card({ siteId: site.id, shiftTypeId: d.id, brokerId: K.id, clientRate: 900, guardWage: 700, brokerFee: 0 });
    await mkRecords(site.id, d.id, K.id, 3);
    const { ctx } = await runCtx();
    await runAutoPricing(ctx, SEPT);
    expect(await prisma.rateCard.count({ where: { siteId: site.id, source: { startsWith: "auto:one-click:" } } })).toBe(1);
    // 模擬價 snapshot 被清走（卡仲在，更次又未定價）
    await prisma.shiftRecord.updateMany({ where: { siteId: site.id }, data: { clientRateSnapshot: null, guardWageSnapshot: null, brokerFeeSnapshot: null } });
    // 先令「現有生效卡補價」唔處理：作廢現有生效 auto 卡以外嘅路徑——直接叫 createCardAndPrice 兩次
    const writer = ctx;
    const grp = { siteId: site.id, shiftTypeId: d.id, brokerId: K.id, ot: false };
    const r1 = await createCardAndPrice(writer, { month: SEPT, group: grp, need: { client: true, payout: true }, values: { clientRate: 900, guardWage: 700, brokerFee: 0, payoutRate: 700 }, evidence: "t", note: "t", confidence: "auto" });
    const r2 = await createCardAndPrice(writer, { month: SEPT, group: grp, need: { client: true, payout: true }, values: { clientRate: 900, guardWage: 700, brokerFee: 0, payoutRate: 700 }, evidence: "t", note: "t", confidence: "auto" });
    expect(r1.cardId).toBe(r2.cardId);
    expect(await prisma.rateCard.count({ where: { siteId: site.id, source: { startsWith: "auto:one-click:" } } })).toBe(1);
    for (const s of await snap(site.id)) expect(s).toEqual([900, 700, 0]);
  });

  it("修7：undo 連「之後 reconcile 補價（冇 journal）」嘅價都還原，唔留已作廢卡嘅價", async () => {
    const { site, d } = await mkSite("測試價盤7x");
    await card({ siteId: site.id, shiftTypeId: d.id, brokerId: K.id, clientRate: 900, guardWage: 700, brokerFee: 0 });
    await mkRecords(site.id, d.id, K.id, 3);
    const { run, ctx } = await runCtx();
    await runAutoPricing(ctx, SEPT);
    // 之後（例如 rerun 嘅 reconcile 開頭 reprice）新增一條用 auto 卡定價嘅更，冇 journal
    n++;
    const late = await prisma.shiftRecord.create({ data: { workDate: sep(29), siteId: site.id, shiftTypeId: d.id, guardId: (await mkGuard()).id, settlementBrokerId: K.id, operationalBrokerId: K.id, recordType: "shift", status: "confirmed", clientRateSnapshot: 900, guardWageSnapshot: 700, brokerFeeSnapshot: 0, createdBy: "t" } });
    await prisma.monthCloseRun.update({ where: { id: run.id }, data: { status: "done" } });
    const { undoAutoChanges } = await import("@/lib/month-close/auto/undo");
    await undoAutoChanges(run.id, fx.userIds["老闆"], null);
    for (const r of await prisma.shiftRecord.findMany({ where: { siteId: site.id } })) expect([r.clientRateSnapshot, r.guardWageSnapshot, r.brokerFeeSnapshot]).toEqual([null, null, null]);
    expect(late.id).toBeTruthy();
  });
});
