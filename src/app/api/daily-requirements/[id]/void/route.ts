import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/rbac/requirePermission";
import { assertMonthNotLocked } from "@/lib/month-lock";
import { ok, getClientIp, withApiError } from "@/lib/api/http";
import { toDailyRequirementFullDTO } from "@/lib/api/dto";
import { readJson } from "@/lib/api/query";
import { parseBody } from "@/lib/api/validate";
import { VoidReasonSchema } from "@/lib/api/schemas";
import { writeAudit } from "@/lib/audit";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withApiError(async () => {
    const session = await requirePermission(req, "更表", "void");
    const { id } = await params;
    const body = await readJson(req);
    const { reason } = parseBody(VoidReasonSchema, body);
    const before = await prisma.dailyRequirement.findUniqueOrThrow({ where: { id } });
    await assertMonthNotLocked({ workDate: before.workDate, actorUserId: session.userId, tableName: "daily_requirements", rowId: id, ip: getClientIp(req) });
    const after = await prisma.dailyRequirement.update({ where: { id }, data: { voidedAt: new Date(), voidedBy: session.userId } });
    await writeAudit({ actorUserId: session.userId, tableName: "daily_requirements", rowId: id, action: "void", before, after: { ...after, void_reason: reason }, ip: getClientIp(req) });
    return ok(toDailyRequirementFullDTO(after));
  });
}
