// P1-WP3（E）：referral_fee_rates（雞頭介紹費率，P3a：逐盤逐雞頭逐月可
// 變）CRUD——跟 quotas（配額）走同一套 pattern（`雞頭` module，唔開新
// module；雞頭 GET 只見自己，create/update/void 硬性 deny，見
// src/lib/rbac/matrix.ts「雞頭」module 個 row）。
//
// site_id 留空＝呢個雞頭全盤預設費率，有 site_id 嘅行覆蓋預設；DB 兩條
// unique 約束（見 prisma/schema.prisma／init migration 手寫 SQL）：
//   - (broker_id, site_id, month) 標準 unique（涵蓋指定盤嘅行）
//   - partial unique (broker_id, month) WHERE site_id IS NULL（擋同一
//     雞頭同一個月有兩行「預設費率」）
// 兩條都靠 DB 保證，呢度淨係捕 P2002 轉做 409。
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/rbac/requirePermission";
import { scopeReferralFeeRateWhere, isBrokerRole } from "@/lib/broker-isolation";
import { toBrokerReferralFeeRateDTO, mapListForBroker } from "@/lib/broker-dto";
import { toReferralFeeRateDTO, mapListDTO } from "@/lib/api/dto";
import { applyFieldGroupGate, applyFieldGroupGateToList, assertFieldGroupWritable } from "@/lib/api/field-groups";
import { assertMonthNotLocked, monthStart } from "@/lib/month-lock";
import { ok, getClientIp, withApiError } from "@/lib/api/http";
import { paginationParams, readJson } from "@/lib/api/query";
import { parseBody } from "@/lib/api/validate";
import { snakeToCamelShallow } from "@/lib/api/case";
import { ReferralFeeRateCreateSchema } from "@/lib/api/schemas";
import { writeAudit } from "@/lib/audit";
import { BadRequest, Conflict } from "@/lib/api/errors";
import type { Prisma } from "@prisma/client";

export async function GET(req: Request) {
  return withApiError(async () => {
    const session = await requirePermission(req, "雞頭", "view");
    const url = new URL(req.url);
    const { skip, take } = paginationParams(url);
    const siteId = url.searchParams.get("site_id");
    const brokerId = url.searchParams.get("broker_id");
    const monthParam = url.searchParams.get("month");
    const includeVoided = url.searchParams.get("include_voided") === "1";
    let where: Prisma.ReferralFeeRateWhereInput = {
      ...(siteId ? { siteId } : {}),
      ...(brokerId ? { brokerId } : {}),
      ...(monthParam ? { month: monthStart(new Date(monthParam)) } : {}),
      ...(includeVoided ? {} : { voidedAt: null }),
    };
    where = scopeReferralFeeRateWhere(session, where);
    const [rows, total] = await Promise.all([
      prisma.referralFeeRate.findMany({ where, skip, take, orderBy: [{ month: "desc" }, { id: "asc" }] }),
      prisma.referralFeeRate.count({ where }),
    ]);
    if (isBrokerRole(session)) {
      return ok(mapListForBroker({ rows, total, skip, take }, toBrokerReferralFeeRateDTO));
    }
    const dto = mapListDTO({ rows, total, skip, take }, toReferralFeeRateDTO);
    return ok(await applyFieldGroupGateToList(session, "referral_fee_rates", dto));
  });
}

export async function POST(req: Request) {
  return withApiError(async () => {
    // 雞頭「雞頭:create」硬性 deny（矩陣）——介紹費率一定由老闆/主管/
    // 會計派，雞頭唔可以自己幫自己開費率。
    const session = await requirePermission(req, "雞頭", "create");
    const body = await readJson(req);
    const parsed = parseBody(ReferralFeeRateCreateSchema, body);
    await assertFieldGroupWritable(session, "referral_fee_rates", parsed);

    const parsedMonth = new Date(parsed.month);
    if (Number.isNaN(parsedMonth.getTime())) throw BadRequest("month 格式唔啱（YYYY-MM-DD 或 YYYY-MM）");
    const month = monthStart(parsedMonth);

    const broker = await prisma.broker.findUnique({ where: { id: parsed.broker_id }, select: { id: true } });
    if (!broker) throw BadRequest("broker_id 唔存在");
    if (parsed.site_id) {
      const site = await prisma.site.findUnique({ where: { id: parsed.site_id }, select: { id: true } });
      if (!site) throw BadRequest("site_id 唔存在");
    }

    await assertMonthNotLocked({ workDate: month, actorUserId: session.userId, tableName: "referral_fee_rates", rowId: "new", ip: getClientIp(req) });

    const data = snakeToCamelShallow({ ...parsed, month: parsed.month }) as Prisma.ReferralFeeRateUncheckedCreateInput;
    try {
      const created = await prisma.referralFeeRate.create({
        data: { ...data, month, createdBy: session.userId },
      });
      await writeAudit({ actorUserId: session.userId, tableName: "referral_fee_rates", rowId: created.id, action: "create", after: created, ip: getClientIp(req) });
      return ok(await applyFieldGroupGate(session, "referral_fee_rates", toReferralFeeRateDTO(created)), 201);
    } catch (err: unknown) {
      if (err && typeof err === "object" && "code" in err && (err as { code?: string }).code === "P2002") {
        throw Conflict(
          parsed.site_id
            ? "呢個雞頭／盤／月份已經有介紹費率行（unique(broker_id,site_id,month)）"
            : "呢個雞頭呢個月已經有預設費率行（partial unique(broker_id,month) WHERE site_id IS NULL）",
        );
      }
      throw err;
    }
  });
}
