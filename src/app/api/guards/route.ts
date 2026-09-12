import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/rbac/requirePermission";
import { scopeGuardWhere, scrubForBrokerSession, isBrokerRole } from "@/lib/broker-isolation";
import { toBrokerGuardDTO, mapListForBroker } from "@/lib/broker-dto";
import { toGuardFullDTO, mapListDTO } from "@/lib/api/dto";
import { applyFieldGroupGate, applyFieldGroupGateToList } from "@/lib/api/field-groups";
import { ok, getClientIp, withApiError } from "@/lib/api/http";
import { paginationParams, readJson } from "@/lib/api/query";
import { parseBody } from "@/lib/api/validate";
import { snakeToCamelShallow } from "@/lib/api/case";
import { GuardCreateSchema } from "@/lib/api/schemas";
import { writeAudit } from "@/lib/audit";
import type { AuthedSession } from "@/lib/rbac/requirePermission";
import type { Module } from "@/lib/rbac/matrix";
import type { Prisma } from "@prisma/client";

// C3：雞頭睇/管自己安員用「自己安員」module（§6.2「自己安員名冊管理」），
// 內部角色（老闆/主管/會計）睇全公司安員用「安員」module——同一個
// route，依 session 嘅 base_role 動態揀 module（見
// src/lib/rbac/requirePermission.ts 嘅 ModuleSelector）。
function guardModule(session: AuthedSession): Module {
  return isBrokerRole(session) ? "自己安員" : "安員";
}

export async function GET(req: Request) {
  return withApiError(async () => {
    const session = await requirePermission(req, guardModule, "view");
    const url = new URL(req.url);
    const { skip, take } = paginationParams(url);
    const includeInactive = url.searchParams.get("include_inactive") === "1";
    let where: Prisma.GuardWhereInput = includeInactive ? {} : { status: "active" };
    where = scopeGuardWhere(session, where);
    const [rows, total] = await Promise.all([
      prisma.guard.findMany({ where, skip, take, orderBy: { createdAt: "asc" } }),
      prisma.guard.count({ where }),
    ]);
    if (isBrokerRole(session)) {
      return ok(scrubForBrokerSession(session, mapListForBroker({ rows, total, skip, take }, toBrokerGuardDTO)));
    }
    const dto = mapListDTO({ rows, total, skip, take }, toGuardFullDTO);
    return ok(await applyFieldGroupGateToList(session, "guards", dto));
  });
}

export async function POST(req: Request) {
  return withApiError(async () => {
    const session = await requirePermission(req, guardModule, "create");
    const body = await readJson(req);
    const parsed = parseBody(GuardCreateSchema, body);
    const data = snakeToCamelShallow(parsed) as Prisma.GuardUncheckedCreateInput;
    // 雞頭建安員：強制掛喺自己個 broker 底下（唔准幫其他雞頭/自己揀第二個 broker）
    if (isBrokerRole(session)) data.defaultBrokerId = session.brokerId;
    const created = await prisma.guard.create({ data: { ...data, createdBy: session.userId } });
    await writeAudit({ actorUserId: session.userId, tableName: "guards", rowId: created.id, action: "create", after: created, ip: getClientIp(req) });
    if (isBrokerRole(session)) return ok(scrubForBrokerSession(session, toBrokerGuardDTO(created)), 201);
    return ok(await applyFieldGroupGate(session, "guards", toGuardFullDTO(created)), 201);
  });
}
