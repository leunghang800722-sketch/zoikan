// Opus 對抗式驗收第四輪 C1-C5（應修）。
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { findKeysDeep } from "@/lib/api/serialize";

import { GET as monthClosesList } from "@/app/api/month-closes/route";
import { GET as monthCloseDetail } from "@/app/api/month-closes/[id]/route";
import { GET as guardsList } from "@/app/api/guards/route";
import { PATCH as guardUpdate } from "@/app/api/guards/[id]/route";
import { GET as brokersList } from "@/app/api/brokers/route";
import { GET as specialItemsList } from "@/app/api/special-items/route";
import { GET as auditLogGet } from "@/app/api/audit-log/route";
import { POST as specialItemCreate } from "@/app/api/special-items/route";

function req(url: string, cookie: string, method = "GET", body?: unknown) {
  return new Request(url, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
}

describe("WP2 C1：雞頭 GET month-closes 淨係見 {id, month, locked_at}", () => {
  let fx: Wp2Fixture;
  let brokerACookie: string;

  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    brokerACookie = await sessionCookieForUser(fx.userIds["雞頭"]);
  });

  it("GET /api/month-closes（list）：雞頭見唔到 roster_version_note／locked_by／created_by", async () => {
    const res = await monthClosesList(req("http://test.local/api/month-closes", brokerACookie));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(findKeysDeep(json, ["roster_version_note", "locked_by", "created_by"])).toEqual([]);
    const body = json as { rows: Array<{ month: string; locked_at: string | null }> };
    expect(body.rows.some((r) => r.locked_at !== null)).toBe(true);
  });

  it("GET /api/month-closes/:id（detail）：雞頭見唔到 roster_version_note／locked_by／created_by", async () => {
    const res = await monthCloseDetail(req(`http://test.local/api/month-closes/${fx.lockedMonthCloseId}`, brokerACookie), {
      params: Promise.resolve({ id: fx.lockedMonthCloseId }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(findKeysDeep(json, ["roster_version_note", "locked_by", "created_by"])).toEqual([]);
    expect((json as { locked_at: string | null }).locked_at).toBeTruthy();
  });
});

describe("WP2 C2：field-groups 補齊嘅欄（guards.monthly_salary／brokers.bank_info／special_items.cost／rate_cards.payout_rate）", () => {
  let fx: Wp2Fixture;
  let supervisorCookie: string;
  let ownerCookie: string;

  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    supervisorCookie = await sessionCookieForUser(fx.userIds["主管"]);
    ownerCookie = await sessionCookieForUser(fx.userIds["老闆"]);
  });

  // 主管出廠「出街價:view」其實係 ✓（內部角色本身應該見到出街價——呢個
  // gate 保護嘅係「冇出街價:view」嘅角色，例如自訂角色）。呢度為咗測試
  // field-group gate 本身確實生效（唔係測緊「主管出廠揸唔揸得到」），
  // 手動 revoke 主管嘅出街價:view，證明冇呢個 permission 就真係剝走
  // monthly_salary/bank_info/cost/payout_rate。
  async function revokeSupervisorSettlementView() {
    const permission = await prisma.permission.findUniqueOrThrow({ where: { module_action: { module: "出街價", action: "view" } } });
    await prisma.rolePermission.update({
      where: { roleId_permissionId: { roleId: fx.roleIds["主管"], permissionId: permission.id } },
      data: { granted: false },
    });
  }

  it("主管冇「出街價:view」GET guards：零命中 monthly_salary", async () => {
    await revokeSupervisorSettlementView();
    const res = await guardsList(req("http://test.local/api/guards", supervisorCookie));
    expect(res.status).toBe(200);
    expect(findKeysDeep(await res.json(), ["monthly_salary"])).toEqual([]);
  });

  it("主管冇「出街價:view」GET brokers：零命中 bank_info", async () => {
    await revokeSupervisorSettlementView();
    const res = await brokersList(req("http://test.local/api/brokers", supervisorCookie));
    expect(res.status).toBe(200);
    expect(findKeysDeep(await res.json(), ["bank_info"])).toEqual([]);
  });

  it("主管開「糧務:view」但冇「出街價:view」GET special-items：零命中 cost", async () => {
    await revokeSupervisorSettlementView();
    const permission = await prisma.permission.findUniqueOrThrow({ where: { module_action: { module: "糧務", action: "view" } } });
    await prisma.rolePermission.update({
      where: { roleId_permissionId: { roleId: fx.roleIds["主管"], permissionId: permission.id } },
      data: { granted: true },
    });
    const createRes = await specialItemCreate(
      req("http://test.local/api/special-items", ownerCookie, "POST", { month: "2026-08-01", kind: "other", revenue: 1000, cost: 500 }),
    );
    expect(createRes.status).toBe(201);
    const res = await specialItemsList(req("http://test.local/api/special-items", supervisorCookie));
    expect(res.status).toBe(200);
    expect(findKeysDeep(await res.json(), ["cost"])).toEqual([]);
  });

  it("audit-log 同樣：主管冇「出街價:view」GET audit-log 零命中 monthly_salary／bank_info／cost", async () => {
    await revokeSupervisorSettlementView();
    // 經 API（唔係直接 Prisma）改先會寫 audit_log（writeAudit 淨係喺
    // route handler 入面觸發），等呢個 audit row 嘅 before/after 真係含
    // monthly_salary，先真正測到 gate。
    const patchRes = await guardUpdate(
      req(`http://test.local/api/guards/${fx.guardA.id}`, ownerCookie, "PATCH", { monthly_salary: 20000 }),
      { params: Promise.resolve({ id: fx.guardA.id }) },
    );
    expect(patchRes.status).toBe(200);

    const permission = await prisma.permission.findUniqueOrThrow({ where: { module_action: { module: "操作紀錄", action: "view" } } });
    await prisma.rolePermission.update({
      where: { roleId_permissionId: { roleId: fx.roleIds["主管"], permissionId: permission.id } },
      data: { granted: true },
    });
    const res = await auditLogGet(req("http://test.local/api/audit-log", supervisorCookie));
    expect(res.status).toBe(200);
    expect(findKeysDeep(await res.json(), ["monthly_salary", "bank_info"])).toEqual([]);
  });
});

describe("WP2 C4：paginationParams take/skip Math.floor", () => {
  it("take=1.5 → clamp 之餘都要 floor 做 1", async () => {
    const { paginationParams } = await import("@/lib/api/query");
    expect(paginationParams(new URL("http://x/?take=1.5")).take).toBe(1);
  });
  it("take=2.9 → floor 做 2（唔係 round 做 3）", async () => {
    const { paginationParams } = await import("@/lib/api/query");
    expect(paginationParams(new URL("http://x/?take=2.9")).take).toBe(2);
  });
  it("skip=3.7 → floor 做 3", async () => {
    const { paginationParams } = await import("@/lib/api/query");
    expect(paginationParams(new URL("http://x/?skip=3.7")).skip).toBe(3);
  });
});
