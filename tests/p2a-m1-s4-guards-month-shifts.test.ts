// P2-A 驗收修復：
// M1——GET /api/guards?with_month_shifts= 舊版 regex `^\d{4}-\d{2}$` 會
// 接受「2026-13」「2026-00」呢類結構啱但月份唔存在嘅字串，令
// `loadMonthShiftCounts()` 拎到 Invalid Date 落 Prisma query 直接 500。
// 收緊做 `^\d{4}-(0[1-9]|1[0-2])$`，格式唔啱一律 400 BadRequest（同
// referral-fee-rates/quotas/broker-site-assignments 呢類 route 一致）。
// S4——`monthShiftCount` 而家喺 DTO／field-group gate 之前就 merge 落
// raw rows，行 `pickWhitelist()` 正常白名單路徑（GUARD_FIELDS／
// GUARD_BROKER_FIELDS 已加呢個欄）；呢個 test 順便驗證內部角色／雞頭
// 角色兩邊都仲見到 `month_shift_count`（冇因為呢次重構而拆散咗）。
import { describe, it, expect, beforeEach } from "vitest";
import { clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { GET as guardsList } from "@/app/api/guards/route";

function req(url: string, cookie: string) {
  return new Request(url, { method: "GET", headers: { cookie } });
}

describe("P2-A M1：with_month_shifts 格式驗證", () => {
  let fx: Wp2Fixture;
  let ownerCookie: string;
  let brokerACookie: string;

  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    ownerCookie = await sessionCookieForUser(fx.userIds["老闆"]);
    brokerACookie = await sessionCookieForUser(fx.userIds["雞頭"]);
  });

  it("with_month_shifts=2026-13（月份唔存在）→ 400，唔係 500", async () => {
    const res = await guardsList(req("http://test.local/api/guards?with_month_shifts=2026-13", ownerCookie));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("bad_request");
  });

  it("with_month_shifts=2026-00（月份唔存在）→ 400，唔係 500", async () => {
    const res = await guardsList(req("http://test.local/api/guards?with_month_shifts=2026-00", ownerCookie));
    expect(res.status).toBe(400);
  });

  it("with_month_shifts=2026-8（冇補零）→ 400", async () => {
    const res = await guardsList(req("http://test.local/api/guards?with_month_shifts=2026-8", ownerCookie));
    expect(res.status).toBe(400);
  });

  it("with_month_shifts=abc（完全唔啱格式）→ 400", async () => {
    const res = await guardsList(req("http://test.local/api/guards?with_month_shifts=abc", ownerCookie));
    expect(res.status).toBe(400);
  });

  it("with_month_shifts=2026-08（啱格式）→ 200，返回正確更數", async () => {
    const res = await guardsList(req("http://test.local/api/guards?with_month_shifts=2026-08", ownerCookie));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: Array<{ id: string; month_shift_count?: number }> };
    const guardA = body.rows.find((r) => r.id === fx.guardA.id);
    expect(guardA?.month_shift_count).toBe(1);
  });

  it("冇傳 with_month_shifts → 200，rows 冇 month_shift_count 呢個 key", async () => {
    const res = await guardsList(req("http://test.local/api/guards", ownerCookie));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: Array<Record<string, unknown>> };
    const guardA = body.rows.find((r) => r.id === fx.guardA.id);
    expect(guardA).toBeDefined();
    expect(guardA && "month_shift_count" in guardA).toBe(false);
  });

  it("S4：雞頭角色 GET 自己保安員 with_month_shifts=2026-08 一樣見到 month_shift_count（白名單行正路，唔靠 gate 之後先加）", async () => {
    const res = await guardsList(req("http://test.local/api/guards?with_month_shifts=2026-08", brokerACookie));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: Array<{ id: string; month_shift_count?: number }> };
    const guardA = body.rows.find((r) => r.id === fx.guardA.id);
    expect(guardA?.month_shift_count).toBe(1);
  });

  it("S4：雞頭角色 with_month_shifts 格式唔啱一樣 400（唔會漏咗做內部角色先驗證）", async () => {
    const res = await guardsList(req("http://test.local/api/guards?with_month_shifts=2026-13", brokerACookie));
    expect(res.status).toBe(400);
  });
});
