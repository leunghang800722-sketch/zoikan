// WP-LTSHIFT（老闆 2026-09-26 §3）：`POST /api/reports/referral-fee/recompute
// { month }`——月結頁「重算介紹費」掣，由 `guards.referral_broker_id`＋
// B07（internal_longterm）更數＋`referral_fee_rates` 自動計 special_items
// (kind=referral_fee)，卓弘客戶盤豁免（規則 12a），7 月唔可以重算（已經
// 人手入咗）。
//
// 權限：跟 `POST /api/month-closes/:id/generate` 一致做法，用
// 「月結總表:view」做入口 gate（呢個 module 冇 create/update/void 動作，
// 全部 NA，「重新計算報表」呢種操作向來用 view 做閘），但任務書明文淨係
// 「老闆／會計」——「月結總表:view」對主管係 O（可選，未必開），對
// 雞頭/安員硬性 D，所以額外顯式擋主管（即使主管個別被開咗
// 月結總表:view，都唔可以碰呢個會改 special_items 嘅寫入操作）。
import { requirePermission } from "@/lib/rbac/requirePermission";
import { ok, getClientIp, withApiError } from "@/lib/api/http";
import { brandSafeResponse } from "@/lib/api/serialize";
import { readJson } from "@/lib/api/query";
import { BadRequest, Forbidden } from "@/lib/api/errors";
import { parseMonthParam } from "@/lib/reports/money";
import { recomputeReferralFees } from "@/lib/reports/referral-fee";
import { prisma } from "@/lib/db";

export async function POST(req: Request) {
  return withApiError(async () => {
    const session = await requirePermission(req, "月結總表", "view");
    if (session.baseRole !== "老闆" && session.baseRole !== "會計") {
      throw Forbidden("重算長工介紹費淨係老闆／會計可以做");
    }
    const body = (await readJson(req)) as { month?: unknown };
    const month = typeof body.month === "string" ? parseMonthParam(body.month) : null;
    if (!month) throw BadRequest("請傳 month（YYYY-MM 或 YYYY-MM-01）");

    const result = await recomputeReferralFees(month, session.userId, getClientIp(req));

    // 頁面顯示用雞頭代號（K/W/T/G…），唔係 brokerId——逐個查返 code
    // （呢張表通常得幾個雞頭，唔使擔心 N+1）。
    const brokerIds = [...result.totalsByBroker.keys()];
    const brokers = brokerIds.length ? await prisma.broker.findMany({ where: { id: { in: brokerIds } }, select: { id: true, code: true } }) : [];
    const codeById = new Map(brokers.map((b) => [b.id, b.code]));
    const totalsByBrokerCode: Record<string, number> = {};
    for (const [brokerId, amount] of result.totalsByBroker) {
      totalsByBrokerCode[codeById.get(brokerId) ?? brokerId] = amount;
    }

    return ok(
      brandSafeResponse({
        month: month.toISOString().slice(0, 10),
        total_amount: result.totalAmount,
        totals_by_broker: Object.fromEntries(result.totalsByBroker),
        totals_by_broker_code: totalsByBrokerCode,
        created_count: result.createdCount,
        voided_count: result.voidedCount,
        exempt_shift_count: result.exemptShiftCount,
        warnings: result.warnings,
      }),
    );
  });
}
