// WP-LTPAY §21 任務 5b：`PATCH/DELETE /api/longterm/inputs/:id`——編輯／
// 作廢人手輸入項。DELETE＝軟刪（`voidedAt`，「業務事實只可以作廢，唔可以
// 真刪」鐵則，同 `special_items` 一致精神），對應 module「長工糧」嘅
// `void` action（`row()` 第 4 格，見 rbac/matrix.ts）。
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/rbac/requirePermission";
import { assertMonthNotLocked } from "@/lib/month-lock";
import { toLongtermInputDTO } from "@/lib/longterm-payroll/dto";
import { ok, getClientIp, withApiError } from "@/lib/api/http";
import { readJson } from "@/lib/api/query";
import { parseBody } from "@/lib/api/validate";
import { snakeToCamelShallow } from "@/lib/api/case";
import { LongtermInputUpdateSchema } from "@/lib/api/schemas";
import { writeAudit } from "@/lib/audit";
import { NotFound, Conflict } from "@/lib/api/errors";
import type { Prisma } from "@prisma/client";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withApiError(async () => {
    await requirePermission(req, "長工糧", "view");
    const { id } = await params;
    const row = await prisma.longtermPayrollInput.findUnique({ where: { id } });
    if (!row) throw NotFound();
    return ok(toLongtermInputDTO(row));
  });
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withApiError(async () => {
    const session = await requirePermission(req, "長工糧", "update");
    const { id } = await params;
    const before = await prisma.longtermPayrollInput.findUniqueOrThrow({ where: { id } });
    if (before.voidedAt) throw Conflict("呢項已作廢，唔可以再編輯——要改就新增一項");
    await assertMonthNotLocked({ workDate: before.month, actorUserId: session.userId, tableName: "longterm_payroll_inputs", rowId: id, ip: getClientIp(req) });
    const body = await readJson(req);
    const parsed = parseBody(LongtermInputUpdateSchema, body);
    const data = snakeToCamelShallow(parsed) as Prisma.LongtermPayrollInputUncheckedUpdateInput;
    const after = await prisma.longtermPayrollInput.update({ where: { id }, data });
    await writeAudit({ actorUserId: session.userId, tableName: "longterm_payroll_inputs", rowId: id, action: "update", before, after, ip: getClientIp(req) });
    return ok(toLongtermInputDTO(after));
  });
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withApiError(async () => {
    const session = await requirePermission(req, "長工糧", "void");
    const { id } = await params;
    const before = await prisma.longtermPayrollInput.findUniqueOrThrow({ where: { id } });
    if (before.voidedAt) return ok(toLongtermInputDTO(before)); // 已作廢，冪等
    await assertMonthNotLocked({ workDate: before.month, actorUserId: session.userId, tableName: "longterm_payroll_inputs", rowId: id, ip: getClientIp(req) });
    const after = await prisma.longtermPayrollInput.update({ where: { id }, data: { voidedAt: new Date(), voidedBy: session.userId } });
    await writeAudit({ actorUserId: session.userId, tableName: "longterm_payroll_inputs", rowId: id, action: "void", before, after, ip: getClientIp(req) });
    return ok(toLongtermInputDTO(after));
  });
}
