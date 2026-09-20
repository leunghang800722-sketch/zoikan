// 應修 4（Opus 驗收覆核）：`settlement_broker_id`／`operational_broker_id`
// 之前淨係 zod 格式校驗（`uuid`），冇校驗真係存在——傳一個格式啱但唔
// 存在嘅 UUID 會一路帶到 `prisma.shiftRecord.create()`/`update()` 先撞
// FK constraint，變成未經處理嘅 500。雞頭 session 帶咗第二個雞頭嘅 id
// 落 batch route，之前完全冇讀 payload 呢個欄（靜靜用自己個 id 蓋過
// 去）。而家兩個問題都喺 `src/lib/broker-isolation.ts`
// `assertSettlementBrokerIdsValid()` 度攔截，呢度直接打 batch route／
// 單筆 POST route 驗證。
import { describe, it, expect, beforeEach } from "vitest";
import { clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { POST as batchSave } from "@/app/api/shift-records/batch/route";
import { POST as shiftRecordCreate } from "@/app/api/shift-records/route";

const NONEXISTENT_UUID = "00000000-0000-0000-0000-000000000000";

function req(url: string, cookie: string, method: string, body?: unknown) {
  return new Request(url, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
}

describe("應修 4：POST /api/shift-records/batch——settlement_broker_id 校驗", () => {
  let fx: Wp2Fixture;
  let ownerCookie: string;
  let brokerACookie: string;

  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    ownerCookie = await sessionCookieForUser(fx.userIds["老闆"]);
    brokerACookie = await sessionCookieForUser(fx.userIds["雞頭"]); // 掛 brokerA
  });

  it("內部角色（老闆）settlement_broker_id 帶一個唔存在嘅 UUID → 400（唔係 FK 500）", async () => {
    const res = await batchSave(
      req("http://test.local/api/shift-records/batch", ownerCookie, "POST", {
        site_id: fx.site.id,
        month: "2026-08",
        cells: [{ guard_id: fx.guardA.id, shift_type_id: fx.shiftType.id, work_date: "2026-08-15", code: "N", settlement_broker_id: NONEXISTENT_UUID }],
      }),
    );
    expect(res.status).toBe(400);
  });

  it("雞頭（brokerA）session 帶咗 brokerB 嘅 settlement_broker_id → 403（之前靜靜用自己個 id 蓋過去）", async () => {
    const res = await batchSave(
      req("http://test.local/api/shift-records/batch", brokerACookie, "POST", {
        site_id: fx.site.id,
        month: "2026-08",
        cells: [{ guard_id: fx.guardA.id, shift_type_id: fx.shiftType.id, work_date: "2026-08-16", code: "N", settlement_broker_id: fx.brokerB.id }],
      }),
    );
    expect(res.status).toBe(403);
  });

  it("雞頭（brokerA）session 帶返自己嘅 broker id → 唔受影響，照樣 200", async () => {
    const res = await batchSave(
      req("http://test.local/api/shift-records/batch", brokerACookie, "POST", {
        site_id: fx.site.id,
        month: "2026-08",
        cells: [{ guard_id: fx.guardA.id, shift_type_id: fx.shiftType.id, work_date: "2026-08-17", code: "N", settlement_broker_id: fx.brokerA.id }],
      }),
    );
    expect(res.status).toBe(200);
  });

  it("內部角色帶一個真實存在嘅 broker id → 唔受影響，照樣 200（對照組）", async () => {
    const res = await batchSave(
      req("http://test.local/api/shift-records/batch", ownerCookie, "POST", {
        site_id: fx.site.id,
        month: "2026-08",
        cells: [{ guard_id: fx.guardA.id, shift_type_id: fx.shiftType.id, work_date: "2026-08-18", code: "N", settlement_broker_id: fx.brokerB.id }],
      }),
    );
    expect(res.status).toBe(200);
  });
});

describe("應修 4：POST /api/shift-records（單筆，內部角色）——settlement/operational_broker_id 校驗", () => {
  let fx: Wp2Fixture;
  let ownerCookie: string;

  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    ownerCookie = await sessionCookieForUser(fx.userIds["老闆"]);
  });

  it("settlement_broker_id 帶一個唔存在嘅 UUID → 400（唔係 FK 500）", async () => {
    const res = await shiftRecordCreate(
      req("http://test.local/api/shift-records", ownerCookie, "POST", {
        work_date: "2026-08-19",
        site_id: fx.site.id,
        shift_type_id: fx.shiftType.id,
        guard_id: fx.guardA.id,
        settlement_broker_id: NONEXISTENT_UUID,
        record_type: "shift",
      }),
    );
    expect(res.status).toBe(400);
  });

  it("operational_broker_id 帶一個唔存在嘅 UUID（settlement 本身合法）→ 400", async () => {
    const res = await shiftRecordCreate(
      req("http://test.local/api/shift-records", ownerCookie, "POST", {
        work_date: "2026-08-20",
        site_id: fx.site.id,
        shift_type_id: fx.shiftType.id,
        guard_id: fx.guardA.id,
        settlement_broker_id: fx.brokerA.id,
        operational_broker_id: NONEXISTENT_UUID,
        record_type: "shift",
      }),
    );
    expect(res.status).toBe(400);
  });

  it("settlement_broker_id 帶一個真實存在嘅 broker id → 唔受影響，照樣 201（對照組）", async () => {
    const res = await shiftRecordCreate(
      req("http://test.local/api/shift-records", ownerCookie, "POST", {
        work_date: "2026-08-21",
        site_id: fx.site.id,
        shift_type_id: fx.shiftType.id,
        guard_id: fx.guardA.id,
        settlement_broker_id: fx.brokerA.id,
        record_type: "shift",
      }),
    );
    expect(res.status).toBe(201);
  });
});
