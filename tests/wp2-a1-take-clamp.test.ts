// Opus 對抗式驗收第三輪 A1（應修）：`take` clamp。
import { describe, it, expect, beforeEach } from "vitest";
import { paginationParams } from "@/lib/api/query";
import { clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { GET as sitesList } from "@/app/api/sites/route";

function req(url: string, cookie: string) {
  return new Request(url, { method: "GET", headers: { cookie } });
}

describe("A1：paginationParams take clamp", () => {
  it("take=-1 → clamp 到 1（唔係負數，亦唔係 500 錯誤嘅 -1）", () => {
    expect(paginationParams(new URL("http://x/?take=-1")).take).toBe(1);
  });
  it("take=0 → clamp 到 1", () => {
    expect(paginationParams(new URL("http://x/?take=0")).take).toBe(1);
  });
  it("take=99999 → clamp 到上限 500", () => {
    expect(paginationParams(new URL("http://x/?take=99999")).take).toBe(500);
  });
  it("冇傳 take → 預設 100", () => {
    expect(paginationParams(new URL("http://x/")).take).toBe(100);
  });
  it("take=abc（唔係數字）→ 預設 100", () => {
    expect(paginationParams(new URL("http://x/?take=abc")).take).toBe(100);
  });
  it("skip=-5 → clamp 到 0", () => {
    expect(paginationParams(new URL("http://x/?skip=-5")).skip).toBe(0);
  });

  describe("端到端：list route 帶 take=-1 唔會 500", () => {
    let fx: Wp2Fixture;
    let ownerCookie: string;

    beforeEach(async () => {
      await clearAll();
      fx = await seedWp2Fixture();
      ownerCookie = await sessionCookieForUser(fx.userIds["老闆"]);
    });

    it("GET /api/sites?take=-1 → 200，唔係 500", async () => {
      const res = await sitesList(req("http://test.local/api/sites?take=-1", ownerCookie));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { take: number };
      expect(body.take).toBe(1);
    });
  });
});
