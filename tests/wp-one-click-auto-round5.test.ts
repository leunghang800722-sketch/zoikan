// WP-ONE-CLICK-AUTO Opus 第五輪：內部 POST 部分人手出街價、降級題預填次序、OT 冇時數專題、reprice hook、安全網 OT／reportJson。
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { AUG, SEPT, aug, sep, mkBroker, mkGuard } from "./lib/one-click-auto";
import { AutoCollector } from "@/lib/month-close/auto/context";
import { runAutoPricing } from "@/lib/month-close/auto/pricing";
import { undoAutoChanges } from "@/lib/month-close/auto/undo";
import { POST as createRecord } from "@/app/api/shift-records/route";
import { POST as reprice } from "@/app/api/shift-records/reprice/route";

const req = (url: string, cookie: string, method: string, body?: unknown) => new Request(url, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
const time = (hhmm: string) => new Date(`1970-01-01T${hhmm.slice(0, 2)}:${hhmm.slice(2)}:00.000Z`);
const snap = async (id: string) => {
  const r = await prisma.shiftRecord.findUniqueOrThrow({ where: { id } });
  return [r.clientRateSnapshot, r.guardWageSnapshot, r.brokerFeeSnapshot].map((v) => (v === null ? null : Number(v)));
};

describe("WP-ONE-CLICK-AUTO 第五輪", () => {
  let fx: Wp2Fixture;
  let cookie: string;
  let runId: string;
  const boss = () => fx.userIds["老闆"];
  const autoCardData = (extra: Record<string, unknown> = {}) => ({ siteId: fx.site.id, shiftTypeId: fx.shiftType.id, brokerId: fx.brokerA.id, clientRate: 900, guardWage: 700, brokerFee: 20, payoutRate: 720, effectiveFrom: sep(1), effectiveTo: sep(30), billingModel: "per_shift" as const, source: `auto:one-click:${runId}`, createdBy: "t", ...extra });
  const rcCard = async () => {
    const card = await prisma.rateCard.findFirstOrThrow({ where: { source: `auto:one-click:${runId}` } });
    await prisma.monthCloseAutoChange.create({ data: { runId, kind: "rate_card_created", refTable: "rate_cards", refId: card.id, summary: "t", detailJson: { cardId: card.id }, undoable: true } });
  };
  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    cookie = await sessionCookieForUser(boss());
    await prisma.rateCard.updateMany({ where: { siteId: fx.site.id }, data: { voidedAt: new Date() } });
    runId = (await prisma.monthCloseRun.create({ data: { month: SEPT, status: "done", startedById: boss(), applyStartedAt: new Date(), finishedAt: new Date(), reportJson: {} } })).id;
  });

  it("必修 1：內部 POST 帶 guard_wage 666 唔帶介紹費 → undo 後 666 保留，只清 auto 填嘅客價／介紹費", async () => {
    await prisma.rateCard.create({ data: autoCardData() });
    const res = await createRecord(req("http://x/api/shift-records", cookie, "POST", { work_date: "2026-09-05", site_id: fx.site.id, shift_type_id: fx.shiftType.id, guard_id: fx.guardA.id, settlement_broker_id: fx.brokerA.id, operational_broker_id: fx.brokerA.id, record_type: "shift", guard_wage_snapshot: 666 }));
    expect(res.status).toBe(201);
    const id = ((await res.json()) as { id: string }).id;
    expect(await snap(id)).toEqual([900, 666, 20]);
    await rcCard();
    await undoAutoChanges(runId, boss(), null);
    expect(await snap(id)).toEqual([null, 666, null]);
  });

  it("必修 2：降級題原來源值排第一做預填；「未經人確認」嘅上月 auto 卡永遠唔預填", async () => {
    const K = await mkBroker("R5K", "broker");
    const g = await mkGuard();
    const site = await prisma.site.create({ data: { canonicalName: "測試第五輪盤", clientName: "c", billingModel: "per_shift", createdBy: "t" } });
    const d = await prisma.shiftType.create({ data: { siteId: site.id, code: "D", startTime: time("0700"), endTime: time("1900"), hours: 12, createdBy: "t" } });
    // 上月只有 auto 卡（未經人確認）→ 只得 propose，唔預填
    await prisma.rateCard.create({ data: { siteId: site.id, shiftTypeId: d.id, brokerId: K.id, clientRate: 650, guardWage: 500, brokerFee: 10, payoutRate: 510, effectiveFrom: aug(1), effectiveTo: aug(31), billingModel: "per_shift", source: "auto:one-click:old", createdBy: "t" } });
    for (let i = 1; i <= 2; i++) await prisma.shiftRecord.create({ data: { workDate: sep(i), siteId: site.id, shiftTypeId: d.id, guardId: g.id, settlementBrokerId: K.id, operationalBrokerId: K.id, recordType: "shift", status: "confirmed", source: "roster_upload", createdBy: "t" } }).catch(() => null);
    const ctx = new AutoCollector(runId, SEPT, boss(), null);
    await runAutoPricing(ctx, SEPT);
    const q = ctx.questions.find((x) => x.evidence.action.type === "pricing")!;
    expect(q).toBeTruthy();
    expect(q.evidence.candidates[0]!.label).toContain("未經人確認");
    expect(q.evidence.prefillCandidateId).toBeNull();
    void AUG;
  });

  it("必修 2：降級（本月已有欄位唔齊嘅 auto 卡）→ 原來源值（上月人手卡 700）排第一兼預填", async () => {
    const K = await mkBroker("R5D", "broker");
    const g = await mkGuard();
    const site = await prisma.site.create({ data: { canonicalName: "測試第五輪降級盤", clientName: "c", billingModel: "per_shift", createdBy: "t" } });
    const d = await prisma.shiftType.create({ data: { siteId: site.id, code: "D", startTime: time("0700"), endTime: time("1900"), hours: 12, createdBy: "t" } });
    await prisma.rateCard.create({ data: { siteId: site.id, shiftTypeId: d.id, brokerId: K.id, clientRate: 880, guardWage: 700, brokerFee: 10, payoutRate: 710, effectiveFrom: aug(1), effectiveTo: aug(31), billingModel: "per_shift", createdBy: "t" } });
    await prisma.rateCard.create({ data: { siteId: site.id, shiftTypeId: d.id, brokerId: K.id, clientRate: 650, effectiveFrom: sep(1), effectiveTo: null, billingModel: "per_shift", source: "auto:one-click:old", createdBy: "t" } });
    await prisma.shiftRecord.create({ data: { workDate: sep(1), siteId: site.id, shiftTypeId: d.id, guardId: g.id, settlementBrokerId: K.id, operationalBrokerId: K.id, recordType: "shift", status: "confirmed", source: "roster_upload", createdBy: "t" } });
    const ctx = new AutoCollector(runId, SEPT, boss(), null);
    await runAutoPricing(ctx, SEPT);
    const q = ctx.questions.find((x) => x.evidence.action.type === "pricing")!;
    expect(q).toBeTruthy();
    expect(q.evidence.candidates[0]!.values?.guardWage).toBe(700);
    expect(q.evidence.prefillCandidateId).toBe(q.evidence.candidates[0]!.id);
  });

  it("必修 3：OT 成組冇 ot_hours → 唔建卡、出專題 ot_hours（只可 ack）；混合組照定價有時數嗰啲＋專題", async () => {
    const K = await mkBroker("R5O", "broker");
    const g1 = await mkGuard();
    const g2 = await mkGuard();
    const g3 = await mkGuard();
    const site = await prisma.site.create({ data: { canonicalName: "測試第五輪OT盤", clientName: "c", billingModel: "per_shift", createdBy: "t" } });
    const ot = await prisma.shiftType.create({ data: { siteId: site.id, code: "OT", startTime: time("1900"), endTime: time("2300"), hours: 4, createdBy: "t" } });
    await prisma.rateCard.create({ data: { siteId: site.id, shiftTypeId: ot.id, brokerId: K.id, clientRate: 100, guardWage: 80, brokerFee: 5, payoutRate: 85, effectiveFrom: aug(1), effectiveTo: aug(31), billingModel: "per_shift", createdBy: "t" } });
    const mk = (day: number, g: string, hours: number | null) => prisma.shiftRecord.create({ data: { workDate: sep(day), siteId: site.id, shiftTypeId: ot.id, guardId: g, settlementBrokerId: K.id, operationalBrokerId: K.id, recordType: "ot", otHours: hours, status: "confirmed", source: "roster_upload", createdBy: "t" } });
    await mk(1, g1.id, null);
    await mk(2, g2.id, null);
    const ctx = new AutoCollector(runId, SEPT, boss(), null);
    await runAutoPricing(ctx, SEPT);
    expect(await prisma.rateCard.count({ where: { source: { startsWith: "auto:one-click:" }, siteId: site.id } })).toBe(0);
    const qs = ctx.questions.filter((x) => x.evidence.action.type === "ot_hours");
    expect(qs).toHaveLength(1);
    expect(qs[0]!.title).toContain("2 更 OT 冇時數");
    expect(ctx.questions.filter((x) => x.evidence.action.type === "pricing")).toHaveLength(0);
    // 混合：加 1 更有時數
    await mk(3, g3.id, 2);
    const ctx2 = new AutoCollector(runId, SEPT, boss(), null);
    await runAutoPricing(ctx2, SEPT);
    expect(ctx2.questions.filter((x) => x.evidence.action.type === "ot_hours")).toHaveLength(1);
    expect(ctx2.questions.filter((x) => x.evidence.action.type === "pricing")).toHaveLength(0);
  });

  it("順手：POST /api/shift-records/reprice 補 journal → undo 還原舊值", async () => {
    await prisma.rateCard.create({ data: autoCardData() });
    const rec = await prisma.shiftRecord.create({ data: { workDate: sep(9), siteId: fx.site.id, shiftTypeId: fx.shiftType.id, guardId: fx.guardA.id, settlementBrokerId: fx.brokerA.id, operationalBrokerId: fx.brokerA.id, recordType: "shift", status: "confirmed", source: "manual", clientRateSnapshot: 500, guardWageSnapshot: 400, brokerFeeSnapshot: 10, createdBy: "t" } });
    const res = await reprice(req("http://x/api/shift-records/reprice", cookie, "POST", { month: "2026-09", dry_run: false }));
    expect(res.status).toBe(200);
    expect(await snap(rec.id)).toEqual([900, 700, 20]);
    expect(await prisma.monthCloseAutoChange.count({ where: { runId, kind: "price_snapshots" } })).toBe(1);
    await undoAutoChanges(runId, boss(), null);
    expect(await snap(rec.id)).toEqual([500, 400, 10]);
  });

  it("順手：安全網 OT 用卡每小時價 × ot_hours 比較；結果寫入 reportJson（最多 50 個 id）", async () => {
    await prisma.rateCard.create({ data: autoCardData({ clientRate: 100, guardWage: 80, brokerFee: 5, payoutRate: 85 }) });
    const ot = await prisma.shiftRecord.create({ data: { workDate: sep(11), siteId: fx.site.id, shiftTypeId: fx.shiftType.id, guardId: fx.guardA.id, settlementBrokerId: fx.brokerA.id, operationalBrokerId: fx.brokerA.id, recordType: "ot", otHours: 2, status: "confirmed", source: "manual", clientRateSnapshot: 200, guardWageSnapshot: 160, brokerFeeSnapshot: 10, createdBy: "t" } });
    await rcCard();
    const u = await undoAutoChanges(runId, boss(), null);
    expect(u.stillUsingVoidedCardPrices).toBe(1);
    expect(u.stillUsingVoidedCardIds).toEqual([ot.id]);
    const run = await prisma.monthCloseRun.findUniqueOrThrow({ where: { id: runId } });
    expect((run.reportJson as { auto?: { voidedCardPriceCheck?: { count: number; recordIds: string[] } } }).auto?.voidedCardPriceCheck).toEqual({ count: 1, recordIds: [ot.id] });
    expect(await snap(ot.id)).toEqual([200, 160, 10]);
  });
});
