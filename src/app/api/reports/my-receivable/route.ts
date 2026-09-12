// P1-執行計劃.md §4 WP4 item 4／設計文件§6.2：雞頭「本月應收」——
// `GET /api/reports/my-receivable?month=`（雞頭 session；`出街價:view`
// 自己）：更數×自己出街價逐日明細＋合計；零收客價、零他人。
//
// 呢個 report 一律用 session.brokerId（`requireOwnBrokerId()`）決定睇邊
// 個雞頭嘅資料——冇 query 參數可以指定第二個 broker_id，結構性排除「雞頭
// A 想睇雞頭 B 應收」呢種可能性。`scrubForBrokerSession()` 做埋
// defense-in-depth（雖然 buildMyReceivable() 輸出本身已經冇 client_rate
// 呢類收客價欄）。
import { requirePermission } from "@/lib/rbac/requirePermission";
import { isBrokerRole, requireOwnBrokerId, scrubForBrokerSession } from "@/lib/broker-isolation";
import { ok, withApiError } from "@/lib/api/http";
import { brandSafeResponse } from "@/lib/api/serialize";
import { parseMonthParam } from "@/lib/reports/money";
import { buildMyReceivable } from "@/lib/reports/my-receivable";
import { Forbidden, BadRequest } from "@/lib/api/errors";

export async function GET(req: Request) {
  return withApiError(async () => {
    const session = await requirePermission(req, "出街價", "view");
    if (!isBrokerRole(session)) throw Forbidden("呢個 report 淨係俾雞頭角色用——內部角色請用 GET /api/reports/gross-margin");
    const brokerId = requireOwnBrokerId(session);

    const url = new URL(req.url);
    const month = parseMonthParam(url.searchParams.get("month"));
    if (!month) throw BadRequest("month 要帶值（YYYY-MM）");

    const result = await buildMyReceivable(brokerId, month);
    return ok(scrubForBrokerSession(session, brandSafeResponse({ ...result })));
  });
}
