// P2-B：更表索引「最近開過」——GET /api/roster/overview?month=（見
// src/lib/reports/roster-overview.ts、src/app/api/roster/overview/route.ts）。
// 用 tests/fixtures/wp2-fixture.ts 嗰份假數據：fx.site 喺 2026-08 有
// brokerA／brokerB 各一條 shift_record（兩個雞頭都喺呢個盤有
// broker_site_assignments）；呢度加多一個淨係 brokerB 有份嘅盤，測試雞頭
// A 見唔到。
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { TEST_USER_TEL } from "./fixtures/test-users";
import { GET as getRosterOverview } from "@/app/api/roster/overview/route";

function req(url: string, cookie: string) {
  return new Request(url, { method: "GET", headers: { "content-type": "application/json", cookie } });
}

describe("P2-B：更表索引 GET /api/roster/overview", () => {
  let fx: Wp2Fixture;
  let ownerCookie: string;
  let brokerACookie: string;
  let brokerBCookie: string;
  let siteOnlyB: { id: string; name: string };

  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    ownerCookie = await sessionCookieForUser(fx.userIds["老闆"]);
    brokerACookie = await sessionCookieForUser(fx.userIds["雞頭"]); // 雞頭A，掛 brokerA
    const brokerBUser = await prisma.user.findUniqueOrThrow({ where: { tel: TEST_USER_TEL["雞頭B"] } });
    brokerBCookie = await sessionCookieForUser(brokerBUser.id);

    const site = await prisma.site.create({
      data: { canonicalName: "測試盤P2B-淨係B", clientName: "測試客戶P2B", billingModel: "per_shift", createdBy: "test-fixture:p2b" },
    });
    siteOnlyB = { id: site.id, name: site.canonicalName };
    await prisma.brokerSiteAssignment.create({
      data: { brokerId: fx.brokerB.id, siteId: site.id, month: fx.unlockedMonth, createdBy: "test-fixture:p2b" },
    });
    await prisma.shiftRecord.create({
      data: {
        workDate: new Date(Date.UTC(2026, 7, 2)),
        siteId: site.id,
        shiftTypeId: fx.shiftType.id,
        guardId: fx.guardB.id,
        settlementBrokerId: fx.brokerB.id,
        operationalBrokerId: fx.brokerB.id,
        recordType: "shift",
        clientRateSnapshot: 999,
        guardWageSnapshot: 700,
        brokerFeeSnapshot: 50,
        createdBy: "test-fixture:p2b",
      },
    });
  });

  it("雞頭A：見唔到雞頭B 專屬盤，但見到共同盤（fx.site）自己嗰份（1 更／1 人）", async () => {
    const res = await getRosterOverview(req("http://test.local/api/roster/overview?month=2026-08", brokerACookie));
    expect(res.status).toBe(200);
    const body = await res.json();
    const siteIds = body.sites.map((s: { site_id: string }) => s.site_id);
    expect(siteIds).not.toContain(siteOnlyB.id);
    expect(siteIds).toContain(fx.site.id);
    const row = body.sites.find((s: { site_id: string }) => s.site_id === fx.site.id);
    expect(row.shift_count).toBe(1);
    expect(row.guard_count).toBe(1);
  });

  it("雞頭B：見到自己專屬盤（1 更／1 人），亦見到共同盤自己嗰份", async () => {
    const res = await getRosterOverview(req("http://test.local/api/roster/overview?month=2026-08", brokerBCookie));
    expect(res.status).toBe(200);
    const body = await res.json();
    const row = body.sites.find((s: { site_id: string }) => s.site_id === siteOnlyB.id);
    expect(row).toBeTruthy();
    expect(row.shift_count).toBe(1);
    expect(row.guard_count).toBe(1);
  });

  it("老闆：見全部盤（共同盤 + 雞頭B 專屬盤），共同盤更數計埋兩個雞頭（2）", async () => {
    const res = await getRosterOverview(req("http://test.local/api/roster/overview?month=2026-08", ownerCookie));
    expect(res.status).toBe(200);
    const body = await res.json();
    const siteIds = body.sites.map((s: { site_id: string }) => s.site_id);
    expect(siteIds).toContain(fx.site.id);
    expect(siteIds).toContain(siteOnlyB.id);
    const row = body.sites.find((s: { site_id: string }) => s.site_id === fx.site.id);
    expect(row.shift_count).toBe(2);
    expect(row.guard_count).toBe(2);
  });

  it("locked：fx.lockedMonth 已鎖定（月結），呢個月嘅盤（有 broker_site_assignments）locked=true", async () => {
    const res = await getRosterOverview(req("http://test.local/api/roster/overview?month=2026-06", ownerCookie));
    expect(res.status).toBe(200);
    const body = await res.json();
    const row = body.sites.find((s: { site_id: string }) => s.site_id === fx.site.id);
    expect(row).toBeTruthy();
    expect(row.locked).toBe(true);
    expect(row.shift_count).toBe(0); // 冇 2026-06 嘅 shift_record，淨係靠 assignment 出現
  });

  it("非法 month（唔啱 YYYY-MM 形狀）→ 400", async () => {
    const res = await getRosterOverview(req("http://test.local/api/roster/overview?month=garbage", ownerCookie));
    expect(res.status).toBe(400);
  });

  it("冇 month → 400", async () => {
    const res = await getRosterOverview(req("http://test.local/api/roster/overview", ownerCookie));
    expect(res.status).toBe(400);
  });
});
