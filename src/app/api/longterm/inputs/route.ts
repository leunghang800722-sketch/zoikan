// WP-LTPAY §21 任務 5b：`GET/POST /api/longterm/inputs`——會計每月人手
// 輸入項（津貼／扣款／制服／病假段＋醫生紙 flag／無薪假段／年假段／
// 離職結算 override／轉約備註），`src/lib/longterm-payroll/aggregate.ts`
// `buildLongtermPayrollInputs()` 讀呢張表。module「長工糧」（同「保安員
// 銀行資料」一致粒度——老闆／會計先有，主管／雞頭／保安員硬性拒）。
// 月鎖後唯讀：create 用 `assertMonthNotLocked()`（同 `special-items`
// route 一致 pattern）。
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/rbac/requirePermission";
import { assertMonthNotLocked } from "@/lib/month-lock";
import { toLongtermInputDTO, toLongtermInputWithGuardDTO } from "@/lib/longterm-payroll/dto";
import { ok, getClientIp, withApiError } from "@/lib/api/http";
import { brandSafeResponse } from "@/lib/api/serialize";
import { readJson } from "@/lib/api/query";
import { parseBody } from "@/lib/api/validate";
import { snakeToCamelShallow } from "@/lib/api/case";
import { LongtermInputCreateSchema } from "@/lib/api/schemas";
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
    const includeVoided = url.searchParams.get("include_voided") === "1";
    const where: Prisma.LongtermPayrollInputWhereInput = {
      ...(month ? { month } : {}),
      ...(guardId ? { guardId } : {}),
      ...(includeVoided ? {} : { voidedAt: null }),
    };
    const rows = await prisma.longtermPayrollInput.findMany({
      where,
      include: { guard: { select: { nameZh: true, staffNo: true, staffNoMw: true } } },
      orderBy: { createdAt: "desc" },
      take: 500,
    });
    const dto = rows.map((r) => toLongtermInputWithGuardDTO({ ...r, guardName: r.guard.nameZh, guardStaffNo: r.guard.staffNo ?? r.guard.staffNoMw ?? null }));
    return ok(brandSafeResponse({ rows: dto }));
  });
}

export async function POST(req: Request) {
  return withApiError(async () => {
    const session = await requirePermission(req, "長工糧", "create");
    const body = await readJson(req);
    const parsed = parseBody(LongtermInputCreateSchema, body);
    if (parsed.kind === "leave" && !parsed.date_from) throw BadRequest("kind=leave 要帶 date_from（病假／無薪假段開始日）");
    await assertMonthNotLocked({ workDate: parsed.month, actorUserId: session.userId, tableName: "longterm_payroll_inputs", rowId: "new", ip: getClientIp(req) });
    const data = snakeToCamelShallow(parsed) as Prisma.LongtermPayrollInputUncheckedCreateInput;
    const created = await prisma.longtermPayrollInput.create({ data: { ...data, createdBy: session.userId } });
    await writeAudit({ actorUserId: session.userId, tableName: "longterm_payroll_inputs", rowId: created.id, action: "create", after: created, ip: getClientIp(req) });
    return ok(toLongtermInputDTO(created), 201);
  });
}
