// WP-POSTORDER-FREE（§34 B）：`GET /api/sites/:id/default-broker-suggestion?month=YYYY-MM`——唯讀。
// 由該月 Postorder Roster 分頁同盤逐日雞頭推出「建議盤預設雞頭」（值唯一先有建議）。用戶撳「採用」先 PATCH /api/sites/:id。
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/rbac/requirePermission";
import { ok, withApiError } from "@/lib/api/http";
import { brandSafeResponse } from "@/lib/api/serialize";
import { BadRequest, NotFound } from "@/lib/api/errors";
import { parseMonthParam } from "@/lib/reports/money";
import { suggestSiteDefaultBroker } from "@/lib/month-close/auto/site-default-broker";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withApiError(async () => {
    const session = await requirePermission(req, "盤", "view");
    const { id } = await params;
    const site = await prisma.site.findUnique({ where: { id }, select: { defaultSettlementBrokerId: true } });
    if (!site) throw NotFound();
    const monthParam = new URL(req.url).searchParams.get("month");
    const month = monthParam ? parseMonthParam(monthParam) : null;
    if (monthParam && !month) throw BadRequest("month 格式要 YYYY-MM");
    const r = await suggestSiteDefaultBroker(id, month, session.userId);
    return ok(
      brandSafeResponse({
        month: r.month,
        reason: r.reason,
        current_broker_id: site.defaultSettlementBrokerId,
        suggestion: r.suggestion ? { broker_id: r.suggestion.brokerId, broker_code: r.suggestion.brokerCode, broker_name: r.suggestion.brokerName, days: r.suggestion.days, source: r.suggestion.source } : null,
      }),
    );
  });
}
