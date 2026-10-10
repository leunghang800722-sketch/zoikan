// WP-LTSHIFT（老闆 2026-09-26 §3）：`POST /api/reports/referral-fee/recompute`
// route-level 測試——權限（老闆／會計先得，主管/雞頭/保安員擋）、7 月拒絕、
// 快樂路徑金額。
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { POST as recomputeRoute } from "@/app/api/reports/referral-fee/recompute/route";

function req(cookie: string, body: unknown) {
  return new Request("http://test.local/api/reports/referral-fee/recompute", { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) });
}

describe("POST /api/reports/referral-fee/recompute", () => {
  let fx: Wp2Fixture;

  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
  });

  it("老闆：計出金額，special_items 有寫入", async () => {
    const b07 = await prisma.broker.create({ data: { code: "TEST-B07R", name: "測試B07", kind: "internal_longterm", settlementType: "salary", createdBy: "t" } });
    const guard = await prisma.guard.create({ data: { nameZh: "測試長工", employmentType: "longterm_autopay", referralBrokerId: fx.brokerA.id, createdBy: "t" } });
    await prisma.referralFeeRate.create({ data: { brokerId: fx.brokerA.id, siteId: null, month: new Date("2026-08-01"), feePerShift: 100, createdBy: "t" } });
    await prisma.shiftRecord.create({ data: { workDate: new Date("2026-08-05"), siteId: fx.site.id, shiftTypeId: fx.shiftType.id, guardId: guard.id, settlementBrokerId: b07.id, operationalBrokerId: fx.brokerA.id } });

    const cookie = await sessionCookieForUser(fx.userIds["老闆"]);
    const res = await recomputeRoute(req(cookie, { month: "2026-08" }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { total_amount: number; created_count: number };
    expect(json.total_amount).toBe(100);
    expect(json.created_count).toBe(1);
  });

  it("會計：一樣得", async () => {
    const cookie = await sessionCookieForUser(fx.userIds["會計"]);
    const res = await recomputeRoute(req(cookie, { month: "2026-08" }));
    expect(res.status).toBe(200);
  });

  it("主管／雞頭／保安員：403", async () => {
    for (const role of ["主管", "雞頭", "安員"] as const) {
      const cookie = await sessionCookieForUser(fx.userIds[role]);
      const res = await recomputeRoute(req(cookie, { month: "2026-08" }));
      expect(res.status).toBe(403);
    }
  });

  it("7 月：400", async () => {
    const cookie = await sessionCookieForUser(fx.userIds["老闆"]);
    const res = await recomputeRoute(req(cookie, { month: "2026-07" }));
    expect(res.status).toBe(400);
  });

  it("冇 month：400", async () => {
    const cookie = await sessionCookieForUser(fx.userIds["老闆"]);
    const res = await recomputeRoute(req(cookie, {}));
    expect(res.status).toBe(400);
  });
});
