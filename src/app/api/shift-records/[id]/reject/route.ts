// P1-WP3：審批隊列——退回（附原因）。設計文件§4.1「主管：審批隊列逐項
// 確認」嘅反面操作；退回 = 打返 draft，等雞頭喺自己配額入面改完再交
// （唔用 cancelled——cancelled 係正式作廢，退回仲需要雞頭跟進，唔係
// 「呢件事完結」）。
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/rbac/requirePermission";
import { assertMonthNotLocked } from "@/lib/month-lock";
import { toShiftRecordFullDTO } from "@/lib/api/dto";
import { applyFieldGroupGate } from "@/lib/api/field-groups";
import { ok, getClientIp, withApiError } from "@/lib/api/http";
import { readJson } from "@/lib/api/query";
import { parseBody } from "@/lib/api/validate";
import { RejectReasonSchema } from "@/lib/api/schemas";
import { writeAudit } from "@/lib/audit";
import { Conflict, NotFound } from "@/lib/api/errors";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withApiError(async () => {
    const session = await requirePermission(req, "審批", "update");
    const { id } = await params;
    const body = await readJson(req);
    const { reason } = parseBody(RejectReasonSchema, body);
    const before = await prisma.shiftRecord.findUnique({ where: { id } });
    if (!before) throw NotFound();
    if (before.status !== "pending_approval") {
      throw Conflict(`呢條更次而家係 ${before.status}，唔係 pending_approval，冇嘢要退回`);
    }
    await assertMonthNotLocked({ workDate: before.workDate, actorUserId: session.userId, tableName: "shift_records", rowId: id, ip: getClientIp(req) });
    const after = await prisma.shiftRecord.update({ where: { id }, data: { status: "draft" } });
    await writeAudit({
      actorUserId: session.userId,
      tableName: "shift_records",
      rowId: id,
      action: "update",
      before,
      after: { ...after, reject_reason: reason },
      ip: getClientIp(req),
    });
    return ok(await applyFieldGroupGate(session, "shift_records", toShiftRecordFullDTO(after)));
  });
}
