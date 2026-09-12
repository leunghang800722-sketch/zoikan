import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/rbac/requirePermission";
import { assertMonthRangeNotLocked } from "@/lib/month-lock";
import { toRateCardFullDTO } from "@/lib/api/dto";
import { applyFieldGroupGate } from "@/lib/api/field-groups";
import { ok, getClientIp, withApiError } from "@/lib/api/http";
import { readJson } from "@/lib/api/query";
import { parseBody } from "@/lib/api/validate";
import { VoidReasonSchema } from "@/lib/api/schemas";
import { writeAudit } from "@/lib/audit";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withApiError(async () => {
    const session = await requirePermission(req, "出街價", "void");
    const { id } = await params;
    const body = await readJson(req);
    const { reason } = parseBody(VoidReasonSchema, body);
    const before = await prisma.rateCard.findUniqueOrThrow({ where: { id } });
    // M5：rate_cards 嘅 void/unvoid 都要以成個 [effective_from,
    // effective_to] 區間判斷鎖定（唔淨係 effective_from）。
    await assertMonthRangeNotLocked({
      effectiveFrom: before.effectiveFrom,
      effectiveTo: before.effectiveTo,
      actorUserId: session.userId,
      tableName: "rate_cards",
      rowId: id,
      ip: getClientIp(req),
    });
    const after = await prisma.rateCard.update({ where: { id }, data: { voidedAt: new Date(), voidedBy: session.userId } });
    await writeAudit({ actorUserId: session.userId, tableName: "rate_cards", rowId: id, action: "void", before, after: { ...after, void_reason: reason }, ip: getClientIp(req) });
    return ok(await applyFieldGroupGate(session, "rate_cards", toRateCardFullDTO(after)));
  });
}
