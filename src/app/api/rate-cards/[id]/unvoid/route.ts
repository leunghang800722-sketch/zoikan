import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/rbac/requirePermission";
import { assertMonthRangeNotLocked } from "@/lib/month-lock";
import { toRateCardFullDTO } from "@/lib/api/dto";
import { applyFieldGroupGate } from "@/lib/api/field-groups";
import { ok, getClientIp, withApiError } from "@/lib/api/http";
import { writeAudit } from "@/lib/audit";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withApiError(async () => {
    const session = await requirePermission(req, "出街價", "void");
    const { id } = await params;
    const before = await prisma.rateCard.findUniqueOrThrow({ where: { id } });
    await assertMonthRangeNotLocked({
      effectiveFrom: before.effectiveFrom,
      effectiveTo: before.effectiveTo,
      actorUserId: session.userId,
      tableName: "rate_cards",
      rowId: id,
      ip: getClientIp(req),
    });
    const after = await prisma.rateCard.update({ where: { id }, data: { voidedAt: null, voidedBy: null } });
    await writeAudit({ actorUserId: session.userId, tableName: "rate_cards", rowId: id, action: "unvoid", before, after, ip: getClientIp(req) });
    return ok(await applyFieldGroupGate(session, "rate_cards", toRateCardFullDTO(after)));
  });
}
