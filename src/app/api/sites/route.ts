import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/rbac/requirePermission";
import { scopeSiteWhere, isBrokerRole } from "@/lib/broker-isolation";
import { toBrokerSiteDTO, mapListForBroker } from "@/lib/broker-dto";
import { toSiteDTO, mapListDTO } from "@/lib/api/dto";
import { applyFieldGroupGate, applyFieldGroupGateToList, assertFieldGroupWritable } from "@/lib/api/field-groups";
import { ok, getClientIp, withApiError } from "@/lib/api/http";
import { paginationParams, readJson } from "@/lib/api/query";
import { parseBody } from "@/lib/api/validate";
import { snakeToCamelShallow } from "@/lib/api/case";
import { SiteCreateSchema } from "@/lib/api/schemas";
import { writeAudit } from "@/lib/audit";
import type { Prisma } from "@prisma/client";

export async function GET(req: Request) {
  return withApiError(async () => {
    // P1-WP3：module resolver——雞頭用「更表」（先揀得到更表編輯器嘅盤，
    // 見 broker-isolation.ts scopeSiteWhere 頂註解），內部角色維持「盤」
    // （盤管理，硬性 deny 唔變）。
    const session = await requirePermission(req, (s) => (isBrokerRole(s) ? "更表" : "盤"), "view");
    const url = new URL(req.url);
    const { skip, take } = paginationParams(url);
    const includeInactive = url.searchParams.get("include_inactive") === "1";
    let where: Prisma.SiteWhereInput = includeInactive ? {} : { status: { in: ["active", "paused"] } };
    where = scopeSiteWhere(session, where);
    const [rows, total] = await Promise.all([
      prisma.site.findMany({ where, skip, take, orderBy: { createdAt: "asc" } }),
      prisma.site.count({ where }),
    ]);
    if (isBrokerRole(session)) {
      return ok(mapListForBroker({ rows, total, skip, take }, toBrokerSiteDTO));
    }
    // M1/M2：sites 而家都經白名單 DTO + field-group gate（monthly_fee 屬
    // CLIENT_RATE_FIELDS，冇「收客價:view」就見唔到）。
    const dto = mapListDTO({ rows, total, skip, take }, toSiteDTO);
    return ok(await applyFieldGroupGateToList(session, "sites", dto));
  });
}

export async function POST(req: Request) {
  return withApiError(async () => {
    const session = await requirePermission(req, "盤", "create");
    const body = await readJson(req);
    const parsed = parseBody(SiteCreateSchema, body);
    await assertFieldGroupWritable(session, "sites", parsed);
    const data = snakeToCamelShallow(parsed) as Prisma.SiteUncheckedCreateInput;
    const created = await prisma.site.create({ data: { ...data, createdBy: session.userId } });
    await writeAudit({ actorUserId: session.userId, tableName: "sites", rowId: created.id, action: "create", after: created, ip: getClientIp(req) });
    return ok(await applyFieldGroupGate(session, "sites", toSiteDTO(created)), 201);
  });
}
