// WP-LTPAY §21 任務 5d：`/api/longterm/avg-wages`／`/api/longterm/
// leave-balances` integration test——RBAC＋upsert／人手覆核 audit。
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { GET as listAvgWages, POST as upsertAvgWage } from "@/app/api/longterm/avg-wages/route";
import { GET as listLeaveBalances } from "@/app/api/longterm/leave-balances/route";
import { PATCH as patchLeaveBalance } from "@/app/api/longterm/leave-balances/[id]/route";

function req(url: string, cookie: string, method = "GET", body?: unknown) {
  return new Request(url, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
}

describe("/api/longterm/avg-wages", () => {
  let fx: Wp2Fixture;
  let ownerCookie: string;
  let brokerCookie: string;
  let guardId: string;

  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    ownerCookie = await sessionCookieForUser(fx.userIds["老闆"]);
    brokerCookie = await sessionCookieForUser(fx.userIds["雞頭"]);
    const guard = await prisma.guard.create({ data: { nameZh: "測試長工-avgwage", employmentType: "longterm_autopay", createdBy: "test" } });
    guardId = guard.id;
  });

  it("雞頭 403", async () => {
    const res = await listAvgWages(req("http://test.local/api/longterm/avg-wages", brokerCookie));
    expect(res.status).toBe(403);
  });

  it("POST upsert：第一次建，第二次改值（唔會重複建行）", async () => {
    const createRes = await upsertAvgWage(
      req("http://test.local/api/longterm/avg-wages", ownerCookie, "POST", { guard_id: guardId, month: "2026-08-01", avg_daily_wage: 550, source: "7 月計糧表平均工資欄" }),
    );
    expect(createRes.status).toBe(201);

    const updateRes = await upsertAvgWage(
      req("http://test.local/api/longterm/avg-wages", ownerCookie, "POST", { guard_id: guardId, month: "2026-08-01", avg_daily_wage: 600, source: "人手覆核" }),
    );
    expect(updateRes.status).toBe(201);
    expect(Number((await updateRes.json()).avg_daily_wage)).toBe(600);

    const rows = await prisma.guardAvgWage.findMany({ where: { guardId } });
    expect(rows.length).toBe(1);

    const listRes = await listAvgWages(req("http://test.local/api/longterm/avg-wages?month=2026-08", ownerCookie));
    const body = await listRes.json();
    expect(body.rows.length).toBe(1);
    expect(body.rows[0].guard_name).toBe("測試長工-avgwage");
  });

  it("avg_daily_wage 唔係數字 → 400", async () => {
    const res = await upsertAvgWage(
      req("http://test.local/api/longterm/avg-wages", ownerCookie, "POST", { guard_id: guardId, month: "2026-08-01", avg_daily_wage: "唔係數字", source: "test" }),
    );
    expect(res.status).toBe(400);
  });
});

describe("/api/longterm/leave-balances", () => {
  let fx: Wp2Fixture;
  let ownerCookie: string;
  let guardId: string;
  let balanceId: string;

  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    ownerCookie = await sessionCookieForUser(fx.userIds["老闆"]);
    const guard = await prisma.guard.create({ data: { nameZh: "測試長工-leavebal", employmentType: "longterm_autopay", createdBy: "test" } });
    guardId = guard.id;
    const balance = await prisma.guardLeaveBalance.create({ data: { guardId, year: 2026, alTaken: 3, slTaken: 0, slAccrued: 10 } });
    balanceId = balance.id;
  });

  it("GET 列表 join 埋安員姓名", async () => {
    const res = await listLeaveBalances(req("http://test.local/api/longterm/leave-balances?year=2026", ownerCookie));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rows.length).toBe(1);
    expect(body.rows[0].guard_name).toBe("測試長工-leavebal");
  });

  it("PATCH 人手覆核——audit 留底邊個幾時改", async () => {
    const res = await patchLeaveBalance(req(`http://test.local/api/longterm/leave-balances/${balanceId}`, ownerCookie, "PATCH", { al_taken: 5, sl_taken: 2, sl_accrued: 12 }), {
      params: Promise.resolve({ id: balanceId }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Number(body.al_taken)).toBe(5);

    const auditRows = await prisma.auditLog.findMany({ where: { tableName: "guard_leave_balances", rowId: balanceId, action: "update" } });
    expect(auditRows.length).toBe(1);
  });
});
