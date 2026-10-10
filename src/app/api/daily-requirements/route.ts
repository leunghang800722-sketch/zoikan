import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/rbac/requirePermission";
import { scopeBySiteHavingBrokerShifts, isBrokerRole, scrubForBrokerSession, requireOwnBrokerId, assertSiteAssignedToBroker } from "@/lib/broker-isolation";
import { toBrokerDailyRequirementDTO, mapListForBroker } from "@/lib/broker-dto";
import { toDailyRequirementFullDTO, mapListDTO } from "@/lib/api/dto";
import { assertMonthNotLocked } from "@/lib/month-lock";
import { ok, getClientIp, withApiError } from "@/lib/api/http";
import { paginationParams, readJson } from "@/lib/api/query";
import { parseBody } from "@/lib/api/validate";
import { snakeToCamelShallow } from "@/lib/api/case";
import { DailyRequirementCreateSchema } from "@/lib/api/schemas";
import { writeAudit } from "@/lib/audit";
import { BadRequest } from "@/lib/api/errors";
import type { Prisma } from "@prisma/client";

export async function GET(req: Request) {
  return withApiError(async () => {
    const session = await requirePermission(req, "更表", "view");
    const url = new URL(req.url);
    const { skip, take } = paginationParams(url);
    const siteId = url.searchParams.get("site_id");
    const includeVoided = url.searchParams.get("include_voided") === "1";
    // P3-2.4（additive）：`work_date_from`／`work_date_to`——更表編輯器只攞本月，唔再攞該盤所有月份。
    const workDateFrom = url.searchParams.get("work_date_from");
    const workDateTo = url.searchParams.get("work_date_to");
    for (const [name, v] of [["work_date_from", workDateFrom], ["work_date_to", workDateTo]] as const) {
      if (v !== null && (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(new Date(v).getTime()))) throw BadRequest(`${name} 格式唔啱（YYYY-MM-DD）`);
    }
    let where: Prisma.DailyRequirementWhereInput = {
      ...(siteId ? { siteId } : {}),
      ...(includeVoided ? {} : { voidedAt: null }),
      ...(workDateFrom || workDateTo ? { workDate: { ...(workDateFrom ? { gte: new Date(workDateFrom) } : {}), ...(workDateTo ? { lte: new Date(workDateTo) } : {}) } } : {}),
    };
    where = scopeBySiteHavingBrokerShifts(session, where);
    const [rows, total] = await Promise.all([
      prisma.dailyRequirement.findMany({ where, skip, take, orderBy: [{ workDate: "asc" }, { id: "asc" }] }),
      prisma.dailyRequirement.count({ where }),
    ]);
    if (isBrokerRole(session)) {
      return ok(scrubForBrokerSession(session, mapListForBroker({ rows, total, skip, take }, toBrokerDailyRequirementDTO)));
    }
    return ok(mapListDTO({ rows, total, skip, take }, toDailyRequirementFullDTO));
  });
}

export async function POST(req: Request) {
  return withApiError(async () => {
    const session = await requirePermission(req, "更表", "create");
    const body = await readJson(req);
    const parsed = parseBody(DailyRequirementCreateSchema, body);

    // S2：shift_type.site_id 要同傳入嘅 site_id 一致；雞頭仲要
    // assertSiteAssignedToBroker（呢個 route 雞頭本身冇 create 權限
    // 出廠設定係 off，但一齊寫好防止老闆開咗權限之後有漏洞）。
    const st = await prisma.shiftType.findUnique({ where: { id: parsed.shift_type_id }, select: { siteId: true } });
    if (!st) throw BadRequest("shift_type_id 唔存在");
    if (st.siteId !== parsed.site_id) throw BadRequest("shift_type_id 唔屬於呢個 site_id");
    if (isBrokerRole(session)) {
      const brokerId = requireOwnBrokerId(session);
      await assertSiteAssignedToBroker(parsed.site_id, brokerId, parsed.work_date);
    }

    await assertMonthNotLocked({
      workDate: parsed.work_date,
      actorUserId: session.userId,
      tableName: "daily_requirements",
      rowId: "new",
      ip: getClientIp(req),
    });
    const data = snakeToCamelShallow(parsed) as Prisma.DailyRequirementUncheckedCreateInput;
    const created = await prisma.dailyRequirement.create({ data: { ...data, createdBy: session.userId } });
    await writeAudit({ actorUserId: session.userId, tableName: "daily_requirements", rowId: created.id, action: "create", after: created, ip: getClientIp(req) });
    return ok(toDailyRequirementFullDTO(created), 201);
  });
}
