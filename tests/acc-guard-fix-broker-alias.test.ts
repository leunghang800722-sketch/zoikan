// 驗收修正（2026-09-26）：雞頭稱呼對應——`POST /api/guard-fix/broker-alias`
// integration test。鐵則：合成測試用嘅「稱呼」（唔用真名），fixture 已有
// `brokerA`（code=TEST-BA、name=測試雞頭A，見 tests/fixtures/wp2-fixture.ts）。
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { POST as postBrokerAlias } from "@/app/api/guard-fix/broker-alias/route";

function reqJson(cookie: string, body: unknown) {
  return new Request("http://test/api/guard-fix/broker-alias", { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) });
}

describe("POST /api/guard-fix/broker-alias（驗收修正：雞頭稱呼對應）", () => {
  let fx: Wp2Fixture;
  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
  });

  it("RBAC：主管/會計/雞頭/安員一律 403（同呢一頁其餘寫入 action 一致用「安員配對修復」）", async () => {
    for (const role of ["主管", "會計", "雞頭", "安員"] as const) {
      const cookie = await sessionCookieForUser(fx.userIds[role]);
      const res = await postBrokerAlias(reqJson(cookie, { label: "測試稱呼甲", broker_id: fx.brokerA.id }));
      expect(res.status).toBe(403);
    }
  });

  it("老闆：新稱呼寫入 brokers.aliases，回 added:true，audit 一行（唔存稱呼本身，淨係 count）", async () => {
    const cookie = await sessionCookieForUser(fx.userIds["老闆"]);
    const res = await postBrokerAlias(reqJson(cookie, { label: "測試稱呼甲", broker_id: fx.brokerA.id }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.added).toBe(true);
    expect(body.broker.code).toBe("TEST-BA");

    const broker = await prisma.broker.findUniqueOrThrow({ where: { id: fx.brokerA.id } });
    expect(broker.aliases).toContain("測試稱呼甲");

    const audit = await prisma.auditLog.findFirst({ where: { tableName: "brokers", rowId: fx.brokerA.id, action: "update" }, orderBy: { createdAt: "desc" } });
    expect(audit).not.toBeNull();
    expect(JSON.stringify(audit?.after)).not.toContain("測試稱呼甲"); // 稱呼本身唔存入 audit
  });

  it("冪等：同一個稱呼再撳一次——added:false，aliases 唔會重複", async () => {
    const cookie = await sessionCookieForUser(fx.userIds["老闆"]);
    await postBrokerAlias(reqJson(cookie, { label: "測試稱呼甲", broker_id: fx.brokerA.id }));
    const res2 = await postBrokerAlias(reqJson(cookie, { label: "測試稱呼甲", broker_id: fx.brokerA.id }));
    expect(res2.status).toBe(200);
    const body2 = await res2.json();
    expect(body2.added).toBe(false);
    const broker = await prisma.broker.findUniqueOrThrow({ where: { id: fx.brokerA.id } });
    expect(broker.aliases.filter((a) => a === "測試稱呼甲")).toHaveLength(1);
  });

  it("同 code／name 一樣——當已經有，唔加（added:false）", async () => {
    const cookie = await sessionCookieForUser(fx.userIds["老闆"]);
    const res = await postBrokerAlias(reqJson(cookie, { label: "TEST-BA", broker_id: fx.brokerA.id }));
    const body = await res.json();
    expect(body.added).toBe(false);
    const res2 = await postBrokerAlias(reqJson(cookie, { label: "測試雞頭A", broker_id: fx.brokerA.id }));
    const body2 = await res2.json();
    expect(body2.added).toBe(false);
  });

  it("broker_id 搵唔到——404", async () => {
    const cookie = await sessionCookieForUser(fx.userIds["老闆"]);
    const res = await postBrokerAlias(reqJson(cookie, { label: "測試稱呼甲", broker_id: "00000000-0000-0000-0000-000000000000" }));
    expect(res.status).toBe(404);
  });

  it("label 空——400；broker_id 格式啱但搵唔到——404（同 schemas.ts 其他 uuid 欄一致，`uuid` 淨係要求非空字串，唔驗格式，交低層 lookup 判斷）", async () => {
    const cookie = await sessionCookieForUser(fx.userIds["老闆"]);
    const res1 = await postBrokerAlias(reqJson(cookie, { label: "", broker_id: fx.brokerA.id }));
    expect(res1.status).toBe(400);
    const res2 = await postBrokerAlias(reqJson(cookie, { label: "測試稱呼甲", broker_id: "not-a-uuid" }));
    expect(res2.status).toBe(404);
  });
});
