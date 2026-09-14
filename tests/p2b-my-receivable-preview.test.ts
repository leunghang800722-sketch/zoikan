// P2-B（README §11 本月應收）additive 行為——GET /api/reports/my-receivable
// 加咗 `?broker=<code 或 id>` 俾老闆/會計/主管（有「出街價:view」）預覽
// 某個雞頭嘅本月應收；雞頭 session 完全忽略呢個參數，一律淨係見自己。
// 舊有「老闆冇帶 broker → 403」語意喺 tests/wp4-reports.test.ts 已覆蓋，
// 呢度唔重複。同時覆蓋新加嘅 pending_count/pending_amount（待審批 stat）。
import { describe, it, expect, beforeEach } from "vitest";
import { clearAll } from "./lib/db";
import { prisma } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { GET as getMyReceivable } from "@/app/api/reports/my-receivable/route";
import { findKeysDeep, findSubstringInValuesDeep } from "@/lib/api/serialize";
import { BROKER_FORBIDDEN_KEYS } from "@/lib/broker-isolation";

function req(url: string, cookie: string) {
  return new Request(url, { method: "GET", headers: { "content-type": "application/json", cookie } });
}

describe("P2-B：本月應收 ?broker= 預覽（GET /api/reports/my-receivable）", () => {
  let fx: Wp2Fixture;
  let ownerCookie: string;
  let brokerACookie: string;

  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    ownerCookie = await sessionCookieForUser(fx.userIds["老闆"]);
    brokerACookie = await sessionCookieForUser(fx.userIds["雞頭"]); // 雞頭A，掛 brokerA
  });

  it("老闆帶 ?broker=<brokerA code> → 200，見到 brokerA 嗰份（750），previewing=true 標明邊個雞頭", async () => {
    const res = await getMyReceivable(req("http://test.local/api/reports/my-receivable?month=2026-08&broker=TEST-BA", ownerCookie));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(750);
    expect(body.previewing).toBe(true);
    expect(body.broker_code).toBe("TEST-BA");
  });

  it("老闆帶 ?broker=<brokerA id>（用 id 代替 code）→ 一樣揾到", async () => {
    const res = await getMyReceivable(req(`http://test.local/api/reports/my-receivable?month=2026-08&broker=${fx.brokerA.id}`, ownerCookie));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(750);
  });

  it("老闆帶 ?broker=唔存在嘅代號 → 400", async () => {
    const res = await getMyReceivable(req("http://test.local/api/reports/my-receivable?month=2026-08&broker=NOSUCHCODE", ownerCookie));
    expect(res.status).toBe(400);
  });

  it("雞頭A 帶 ?broker=<brokerB id>（想扮睇 brokerB）→ 完全忽略，仍然淨係見返自己（750，唔係 brokerB 嘅 999），零 brokerB 痕跡", async () => {
    const res = await getMyReceivable(req(`http://test.local/api/reports/my-receivable?month=2026-08&broker=${fx.brokerB.id}`, brokerACookie));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(750);
    expect(body.previewing).toBe(false);

    const forbidden = findKeysDeep(body, [...BROKER_FORBIDDEN_KEYS]);
    expect(forbidden).toEqual([]);
    const brokerBLeak = findSubstringInValuesDeep(body, [fx.brokerB.id]);
    expect(brokerBLeak).toEqual([]);
  });

  // 老闆 2026-09-15 拍板：主管可以見到出街價——`?broker=` 預覽只要
  // 「出街價:view」，主管出廠有 → 200（唔再要「收客價」）；雞頭 session
  // 唔受影響（結構性行 else branch 之前）。
  it("老闆拍板：主管帶 ?broker= 預覽——有「出街價」權限即可，200，見到出街價合計", async () => {
    const supervisorCookie = await sessionCookieForUser(fx.userIds["主管"]);
    const res = await getMyReceivable(req("http://test.local/api/reports/my-receivable?month=2026-08&broker=TEST-BA", supervisorCookie));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(750);
    expect(body.previewing).toBe(true);
    expect(JSON.stringify(body)).not.toMatch(/client_rate|clientRate/);
  });

  it("會計帶 ?broker= 預覽——照舊 200", async () => {
    const accountantCookie = await sessionCookieForUser(fx.userIds["會計"]);
    const res = await getMyReceivable(req("http://test.local/api/reports/my-receivable?month=2026-08&broker=TEST-BA", accountantCookie));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(750);
    expect(body.previewing).toBe(true);
  });

  it("雞頭A 自己嗰個 route（唔經預覽分支）照舊 200", async () => {
    const res = await getMyReceivable(req("http://test.local/api/reports/my-receivable?month=2026-08", brokerACookie));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(750);
    expect(body.previewing).toBe(false);
  });

  it("待審批 stat：新加一條 pending_approval 嘅更，pending_count=1，pending_amount=嗰條金額，total_shifts 計埋佢", async () => {
    await prisma.shiftRecord.create({
      data: {
        workDate: new Date(Date.UTC(2026, 7, 3)),
        siteId: fx.site.id,
        shiftTypeId: fx.shiftType.id,
        guardId: fx.guardA.id,
        settlementBrokerId: fx.brokerA.id,
        operationalBrokerId: fx.brokerA.id,
        recordType: "shift",
        status: "pending_approval",
        clientRateSnapshot: 999,
        guardWageSnapshot: 700,
        brokerFeeSnapshot: 50,
        createdBy: "test-fixture:p2b",
      },
    });
    const res = await getMyReceivable(req("http://test.local/api/reports/my-receivable?month=2026-08", brokerACookie));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total_shifts).toBe(2);
    expect(body.pending_count).toBe(1);
    expect(body.pending_amount).toBe(750);
    expect(body.total).toBe(1500);
  });
});
