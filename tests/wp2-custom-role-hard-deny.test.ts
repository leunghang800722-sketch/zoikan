// Opus 對抗式驗收殘留2：自訂角色 hard-deny——roles.base_role（複製來源，
// 唔可以改）；isHardDenied() 用 base_role；未知角色一律當最嚴。
// test：複製雞頭改名後開 報表:view（用新矩陣嘅其中一個報表 module，例如
// 「月結總表」）→ 400，證明改名唔會逃過硬性禁止。
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieFor, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { requireSession, requirePermission } from "@/lib/rbac/requirePermission";
import { ApiError } from "@/lib/api/errors";
import { POST as rolesCreate } from "@/app/api/roles/route";
import { PATCH as permissionsPatch } from "@/app/api/roles/[id]/permissions/route";

function req(url: string, cookie: string, method: string, body?: unknown) {
  return new Request(url, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
}

describe("WP2 殘留2：自訂角色 hard-deny 用 base_role", () => {
  let fx: Wp2Fixture;
  let ownerCookie: string;

  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    ownerCookie = await sessionCookieForUser(fx.userIds["老闆"]);
  });

  it("複製雞頭角色改名做「高級雞頭」，base_role 仍然係「雞頭」", async () => {
    const res = await rolesCreate(
      req("http://test.local/api/roles", ownerCookie, "POST", { source_role_id: fx.roleIds["雞頭"], name: "高級雞頭" }),
    );
    expect(res.status).toBe(201);
    const created = (await res.json()) as { id: string; base_role: string; is_custom: boolean };
    expect(created.base_role).toBe("雞頭");
    expect(created.is_custom).toBe(true);

    const role = await prisma.role.findUniqueOrThrow({ where: { id: created.id } });
    expect(role.baseRole).toBe("雞頭");
  });

  it("複製雞頭改名後，PATCH /roles/:id/permissions 想開一個雞頭硬性禁止嘅格（月結總表:view）→ 400", async () => {
    const createRes = await rolesCreate(
      req("http://test.local/api/roles", ownerCookie, "POST", { source_role_id: fx.roleIds["雞頭"], name: "高級雞頭2" }),
    );
    const created = (await createRes.json()) as { id: string };

    const res = await permissionsPatch(
      req(`http://test.local/api/roles/${created.id}/permissions`, ownerCookie, "PATCH", {
        changes: [{ module: "月結總表", action: "view", granted: true }],
      }),
      { params: Promise.resolve({ id: created.id }) },
    );
    expect(res.status).toBe(400);

    // 確認真係冇寫入（DB 完全冇呢行，或者 granted 仍然係 false）
    const permission = await prisma.permission.findUniqueOrThrow({ where: { module_action: { module: "月結總表", action: "view" } } });
    const rp = await prisma.rolePermission.findUnique({ where: { roleId_permissionId: { roleId: created.id, permissionId: permission.id } } });
    expect(rp).toBeNull();
  });

  it("即使有人手動塞一條 granted=true 嘅 role_permission 落自訂角色，requirePermission() 都照拒（用 base_role 查硬性矩陣）", async () => {
    const createRes = await rolesCreate(
      req("http://test.local/api/roles", ownerCookie, "POST", { source_role_id: fx.roleIds["雞頭"], name: "高級雞頭3" }),
    );
    const created = (await createRes.json()) as { id: string };

    const permission = await prisma.permission.findUniqueOrThrow({ where: { module_action: { module: "盤", action: "view" } } });
    await prisma.rolePermission.create({ data: { roleId: created.id, permissionId: permission.id, granted: true, createdBy: "test" } });

    const user = await prisma.user.create({
      data: { name: "測試高級雞頭用戶", tel: "96000099", passwordHash: "x", roleId: created.id, brokerId: fx.brokerA.id, createdBy: "test" },
    });
    const cookie = await sessionCookieForUser(user.id);
    await expect(requirePermission(req("http://test.local/api/sites", cookie, "GET"), "盤", "view")).rejects.toMatchObject({ status: 403 });
  });

  it("未知角色（base_role 唔喺五個出廠角色之內）一律當最嚴——requireSession() 拒 403", async () => {
    // 呢個情況理論上唔應該發生（DB 冇 constraint 擋，但 API 冇任何路徑會
    // 整到一個未知 base_role），呢度直接 seal 一個模擬嘅 session 測試
    // fail-closed 行為。
    const cookie = await sessionCookieFor({
      userId: fx.userIds["老闆"],
      tel: "90000000",
      name: "測試",
      roleId: fx.roleIds["老闆"],
      roleName: "未知角色XYZ",
      baseRole: "未知角色XYZ",
      brokerId: null,
      guardId: null,
      payoutApprovalLimit: null,
      tokenVersion: 1,
      loggedInAt: new Date().toISOString(),
    });
    let caught: unknown;
    try {
      await requireSession(req("http://test.local/x", cookie, "GET"));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).status).toBe(403);
  });
});
