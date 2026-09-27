// WP-LTPAY §21 任務 5b：`GET /api/longterm/leave-balances`——逐人逐年
// AL／SL 結餘（`recomputeLongtermPayroll()` 跑完自動 upsert，見
// aggregate.ts §21 任務 4b(f)）；人手改用 `PATCH .../:id`（見同目錄
// `[id]/route.ts`）。module「長工糧」。
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/rbac/requirePermission";
import { toGuardLeaveBalanceWithGuardDTO } from "@/lib/longterm-payroll/dto";
import { ok, withApiError } from "@/lib/api/http";
import { brandSafeResponse } from "@/lib/api/serialize";
import type { Prisma } from "@prisma/client";

export async function GET(req: Request) {
  return withApiError(async () => {
    await requirePermission(req, "長工糧", "view");
    const url = new URL(req.url);
    const yearRaw = url.searchParams.get("year");
    const year = yearRaw && !Number.isNaN(Number(yearRaw)) ? Number(yearRaw) : undefined;
    const guardId = url.searchParams.get("guard_id");
    const where: Prisma.GuardLeaveBalanceWhereInput = { ...(year ? { year } : {}), ...(guardId ? { guardId } : {}) };
    const rows = await prisma.guardLeaveBalance.findMany({
      where,
      include: { guard: { select: { nameZh: true, staffNo: true, staffNoMw: true } } },
      orderBy: [{ year: "desc" }],
      take: 1000,
    });
    const dto = rows.map((r) => toGuardLeaveBalanceWithGuardDTO({ ...r, guardName: r.guard.nameZh, guardStaffNo: r.guard.staffNo ?? r.guard.staffNoMw ?? null }));
    return ok(brandSafeResponse({ rows: dto }));
  });
}
