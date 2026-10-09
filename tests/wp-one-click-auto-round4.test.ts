// WP-ONE-CLICK-AUTO Opus 第四輪：人手路徑補 journal、undo 安全網、OT 冇 ot_hours 唔計 changed。
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { SEPT, sep } from "./lib/one-click-auto";
import { AutoCollector } from "@/lib/month-close/auto/context";
import { createCardAndPrice } from "@/lib/month-close/auto/pricing";
import { undoAutoChanges } from "@/lib/month-close/auto/undo";
import { POST as createRecord } from "@/app/api/shift-records/route";
import { POST as batchSave } from "@/app/api/shift-records/batch/route";
import { POST as undoRoute } from "@/app/api/month-close/one-click/[id]/undo-auto/route";

const req = (url: string, cookie: string, method: string, body?: unknown) => new Request(url, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
const snap = async (id: string) => {
  const r = await prisma.shiftRecord.findUniqueOrThrow({ where: { id } });
  return [r.clientRateSnapshot, r.guardWageSnapshot, r.brokerFeeSnapshot].map((v) => (v === null ? null : Number(v)));
};

describe("WP-ONE-CLICK-AUTO 第四輪", () => {
  let fx: Wp2Fixture;
  let cookie: string;
  let runId: string;
  const boss = () => fx.userIds["老闆"];
  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    cookie = await sessionCookieForUser(boss());
    await prisma.rateCard.updateMany({ where: { siteId: fx.site.id }, data: { voidedAt: new Date() } });
    const run = await prisma.monthCloseRun.create({ data: { month: SEPT, status: "done", startedById: boss(), applyStartedAt: new Date(), finishedAt: new Date(), reportJson: {} } });
    runId = run.id;
    await prisma.rateCard.create({ data: { siteId: fx.site.id, shiftTypeId: fx.shiftType.id, brokerId: fx.brokerA.id, clientRate: 900, guardWage: 700, brokerFee: 20, payoutRate: 720, effectiveFrom: sep(1), effectiveTo: sep(30), billingModel: "per_shift", source: `auto:one-click:${runId}`, createdBy: "t" } });
  });

  it("必修 1：人手 POST 開更／批量儲存用 auto 卡定價 → 有 journal → undo 清返 null，還原 0 遺留", async () => {
    const r1 = await createRecord(req("http://x/api/shift-records", cookie, "POST", { work_date: "2026-09-05", site_id: fx.site.id, shift_type_id: fx.shiftType.id, guard_id: fx.guardA.id, settlement_broker_id: fx.brokerA.id, operational_broker_id: fx.brokerA.id, record_type: "shift" }));
    expect(r1.status).toBe(201);
    const id1 = ((await r1.json()) as { id: string }).id;
    expect(await snap(id1)).toEqual([900, 700, 20]);
    const r2 = await batchSave(req("http://x/api/shift-records/batch", cookie, "POST", { site_id: fx.site.id, month: "2026-09", cells: [{ guard_id: fx.guardB.id, shift_type_id: fx.shiftType.id, work_date: "2026-09-06", code: "N", settlement_broker_id: fx.brokerA.id }] }));
    expect(r2.status).toBe(200);
    const rec2 = await prisma.shiftRecord.findFirstOrThrow({ where: { guardId: fx.guardB.id, workDate: sep(6) } });
    expect(await snap(rec2.id)).toEqual([900, 700, 20]);
    const j = await prisma.monthCloseAutoChange.findMany({ where: { runId, kind: "price_snapshots" } });
    expect(j.reduce((a, c) => a + (c.detailJson as { rows: unknown[] }).rows.length, 0)).toBe(2);
    // 作廢 auto 卡嘅 undo 需要 rate_card_created journal：補一行（模擬 run 建卡）
    const card = await prisma.rateCard.findFirstOrThrow({ where: { source: `auto:one-click:${runId}` } });
    await prisma.monthCloseAutoChange.create({ data: { runId, kind: "rate_card_created", refTable: "rate_cards", refId: card.id, summary: "t", detailJson: { cardId: card.id }, undoable: true } });
    const res = await undoRoute(req("http://x/undo", cookie, "POST"), { params: Promise.resolve({ id: runId }) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { still_using_voided_card_prices: number };
    expect(body.still_using_voided_card_prices).toBe(0);
    expect(await snap(id1)).toEqual([null, null, null]);
    expect(await snap(rec2.id)).toEqual([null, null, null]);
  });

  it("必修 1：繞過 journal 寫入 → undo 報 stillUsingVoidedCardPrices=N，價唔郁", async () => {
    const mk = (day: number, g: string) => prisma.shiftRecord.create({ data: { workDate: sep(day), siteId: fx.site.id, shiftTypeId: fx.shiftType.id, guardId: g, settlementBrokerId: fx.brokerA.id, operationalBrokerId: fx.brokerA.id, recordType: "shift", status: "confirmed", source: "manual", clientRateSnapshot: 900, guardWageSnapshot: 700, brokerFeeSnapshot: 20, createdBy: "t" } });
    const a = await mk(7, fx.guardA.id);
    const b = await mk(8, fx.guardB.id);
    const card = await prisma.rateCard.findFirstOrThrow({ where: { source: `auto:one-click:${runId}` } });
    await prisma.monthCloseAutoChange.create({ data: { runId, kind: "rate_card_created", refTable: "rate_cards", refId: card.id, summary: "t", detailJson: { cardId: card.id }, undoable: true } });
    const u = await undoAutoChanges(runId, boss(), null);
    expect(u.stillUsingVoidedCardPrices).toBe(2);
    expect(await snap(a.id)).toEqual([900, 700, 20]);
    expect(await snap(b.id)).toEqual([900, 700, 20]);
  });

  it("必修 2：OT 冇 ot_hours → null→null 唔計 changed、journal 0 行，rerun 兩次仍然 0", async () => {
    const ot = await prisma.shiftType.create({ data: { siteId: fx.site.id, code: "OT", startTime: new Date("1970-01-01T19:00:00Z"), endTime: new Date("1970-01-01T23:00:00Z"), hours: 4, createdBy: "t" } });
    for (let i = 0; i < 3; i++) await prisma.shiftRecord.create({ data: { workDate: sep(10 + i), siteId: fx.site.id, shiftTypeId: ot.id, guardId: fx.guardA.id, settlementBrokerId: fx.brokerA.id, operationalBrokerId: fx.brokerA.id, recordType: "ot", otHours: null, status: "confirmed", source: "manual", createdBy: "t" } });
    const ctx = new AutoCollector(runId, SEPT, boss(), null);
    const g = { siteId: fx.site.id, shiftTypeId: ot.id, brokerId: fx.brokerA.id, ot: true };
    const values = { clientRate: 100, guardWage: 80, brokerFee: 5, payoutRate: 85 };
    for (let i = 0; i < 2; i++) {
      const r = await createCardAndPrice(ctx, { month: SEPT, group: g, need: { client: true, payout: true }, values, evidence: "t", note: "t", confidence: "auto" });
      expect(r.recordsPriced).toBe(0);
    }
    expect(await prisma.monthCloseAutoChange.count({ where: { runId, kind: "price_snapshots" } })).toBe(0);
  });
});
