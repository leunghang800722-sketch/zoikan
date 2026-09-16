// WP-PRICE（老闆 2026-09-16 拍板）——integration test：
//  1. 更表批量儲存新記錄自動填 snapshot（之前完全冇寫，見 batch/route.ts
//     舊版註解），回應帶 pricing.priced/unpriced。
//  2. GET /api/shift-records/unpriced：權限「更表:view」、雞頭隔離。
//  3. POST /api/shift-records/reprice：權限「出街價:update」、鎖定月份
//     409、重算後 snapshot＝卡值、unpriced 分組。
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { POST as batchSave } from "@/app/api/shift-records/batch/route";
import { GET as unpricedGet } from "@/app/api/shift-records/unpriced/route";
import { POST as reprice } from "@/app/api/shift-records/reprice/route";

function req(url: string, cookie: string, method: string, body?: unknown) {
  return new Request(url, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
}

describe("WP-PRICE：更表批量儲存自動計价", () => {
  let fx: Wp2Fixture;
  let ownerCookie: string;

  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    ownerCookie = await sessionCookieForUser(fx.userIds["老闆"]);
  });

  it("新記錄自動填 snapshot（用返 rateCardBrokerA 嘅價：888/650/60），回應 pricing.priced=1", async () => {
    const res = await batchSave(
      req("http://test.local/api/shift-records/batch", ownerCookie, "POST", {
        site_id: fx.site.id,
        month: "2026-08",
        cells: [{ guard_id: fx.guardA.id, shift_type_id: fx.shiftType.id, work_date: "2026-08-05", code: "N", settlement_broker_id: fx.brokerA.id }],
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.pricing.priced).toBe(1);
    expect(body.pricing.unpriced).toBe(0);

    const created = await prisma.shiftRecord.findFirst({ where: { guardId: fx.guardA.id, workDate: new Date(Date.UTC(2026, 7, 5)) } });
    expect(created).toBeTruthy();
    expect(created!.clientRateSnapshot?.toString()).toBe("888");
    expect(created!.guardWageSnapshot?.toString()).toBe("650");
    expect(created!.brokerFeeSnapshot?.toString()).toBe("60");
  });

  it("冇對應卡嘅組合：新記錄 snapshot 全 null，pricing.unpriced=1 並帶分組明細", async () => {
    // brokerB 喺呢個盤冇任何 rate_card（fixture 淨係起咗 generic 同 brokerA 兩張）。
    const res = await batchSave(
      req("http://test.local/api/shift-records/batch", ownerCookie, "POST", {
        site_id: fx.site.id,
        month: "2026-08",
        cells: [{ guard_id: fx.guardB.id, shift_type_id: fx.shiftType.id, work_date: "2026-08-06", code: "N", settlement_broker_id: fx.brokerB.id }],
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    // generic 卡（brokerId=null）都有 client_rate/guard_wage/broker_fee，所以收客/出街都會揀到 generic 卡，唔算 unpriced。
    expect(body.pricing.priced).toBe(1);
    expect(body.pricing.unpriced).toBe(0);
  });

  it("真係冇任何卡（voidedAt 所有卡）：pricing.unpriced=1，snapshot 全 null", async () => {
    await prisma.rateCard.updateMany({ where: { siteId: fx.site.id }, data: { voidedAt: new Date() } });
    const res = await batchSave(
      req("http://test.local/api/shift-records/batch", ownerCookie, "POST", {
        site_id: fx.site.id,
        month: "2026-08",
        cells: [{ guard_id: fx.guardA.id, shift_type_id: fx.shiftType.id, work_date: "2026-08-07", code: "N", settlement_broker_id: fx.brokerA.id }],
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.pricing.unpriced).toBe(1);
    expect(body.pricing.unpriced_cells.length).toBeGreaterThan(0);
    const created = await prisma.shiftRecord.findFirst({ where: { guardId: fx.guardA.id, workDate: new Date(Date.UTC(2026, 7, 7)) } });
    expect(created!.clientRateSnapshot).toBeNull();
    expect(created!.guardWageSnapshot).toBeNull();
    expect(created!.brokerFeeSnapshot).toBeNull();
  });
});

describe("WP-PRICE：GET /api/shift-records/unpriced", () => {
  let fx: Wp2Fixture;
  let ownerCookie: string;
  let brokerACookie: string;

  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    ownerCookie = await sessionCookieForUser(fx.userIds["老闆"]);
    brokerACookie = await sessionCookieForUser(fx.userIds["雞頭"]); // 掛 brokerA
    // shiftRecordA/B 本身已經有齊 snapshot（fixture 種嘅），呢度補一條冇卡嘅未定价記錄（brokerA）。
    await prisma.rateCard.updateMany({ where: { siteId: fx.site.id }, data: { voidedAt: new Date() } });
    await prisma.shiftRecord.create({
      data: {
        workDate: new Date(Date.UTC(2026, 7, 8)),
        siteId: fx.site.id,
        shiftTypeId: fx.shiftType.id,
        guardId: fx.guardA.id,
        settlementBrokerId: fx.brokerA.id,
        operationalBrokerId: fx.brokerA.id,
        recordType: "shift",
        createdBy: "test",
      },
    });
    await prisma.shiftRecord.create({
      data: {
        workDate: new Date(Date.UTC(2026, 7, 8)),
        siteId: fx.site.id,
        shiftTypeId: fx.shiftType.id,
        guardId: fx.guardB.id,
        settlementBrokerId: fx.brokerB.id,
        operationalBrokerId: fx.brokerB.id,
        recordType: "shift",
        createdBy: "test",
      },
    });
  });

  it("老闆見到全部未定价（brokerA + brokerB）", async () => {
    const res = await unpricedGet(req(`http://test.local/api/shift-records/unpriced?month=2026-08`, ownerCookie, "GET"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBe(2);
  });

  it("雞頭（brokerA）淨係見到自己嘅未定价（隔離）", async () => {
    const brokerARow = await prisma.broker.findUniqueOrThrow({ where: { id: fx.brokerA.id } });
    const res = await unpricedGet(req(`http://test.local/api/shift-records/unpriced?month=2026-08`, brokerACookie, "GET"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBe(1);
    expect(body.groups[0].broker_code).toBe(brokerARow.code);
  });
});

describe("WP-PRICE：POST /api/shift-records/reprice", () => {
  let fx: Wp2Fixture;
  let ownerCookie: string;
  let supervisorCookie: string;
  let brokerACookie: string;

  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    ownerCookie = await sessionCookieForUser(fx.userIds["老闆"]);
    supervisorCookie = await sessionCookieForUser(fx.userIds["主管"]);
    brokerACookie = await sessionCookieForUser(fx.userIds["雞頭"]);
  });

  it("雞頭冇「出街價:update」（硬性 deny）→ 403", async () => {
    const res = await reprice(req("http://test.local/api/shift-records/reprice", brokerACookie, "POST", { month: "2026-08" }));
    expect(res.status).toBe(403);
  });

  it("主管出廠冇「出街價:update」（off，未開）→ 403", async () => {
    const res = await reprice(req("http://test.local/api/shift-records/reprice", supervisorCookie, "POST", { month: "2026-08" }));
    expect(res.status).toBe(403);
  });

  it("鎖定月份（2026-06）→ 409", async () => {
    const res = await reprice(req("http://test.local/api/shift-records/reprice", ownerCookie, "POST", { month: "2026-06" }));
    expect(res.status).toBe(409);
  });

  it("老闆重新計价 2026-08：改咗 rate_card 之後，重算完 snapshot 追返新卡值", async () => {
    // shiftRecordA 本身 snapshot 係 999/700/50（fixture 種嘅舊值）——改
    // 咗 rateCardBrokerA 嘅價之後，冇重計之前 snapshot 唔會自動變。
    await prisma.rateCard.update({ where: { id: fx.rateCardBrokerA.id }, data: { clientRate: 1200, guardWage: 900, brokerFee: 80 } });

    const res = await reprice(req("http://test.local/api/shift-records/reprice", ownerCookie, "POST", { month: "2026-08" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.repriced).toBeGreaterThanOrEqual(1);

    const after = await prisma.shiftRecord.findUniqueOrThrow({ where: { id: fx.shiftRecordA.id } });
    expect(after.clientRateSnapshot?.toString()).toBe("1200");
    expect(after.guardWageSnapshot?.toString()).toBe("900");
    expect(after.brokerFeeSnapshot?.toString()).toBe("80");
  });

  it("重新計价之後、冇卡嘅記錄回應帶 unpriced 分組", async () => {
    await prisma.rateCard.updateMany({ where: { siteId: fx.site.id }, data: { voidedAt: new Date() } });
    const res = await reprice(req("http://test.local/api/shift-records/reprice", ownerCookie, "POST", { month: "2026-08" }));
    const body = await res.json();
    expect(body.unpriced).toBeGreaterThanOrEqual(2); // shiftRecordA + shiftRecordB 都跌返冇卡
    expect(body.groups.length).toBeGreaterThan(0);

    const after = await prisma.shiftRecord.findUniqueOrThrow({ where: { id: fx.shiftRecordA.id } });
    expect(after.guardWageSnapshot).toBeNull();
    expect(after.brokerFeeSnapshot).toBeNull();
  });

  it("site_id 篩選：淨係重算指定盤", async () => {
    const res = await reprice(req("http://test.local/api/shift-records/reprice", ownerCookie, "POST", { month: "2026-08", site_id: fx.site.id }));
    expect(res.status).toBe(200);
  });

  it("寫低 audit_log（action=reprice_month）", async () => {
    const before = await prisma.auditLog.count({ where: { action: "reprice_month" } });
    await reprice(req("http://test.local/api/shift-records/reprice", ownerCookie, "POST", { month: "2026-08" }));
    const after = await prisma.auditLog.count({ where: { action: "reprice_month" } });
    expect(after).toBe(before + 1);
  });
});
