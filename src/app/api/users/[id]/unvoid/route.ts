import { assertNotSystemAccount } from "@/lib/system-user";
import { toUserDTO } from "@/lib/api/dto";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/rbac/requirePermission";
import { ok, getClientIp, withApiError } from "@/lib/api/http";
import { writeAudit } from "@/lib/audit";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withApiError(async () => {
    const session = await requirePermission(req, "用戶管理", "void");
    const { id } = await params;
    await assertNotSystemAccount(id);
    const before = await prisma.user.findUniqueOrThrow({ where: { id } });
    const after = await prisma.user.update({ where: { id }, data: { status: "active" } });
    const dto = toUserDTO(after, true);
    await writeAudit({ actorUserId: session.userId, tableName: "users", rowId: id, action: "unvoid", before: toUserDTO(before, true), after: dto, ip: getClientIp(req) });
    return ok(dto);
  });
}
