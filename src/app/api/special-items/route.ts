import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/rbac/requirePermission";
import { assertMonthNotLocked } from "@/lib/month-lock";
import { toSpecialItemDTO, mapListDTO } from "@/lib/api/dto";
import { applyFieldGroupGate, applyFieldGroupGateToList, assertFieldGroupWritable } from "@/lib/api/field-groups";
import { ok, getClientIp, withApiError } from "@/lib/api/http";
import { paginationParams, readJson } from "@/lib/api/query";
import { parseBody } from "@/lib/api/validate";
import { snakeToCamelShallow } from "@/lib/api/case";
import { SpecialItemCreateSchema } from "@/lib/api/schemas";
import { writeAudit } from "@/lib/audit";
import type { Prisma } from "@prisma/client";

export async function GET(req: Request) {
  return withApiError(async () => {
    const session = await requirePermission(req, "糧務", "view");
    const url = new URL(req.url);
    const { skip, take } = paginationParams(url);
    const month = url.searchParams.get("month");
    const includeVoided = url.searchParams.get("include_voided") === "1";
    const where: Prisma.SpecialItemWhereInput = {
      ...(month ? { month: new Date(month) } : {}),
      ...(includeVoided ? {} : { voidedAt: null }),
    };
    const [rows, total] = await Promise.all([
      prisma.specialItem.findMany({ where, skip, take, orderBy: { createdAt: "desc" } }),
      prisma.specialItem.count({ where }),
    ]);
    // M1/M3：special_items.revenue 受「收客價」field-level gate 管（主管
    // 出廠設定睇唔到）——中央機制，唔係呢個 route 自己補。
    const dto = mapListDTO({ rows, total, skip, take }, toSpecialItemDTO);
    return ok(await applyFieldGroupGateToList(session, "special_items", dto));
  });
}

export async function POST(req: Request) {
  return withApiError(async () => {
    const session = await requirePermission(req, "糧務", "create");
    const body = await readJson(req);
    const parsed = parseBody(SpecialItemCreateSchema, body);
    await assertFieldGroupWritable(session, "special_items", parsed);
    await assertMonthNotLocked({
      workDate: parsed.month,
      actorUserId: session.userId,
      tableName: "special_items",
      rowId: "new",
      ip: getClientIp(req),
    });
    const data = snakeToCamelShallow(parsed) as Prisma.SpecialItemUncheckedCreateInput;
    const created = await prisma.specialItem.create({ data: { ...data, createdBy: session.userId } });
    await writeAudit({ actorUserId: session.userId, tableName: "special_items", rowId: created.id, action: "create", after: created, ip: getClientIp(req) });
    return ok(await applyFieldGroupGate(session, "special_items", toSpecialItemDTO(created)), 201);
  });
}
