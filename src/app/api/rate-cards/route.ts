import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/rbac/requirePermission";
import { scopeRateCardWhere, scrubForBrokerSession, isBrokerRole } from "@/lib/broker-isolation";
import { toBrokerRateCardDTO, mapListForBroker } from "@/lib/broker-dto";
import { toRateCardFullDTO, mapListDTO } from "@/lib/api/dto";
import { applyFieldGroupGate, applyFieldGroupGateToList, assertFieldGroupWritable } from "@/lib/api/field-groups";
import { assertMonthRangeNotLocked } from "@/lib/month-lock";
import { ok, getClientIp, withApiError } from "@/lib/api/http";
import { paginationParams, readJson } from "@/lib/api/query";
import { parseBody } from "@/lib/api/validate";
import { snakeToCamelShallow } from "@/lib/api/case";
import { RateCardCreateSchema } from "@/lib/api/schemas";
import { writeAudit } from "@/lib/audit";
import type { Prisma } from "@prisma/client";

// C3：資源基本存取（list/get/create/update/void）一律用「出街價」module；
// 「收客價」淨係做 field-level gate（睇唔睇得到/改唔改得到 client_rate
// 呢一粒數，唔決定成個 rate_card 見唔見得到）——M1/M3：而家用中央
// field-groups 機制（唔係逐 route 補嘅舊 field-gates.ts）。
export async function GET(req: Request) {
  return withApiError(async () => {
    const session = await requirePermission(req, "出街價", "view");
    const url = new URL(req.url);
    const { skip, take } = paginationParams(url);
    const siteId = url.searchParams.get("site_id");
    const includeVoided = url.searchParams.get("include_voided") === "1";
    let where: Prisma.RateCardWhereInput = { ...(siteId ? { siteId } : {}), ...(includeVoided ? {} : { voidedAt: null }) };
    where = scopeRateCardWhere(session, where);
    const [rows, total] = await Promise.all([
      prisma.rateCard.findMany({ where, skip, take, orderBy: [{ effectiveFrom: "desc" }, { id: "asc" }] }),
      prisma.rateCard.count({ where }),
    ]);

    // 雞頭：白名單 DTO（C2，連 blocklist scrub 做 defense-in-depth）。
    if (isBrokerRole(session)) {
      return ok(scrubForBrokerSession(session, mapListForBroker({ rows, total, skip, take }, toBrokerRateCardDTO)));
    }
    // 內部角色：M1 白名單 DTO + M3 field-group gate（冇「收客價:view」
    // 剝 client_rate；冇「出街價:view」剝 guard_wage/broker_fee/note等）。
    const dto = mapListDTO({ rows, total, skip, take }, toRateCardFullDTO);
    return ok(await applyFieldGroupGateToList(session, "rate_cards", dto));
  });
}

export async function POST(req: Request) {
  return withApiError(async () => {
    const session = await requirePermission(req, "出街價", "create");
    const body = await readJson(req);
    const parsed = parseBody(RateCardCreateSchema, body);
    await assertFieldGroupWritable(session, "rate_cards", parsed);

    // M5：check 成個 [effective_from, effective_to] 區間入面有冇任何一個
    // 月被鎖（唔淨係 effective_from 嗰個月）。
    await assertMonthRangeNotLocked({
      effectiveFrom: parsed.effective_from,
      effectiveTo: parsed.effective_to ?? null,
      actorUserId: session.userId,
      tableName: "rate_cards",
      rowId: "new",
      ip: getClientIp(req),
    });

    const data = snakeToCamelShallow(parsed) as Prisma.RateCardUncheckedCreateInput;
    const created = await prisma.rateCard.create({ data: { ...data, createdBy: session.userId } });
    await writeAudit({ actorUserId: session.userId, tableName: "rate_cards", rowId: created.id, action: "create", after: created, ip: getClientIp(req) });
    return ok(await applyFieldGroupGate(session, "rate_cards", toRateCardFullDTO(created)), 201);
  });
}
