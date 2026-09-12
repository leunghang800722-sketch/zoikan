import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/rbac/requirePermission";
import { ok, getClientIp, withApiError } from "@/lib/api/http";
import { toShiftTypeDTO } from "@/lib/api/dto";
import { writeAudit } from "@/lib/audit";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withApiError(async () => {
    const session = await requirePermission(req, "盤", "void");
    const { id } = await params;
    const before = await prisma.shiftType.findUniqueOrThrow({ where: { id } });
    const after = await prisma.shiftType.update({ where: { id }, data: { voidedAt: null, voidedBy: null } });
    await writeAudit({ actorUserId: session.userId, tableName: "shift_types", rowId: id, action: "unvoid", before, after, ip: getClientIp(req) });
    return ok(toShiftTypeDTO(after));
  });
}
