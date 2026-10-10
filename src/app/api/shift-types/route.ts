import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/rbac/requirePermission";
import { scopeBySiteHavingBrokerShifts, isBrokerRole } from "@/lib/broker-isolation";
import { toBrokerShiftTypeDTO, mapListForBroker } from "@/lib/broker-dto";
import { toShiftTypeDTO, mapListDTO } from "@/lib/api/dto";
import { ok, getClientIp, withApiError } from "@/lib/api/http";
import { paginationParams, readJson } from "@/lib/api/query";
import { parseBody } from "@/lib/api/validate";
import { snakeToCamelShallow } from "@/lib/api/case";
import { ShiftTypeCreateSchema } from "@/lib/api/schemas";
import { writeAudit } from "@/lib/audit";
import type { Prisma } from "@prisma/client";

export async function GET(req: Request) {
  return withApiError(async () => {
    // P1-WP3：「盤」module 對雞頭係硬性 deny（盤管理，同雞頭角色無關），
    // 但雞頭需要睇到自己有份嗰啲盤嘅更別代號先填得到自己配額（設計文件
    // §4.1「雞頭：喺自己配額內填人」）——呢度用 module resolver（同
    // guards/route.ts 一致嘅手法）：雞頭用「更表」（出廠 view=grant），
    // 內部角色維持「盤」。query 層再用 broker_site_assignments 白名單
    // scope（scopeBySiteHavingBrokerShifts），response 用雞頭專屬白名單
    // DTO（toBrokerShiftTypeDTO，冇 createdBy/voidedBy）。
    const session = await requirePermission(req, (s) => (isBrokerRole(s) ? "更表" : "盤"), "view");
    const url = new URL(req.url);
    const { skip, take } = paginationParams(url);
    const siteId = url.searchParams.get("site_id");
    const includeVoided = url.searchParams.get("include_voided") === "1";
    let where: Prisma.ShiftTypeWhereInput = { ...(siteId ? { siteId } : {}), ...(includeVoided ? {} : { voidedAt: null }) };
    where = scopeBySiteHavingBrokerShifts(session, where);
    const [rows, total] = await Promise.all([
      prisma.shiftType.findMany({ where, skip, take, orderBy: [{ createdAt: "asc" }, { id: "asc" }] }),
      prisma.shiftType.count({ where }),
    ]);
    if (isBrokerRole(session)) {
      return ok(mapListForBroker({ rows, total, skip, take }, toBrokerShiftTypeDTO));
    }
    return ok(mapListDTO({ rows, total, skip, take }, toShiftTypeDTO));
  });
}

export async function POST(req: Request) {
  return withApiError(async () => {
    const session = await requirePermission(req, "盤", "create");
    const body = await readJson(req);
    const parsed = parseBody(ShiftTypeCreateSchema, body);
    const data = snakeToCamelShallow(parsed) as Prisma.ShiftTypeUncheckedCreateInput;
    const created = await prisma.shiftType.create({ data: { ...data, createdBy: session.userId } });
    await writeAudit({ actorUserId: session.userId, tableName: "shift_types", rowId: created.id, action: "create", after: created, ip: getClientIp(req) });
    return ok(toShiftTypeDTO(created), 201);
  });
}
