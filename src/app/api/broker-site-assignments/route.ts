// S6（Opus 對抗式驗收）：broker_site_assignments 管理 API——quotas 表 P3
// 先做，P1 暫代做「邊個雞頭喺邊個盤邊個月有份」嘅白名單管理入口。權限
// 用「配額」module（呢個表本質上就係配額嘅前身：先有資格喺度，先至傾
// 配額幾多）。雞頭 GET 淨係見自己。
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/rbac/requirePermission";
import { scopeBrokerSiteAssignmentWhere, isBrokerRole } from "@/lib/broker-isolation";
import { toBrokerSiteAssignmentDTO, mapListDTO } from "@/lib/api/dto";
import { ok, getClientIp, withApiError } from "@/lib/api/http";
import { paginationParams, readJson } from "@/lib/api/query";
import { parseBody } from "@/lib/api/validate";
import { BrokerSiteAssignmentCreateSchema } from "@/lib/api/schemas";
import { monthStart, assertMonthNotLocked } from "@/lib/month-lock";
import { writeAudit } from "@/lib/audit";
import { BadRequest, Conflict } from "@/lib/api/errors";
import type { Prisma } from "@prisma/client";

export async function GET(req: Request) {
  return withApiError(async () => {
    const session = await requirePermission(req, "配額", "view");
    const url = new URL(req.url);
    const { skip, take } = paginationParams(url);
    const brokerId = url.searchParams.get("broker_id");
    const siteId = url.searchParams.get("site_id");
    let where: Prisma.BrokerSiteAssignmentWhereInput = {
      ...(brokerId ? { brokerId } : {}),
      ...(siteId ? { siteId } : {}),
    };
    where = scopeBrokerSiteAssignmentWhere(session, where);
    const [rows, total] = await Promise.all([
      prisma.brokerSiteAssignment.findMany({ where, skip, take, orderBy: [{ month: "desc" }, { id: "asc" }] }),
      prisma.brokerSiteAssignment.count({ where }),
    ]);
    return ok(mapListDTO({ rows, total, skip, take }, toBrokerSiteAssignmentDTO));
  });
}

export async function POST(req: Request) {
  return withApiError(async () => {
    // 雞頭喺 matrix.ts 「配額:create」係 deny（硬性）——自己唔可以幫自己
    // 開白名單，一定要老闆/主管派。
    const session = await requirePermission(req, "配額", "create");
    const body = await readJson(req);
    const parsed = parseBody(BrokerSiteAssignmentCreateSchema, body);
    const parsedMonth = new Date(parsed.month);
    if (Number.isNaN(parsedMonth.getTime())) throw BadRequest("month 格式唔啱（YYYY-MM-DD 或 YYYY-MM）");
    const month = monthStart(parsedMonth);
    if (isBrokerRole(session)) throw BadRequest("雞頭唔可以自己開 broker_site_assignments"); // 防禦：就算 hard-deny 有漏，呢度再擋一次

    // P6.1d（H4）：掛盤係跟月份走嘅資料，已鎖月份 403（同配額 route 一致）。
    await assertMonthNotLocked({ workDate: month, actorUserId: session.userId, tableName: "broker_site_assignments", rowId: "new", ip: getClientIp(req) });

    try {
      const created = await prisma.brokerSiteAssignment.create({
        data: { brokerId: parsed.broker_id, siteId: parsed.site_id, month, createdBy: session.userId },
      });
      await writeAudit({
        actorUserId: session.userId,
        tableName: "broker_site_assignments",
        rowId: created.id,
        action: "create",
        after: created,
        ip: getClientIp(req),
      });
      return ok(toBrokerSiteAssignmentDTO(created), 201);
    } catch (err: unknown) {
      if (err && typeof err === "object" && "code" in err && (err as { code?: string }).code === "P2002") {
        throw Conflict("呢個雞頭喺呢個盤呢個月已經有份");
      }
      throw err;
    }
  });
}
