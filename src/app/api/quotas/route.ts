// P1-WP3：quotas（配額）CRUD——設計文件§3.2、§4.1。`配額` module（已喺
// src/lib/rbac/matrix.ts 出廠設定：老闆/主管 create+update G，雞頭淨係
// view G，其餘 D/O，見矩陣本身）。雞頭 GET 只見自己（scopeQuotaWhere）。
// 軟性限制：呢個 API 本身唔擋超配額（超配額嘅警示喺更表編輯器批量
// 儲存 response 度出，見 src/app/api/shift-records/batch/route.ts）。
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/rbac/requirePermission";
import { scopeQuotaWhere, isBrokerRole } from "@/lib/broker-isolation";
import { toBrokerQuotaDTO, mapListForBroker } from "@/lib/broker-dto";
import { toQuotaDTO, mapListDTO } from "@/lib/api/dto";
import { assertMonthNotLocked, monthStart } from "@/lib/month-lock";
import { ok, getClientIp, withApiError } from "@/lib/api/http";
import { paginationParams, readJson } from "@/lib/api/query";
import { parseBody } from "@/lib/api/validate";
import { QuotaCreateSchema } from "@/lib/api/schemas";
import { writeAudit } from "@/lib/audit";
import { BadRequest, Conflict } from "@/lib/api/errors";
import type { Prisma } from "@prisma/client";

export async function GET(req: Request) {
  return withApiError(async () => {
    const session = await requirePermission(req, "配額", "view");
    const url = new URL(req.url);
    const { skip, take } = paginationParams(url);
    const siteId = url.searchParams.get("site_id");
    const brokerId = url.searchParams.get("broker_id");
    const monthParam = url.searchParams.get("month");
    const includeVoided = url.searchParams.get("include_voided") === "1";
    let where: Prisma.QuotaWhereInput = {
      ...(siteId ? { siteId } : {}),
      ...(brokerId ? { brokerId } : {}),
      ...(monthParam ? { month: monthStart(new Date(monthParam)) } : {}),
      ...(includeVoided ? {} : { voidedAt: null }),
    };
    where = scopeQuotaWhere(session, where);
    const [rows, total] = await Promise.all([
      prisma.quota.findMany({ where, skip, take, orderBy: [{ month: "desc" }, { id: "asc" }] }),
      prisma.quota.count({ where }),
    ]);
    if (isBrokerRole(session)) {
      return ok(mapListForBroker({ rows, total, skip, take }, toBrokerQuotaDTO));
    }
    return ok(mapListDTO({ rows, total, skip, take }, toQuotaDTO));
  });
}

export async function POST(req: Request) {
  return withApiError(async () => {
    // 雞頭「配額:create」硬性 deny（矩陣）——配額一定由老闆/主管派，
    // 唔可以自己派俾自己。
    const session = await requirePermission(req, "配額", "create");
    const body = await readJson(req);
    const parsed = parseBody(QuotaCreateSchema, body);
    const parsedMonth = new Date(parsed.month);
    if (Number.isNaN(parsedMonth.getTime())) throw BadRequest("month 格式唔啱（YYYY-MM-DD 或 YYYY-MM）");
    const month = monthStart(parsedMonth);

    const st = await prisma.shiftType.findUnique({ where: { id: parsed.shift_type_id }, select: { siteId: true } });
    if (!st) throw BadRequest("shift_type_id 唔存在");
    if (st.siteId !== parsed.site_id) throw BadRequest("shift_type_id 唔屬於呢個 site_id");

    await assertMonthNotLocked({ workDate: month, actorUserId: session.userId, tableName: "quotas", rowId: "new", ip: getClientIp(req) });

    try {
      const created = await prisma.quota.create({
        data: {
          month,
          siteId: parsed.site_id,
          shiftTypeId: parsed.shift_type_id,
          brokerId: parsed.broker_id,
          targetShifts: parsed.target_shifts,
          createdBy: session.userId,
        },
      });
      await writeAudit({ actorUserId: session.userId, tableName: "quotas", rowId: created.id, action: "create", after: created, ip: getClientIp(req) });
      return ok(toQuotaDTO(created), 201);
    } catch (err: unknown) {
      if (err && typeof err === "object" && "code" in err && (err as { code?: string }).code === "P2002") {
        throw Conflict("呢個盤／更別／雞頭／月份已經有配額行（unique(month,site_id,shift_type_id,broker_id)）");
      }
      throw err;
    }
  });
}
