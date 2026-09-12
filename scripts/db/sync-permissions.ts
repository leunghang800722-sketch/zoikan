// 容器啟動步驟：補漏權限（見 src/lib/rbac/sync.ts）。唔覆蓋任何已存在嘅 role_permissions。
import { PrismaClient } from "@prisma/client";
import { syncPermissions } from "../../src/lib/rbac/sync";

const prisma = new PrismaClient();
syncPermissions(prisma)
  .then((r) => {
    console.log(`[db:sync-permissions] 完成——permissions=${r.permissionsUpserted} roles=${r.rolesScanned} role_permissions 新增=${r.rolePermissionsAdded} 保留=${r.rolePermissionsKept}`);
    return prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error("[db:sync-permissions] 失敗", e instanceof Error ? e.message : e);
    await prisma.$disconnect();
    process.exit(1);
  });
