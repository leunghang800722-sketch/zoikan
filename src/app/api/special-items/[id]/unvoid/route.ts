import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/rbac/requirePermission";
import { assertMonthNotLocked } from "@/lib/month-lock";
import { ok, getClientIp, withApiError } from "@/lib/api/http";
import { toSpecialItemDTO } from "@/lib/api/dto";
import { applyFieldGroupGate } from "@/lib/api/field-groups";
import { writeAudit } from "@/lib/audit";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withApiError(async () => {
    const session = await requirePermission(req, "糧務", "void");
    const { id } = await params;
    const before = await prisma.specialItem.findUniqueOrThrow({ where: { id } });
    // C4：unvoid 之前漏咗呢個 check。
    await assertMonthNotLocked({ workDate: before.month, actorUserId: session.userId, tableName: "special_items", rowId: id, ip: getClientIp(req) });
    const after = await prisma.specialItem.update({ where: { id }, data: { voidedAt: null, voidedBy: null } });
    await writeAudit({ actorUserId: session.userId, tableName: "special_items", rowId: id, action: "unvoid", before, after, ip: getClientIp(req) });
    return ok(await applyFieldGroupGate(session, "special_items", toSpecialItemDTO(after)));
  });
}
