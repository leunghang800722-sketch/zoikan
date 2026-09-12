import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/rbac/requirePermission";
import { scopeBrokerWhere, scrubForBrokerSession, isBrokerRole, requireOwnBrokerId } from "@/lib/broker-isolation";
import { toBrokerSelfDTO } from "@/lib/broker-dto";
import { toBrokerFullDTO } from "@/lib/api/dto";
import { applyFieldGroupGate } from "@/lib/api/field-groups";
import { ok, getClientIp, withApiError } from "@/lib/api/http";
import { readJson } from "@/lib/api/query";
import { parseBody } from "@/lib/api/validate";
import { snakeToCamelShallow } from "@/lib/api/case";
import { BrokerUpdateSchema } from "@/lib/api/schemas";
import { writeAudit } from "@/lib/audit";
import { NotFound, Forbidden } from "@/lib/api/errors";
import type { Prisma } from "@prisma/client";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withApiError(async () => {
    const session = await requirePermission(req, "雞頭", "view");
    const { id } = await params;
    if (isBrokerRole(session) && id !== requireOwnBrokerId(session)) throw Forbidden("雞頭只可以睇自己嘅資料");
    const where = scopeBrokerWhere(session, { id });
    const row = await prisma.broker.findFirst({ where });
    if (!row) throw NotFound();
    if (isBrokerRole(session)) return ok(scrubForBrokerSession(session, toBrokerSelfDTO(row)));
    return ok(await applyFieldGroupGate(session, "brokers", toBrokerFullDTO(row)));
  });
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withApiError(async () => {
    const session = await requirePermission(req, "雞頭", "update");
    const { id } = await params;
    if (isBrokerRole(session)) throw Forbidden("雞頭唔可以改自己雞頭紀錄（WP2 唔開放）");
    const before = await prisma.broker.findUniqueOrThrow({ where: { id } });
    const body = await readJson(req);
    const parsed = parseBody(BrokerUpdateSchema, body);
    const data = snakeToCamelShallow(parsed) as Prisma.BrokerUncheckedUpdateInput;
    const after = await prisma.broker.update({ where: { id }, data });
    await writeAudit({ actorUserId: session.userId, tableName: "brokers", rowId: id, action: "update", before, after, ip: getClientIp(req) });
    return ok(await applyFieldGroupGate(session, "brokers", toBrokerFullDTO(after)));
  });
}
