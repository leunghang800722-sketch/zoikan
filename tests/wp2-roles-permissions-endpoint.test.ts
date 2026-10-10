// P1-WP2：角色權限管理 endpoint（roles/:id/permissions）——GET 攞矩陣
// （含 hard_denied 旗標），PATCH 逐格改 granted；硬性禁止格 PATCH 要拒。
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { GET as permissionsGet, PATCH as permissionsPatch } from "@/app/api/roles/[id]/permissions/route";
import { MODULES, ACTIONS } from "@/lib/rbac/matrix";

function req(url: string, cookie: string, method: string, body?: unknown) {
  return new Request(url, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
}

describe("WP2 角色權限管理 endpoint", () => {
  let fx: Wp2Fixture;
  let ownerCookie: string;

  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    ownerCookie = await sessionCookieForUser(fx.userIds["老闆"]);
  });

  it(`GET 攞雞頭角色嘅矩陣：${MODULES.length * ACTIONS.length} 格（C3 拆細後），盤:view 應該 hard_denied=true 兼 granted=false`, async () => {
    const res = await permissionsGet(req(`http://test.local/api/roles/${fx.roleIds["雞頭"]}/permissions`, ownerCookie, "GET"), {
      params: Promise.resolve({ id: fx.roleIds["雞頭"] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { cells: Array<{ module: string; action: string; granted: boolean; hard_denied: boolean }> };
    expect(body.cells.length).toBe(MODULES.length * ACTIONS.length);
    const siteView = body.cells.find((c) => c.module === "盤" && c.action === "view")!;
    expect(siteView.hard_denied).toBe(true);
    expect(siteView.granted).toBe(false);
    const shiftView = body.cells.find((c) => c.module === "更表" && c.action === "view")!;
    expect(shiftView.hard_denied).toBe(false);
    expect(shiftView.granted).toBe(true);
    // C3：收客價連 view 都硬性禁止（硬性規則1第一層防線）
    const clientRateView = body.cells.find((c) => c.module === "收客價" && c.action === "view")!;
    expect(clientRateView.hard_denied).toBe(true);
    // C3：保安員:view 而家係 off（唔係 hard_denied），自己保安員:view 先係 grant
    const guardView = body.cells.find((c) => c.module === "安員" && c.action === "view")!;
    expect(guardView.hard_denied).toBe(false);
    expect(guardView.granted).toBe(false);
    const ownGuardView = body.cells.find((c) => c.module === "自己安員" && c.action === "view")!;
    expect(ownGuardView.hard_denied).toBe(false);
    expect(ownGuardView.granted).toBe(true);
  });

  it("PATCH 想開一個硬性禁止格（雞頭/盤:view）——400 拒絕，唔會寫入", async () => {
    const res = await permissionsPatch(
      req(`http://test.local/api/roles/${fx.roleIds["雞頭"]}/permissions`, ownerCookie, "PATCH", {
        changes: [{ module: "盤", action: "view", granted: true }],
      }),
      { params: Promise.resolve({ id: fx.roleIds["雞頭"] }) },
    );
    expect(res.status).toBe(400);

    const permission = await prisma.permission.findUniqueOrThrow({ where: { module_action: { module: "盤", action: "view" } } });
    const rp = await prisma.rolePermission.findUnique({ where: { roleId_permissionId: { roleId: fx.roleIds["雞頭"], permissionId: permission.id } } });
    expect(rp).toBeNull(); // 完全冇呢行，唔係 granted=false
  });

  it("PATCH 開返一個「○」格（會計/批核糧務批次:update）——成功，之後查得返", async () => {
    const before = await prisma.rolePermission.findFirst({
      where: { roleId: fx.roleIds["會計"], permission: { module: "批核糧務批次", action: "update" } },
    });
    expect(before?.granted).toBe(false); // 出廠 off（○高級）

    const res = await permissionsPatch(
      req(`http://test.local/api/roles/${fx.roleIds["會計"]}/permissions`, ownerCookie, "PATCH", {
        changes: [{ module: "批核糧務批次", action: "update", granted: true }],
      }),
      { params: Promise.resolve({ id: fx.roleIds["會計"] }) },
    );
    expect(res.status).toBe(200);

    const after = await prisma.rolePermission.findFirst({ where: { roleId: fx.roleIds["會計"], permission: { module: "批核糧務批次", action: "update" } } });
    expect(after?.granted).toBe(true);

    const audit = await prisma.auditLog.findFirst({ where: { tableName: "role_permissions", rowId: fx.roleIds["會計"], action: "update" } });
    expect(audit).toBeTruthy();
  });
});
