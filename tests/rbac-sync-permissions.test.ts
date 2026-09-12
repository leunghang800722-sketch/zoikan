// 正式站權限同步（src/lib/rbac/sync.ts）：補漏、幂等、唔覆蓋老闆改過嘅格、自訂角色按 base_role 補。
// 注意：測試 DB 由 global-setup 已 seed RBAC，clearAll() 唔清 roles/permissions，所以基線用 syncPermissions 本身建立。
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { syncPermissions } from "@/lib/rbac/sync";
import { MODULES, ACTIONS } from "@/lib/rbac/matrix";

async function ids() {
  const roles = await prisma.role.findMany({ select: { id: true, name: true } });
  const perms = await prisma.permission.findMany({ select: { id: true, module: true, action: true } });
  const roleId = (n: string) => roles.find((r) => r.name === n)!.id;
  const permId = (m: string, a: string) => perms.find((p) => p.module === m && p.action === a)!.id;
  return { roleId, permId };
}

describe("syncPermissions", () => {
  beforeEach(async () => {
    await clearAll();
    await syncPermissions(prisma, "test-baseline");
  });

  it("幂等：基線之後再跑零新增，permission 數＝module×action", async () => {
    const r = await syncPermissions(prisma, "test");
    expect(r.permissionsUpserted).toBe(MODULES.length * ACTIONS.length);
    expect(r.rolePermissionsAdded).toBe(0);
    expect(r.rolePermissionsKept).toBeGreaterThan(0);
  });

  it("缺一個 module 嘅行：只補嗰啲，唔覆蓋老闆改過嘅格", async () => {
    const { roleId, permId } = await ids();
    const supervisor = roleId("主管");
    const permView = permId("更表", "view");
    await prisma.rolePermission.update({ where: { roleId_permissionId: { roleId: supervisor, permissionId: permView } }, data: { granted: false } });
    const helperPerms = await prisma.permission.findMany({ where: { module: "助手" } });
    await prisma.rolePermission.deleteMany({ where: { permissionId: { in: helperPerms.map((p) => p.id) } } });
    await prisma.permission.deleteMany({ where: { module: "助手" } });
    const r = await syncPermissions(prisma, "test");
    expect(r.rolePermissionsAdded).toBe(3); // 助手:view 老闆／主管／會計；雞頭／保安員硬性 deny 冇行
    const after = await prisma.rolePermission.findUnique({ where: { roleId_permissionId: { roleId: supervisor, permissionId: permView } } });
    expect(after?.granted).toBe(false);
    const { permId: permId2 } = await ids();
    const bossRow = await prisma.rolePermission.findUnique({ where: { roleId_permissionId: { roleId: roleId("老闆"), permissionId: permId2("助手", "view") } } });
    expect(bossRow?.granted).toBe(true);
  });

  it("自訂角色（base_role=雞頭）按 base_role 補預設行，硬性 deny 唔寫行", async () => {
    const custom = await prisma.role.create({ data: { name: "高級雞頭", baseRole: "雞頭", createdBy: "test" } });
    const r = await syncPermissions(prisma, "test");
    expect(r.rolesScanned).toBeGreaterThanOrEqual(6);
    const { permId } = await ids();
    const helper = await prisma.rolePermission.findUnique({ where: { roleId_permissionId: { roleId: custom.id, permissionId: permId("助手", "view") } } });
    expect(helper).toBeNull();
    const roster = await prisma.rolePermission.findUnique({ where: { roleId_permissionId: { roleId: custom.id, permissionId: permId("更表", "view") } } });
    expect(roster?.granted).toBe(true);
  });
});
