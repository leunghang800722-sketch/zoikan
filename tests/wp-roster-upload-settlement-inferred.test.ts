// WP-ROSTER-UPLOAD Phase B-1（B1-5，WP-ATTRIB）：`POST /api/shift-records/batch`
// response 新 additive 欄 `settlement_inferred`——格仔冇喺 payload／現存
// 記錉度攞到 settlement_broker_id，靠 resolveSettlementBrokerFallback()
// 推算先至有值——等 RosterEditor 儲存完可以 toast「N 格結算單位推算」。
import { describe, it, expect, beforeEach } from "vitest";
import { clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { POST as batchSave } from "@/app/api/shift-records/batch/route";

function req(url: string, cookie: string, method: string, body?: unknown) {
  return new Request(url, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
}

describe("WP-ROSTER-UPLOAD Phase B-1（B1-5）：batch 儲存 settlement_inferred 標記", () => {
  let fx: Wp2Fixture;
  let ownerCookie: string;

  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    ownerCookie = await sessionCookieForUser(fx.userIds["老闆"]);
  });

  it("cells 冇帶 settlement_broker_id → 跌落 fallback（guard.default_broker_id）→ settlement_inferred=true", async () => {
    const res = await batchSave(
      req("http://test.local/api/shift-records/batch", ownerCookie, "POST", {
        site_id: fx.site.id,
        month: "2026-08",
        cells: [{ guard_id: fx.guardB.id, shift_type_id: fx.shiftType.id, work_date: "2026-08-05", code: "N" }],
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: { settlement_inferred?: boolean }[]; settlement_inferred_count: number };
    expect(body.results[0]!.settlement_inferred).toBe(true);
    expect(body.settlement_inferred_count).toBe(1);
  });

  it("cells 帶咗明確 settlement_broker_id → settlement_inferred=false", async () => {
    const res = await batchSave(
      req("http://test.local/api/shift-records/batch", ownerCookie, "POST", {
        site_id: fx.site.id,
        month: "2026-08",
        cells: [{ guard_id: fx.guardB.id, shift_type_id: fx.shiftType.id, work_date: "2026-08-06", code: "N", settlement_broker_id: fx.brokerB.id }],
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: { settlement_inferred?: boolean }[]; settlement_inferred_count: number };
    expect(body.results[0]!.settlement_inferred).toBe(false);
    expect(body.settlement_inferred_count).toBe(0);
  });
});
