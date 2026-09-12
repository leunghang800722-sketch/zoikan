import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/rbac/requirePermission";
import { scopeBySiteHavingBrokerShifts } from "@/lib/broker-isolation";
import { toDailyRequirementFullDTO } from "@/lib/api/dto";
import { assertMonthNotLocked } from "@/lib/month-lock";
import { ok, getClientIp, withApiError } from "@/lib/api/http";
import { readJson } from "@/lib/api/query";
import { parseBody } from "@/lib/api/validate";
import { snakeToCamelShallow } from "@/lib/api/case";
import { DailyRequirementUpdateSchema } from "@/lib/api/schemas";
import { writeAudit } from "@/lib/audit";
import { NotFound } from "@/lib/api/errors";
import type { Prisma } from "@prisma/client";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withApiError(async () => {
    const session = await requirePermission(req, "更表", "view");
    const { id } = await params;
    const where = scopeBySiteHavingBrokerShifts(session, { id });
    const row = await prisma.dailyRequirement.findFirst({ where });
    if (!row) throw NotFound();
    return ok(toDailyRequirementFullDTO(row));
  });
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withApiError(async () => {
    const session = await requirePermission(req, "更表", "update");
    const { id } = await params;
    const before = await prisma.dailyRequirement.findUniqueOrThrow({ where: { id } });
    await assertMonthNotLocked({ workDate: before.workDate, actorUserId: session.userId, tableName: "daily_requirements", rowId: id, ip: getClientIp(req) });
    const body = await readJson(req);
    const parsed = parseBody(DailyRequirementUpdateSchema, body);
    const data = snakeToCamelShallow(parsed) as Prisma.DailyRequirementUncheckedUpdateInput;
    const after = await prisma.dailyRequirement.update({ where: { id }, data });
    await writeAudit({ actorUserId: session.userId, tableName: "daily_requirements", rowId: id, action: "update", before, after, ip: getClientIp(req) });
    return ok(toDailyRequirementFullDTO(after));
  });
}
