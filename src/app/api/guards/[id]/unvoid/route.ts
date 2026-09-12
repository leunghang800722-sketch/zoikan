import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/rbac/requirePermission";
import { ok, getClientIp, withApiError } from "@/lib/api/http";
import { toGuardFullDTO } from "@/lib/api/dto";
import { applyFieldGroupGate } from "@/lib/api/field-groups";
import { writeAudit } from "@/lib/audit";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withApiError(async () => {
    const session = await requirePermission(req, "安員", "void");
    const { id } = await params;
    const before = await prisma.guard.findUniqueOrThrow({ where: { id } });
    const after = await prisma.guard.update({ where: { id }, data: { status: "active" } });
    await writeAudit({ actorUserId: session.userId, tableName: "guards", rowId: id, action: "unvoid", before, after, ip: getClientIp(req) });
    return ok(await applyFieldGroupGate(session, "guards", toGuardFullDTO(after)));
  });
}
