// P2-B：更表索引「最近開過」——GET /api/roster/overview?month=（見
// src/lib/reports/roster-overview.ts、src/app/api/roster/overview/route.ts）。
// 用 tests/fixtures/wp2-fixture.ts 嗰份假數據：fx.site 喺 2026-08 有
// brokerA／brokerB 各一條 shift_record（兩個雞頭都喺呢個盤有
// broker_site_assignments）；呢度加多一個淨係 brokerB 有份嘅盤，測試雞頭
// A 見唔到。
//
// Opus 驗收 M1/M2/M3 修正版：
//  - M3：「最近開過」而家淨係跟呢個月 shift_records 嘅存在／updated_at
//    決定會唔會出現／排序——單純有 broker_site_assignments、冇任何
//    shift_records 嘅盤唔再出現（之前 fx.lockedMonth 嗰個 test 靠
//    assignment-only discovery，而家改用真正有 shift_record 嘅日子）。
//  - M1：雞頭 session 嘅 `shortfall` 一律 null（結構性唔傳盤級口徑）。
//  - M2：老闆／內部角色嘅 `shortfall`＝逐日 `computeSiteDayShortfall()`
//    淨額加總埋成個月，同 `buildShortfall()`（首頁尚欠總覽）口徑一致。
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { TEST_USER_TEL } from "./fixtures/test-users";
import { GET as getRosterOverview } from "@/app/api/roster/overview/route";
import { buildShortfall } from "@/lib/reports/shortfall";

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

  it("雞頭A：見唔到雞頭B 專屬盤，但見到共同盤（fx.site）自己嗰份（1 更／1 人）；shortfall 為 null", async () => {
    const res = await getRosterOverview(req("http://test.local/api/roster/overview?month=2026-08", brokerACookie));
    expect(res.status).toBe(200);
    const body = await res.json();
    const siteIds = body.sites.map((s: { site_id: string }) => s.site_id);
    expect(siteIds).not.toContain(siteOnlyB.id);
    expect(siteIds).toContain(fx.site.id);
    const row = body.sites.find((s: { site_id: string }) => s.site_id === fx.site.id);
    expect(row.shift_count).toBe(1);
    expect(row.guard_count).toBe(1);
    // M1：雞頭 session 結構性唔傳盤級尚欠口徑——一律 null，唔會反推到
    // 盤總所需人手（fx.dailyRequirement headcount_required=3，雞頭A 自己
    // 淨係 1 條記錄，舊邏輯會錯誤顯示「欠 2」）。
    for (const s of body.sites) expect(s.shortfall).toBeNull();
  });

  it("雞頭B：見到自己專屬盤（1 更／1 人），亦見到共同盤自己嗰份；shortfall 為 null", async () => {
    const res = await getRosterOverview(req("http://test.local/api/roster/overview?month=2026-08", brokerBCookie));
    expect(res.status).toBe(200);
    const body = await res.json();
    const row = body.sites.find((s: { site_id: string }) => s.site_id === siteOnlyB.id);
    expect(row).toBeTruthy();
    expect(row.shift_count).toBe(1);
    expect(row.guard_count).toBe(1);
    for (const s of body.sites) expect(s.shortfall).toBeNull();
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

  it("M2：老闆睇 fx.site 嘅本月尚欠，同 buildShortfall() 嗰日嘅尚欠一致（呢個月淨係 2026-08-01 有 daily_requirement／confirmed 記錄，其餘日子 required=confirmed=0）", async () => {
    const res = await getRosterOverview(req("http://test.local/api/roster/overview?month=2026-08", ownerCookie));
    expect(res.status).toBe(200);
    const body = await res.json();
    const row = body.sites.find((s: { site_id: string }) => s.site_id === fx.site.id);
    expect(row).toBeTruthy();

    const shortfallToday = await buildShortfall(new Date(Date.UTC(2026, 7, 1)));
    const todayRow = shortfallToday.today.find((s) => s.siteId === fx.site.id);
    expect(todayRow).toBeTruthy();
    // fx.dailyRequirement headcount_required=3，2026-08-01 confirmed=2
    // （brokerA+brokerB 各一條）→ 當日 shortfall=1；成個月其餘日子冇任何
    // daily_requirement／shift_record，required=confirmed=0，唔會加多。
    expect(todayRow!.shortfall).toBe(1);
    expect(row.shortfall).toBe(Math.max(0, todayRow!.shortfall));
  });

  it("M3：呢個月完全冇 shift_records、淨係有 broker_site_assignments 嘅盤唔出現喺「最近開過」", async () => {
    // fx.site 喺 fx.lockedMonth（2026-06）淨係有 broker_site_assignments，
    // 冇任何 shift_record——新口徑（M3）淨係跟 shift_records 決定「開過」，
    // 呢個盤喺 2026-06 唔應該出現。
    const res = await getRosterOverview(req("http://test.local/api/roster/overview?month=2026-06", ownerCookie));
    expect(res.status).toBe(200);
    const body = await res.json();
    const siteIds = body.sites.map((s: { site_id: string }) => s.site_id);
    expect(siteIds).not.toContain(fx.site.id);
    expect(body.sites).toEqual([]);
  });

  it("M3：有 shift_record 嘅盤喺鎖定月份 locked=true", async () => {
    await prisma.shiftRecord.create({
      data: {
        workDate: new Date(Date.UTC(2026, 5, 5)),
        siteId: fx.site.id,
        shiftTypeId: fx.shiftType.id,
        guardId: fx.guardA.id,
        settlementBrokerId: fx.brokerA.id,
        operationalBrokerId: fx.brokerA.id,
        recordType: "shift",
        clientRateSnapshot: 999,
        guardWageSnapshot: 700,
        brokerFeeSnapshot: 50,
        createdBy: "test-fixture:p2b",
      },
    });
    const res = await getRosterOverview(req("http://test.local/api/roster/overview?month=2026-06", ownerCookie));
    expect(res.status).toBe(200);
    const body = await res.json();
    const row = body.sites.find((s: { site_id: string }) => s.site_id === fx.site.id);
    expect(row).toBeTruthy();
    expect(row.locked).toBe(true);
    expect(row.shift_count).toBe(1);
  });

  it("M3：cancelled 嘅記錄唔計更數/人數，亦唔令盤單憑 cancelled 記錄「開過」", async () => {
    const cancelSite = await prisma.site.create({
      data: { canonicalName: "測試盤P2B-淨係cancelled", clientName: "測試客戶P2B", billingModel: "per_shift", createdBy: "test-fixture:p2b" },
    });
    const cancelShiftType = await prisma.shiftType.create({
      data: { siteId: cancelSite.id, code: "N", label: "測試夜更", hours: 12, createdBy: "test-fixture:p2b" },
    });
    await prisma.shiftRecord.create({
      data: {
        workDate: new Date(Date.UTC(2026, 7, 10)),
        siteId: cancelSite.id,
        shiftTypeId: cancelShiftType.id,
        guardId: fx.guardA.id,
        settlementBrokerId: fx.brokerA.id,
        operationalBrokerId: fx.brokerA.id,
        recordType: "shift",
        status: "cancelled",
        clientRateSnapshot: 999,
        guardWageSnapshot: 700,
        brokerFeeSnapshot: 50,
        createdBy: "test-fixture:p2b",
      },
    });
    const res = await getRosterOverview(req("http://test.local/api/roster/overview?month=2026-08", ownerCookie));
    expect(res.status).toBe(200);
    const body = await res.json();
    const siteIds = body.sites.map((s: { site_id: string }) => s.site_id);
    expect(siteIds).not.toContain(cancelSite.id);
  });

  it("limit 參數：預設 8，上限 50", async () => {
    const res = await getRosterOverview(req("http://test.local/api/roster/overview?month=2026-08&limit=1", ownerCookie));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sites.length).toBeLessThanOrEqual(1);

    const tooBig = await getRosterOverview(req("http://test.local/api/roster/overview?month=2026-08&limit=999", ownerCookie));
    expect(tooBig.status).toBe(200);
    const tooBigBody = await tooBig.json();
    expect(tooBigBody.sites.length).toBeLessThanOrEqual(50);
  });

  it("非法 limit（負數/非數字）→ 400", async () => {
    const res = await getRosterOverview(req("http://test.local/api/roster/overview?month=2026-08&limit=-1", ownerCookie));
    expect(res.status).toBe(400);
    const res2 = await getRosterOverview(req("http://test.local/api/roster/overview?month=2026-08&limit=abc", ownerCookie));
    expect(res2.status).toBe(400);
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
