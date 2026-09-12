// P1-WP2 §D 矩陣逐格 test：5 角色 × 50 permission（10 module × 5 action）。
// ✓ 通、○ 預設拒、✗ 永遠拒（即使 role_permissions 被塞入 granted=true 都拒）。
import { describe, it, expect, beforeAll } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { requirePermission } from "@/lib/rbac/requirePermission";
import { MODULES, ACTIONS, DEFAULT_MATRIX, ROLE_NAMES } from "@/lib/rbac/matrix";
import { ApiError } from "@/lib/api/errors";

function reqWithCookie(cookie: string) {
  return new Request("http://test.local/api/x", { headers: { cookie } });
}

describe("WP2 RBAC 矩陣逐格", () => {
  let fx: Wp2Fixture;
  const cookieByRole: Record<string, string> = {};

  beforeAll(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    for (const roleName of ROLE_NAMES) {
      cookieByRole[roleName] = await sessionCookieForUser(fx.userIds[roleName]);
    }
  });

  for (const roleName of ROLE_NAMES) {
    for (const mod of MODULES) {
      for (const action of ACTIONS) {
        const cell = DEFAULT_MATRIX[roleName][mod][action];
        const label = `${roleName} / ${mod}:${action} = ${cell}`;

        if (cell === "grant") {
          it(`✓ ${label} → 通過`, async () => {
            const session = await requirePermission(reqWithCookie(cookieByRole[roleName]), mod, action);
            expect(session.roleName).toBe(roleName);
          });
        } else {
          it(`${cell === "off" ? "○" : "✗"} ${label} → 拒（403）`, async () => {
            await expect(requirePermission(reqWithCookie(cookieByRole[roleName]), mod, action)).rejects.toMatchObject({ status: 403 });
          });
        }
      }
    }
  }

  it("✗ 硬性禁止：即使有人手動塞一條 granted=true 嘅 role_permission，都照拒", async () => {
    // 雞頭角色「盤:view」喺 matrix.ts 係 deny——seed 冇生成呢行，呢度模擬
    // 「被入侵/手誤塞咗一行」，確認 requirePermission 唔止靠「冇呢行」，
    // 仲有 matrix.ts 嘅 runtime hard-deny check 兜底。
    const role = await prisma.role.findUniqueOrThrow({ where: { id: fx.roleIds["雞頭"] } });
    const permission = await prisma.permission.findUniqueOrThrow({ where: { module_action: { module: "盤", action: "view" } } });
    await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: permission.id, granted: true, createdBy: "test:hard-deny-bypass-attempt" } });

    let caught: unknown;
    try {
      await requirePermission(reqWithCookie(cookieByRole["雞頭"]), "盤", "view");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).status).toBe(403);

    await prisma.rolePermission.delete({ where: { roleId_permissionId: { roleId: role.id, permissionId: permission.id } } });
  });

  it("未登入（冇 session）一律 401", async () => {
    await expect(requirePermission(new Request("http://test.local/api/x"), "更表", "view")).rejects.toMatchObject({ status: 401 });
  });

  it("拒絕會寫 audit_log action=permission_denied", async () => {
    const before = await prisma.auditLog.count({ where: { action: "permission_denied" } });
    await requirePermission(reqWithCookie(cookieByRole["安員"]), "用戶管理", "view").catch(() => {});
    const after = await prisma.auditLog.count({ where: { action: "permission_denied" } });
    expect(after).toBe(before + 1);
  });
});
