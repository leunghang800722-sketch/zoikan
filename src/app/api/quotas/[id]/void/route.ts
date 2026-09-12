import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/rbac/requirePermission";
import { assertMonthNotLocked } from "@/lib/month-lock";
import { toQuotaDTO } from "@/lib/api/dto";
import { ok, getClientIp, withApiError } from "@/lib/api/http";
import { readJson } from "@/lib/api/query";
import { parseBody } from "@/lib/api/validate";
import { VoidReasonSchema } from "@/lib/api/schemas";
import { writeAudit } from "@/lib/audit";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withApiError(async () => {
    const session = await requirePermission(req, "配額", "void");
    const { id } = await params;
    const body = await readJson(req);
    const { reason } = parseBody(VoidReasonSchema, body);
    const before = await prisma.quota.findUniqueOrThrow({ where: { id } });
    await assertMonthNotLocked({ workDate: before.month, actorUserId: session.userId, tableName: "quotas", rowId: id, ip: getClientIp(req) });
    const after = await prisma.quota.update({ where: { id }, data: { voidedAt: new Date(), voidedBy: session.userId } });
    await writeAudit({ actorUserId: session.userId, tableName: "quotas", rowId: id, action: "void", before, after: { ...after, void_reason: reason }, ip: getClientIp(req) });
    return ok(toQuotaDTO(after));
  });
}
