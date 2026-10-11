// P10.1：`PATCH /api/longterm/cover-rates/:id`——改額或作廢（{ amount } 或 { void:true }）。老闆專用；生效區間覆蓋已鎖月份 → 403（要改價請新增一行新生效日）。
import { requirePermission } from "@/lib/rbac/requirePermission";
import { toCoverRateDTO } from "@/lib/longterm-payroll/dto";
import { updateCoverRate } from "@/lib/longterm-payroll/cover-rates-service";
import { ok, getClientIp, withApiError } from "@/lib/api/http";
import { readJson } from "@/lib/api/query";
import { parseBody } from "@/lib/api/validate";
import { CoverRateUpdateSchema } from "@/lib/api/schemas";
import { Forbidden } from "@/lib/api/errors";

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withApiError(async () => {
    const session = await requirePermission(req, "長工糧", "update");
    if (session.baseRole !== "老闆") throw Forbidden("頂位價目表淨係老闆先可以改");
    const { id } = await params;
    const p = parseBody(CoverRateUpdateSchema, await readJson(req));
    const after = await updateCoverRate(id, { amount: p.amount, void: p.void }, session.userId, getClientIp(req));
    return ok(toCoverRateDTO(after));
  });
}
