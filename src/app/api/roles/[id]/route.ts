import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/rbac/requirePermission";
import { ok, getClientIp, withApiError } from "@/lib/api/http";
import { readJson } from "@/lib/api/query";
import { parseBody } from "@/lib/api/validate";
import { snakeToCamelShallow } from "@/lib/api/case";
import { RoleUpdateSchema } from "@/lib/api/schemas";
import { toRoleDTO } from "@/lib/api/dto";
import { writeAudit } from "@/lib/audit";
import { NotFound } from "@/lib/api/errors";
import type { Prisma } from "@prisma/client";

// 改名容易撞五個出廠角色名，WP2 唔開放；改權限格用 /permissions

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withApiError(async () => {
    await requirePermission(req, "用戶管理", "view");
    const { id } = await params;
    const row = await prisma.role.findUnique({ where: { id } });
    if (!row) throw NotFound();
    return ok(toRoleDTO(row));
  });
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withApiError(async () => {
    const session = await requirePermission(req, "用戶管理", "update");
    const { id } = await params;
    const before = await prisma.role.findUniqueOrThrow({ where: { id } });
    const body = await readJson(req);
    const parsed = parseBody(RoleUpdateSchema, body);
    const data = snakeToCamelShallow(parsed) as Prisma.RoleUncheckedUpdateInput;
    const after = await prisma.role.update({ where: { id }, data });
    await writeAudit({ actorUserId: session.userId, tableName: "roles", rowId: id, action: "update", before, after, ip: getClientIp(req) });
    return ok(toRoleDTO(after));
  });
}
