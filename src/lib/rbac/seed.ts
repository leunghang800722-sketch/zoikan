// 單一事實來源嘅 RBAC 種子邏輯——scripts/seed/index.ts（真實 7 月數據 seed）
// 同 tests/global-setup.ts／tests/lib/db.ts（假數據 test fixture）都經呢個
// 檔案，唔會各自抄一份 matrix 出嚟，防止兩邊日後漂移唔同步。
//
// 拆開三個函數（permissions/roles/role_permissions）唔係得一個大函數，
// 原因：tests/lib/db.ts 嘅 clearAll() 每個 test 都要將 role_permissions
// 重置返出廠設定（測試會改 granted 值，例如
// tests/wp2-roles-permissions-endpoint.test.ts），但 users/roles/
// permissions 三個表成個 test run 淨係種一次唔會刪（見嗰個檔案嘅註解：
// audit_log 嘅 FK 令有審計歷史嘅 user 冇得再刪）——所以淨係
// `seedRolePermissions()` 呢部分要係「可以重複執行」，冧咗要 export 開。
import type { PrismaClient } from "@prisma/client";
import { MODULES, ACTIONS, DEFAULT_MATRIX, ROLE_NAMES, type RoleName } from "./matrix";

export const DEFAULT_PAYOUT_APPROVAL_LIMIT: Record<RoleName, number | null> = {
  老闆: null,
  主管: null,
  會計: 50000,
  雞頭: null,
  安員: null,
};

/**
 * P1-WP3：`upsert`（唔係 `create`）——`scripts/seed/index.ts` 嘅 dev DB
 * 重跑 `npm run db:seed` 可能撞到已經有 `audit_log` 歷史嘅 user（呢個
 * user 因為 audit_log 嘅 FK append-only 設計，`clearAll()` 而家唔會再
 * 刪佢，見嗰個檔案），令佢間接引用嘅 role/permission 都刪唔到
 * （FK RESTRICT）——upsert 令呢個函數喺「表已經有舊資料」嘅情況下都可以
 * 安全重複執行，唔淨係得「一張空表」先得。`tests/global-setup.ts`
 * 淨係喺全新臨時 DB 度 call 一次，upsert 喺嗰度效果同 create 一樣
 * （冇撞到現存行）。
 */
export async function seedPermissions(prisma: PrismaClient, createdBy: string): Promise<Record<string, string>> {
  const permissionIds: Record<string, string> = {};
  for (const m of MODULES) {
    for (const a of ACTIONS) {
      const p = await prisma.permission.upsert({
        where: { module_action: { module: m, action: a } },
        create: { module: m, action: a, createdBy },
        update: {},
      });
      permissionIds[`${m}:${a}`] = p.id;
    }
  }
  return permissionIds;
}

export async function seedRoles(prisma: PrismaClient, createdBy: string): Promise<Record<RoleName, string>> {
  const roleIds = {} as Record<RoleName, string>;
  for (const name of ROLE_NAMES) {
    const created = await prisma.role.upsert({
      where: { name },
      create: { name, baseRole: name, payoutApprovalLimit: DEFAULT_PAYOUT_APPROVAL_LIMIT[name], isCustom: false, createdBy },
      update: { baseRole: name, payoutApprovalLimit: DEFAULT_PAYOUT_APPROVAL_LIMIT[name], isCustom: false },
    });
    roleIds[name] = created.id;
  }
  return roleIds;
}

export interface SeedRolePermissionsStats {
  granted: number;
  off: number;
  hardDeniedNoRow: number;
}

/**
 * 淨係種 role_permissions（用現成嘅 roleIds/permissionIds，唔會建
 * roles/permissions）——出廠矩陣可重複執行，等測試可以每個 test 都重置
 * 返出廠設定，唔使成個 test run 淨種一次（見檔案頂註解）。
 */
export async function seedRolePermissions(
  prisma: PrismaClient,
  roleIds: Record<RoleName, string>,
  permissionIds: Record<string, string>,
  createdBy: string,
): Promise<SeedRolePermissionsStats> {
  let granted = 0;
  let off = 0;
  let denied = 0;
  for (const roleName of ROLE_NAMES) {
    for (const mod of MODULES) {
      for (const action of ACTIONS) {
        const cell = DEFAULT_MATRIX[roleName][mod][action];
        if (cell === "deny") {
          denied++;
          continue;
        }
        await prisma.rolePermission.create({
          data: { roleId: roleIds[roleName], permissionId: permissionIds[`${mod}:${action}`], granted: cell === "grant", createdBy },
        });
        if (cell === "grant") granted++;
        else off++;
      }
    }
  }
  return { granted, off, hardDeniedNoRow: denied };
}

export interface SeedRbacResult {
  roleIds: Record<RoleName, string>;
  permissionIds: Record<string, string>;
  stats: {
    permissions: number;
    roles: number;
    rolePermissionsGranted: number;
    rolePermissionsOffByDefault: number;
    rolePermissionsHardDeniedNoRow: number;
  };
}

/** 全套（permissions + roles + role_permissions）——scripts/seed/index.ts、
 * tests/global-setup.ts 成個 run 淨係用一次嗰種場合用呢個。 */
export async function seedRolesPermissionsMatrix(prisma: PrismaClient, createdBy: string): Promise<SeedRbacResult> {
  const permissionIds = await seedPermissions(prisma, createdBy);
  const roleIds = await seedRoles(prisma, createdBy);
  const rpStats = await seedRolePermissions(prisma, roleIds, permissionIds, createdBy);

  return {
    roleIds,
    permissionIds,
    stats: {
      permissions: MODULES.length * ACTIONS.length,
      roles: ROLE_NAMES.length,
      rolePermissionsGranted: rpStats.granted,
      rolePermissionsOffByDefault: rpStats.off,
      rolePermissionsHardDeniedNoRow: rpStats.hardDeniedNoRow,
    },
  };
}
