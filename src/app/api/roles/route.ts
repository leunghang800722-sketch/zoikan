// 角色可複製再改（設計文件§5.0）：POST body { source_role_id, name } 複製
// 一個現有角色（連埋佢成套 role_permissions）做新角色，is_custom=true。
// 五個出廠角色（老闆/主管/會計/雞頭/安員）is_custom=false，唔可以 void
// （見 [id]/void/route.ts）。
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/rbac/requirePermission";
import { ok, getClientIp, withApiError } from "@/lib/api/http";
import { paginationParams, readJson } from "@/lib/api/query";
import { parseBody } from "@/lib/api/validate";
import { RoleCreateSchema } from "@/lib/api/schemas";
import { toRoleDTO, mapListDTO } from "@/lib/api/dto";
import { writeAudit } from "@/lib/audit";
import { BadRequest, Conflict } from "@/lib/api/errors";

export async function GET(req: Request) {
  return withApiError(async () => {
    await requirePermission(req, "用戶管理", "view");
    const url = new URL(req.url);
    const { skip, take } = paginationParams(url);
    const [rows, total] = await Promise.all([
      prisma.role.findMany({ where: { voidedAt: null }, skip, take, orderBy: { createdAt: "asc" } }),
      prisma.role.count({ where: { voidedAt: null } }),
    ]);
    return ok(mapListDTO({ rows, total, skip, take }, toRoleDTO));
  });
}

export async function POST(req: Request) {
  return withApiError(async () => {
    const session = await requirePermission(req, "用戶管理", "create");
    const body = await readJson(req);
    const input = parseBody(RoleCreateSchema, body);
    const name = input.name.trim();
    if (!name) throw BadRequest("name 唔可以係空白");

    const source = await prisma.role.findUnique({ where: { id: input.source_role_id }, include: { rolePermissions: true } });
    if (!source) throw BadRequest("source_role_id 唔存在");
    const clash = await prisma.role.findUnique({ where: { name } });
    if (clash) throw Conflict("呢個角色名已經用咗");

    const created = await prisma.$transaction(async (tx) => {
      // Opus 驗收殘留2：base_role 繼承自來源角色（如果來源本身已經係
      // 自訂角色，跟埋佢嘅 base_role，唔係重設做 source.name）——保證
      // base_role 永遠追溯得返去五個出廠角色之一，唔會因為連續複製幾
      // 層而斷鏈。
      const role = await tx.role.create({
        data: {
          name,
          payoutApprovalLimit: source.payoutApprovalLimit,
          isCustom: true,
          baseRole: source.baseRole,
          createdBy: session.userId,
        },
      });
      if (source.rolePermissions.length) {
        await tx.rolePermission.createMany({
          data: source.rolePermissions.map((rp) => ({
            roleId: role.id,
            permissionId: rp.permissionId,
            granted: rp.granted,
            createdBy: session.userId,
          })),
        });
      }
      return role;
    });

    await writeAudit({
      actorUserId: session.userId,
      tableName: "roles",
      rowId: created.id,
      action: "create",
      after: { ...created, copied_from: source.name },
      ip: getClientIp(req),
    });
    return ok(toRoleDTO(created), 201);
  });
}
