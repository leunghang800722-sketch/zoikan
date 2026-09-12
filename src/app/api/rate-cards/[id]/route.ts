import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/rbac/requirePermission";
import { scopeRateCardWhere, scrubForBrokerSession, isBrokerRole } from "@/lib/broker-isolation";
import { toBrokerRateCardDTO } from "@/lib/broker-dto";
import { toRateCardFullDTO } from "@/lib/api/dto";
import { applyFieldGroupGate, assertFieldGroupWritable } from "@/lib/api/field-groups";
import { assertMonthRangeNotLocked } from "@/lib/month-lock";
import { ok, getClientIp, withApiError } from "@/lib/api/http";
import { readJson } from "@/lib/api/query";
import { parseBody } from "@/lib/api/validate";
import { snakeToCamelShallow } from "@/lib/api/case";
import { RateCardUpdateSchema } from "@/lib/api/schemas";
import { writeAudit } from "@/lib/audit";
import { NotFound } from "@/lib/api/errors";
import type { Prisma } from "@prisma/client";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withApiError(async () => {
    const session = await requirePermission(req, "出街價", "view");
    const { id } = await params;
    const where = scopeRateCardWhere(session, { id });
    const row = await prisma.rateCard.findFirst({ where });
    if (!row) throw NotFound();
    if (isBrokerRole(session)) return ok(scrubForBrokerSession(session, toBrokerRateCardDTO(row)));
    return ok(await applyFieldGroupGate(session, "rate_cards", toRateCardFullDTO(row)));
  });
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withApiError(async () => {
    // 價目改動強制留痕（P1計劃§4 WP2「價目／糧務改動強制留痕」）——呢個
    // endpoint 每次都會經 writeAudit，冇分支可以繞過。
    const session = await requirePermission(req, "出街價", "update");
    const { id } = await params;
    const before = await prisma.rateCard.findUniqueOrThrow({ where: { id } });
    const body = await readJson(req);
    const parsed = parseBody(RateCardUpdateSchema, body);
    await assertFieldGroupWritable(session, "rate_cards", parsed);

    // M5：改動之前嘅區間、改動之後嘅新區間都要 check——Opus 兩條重現
    // （PATCH 將 effective_to 伸入已鎖定嘅月）就係呢度冚。
    await assertMonthRangeNotLocked({
      effectiveFrom: before.effectiveFrom,
      effectiveTo: before.effectiveTo,
      actorUserId: session.userId,
      tableName: "rate_cards",
      rowId: id,
      ip: getClientIp(req),
    });
    if (parsed.effective_from || parsed.effective_to !== undefined) {
      await assertMonthRangeNotLocked({
        effectiveFrom: parsed.effective_from ?? before.effectiveFrom,
        effectiveTo: parsed.effective_to !== undefined ? (parsed.effective_to ?? null) : before.effectiveTo,
        actorUserId: session.userId,
        tableName: "rate_cards",
        rowId: id,
        ip: getClientIp(req),
      });
    }

    const data = snakeToCamelShallow(parsed) as Prisma.RateCardUncheckedUpdateInput;
    const after = await prisma.rateCard.update({ where: { id }, data });
    await writeAudit({ actorUserId: session.userId, tableName: "rate_cards", rowId: id, action: "update", before, after, ip: getClientIp(req) });
    return ok(await applyFieldGroupGate(session, "rate_cards", toRateCardFullDTO(after)));
  });
}
