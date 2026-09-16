// P1-WP3：審批隊列——逐項確認。`審批` module（矩陣：老闆/主管 view+update
// G，會計 O，雞頭硬性 D）。淨係 status=pending_approval 先可以批（其他
// 狀態 409，防止重複批／批一條 draft／已經 confirmed 嘅行）。
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/rbac/requirePermission";
import { assertMonthNotLocked } from "@/lib/month-lock";
import { toShiftRecordFullDTO } from "@/lib/api/dto";
import { applyFieldGroupGate } from "@/lib/api/field-groups";
import { ok, getClientIp, withApiError } from "@/lib/api/http";
import { writeAudit } from "@/lib/audit";
import { Conflict, NotFound } from "@/lib/api/errors";
// WP-PRICE：批核嗰陣如果 snapshot 仲係 null（雞頭自己開嗰陣可能重計唔到
// ——例如嗰陣仲未有對應卡），呢度補計一次先至 confirm，唔准帶住 0 過主。
import { resolveShiftPricing, type ShiftPricingRecordType } from "@/lib/pricing/resolve-rate";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withApiError(async () => {
    const session = await requirePermission(req, "審批", "update");
    const { id } = await params;
    const before = await prisma.shiftRecord.findUnique({ where: { id } });
    if (!before) throw NotFound();
    if (before.status !== "pending_approval") {
      throw Conflict(`呢條更次而家係 ${before.status}，唔係 pending_approval，冇嘢要批`);
    }
    await assertMonthNotLocked({ workDate: before.workDate, actorUserId: session.userId, tableName: "shift_records", rowId: id, ip: getClientIp(req) });

    const data: { status: "confirmed"; clientRateSnapshot?: number | null; guardWageSnapshot?: number | null; brokerFeeSnapshot?: number | null } = {
      status: "confirmed",
    };
    if (before.clientRateSnapshot === null || before.guardWageSnapshot === null || before.brokerFeeSnapshot === null) {
      const brokerForPricing = before.settlementBrokerId
        ? await prisma.broker.findUnique({ where: { id: before.settlementBrokerId }, select: { kind: true } })
        : null;
      const pricing = await resolveShiftPricing({
        siteId: before.siteId,
        shiftTypeId: before.shiftTypeId,
        settlementBrokerId: before.settlementBrokerId,
        brokerKind: brokerForPricing?.kind ?? null,
        guardId: before.guardId,
        workDate: before.workDate,
        isExternal: before.isExternal,
        recordType: before.recordType as ShiftPricingRecordType,
      });
      if (before.clientRateSnapshot === null) data.clientRateSnapshot = pricing.clientRate;
      if (before.guardWageSnapshot === null) data.guardWageSnapshot = pricing.guardWage;
      if (before.brokerFeeSnapshot === null) data.brokerFeeSnapshot = pricing.brokerFee;
    }

    const after = await prisma.shiftRecord.update({ where: { id }, data });
    await writeAudit({ actorUserId: session.userId, tableName: "shift_records", rowId: id, action: "update", before, after, ip: getClientIp(req) });
    return ok(await applyFieldGroupGate(session, "shift_records", toShiftRecordFullDTO(after)));
  });
}
