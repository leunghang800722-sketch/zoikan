// 正式站權限同步（唔係 seed）：每次容器啟動喺 migrate deploy 之後行一次。
// 只「補漏」——新增嘅 module／action（例如 2026-09-12 加嘅「助手」）補 permission
// 行同各角色嘅 role_permissions 預設行；**永遠唔覆蓋已存在嘅 role_permissions**
// （老闆喺角色權限頁改過嘅格照舊）。自訂角色（base_role≠自己名）按 base_role 嘅
// 預設矩陣補。硬性 deny 嘅格照舊唔寫行。
import type { PrismaClient } from "@prisma/client";
import { ACTIONS, DEFAULT_MATRIX, MODULES, ROLE_NAMES, type RoleName } from "./matrix";
import { seedPermissions, seedRoles } from "./seed";

export interface SyncPermissionsResult {
  permissionsUpserted: number;
  rolePermissionsAdded: number;
  rolePermissionsKept: number;
  rolesScanned: number;
}

export async function syncPermissions(prisma: PrismaClient, createdBy = "db:sync-permissions"): Promise<SyncPermissionsResult> {
  const permissionIds = await seedPermissions(prisma, createdBy); // upsert，幂等
  await seedRoles(prisma, createdBy); // 五個出廠角色 upsert，幂等
  const roles = await prisma.role.findMany({ where: { voidedAt: null }, select: { id: true, name: true, baseRole: true } });
  const existing = await prisma.rolePermission.findMany({ select: { roleId: true, permissionId: true } });
  const have = new Set(existing.map((r) => `${r.roleId}|${r.permissionId}`));
  let added = 0;
  let kept = 0;
  for (const role of roles) {
    const base = (ROLE_NAMES as readonly string[]).includes(role.baseRole) ? (role.baseRole as RoleName) : null;
    if (!base) continue; // 未知 base_role：唔猜，留空（requirePermission 當最嚴）
    for (const mod of MODULES) {
      for (const action of ACTIONS) {
        const cell = DEFAULT_MATRIX[base][mod][action];
        if (cell === "deny") continue;
        const permissionId = permissionIds[`${mod}:${action}`];
        if (!permissionId) continue;
        if (have.has(`${role.id}|${permissionId}`)) {
          kept++;
          continue;
        }
        await prisma.rolePermission.create({ data: { roleId: role.id, permissionId, granted: cell === "grant", createdBy } });
        added++;
      }
    }
  }
  return { permissionsUpserted: Object.keys(permissionIds).length, rolePermissionsAdded: added, rolePermissionsKept: kept, rolesScanned: roles.length };
}
