import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/rbac/requirePermission";
import { toShiftTypeDTO } from "@/lib/api/dto";
import { ok, getClientIp, withApiError } from "@/lib/api/http";
import { readJson } from "@/lib/api/query";
import { parseBody } from "@/lib/api/validate";
import { snakeToCamelShallow } from "@/lib/api/case";
import { ShiftTypeUpdateSchema } from "@/lib/api/schemas";
import { writeAudit } from "@/lib/audit";
import { NotFound } from "@/lib/api/errors";
import type { Prisma } from "@prisma/client";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withApiError(async () => {
    await requirePermission(req, "盤", "view");
    const { id } = await params;
    const row = await prisma.shiftType.findUnique({ where: { id } });
    if (!row) throw NotFound();
    return ok(toShiftTypeDTO(row));
  });
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withApiError(async () => {
    const session = await requirePermission(req, "盤", "update");
    const { id } = await params;
    const before = await prisma.shiftType.findUniqueOrThrow({ where: { id } });
    const body = await readJson(req);
    const parsed = parseBody(ShiftTypeUpdateSchema, body);
    const data = snakeToCamelShallow(parsed) as Prisma.ShiftTypeUncheckedUpdateInput;
    const after = await prisma.shiftType.update({ where: { id }, data });
    await writeAudit({ actorUserId: session.userId, tableName: "shift_types", rowId: id, action: "update", before, after, ip: getClientIp(req) });
    return ok(toShiftTypeDTO(after));
  });
}
