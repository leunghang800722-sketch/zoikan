import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/rbac/requirePermission";
import { assertMonthNotLocked } from "@/lib/month-lock";
import { toSpecialItemDTO } from "@/lib/api/dto";
import { applyFieldGroupGate, assertFieldGroupWritable } from "@/lib/api/field-groups";
import { ok, getClientIp, withApiError } from "@/lib/api/http";
import { readJson } from "@/lib/api/query";
import { parseBody } from "@/lib/api/validate";
import { snakeToCamelShallow } from "@/lib/api/case";
import { SpecialItemUpdateSchema } from "@/lib/api/schemas";
import { writeAudit } from "@/lib/audit";
import { NotFound } from "@/lib/api/errors";
import type { Prisma } from "@prisma/client";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withApiError(async () => {
    const session = await requirePermission(req, "糧務", "view");
    const { id } = await params;
    const row = await prisma.specialItem.findUnique({ where: { id } });
    if (!row) throw NotFound();
    return ok(await applyFieldGroupGate(session, "special_items", toSpecialItemDTO(row)));
  });
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withApiError(async () => {
    const session = await requirePermission(req, "糧務", "update");
    const { id } = await params;
    const before = await prisma.specialItem.findUniqueOrThrow({ where: { id } });
    await assertMonthNotLocked({ workDate: before.month, actorUserId: session.userId, tableName: "special_items", rowId: id, ip: getClientIp(req) });
    const body = await readJson(req);
    const parsed = parseBody(SpecialItemUpdateSchema, body);
    await assertFieldGroupWritable(session, "special_items", parsed);
    const data = snakeToCamelShallow(parsed) as Prisma.SpecialItemUncheckedUpdateInput;
    const after = await prisma.specialItem.update({ where: { id }, data });
    await writeAudit({ actorUserId: session.userId, tableName: "special_items", rowId: id, action: "update", before, after, ip: getClientIp(req) });
    return ok(await applyFieldGroupGate(session, "special_items", toSpecialItemDTO(after)));
  });
}
