// P2-WP-R3：雞頭首頁 dashboard（GET /api/dashboard/broker）——新增嘅唯讀
// endpoint，用 tests/fixtures/wp2-fixture.ts 嗰份假數據（brokerA/brokerB
// 喺同一個 site 各有 1 條 2026-08 confirmed shift_record；guardA 掛
// brokerA，guardB 掛 brokerB）。核心斷言：雞頭A 見唔到雞頭B 嘅數（反之
// 亦然），內部角色打呢個 route 一律 403。
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { TEST_USER_TEL } from "./fixtures/test-users";
import { GET as getBrokerDashboard } from "@/app/api/dashboard/broker/route";
import { findKeysDeep, findSubstringInValuesDeep } from "@/lib/api/serialize";
import { BROKER_FORBIDDEN_KEYS } from "@/lib/broker-isolation";

function req(url: string, cookie: string) {
  return new Request(url, { method: "GET", headers: { "content-type": "application/json", cookie } });
}

describe("P2-WP-R3：雞頭首頁 dashboard（GET /api/dashboard/broker）", () => {
  let fx: Wp2Fixture;
  let ownerCookie: string;
  let brokerACookie: string;
  let brokerBCookie: string;

  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    ownerCookie = await sessionCookieForUser(fx.userIds["老闆"]);
    brokerACookie = await sessionCookieForUser(fx.userIds["雞頭"]); // 雞頭A，掛 brokerA
    const brokerBUser = await prisma.user.findUniqueOrThrow({ where: { tel: TEST_USER_TEL["雞頭B"] } });
    brokerBCookie = await sessionCookieForUser(brokerBUser.id);
  });

  it("雞頭A：見到自己嗰條（1 更／1 位保安員），冇配額（未設）", async () => {
    const res = await getBrokerDashboard(req("http://test.local/api/dashboard/broker?month=2026-08", brokerACookie));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.scheduled_shifts).toBe(1);
    expect(body.pending_approval_count).toBe(0);
    expect(body.guard_count).toBe(1);
    expect(body.quota).toBeNull();
    expect(body.sites.length).toBe(1);
    expect(body.sites[0].site_id).toBe(fx.site.id);
    expect(body.sites[0].shifts).toBe(1);
  });

  it("硬性規則1（雞頭隔離）：雞頭A 嘅回應零 brokerB／guardB 嘅任何痕跡，零收客價/毛利呢類禁字", async () => {
    const res = await getBrokerDashboard(req("http://test.local/api/dashboard/broker?month=2026-08", brokerACookie));
    const body = await res.json();
    const forbidden = findKeysDeep(body, [...BROKER_FORBIDDEN_KEYS]);
    expect(forbidden).toEqual([]);
    const brokerBLeak = findSubstringInValuesDeep(body, [fx.brokerB.id, fx.guardB.name]);
    expect(brokerBLeak).toEqual([]);
  });

  it("雞頭A 同雞頭B 各自見返自己嗰份——A 嘅 1 更唔會計入 B（反之亦然）", async () => {
    const resA = await getBrokerDashboard(req("http://test.local/api/dashboard/broker?month=2026-08", brokerACookie));
    const bodyA = await resA.json();
    const resB = await getBrokerDashboard(req("http://test.local/api/dashboard/broker?month=2026-08", brokerBCookie));
    const bodyB = await resB.json();

    expect(bodyA.scheduled_shifts).toBe(1);
    expect(bodyB.scheduled_shifts).toBe(1);
    // 兩邊都淨係見到自己嗰 1 條，唔係「兩個雞頭合共 2 條」嗰個總數。
    expect(bodyA.guard_count).toBe(1);
    expect(bodyB.guard_count).toBe(1);
  });

  it("有設配額（target_shifts=10）：quota 顯示 已排/配額", async () => {
    await prisma.quota.create({
      data: { month: fx.unlockedMonth, siteId: fx.site.id, shiftTypeId: fx.shiftType.id, brokerId: fx.brokerA.id, targetShifts: 10, createdBy: "test-fixture:wp-r3" },
    });
    const res = await getBrokerDashboard(req("http://test.local/api/dashboard/broker?month=2026-08", brokerACookie));
    const body = await res.json();
    expect(body.quota).toEqual({ target_shifts: 10, scheduled_shifts: 1 });
  });

  it("老闆（內部角色）打呢個 route → 403（雞頭專用，同 my-receivable 一致設計）", async () => {
    const res = await getBrokerDashboard(req("http://test.local/api/dashboard/broker?month=2026-08", ownerCookie));
    expect(res.status).toBe(403);
  });

  it("冇帶 month → 用伺服器現時月份（唔 400）", async () => {
    const res = await getBrokerDashboard(req("http://test.local/api/dashboard/broker", brokerACookie));
    expect(res.status).toBe(200);
  });

  // B10 驗收修正：`parseMonthParam()`（src/lib/reports/money.ts）底層
  // `new Date()` 對住 "garbage-01" 呢類垃圾字串唔一定回 Invalid Date
  // （JS Date parser 好寬鬆），令 `month=garbage` 冇 400——route 而家喺
  // `parseMonthParam()` 之前加咗 zod regex `^\d{4}-\d{2}$` 驗證形狀。
  it("B10：month=garbage → 400（唔准當某個估估吓嘅月份處理）", async () => {
    const res = await getBrokerDashboard(req("http://test.local/api/dashboard/broker?month=garbage", brokerACookie));
    expect(res.status).toBe(400);
  });

  it("B10：month=2026-13（形狀啱但月份唔存在）→ 400", async () => {
    const res = await getBrokerDashboard(req("http://test.local/api/dashboard/broker?month=2026-13", brokerACookie));
    expect(res.status).toBe(400);
  });

  // B7 驗收修正：「我有份嘅盤」= broker_site_assignments（該月）聯集
  // 本月有 settlement 更次嘅盤——有 assignment 但未開過更嘅盤都要出現
  // （更數 0），唔可以淨係靠「有冇更次」判斷「有冇份」。
  it("B7：有 broker_site_assignments 但呢個月未開過更嘅盤，都要出現喺 sites（更數 0）", async () => {
    const emptySite = await prisma.site.create({
      data: { canonicalName: "測試盤WP-R3-未開更", clientName: "測試客戶WP-R3", billingModel: "per_shift", createdBy: "test-fixture:wp-r3" },
    });
    await prisma.brokerSiteAssignment.create({
      data: { brokerId: fx.brokerA.id, siteId: emptySite.id, month: fx.unlockedMonth, createdBy: "test-fixture:wp-r3" },
    });

    const res = await getBrokerDashboard(req("http://test.local/api/dashboard/broker?month=2026-08", brokerACookie));
    const body = await res.json();

    const row = body.sites.find((s: { site_id: string }) => s.site_id === emptySite.id);
    expect(row).toBeDefined();
    expect(row.shifts).toBe(0);
    expect(row.pending).toBe(0);
    // fx.site（有更次）都要照舊出現——聯集，唔係淨係得 assignment 嗰盤。
    expect(body.sites.some((s: { site_id: string }) => s.site_id === fx.site.id)).toBe(true);
  });

  // B9 驗收修正：配額 KPI 分子只計「有設配額嘅 (盤,更別) 組合」嘅已排
  // 更數——呢度幫 fx.site 加多一個冇配額嘅更別（D），開多一條呢個更別
  // 嘅更次，證明佢唔會計落分子（分子應該淨係計原有嘅 N 更別嗰 1 條）。
  it("B9：配額分子淨係計有設配額嗰個 (盤,更別) 組合嘅已排更數，唔包冇配額嘅其他更別", async () => {
    const shiftTypeD = await prisma.shiftType.create({
      data: { siteId: fx.site.id, code: "D", label: "測試日更", hours: 12, createdBy: "test-fixture:wp-r3" },
    });
    await prisma.shiftRecord.create({
      data: {
        workDate: new Date(Date.UTC(2026, 7, 2)),
        siteId: fx.site.id,
        shiftTypeId: shiftTypeD.id,
        guardId: fx.guardA.id,
        settlementBrokerId: fx.brokerA.id,
        operationalBrokerId: fx.brokerA.id,
        recordType: "shift",
        clientRateSnapshot: 999,
        guardWageSnapshot: 700,
        brokerFeeSnapshot: 50,
        createdBy: "test-fixture:wp-r3",
      },
    });
    // 配額淨係幫原有嘅 N 更別（fx.shiftType）設，冇幫 D 設。
    await prisma.quota.create({
      data: { month: fx.unlockedMonth, siteId: fx.site.id, shiftTypeId: fx.shiftType.id, brokerId: fx.brokerA.id, targetShifts: 10, createdBy: "test-fixture:wp-r3" },
    });

    const res = await getBrokerDashboard(req("http://test.local/api/dashboard/broker?month=2026-08", brokerACookie));
    const body = await res.json();

    // scheduled_shifts（本月已排更數總計）依舊要計埋 D 嗰條（2 條）；
    // quota.scheduled_shifts（配額分子）淨係計 N 嗰 1 條。
    expect(body.scheduled_shifts).toBe(2);
    expect(body.quota).toEqual({ target_shifts: 10, scheduled_shifts: 1 });
  });
});
