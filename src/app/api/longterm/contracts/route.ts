// WP-LTPAY §21 任務 5b：`GET/POST /api/longterm/contracts`——長工薪金合約
// 人手管理（列表／新增）。Maxwell 導入用另一個 endpoint（`POST
// /api/longterm/contracts/import`，已交付）。module「長工糧」（同「保安員
// 銀行資料」一致粒度）。合約生效區間覆蓋嘅月份鎖咗就唔准寫（同
// `rate_cards` 一致 pattern，`assertMonthRangeNotLocked()`）。
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/rbac/requirePermission";
import { assertMonthRangeNotLocked } from "@/lib/month-lock";
import { toLongtermContractDTO, toLongtermContractWithGuardDTO } from "@/lib/longterm-payroll/dto";
import { ok, getClientIp, withApiError } from "@/lib/api/http";
import { brandSafeResponse } from "@/lib/api/serialize";
import { readJson } from "@/lib/api/query";
import { parseBody } from "@/lib/api/validate";
import { snakeToCamelShallow } from "@/lib/api/case";
import { LongtermContractCreateSchema } from "@/lib/api/schemas";
import { writeAudit } from "@/lib/audit";
import type { Prisma } from "@prisma/client";

export async function GET(req: Request) {
  return withApiError(async () => {
    await requirePermission(req, "長工糧", "view");
    const url = new URL(req.url);
    const guardId = url.searchParams.get("guard_id");
    const activeOnly = url.searchParams.get("active_only") === "1";
    const includeVoided = url.searchParams.get("include_voided") === "1";
    const where: Prisma.GuardLongtermContractWhereInput = {
      ...(guardId ? { guardId } : {}),
      ...(includeVoided ? {} : { voidedAt: null }),
      ...(activeOnly ? { OR: [{ effectiveTo: null }, { effectiveTo: { gte: new Date() } }] } : {}),
    };
    const rows = await prisma.guardLongtermContract.findMany({
      where,
      include: { guard: { select: { nameZh: true, staffNo: true, staffNoMw: true } } },
      orderBy: [{ guardId: "asc" }, { effectiveFrom: "desc" }],
      take: 1000,
    });
    const dto = rows.map((r) => toLongtermContractWithGuardDTO({ ...r, guardName: r.guard.nameZh, guardStaffNo: r.guard.staffNo ?? r.guard.staffNoMw ?? null }));
    return ok(brandSafeResponse({ rows: dto }));
  });
}

export async function POST(req: Request) {
  return withApiError(async () => {
    const session = await requirePermission(req, "長工糧", "create");
    const body = await readJson(req);
    const parsed = parseBody(LongtermContractCreateSchema, body);
    await assertMonthRangeNotLocked({
      effectiveFrom: parsed.effective_from,
      effectiveTo: parsed.effective_to ?? null,
      actorUserId: session.userId,
      tableName: "guard_longterm_contracts",
      rowId: "new",
      ip: getClientIp(req),
    });
    const data = snakeToCamelShallow(parsed) as Prisma.GuardLongtermContractUncheckedCreateInput;
    const created = await prisma.guardLongtermContract.create({ data: { ...data, source: "manual", createdBy: session.userId } });
    await writeAudit({ actorUserId: session.userId, tableName: "guard_longterm_contracts", rowId: created.id, action: "create", after: created, ip: getClientIp(req) });
    return ok(toLongtermContractDTO(created), 201);
  });
}
