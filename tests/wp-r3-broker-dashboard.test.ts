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
});
