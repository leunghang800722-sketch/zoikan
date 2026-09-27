// WP-LTPAY §21 任務 5b：`GET/PATCH /api/longterm/contracts/:id`——編輯
// （月薪、Rest Day、年假日、試用期、法定假、pay_basis、daily_rate、
// post_site 等）／作廢（`voided:true`，見 schemas.ts 註解）。
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/rbac/requirePermission";
import { assertMonthRangeNotLocked } from "@/lib/month-lock";
import { toLongtermContractDTO } from "@/lib/longterm-payroll/dto";
import { ok, getClientIp, withApiError } from "@/lib/api/http";
import { readJson } from "@/lib/api/query";
import { parseBody } from "@/lib/api/validate";
import { snakeToCamelShallow } from "@/lib/api/case";
import { LongtermContractUpdateSchema } from "@/lib/api/schemas";
import { writeAudit } from "@/lib/audit";
import { NotFound } from "@/lib/api/errors";
import type { Prisma } from "@prisma/client";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withApiError(async () => {
    await requirePermission(req, "長工糧", "view");
    const { id } = await params;
    const row = await prisma.guardLongtermContract.findUnique({ where: { id } });
    if (!row) throw NotFound();
    return ok(toLongtermContractDTO(row));
  });
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withApiError(async () => {
    const session = await requirePermission(req, "長工糧", "update");
    const { id } = await params;
    const before = await prisma.guardLongtermContract.findUniqueOrThrow({ where: { id } });
    const body = await readJson(req);
    const { voided, ...rest } = parseBody(LongtermContractUpdateSchema, body);
    const effectiveFrom = rest.effective_from ?? before.effectiveFrom;
    const effectiveTo = rest.effective_to !== undefined ? rest.effective_to : before.effectiveTo;
    await assertMonthRangeNotLocked({
      effectiveFrom,
      effectiveTo,
      actorUserId: session.userId,
      tableName: "guard_longterm_contracts",
      rowId: id,
      ip: getClientIp(req),
    });
    const data = snakeToCamelShallow(rest) as Prisma.GuardLongtermContractUncheckedUpdateInput;
    if (voided === true) {
      data.voidedAt = new Date();
      data.voidedBy = session.userId;
    } else if (voided === false) {
      data.voidedAt = null;
      data.voidedBy = null;
    }
    const after = await prisma.guardLongtermContract.update({ where: { id }, data });
    await writeAudit({ actorUserId: session.userId, tableName: "guard_longterm_contracts", rowId: id, action: voided !== undefined ? "void" : "update", before, after, ip: getClientIp(req) });
    return ok(toLongtermContractDTO(after));
  });
}
