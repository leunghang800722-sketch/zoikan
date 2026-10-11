// P6.1d（H4）：broker_site_assignments POST／DELETE 已鎖月份 403，DB 零改動。
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { POST as createAssign } from "@/app/api/broker-site-assignments/route";
import { DELETE as deleteAssign } from "@/app/api/broker-site-assignments/[id]/route";

function req(url: string, cookie: string, method: string, body?: unknown) {
  return new Request(url, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
}

describe("P6.1d：掛盤鎖月", () => {
  let fx: Wp2Fixture;
  let ownerCookie: string;
  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    ownerCookie = await sessionCookieForUser(fx.userIds["老闆"]);
  });

  it("POST 已鎖月 → 403 month_locked，冇新 row", async () => {
    const before = await prisma.brokerSiteAssignment.count();
    const res = await createAssign(req("http://test.local/api/broker-site-assignments", ownerCookie, "POST", { broker_id: fx.brokerB.id, site_id: fx.site.id, month: "2026-06-01" }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("month_locked");
    expect(await prisma.brokerSiteAssignment.count()).toBe(before);
  });

  it("POST 未鎖月 → 201", async () => {
    const res = await createAssign(req("http://test.local/api/broker-site-assignments", ownerCookie, "POST", { broker_id: fx.brokerB.id, site_id: fx.siteUnassigned.id, month: "2026-08-01" }));
    expect(res.status).toBe(201);
  });

  it("DELETE 已鎖月嘅掛盤 → 403，row 仍然在", async () => {
    const a = await prisma.brokerSiteAssignment.create({ data: { brokerId: fx.brokerB.id, siteId: fx.siteUnassigned.id, month: fx.lockedMonth, createdBy: "test" } });
    const res = await deleteAssign(req(`http://test.local/api/broker-site-assignments/${a.id}`, ownerCookie, "DELETE"), { params: Promise.resolve({ id: a.id }) });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("month_locked");
    expect(await prisma.brokerSiteAssignment.findUnique({ where: { id: a.id } })).not.toBeNull();
  });

  it("DELETE 未鎖月 → 200 並刪除", async () => {
    const a = await prisma.brokerSiteAssignment.create({ data: { brokerId: fx.brokerB.id, siteId: fx.siteUnassigned.id, month: fx.unlockedMonth, createdBy: "test" } });
    const res = await deleteAssign(req(`http://test.local/api/broker-site-assignments/${a.id}`, ownerCookie, "DELETE"), { params: Promise.resolve({ id: a.id }) });
    expect(res.status).toBe(200);
    expect(await prisma.brokerSiteAssignment.findUnique({ where: { id: a.id } })).toBeNull();
  });
});
