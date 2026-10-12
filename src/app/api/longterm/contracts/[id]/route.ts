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
import { findOverlappingContracts, overlapError } from "@/lib/longterm-payroll/contract-overlap";
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
    // P15 驗收 M1：改日期／取消作廢後唔准同同人其他生效合約重疊（淨改薪酬等欄、或者作廢，唔檢查）
    if (voided !== true && (rest.effective_from !== undefined || rest.effective_to !== undefined || voided === false)) {
      const overlaps = await findOverlappingContracts(before.guardId, effectiveFrom as Date, (effectiveTo as Date | null) ?? null, id);
      if (overlaps.length > 0) throw overlapError(overlaps, false);
    }
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
