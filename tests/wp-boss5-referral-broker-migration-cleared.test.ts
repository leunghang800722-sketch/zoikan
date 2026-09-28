// WP-BOSS5 驗收項 5：GET /api/guards/[id] 嘅 `referral_broker_migration_
// cleared` 之前淨係睇「曾經有過 migration_clear_internal_referral 呢粒
// audit」就當 true——如果之後有人手幫呢個安員重新揀返一個
// referral_broker_id（唔再係 null），前端仲會繼續顯示「已清」提示，同
// 現況唔夾。而家改咗要求「現值 referral_broker_id 係 null」先 true。
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { GET as guardGetOne } from "@/app/api/guards/[id]/route";

function req(url: string, cookie: string) {
  return new Request(url, { headers: { cookie } });
}

describe("GET /api/guards/[id]：referral_broker_migration_cleared（WP-BOSS5 驗收項 5）", () => {
  let fx: Wp2Fixture;
  let ownerCookie: string;

  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    ownerCookie = await sessionCookieForUser(fx.userIds["老闆"]);
  });

  async function makeGuardWithMigrationLog(referralBrokerId: string | null) {
    const guard = await prisma.guard.create({
      data: { nameZh: "測試安員-referral-migration", employmentType: "cash_casual", referralBrokerId, createdBy: "test" },
    });
    await prisma.auditLog.create({
      data: {
        actorUserId: fx.userIds["老闆"],
        tableName: "guards",
        rowId: guard.id,
        action: "migration_clear_internal_referral",
        before: { referral_broker_code: "Y" },
        after: { referral_broker_code: null },
      },
    });
    return guard;
  }

  it("有 migration audit＋現值 referral_broker_id 仍然係 null → true", async () => {
    const guard = await makeGuardWithMigrationLog(null);
    const res = await guardGetOne(req(`http://test.local/api/guards/${guard.id}`, ownerCookie), { params: Promise.resolve({ id: guard.id }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.referral_broker_migration_cleared).toBe(true);
  });

  it("有 migration audit，但之後人手重新揀咗 referral_broker_id（唔再係 null）→ false", async () => {
    const guard = await makeGuardWithMigrationLog(fx.brokerA.id);
    const res = await guardGetOne(req(`http://test.local/api/guards/${guard.id}`, ownerCookie), { params: Promise.resolve({ id: guard.id }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.referral_broker_migration_cleared).toBe(false);
  });

  it("冇 migration audit（從來冇被呢個 migration 掂過）→ false", async () => {
    const guard = await prisma.guard.create({ data: { nameZh: "測試安員-冇audit", employmentType: "cash_casual", referralBrokerId: null, createdBy: "test" } });
    const res = await guardGetOne(req(`http://test.local/api/guards/${guard.id}`, ownerCookie), { params: Promise.resolve({ id: guard.id }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.referral_broker_migration_cleared).toBe(false);
  });
});
