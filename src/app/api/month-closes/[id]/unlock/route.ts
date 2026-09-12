import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/rbac/requirePermission";
import { ok, getClientIp, withApiError } from "@/lib/api/http";
import { readJson } from "@/lib/api/query";
import { parseBody } from "@/lib/api/validate";
import { VoidReasonSchema } from "@/lib/api/schemas";
import { toMonthCloseDTO } from "@/lib/api/dto";
import { applyFieldGroupGate } from "@/lib/api/field-groups";
import { writeAudit } from "@/lib/audit";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withApiError(async () => {
    const session = await requirePermission(req, "月結鎖定解鎖", "void");
    const { id } = await params;
    const body = await readJson(req);
    const { reason } = parseBody(VoidReasonSchema, body);
    const before = await prisma.monthClose.findUniqueOrThrow({ where: { id } });
    const after = await prisma.monthClose.update({ where: { id }, data: { lockedAt: null, lockedBy: null } });
    await writeAudit({ actorUserId: session.userId, tableName: "month_closes", rowId: id, action: "unlock_month", before, after: { ...after, unlock_reason: reason }, ip: getClientIp(req) });
    return ok(await applyFieldGroupGate(session, "month_closes", toMonthCloseDTO(after)));
  });
}
