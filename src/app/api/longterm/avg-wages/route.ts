// WP-LTPAY §21 任務 5b：`GET/POST /api/longterm/avg-wages`——「平均工資」
// （SL 4/5／AL 離職結算派彩優先讀呢張表，見 aggregate.ts）。POST＝upsert
// （`guardId+month` unique），會計人手每月輸入／覆核。module「長工糧」。
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/rbac/requirePermission";
import { assertMonthNotLocked } from "@/lib/month-lock";
import { toGuardAvgWageDTO, toGuardAvgWageWithGuardDTO } from "@/lib/longterm-payroll/dto";
import { ok, getClientIp, withApiError } from "@/lib/api/http";
import { brandSafeResponse } from "@/lib/api/serialize";
import { readJson } from "@/lib/api/query";
import { parseBody } from "@/lib/api/validate";
import { GuardAvgWageUpsertSchema } from "@/lib/api/schemas";
import { writeAudit } from "@/lib/audit";
import { parseMonthParam } from "@/lib/reports/money";
import { BadRequest } from "@/lib/api/errors";
import type { Prisma } from "@prisma/client";

export async function GET(req: Request) {
  return withApiError(async () => {
    await requirePermission(req, "長工糧", "view");
    const url = new URL(req.url);
    const month = parseMonthParam(url.searchParams.get("month"));
    const guardId = url.searchParams.get("guard_id");
    const where: Prisma.GuardAvgWageWhereInput = { voidedAt: null, ...(month ? { month } : {}), ...(guardId ? { guardId } : {}) };
    const rows = await prisma.guardAvgWage.findMany({
      where,
      include: { guard: { select: { nameZh: true, staffNo: true, staffNoMw: true } } },
      orderBy: { month: "desc" },
      take: 1000,
    });
    const dto = rows.map((r) => toGuardAvgWageWithGuardDTO({ ...r, guardName: r.guard.nameZh, guardStaffNo: r.guard.staffNo ?? r.guard.staffNoMw ?? null }));
    return ok(brandSafeResponse({ rows: dto }));
  });
}

export async function POST(req: Request) {
  return withApiError(async () => {
    const session = await requirePermission(req, "長工糧", "create");
    const body = await readJson(req);
    const parsed = parseBody(GuardAvgWageUpsertSchema, body);
    const avgDailyWage = Number(parsed.avg_daily_wage);
    if (parsed.avg_daily_wage === undefined || !Number.isFinite(avgDailyWage)) throw BadRequest("avg_daily_wage 要係數字");
    // Opus 5.5 驗收：月鎖後唯讀（同人手輸入項一致）。
    await assertMonthNotLocked({ workDate: parsed.month, actorUserId: session.userId, tableName: "guard_avg_wages", rowId: "new", ip: getClientIp(req) });
    const after = await prisma.guardAvgWage.upsert({
      where: { guardId_month: { guardId: parsed.guard_id, month: parsed.month } },
      create: { guardId: parsed.guard_id, month: parsed.month, avgDailyWage, source: parsed.source, createdBy: session.userId },
      update: { avgDailyWage, source: parsed.source, voidedAt: null },
    });
    await writeAudit({ actorUserId: session.userId, tableName: "guard_avg_wages", rowId: after.id, action: "update", after, ip: getClientIp(req) });
    return ok(toGuardAvgWageDTO(after), 201);
  });
}
