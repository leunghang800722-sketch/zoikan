import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/rbac/requirePermission";
import { scopeBrokerWhere, scrubForBrokerSession, isBrokerRole } from "@/lib/broker-isolation";
import { toBrokerSelfDTO, mapListForBroker } from "@/lib/broker-dto";
import { toBrokerFullDTO, mapListDTO } from "@/lib/api/dto";
import { applyFieldGroupGate, applyFieldGroupGateToList } from "@/lib/api/field-groups";
import { ok, getClientIp, withApiError } from "@/lib/api/http";
import { paginationParams, readJson } from "@/lib/api/query";
import { parseBody } from "@/lib/api/validate";
import { snakeToCamelShallow } from "@/lib/api/case";
import { BrokerCreateSchema } from "@/lib/api/schemas";
import { writeAudit } from "@/lib/audit";
import type { Prisma } from "@prisma/client";

export async function GET(req: Request) {
  return withApiError(async () => {
    const session = await requirePermission(req, "雞頭", "view");
    const url = new URL(req.url);
    const { skip, take } = paginationParams(url);
    const includeInactive = url.searchParams.get("include_inactive") === "1";

    let where: Prisma.BrokerWhereInput = includeInactive ? {} : { status: "active" };
    where = scopeBrokerWhere(session, where);

    const [rows, total] = await Promise.all([
      prisma.broker.findMany({ where, skip, take, orderBy: [{ createdAt: "asc" }, { id: "asc" }] }),
      prisma.broker.count({ where }),
    ]);
    if (isBrokerRole(session)) {
      return ok(scrubForBrokerSession(session, mapListForBroker({ rows, total, skip, take }, toBrokerSelfDTO)));
    }
    const dto = mapListDTO({ rows, total, skip, take }, toBrokerFullDTO);
    return ok(await applyFieldGroupGateToList(session, "brokers", dto));
  });
}

export async function POST(req: Request) {
  return withApiError(async () => {
    const session = await requirePermission(req, "雞頭", "create");
    const body = await readJson(req);
    const parsed = parseBody(BrokerCreateSchema, body);
    const data = snakeToCamelShallow(parsed) as Prisma.BrokerUncheckedCreateInput;
    const created = await prisma.broker.create({
      data: {
        ...data,
        isInternal: data.isInternal ?? (data.kind === "internal_cash" || data.kind === "internal_longterm"),
        createdBy: session.userId,
      },
    });
    await writeAudit({ actorUserId: session.userId, tableName: "brokers", rowId: created.id, action: "create", after: created, ip: getClientIp(req) });
    return ok(await applyFieldGroupGate(session, "brokers", toBrokerFullDTO(created)), 201);
  });
}
