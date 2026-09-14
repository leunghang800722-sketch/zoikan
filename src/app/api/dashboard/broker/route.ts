// P2-WP-R3：雞頭首頁 dashboard——GET /api/dashboard/broker?month=YYYY-MM
// （唯讀；`更表:view`＋雞頭角色專用，session.brokerId 隔離，見
// src/lib/reports/broker-dashboard.ts 註解）。內部角色（老闆/主管/會計）
// 打呢個 route 一律 403——佢哋首頁用嘅係 /api/reports/shortfall，唔應該
// 有第二條路徑攞到「某個雞頭嘅」dashboard 數（同 GET
// /api/reports/my-receivable 同一設計判斷：雞頭專用 report 唔開俾內部
// 角色代入）。
import { requirePermission } from "@/lib/rbac/requirePermission";
import { isBrokerRole, requireOwnBrokerId, scrubForBrokerSession } from "@/lib/broker-isolation";
import { ok, withApiError } from "@/lib/api/http";
import { brandSafeResponse } from "@/lib/api/serialize";
import { parseMonthParam, monthStart } from "@/lib/reports/money";
import { buildBrokerDashboard } from "@/lib/reports/broker-dashboard";
import { Forbidden, BadRequest } from "@/lib/api/errors";

export async function GET(req: Request) {
  return withApiError(async () => {
    const session = await requirePermission(req, "更表", "view");
    if (!isBrokerRole(session)) throw Forbidden("呢個 dashboard 淨係俾雞頭角色用——內部角色首頁請用 GET /api/reports/shortfall");
    const brokerId = requireOwnBrokerId(session);

    const url = new URL(req.url);
    const monthParam = url.searchParams.get("month");
    const month = monthParam ? parseMonthParam(monthParam) : monthStart(new Date());
    if (!month) throw BadRequest("month 格式唔啱（要 YYYY-MM）");

    const result = await buildBrokerDashboard(brokerId, month);
    return ok(scrubForBrokerSession(session, brandSafeResponse({ ...result })));
  });
}
