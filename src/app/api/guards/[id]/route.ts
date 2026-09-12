import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/rbac/requirePermission";
import { scopeGuardWhere, scrubForBrokerSession, isBrokerRole } from "@/lib/broker-isolation";
import { toBrokerGuardDTO } from "@/lib/broker-dto";
import { toGuardFullDTO } from "@/lib/api/dto";
import { applyFieldGroupGate } from "@/lib/api/field-groups";
import { ok, getClientIp, withApiError } from "@/lib/api/http";
import { readJson } from "@/lib/api/query";
import { parseBody } from "@/lib/api/validate";
import { snakeToCamelShallow } from "@/lib/api/case";
import { GuardUpdateSchema } from "@/lib/api/schemas";
import { writeAudit } from "@/lib/audit";
import { NotFound } from "@/lib/api/errors";
import type { AuthedSession } from "@/lib/rbac/requirePermission";
import type { Module } from "@/lib/rbac/matrix";
import type { Prisma } from "@prisma/client";

function guardModule(session: AuthedSession): Module {
  return isBrokerRole(session) ? "自己安員" : "安員";
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withApiError(async () => {
    const session = await requirePermission(req, guardModule, "view");
    const { id } = await params;
    const where = scopeGuardWhere(session, { id });
    const row = await prisma.guard.findFirst({ where });
    if (!row) throw NotFound();
    if (isBrokerRole(session)) return ok(scrubForBrokerSession(session, toBrokerGuardDTO(row)));
    return ok(await applyFieldGroupGate(session, "guards", toGuardFullDTO(row)));
  });
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withApiError(async () => {
    const session = await requirePermission(req, guardModule, "update");
    const { id } = await params;
    const where = scopeGuardWhere(session, { id });
    const before = await prisma.guard.findFirst({ where });
    if (!before) throw NotFound();
    const body = await readJson(req);
    const parsed = parseBody(GuardUpdateSchema, body);
    const data = snakeToCamelShallow(parsed) as Prisma.GuardUncheckedUpdateInput;
    const after = await prisma.guard.update({ where: { id }, data });
    await writeAudit({ actorUserId: session.userId, tableName: "guards", rowId: id, action: "update", before, after, ip: getClientIp(req) });
    if (isBrokerRole(session)) return ok(scrubForBrokerSession(session, toBrokerGuardDTO(after)));
    return ok(await applyFieldGroupGate(session, "guards", toGuardFullDTO(after)));
  });
}
