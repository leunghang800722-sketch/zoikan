// WP-PII：`syncPermissions()`（src/lib/rbac/sync.ts）——部署時自動補新
// module（安員個人資料／安員銀行資料）行，逐角色補齊，幂等，唔覆蓋老闆
// 已經改過嘅格。手法同 tests/rbac-sync-permissions.test.ts「缺一個
// module 嘅行」個 test 一致，專登針對呢兩個新 module 重現一次。
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { syncPermissions } from "@/lib/rbac/sync";
import { DEFAULT_MATRIX, ROLE_NAMES } from "@/lib/rbac/matrix";

async function ids() {
  const roles = await prisma.role.findMany({ select: { id: true, name: true } });
  const perms = await prisma.permission.findMany({ select: { id: true, module: true, action: true } });
  const roleId = (n: string) => roles.find((r) => r.name === n)!.id;
  const permId = (m: string, a: string) => perms.find((p) => p.module === m && p.action === a)!.id;
  return { roleId, permId };
}

describe("WP-PII：sync-permissions 對新 module（安員個人資料／安員銀行資料）幂等", () => {
  beforeEach(async () => {
    await clearAll();
    await syncPermissions(prisma, "test-baseline");
  });

  it("再跑一次：零新增（已經有齊晒），零改動老闆手動設定過嘅格", async () => {
    // 老闆手動開咗主管嘅「安員個人資料:view」（出廠 off）。
    const { roleId, permId } = await ids();
    const supervisor = roleId("主管");
    const permView = permId("安員個人資料", "view");
    await prisma.rolePermission.update({ where: { roleId_permissionId: { roleId: supervisor, permissionId: permView } }, data: { granted: true } });

    const r = await syncPermissions(prisma, "test");
    expect(r.rolePermissionsAdded).toBe(0);

    const after = await prisma.rolePermission.findUnique({ where: { roleId_permissionId: { roleId: supervisor, permissionId: permView } } });
    expect(after?.granted).toBe(true); // 老闆手動開嘅格冇被覆蓋返出廠 off
  });

  it("缺咗呢兩個 module 嘅行：re-sync 淨係補返出廠值嘅行（deny 嘅角色冇行）", async () => {
    const modulePerms = await prisma.permission.findMany({ where: { module: { in: ["安員個人資料", "安員銀行資料"] } } });
    await prisma.rolePermission.deleteMany({ where: { permissionId: { in: modulePerms.map((p) => p.id) } } });
    await prisma.permission.deleteMany({ where: { module: { in: ["安員個人資料", "安員銀行資料"] } } });

    const r = await syncPermissions(prisma, "test");

    // 逐角色逐 module 逐 action 核對：grant/off 有行，deny 冇行，值啱。
    const { permId } = await ids();
    const roles = await prisma.role.findMany({ where: { isCustom: false } });
    const roleIdByName = Object.fromEntries(roles.map((r2) => [r2.name, r2.id]));

    let expectedAdded = 0;
    for (const roleName of ROLE_NAMES) {
      for (const mod of ["安員個人資料", "安員銀行資料"] as const) {
        for (const action of ["view", "create", "update", "void", "export"] as const) {
          const cell = DEFAULT_MATRIX[roleName][mod][action];
          const permissionId = permId(mod, action);
          const row = await prisma.rolePermission.findUnique({
            where: { roleId_permissionId: { roleId: roleIdByName[roleName]!, permissionId } },
          });
          if (cell === "deny") {
            expect(row, `${roleName}/${mod}:${action} 應該冇行（deny）`).toBeNull();
          } else {
            expect(row, `${roleName}/${mod}:${action} 應該有行`).not.toBeNull();
            expect(row?.granted).toBe(cell === "grant");
            expectedAdded++;
          }
        }
      }
    }
    expect(r.rolePermissionsAdded).toBe(expectedAdded);
  });
});
