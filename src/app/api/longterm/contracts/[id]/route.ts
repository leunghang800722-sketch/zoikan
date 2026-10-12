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
import { overlapError } from "@/lib/longterm-payroll/contract-overlap";
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
    // P15 驗收 M1：改日期／取消作廢後唔准同同人其他生效合約重疊（淨改薪酬等欄、或者作廢，唔檢查）。
    // 檢查同更新喺同一 transaction，並鎖住 guard 行（同 POST 一致，防並發）。
    const after = await prisma.$transaction(async (tx) => {
      if (voided !== true && (rest.effective_from !== undefined || rest.effective_to !== undefined || voided === false)) {
        await tx.$queryRaw`SELECT id FROM guards WHERE id = ${before.guardId} FOR UPDATE`;
        const overlaps = await tx.guardLongtermContract.findMany({
          where: { guardId: before.guardId, voidedAt: null, id: { not: id }, ...(effectiveTo ? { effectiveFrom: { lte: effectiveTo as Date } } : {}), OR: [{ effectiveTo: null }, { effectiveTo: { gte: effectiveFrom as Date } }] },
          select: { id: true, effectiveFrom: true, effectiveTo: true },
          orderBy: { effectiveFrom: "asc" },
        });
        if (overlaps.length > 0) throw overlapError(overlaps, false);
      }
      return tx.guardLongtermContract.update({ where: { id }, data });
    });
    await writeAudit({ actorUserId: session.userId, tableName: "guard_longterm_contracts", rowId: id, action: voided !== undefined ? "void" : "update", before, after, ip: getClientIp(req) });
    return ok(toLongtermContractDTO(after));
  });
}
