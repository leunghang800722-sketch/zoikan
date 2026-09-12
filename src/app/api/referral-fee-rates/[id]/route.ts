import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/rbac/requirePermission";
import { scopeReferralFeeRateWhere, isBrokerRole } from "@/lib/broker-isolation";
import { toBrokerReferralFeeRateDTO } from "@/lib/broker-dto";
import { toReferralFeeRateDTO } from "@/lib/api/dto";
import { applyFieldGroupGate, assertFieldGroupWritable } from "@/lib/api/field-groups";
import { assertMonthNotLocked } from "@/lib/month-lock";
import { ok, getClientIp, withApiError } from "@/lib/api/http";
import { readJson } from "@/lib/api/query";
import { parseBody } from "@/lib/api/validate";
import { snakeToCamelShallow } from "@/lib/api/case";
import { ReferralFeeRateUpdateSchema } from "@/lib/api/schemas";
import { writeAudit } from "@/lib/audit";
import { NotFound } from "@/lib/api/errors";
import type { Prisma } from "@prisma/client";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withApiError(async () => {
    const session = await requirePermission(req, "雞頭", "view");
    const { id } = await params;
    const where = scopeReferralFeeRateWhere(session, { id });
    const row = await prisma.referralFeeRate.findFirst({ where });
    if (!row) throw NotFound();
    if (isBrokerRole(session)) return ok(toBrokerReferralFeeRateDTO(row));
    return ok(await applyFieldGroupGate(session, "referral_fee_rates", toReferralFeeRateDTO(row)));
  });
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withApiError(async () => {
    // 雞頭「雞頭:update」硬性 deny——呢個 route 只有內部角色行得到。
    const session = await requirePermission(req, "雞頭", "update");
    const { id } = await params;
    const before = await prisma.referralFeeRate.findUniqueOrThrow({ where: { id } });
    const body = await readJson(req);
    const parsed = parseBody(ReferralFeeRateUpdateSchema, body);
    await assertFieldGroupWritable(session, "referral_fee_rates", parsed);
    await assertMonthNotLocked({ workDate: before.month, actorUserId: session.userId, tableName: "referral_fee_rates", rowId: id, ip: getClientIp(req) });

    const data = snakeToCamelShallow(parsed) as Prisma.ReferralFeeRateUncheckedUpdateInput;
    const after = await prisma.referralFeeRate.update({ where: { id }, data });
    await writeAudit({ actorUserId: session.userId, tableName: "referral_fee_rates", rowId: id, action: "update", before, after, ip: getClientIp(req) });
    return ok(await applyFieldGroupGate(session, "referral_fee_rates", toReferralFeeRateDTO(after)));
  });
}
