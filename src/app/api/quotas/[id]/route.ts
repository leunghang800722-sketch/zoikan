import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/rbac/requirePermission";
import { scopeQuotaWhere, isBrokerRole } from "@/lib/broker-isolation";
import { toBrokerQuotaDTO } from "@/lib/broker-dto";
import { toQuotaDTO } from "@/lib/api/dto";
import { assertMonthNotLocked } from "@/lib/month-lock";
import { ok, getClientIp, withApiError } from "@/lib/api/http";
import { readJson } from "@/lib/api/query";
import { parseBody } from "@/lib/api/validate";
import { QuotaUpdateSchema } from "@/lib/api/schemas";
import { writeAudit } from "@/lib/audit";
import { NotFound } from "@/lib/api/errors";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withApiError(async () => {
    const session = await requirePermission(req, "配額", "view");
    const { id } = await params;
    const where = scopeQuotaWhere(session, { id });
    const row = await prisma.quota.findFirst({ where });
    if (!row) throw NotFound();
    if (isBrokerRole(session)) return ok(toBrokerQuotaDTO(row));
    return ok(toQuotaDTO(row));
  });
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withApiError(async () => {
    // 雞頭「配額:update」硬性 deny——呢個 route 只有內部角色行得到。
    const session = await requirePermission(req, "配額", "update");
    const { id } = await params;
    const before = await prisma.quota.findUniqueOrThrow({ where: { id } });
    await assertMonthNotLocked({ workDate: before.month, actorUserId: session.userId, tableName: "quotas", rowId: id, ip: getClientIp(req) });
    const body = await readJson(req);
    const parsed = parseBody(QuotaUpdateSchema, body);
    const after = await prisma.quota.update({ where: { id }, data: { targetShifts: parsed.target_shifts } });
    await writeAudit({ actorUserId: session.userId, tableName: "quotas", rowId: id, action: "update", before, after, ip: getClientIp(req) });
    return ok(toQuotaDTO(after));
  });
}
