// P14.3：`PATCH /api/longterm/reconcile-rows/:id`——標記對數差異嘅原因（reason_code 枚舉＋reason_note）。
// reason_code=null 即取消標記（重新計入未解釋）。equal 行唔使標記。權限：長工糧:update（老闆／會計）。
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/rbac/requirePermission";
import { ok, getClientIp, withApiError } from "@/lib/api/http";
import { brandSafeResponse } from "@/lib/api/serialize";
import { NotFound, BadRequest } from "@/lib/api/errors";
import { readJson } from "@/lib/api/query";
import { parseBody } from "@/lib/api/validate";
import { writeAudit } from "@/lib/audit";
import { unresolvedCount } from "@/lib/longterm-payroll/bank-reconcile";
import { REASON_CODES } from "@/lib/longterm-payroll/reconcile-reasons";

const PatchSchema = z
  .object({
    reason_code: z.union([z.enum(REASON_CODES), z.null()]),
    reason_note: z.string().max(500).nullable().optional(),
  })
  .strict();

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withApiError(async () => {
    const session = await requirePermission(req, "長工糧", "update");
    const { id } = await params;
    const body = parseBody(PatchSchema, await readJson(req));
    const before = await prisma.longtermBankReconciliationRow.findUnique({ where: { id } });
    if (!before) throw NotFound("搵唔到呢行對數結果");
    if (before.status === "equal") throw BadRequest("吻合嘅行唔使標記原因");
    const code = body.reason_code;
    const after = await prisma.longtermBankReconciliationRow.update({
      where: { id },
      data: code
        ? { reasonCode: code, reasonNote: body.reason_note ?? null, resolvedBy: session.userId, resolvedAt: new Date() }
        : { reasonCode: null, reasonNote: body.reason_note ?? null, resolvedBy: null, resolvedAt: null },
    });
    await writeAudit({ actorUserId: session.userId, tableName: "longterm_bank_reconciliations", rowId: id, action: "update", before: { reason_code: before.reasonCode }, after: { reason_code: after.reasonCode }, ip: getClientIp(req) });
    const all = await prisma.longtermBankReconciliationRow.findMany({ where: { reconciliationId: after.reconciliationId }, select: { status: true, reasonCode: true } });
    return ok(brandSafeResponse({ id: after.id, reason_code: after.reasonCode, reason_note: after.reasonNote, resolved_at: after.resolvedAt ? after.resolvedAt.toISOString() : null, unresolved: unresolvedCount(all) }));
  });
}
