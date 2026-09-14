// P2-WP-R3：雞頭首頁 dashboard——GET /api/dashboard/broker?month=YYYY-MM
// （唯讀；`更表:view`＋雞頭角色專用，session.brokerId 隔離，見
// src/lib/reports/broker-dashboard.ts 註解）。內部角色（老闆/主管/會計）
// 打呢個 route 一律 403——佢哋首頁用嘅係 /api/reports/shortfall，唔應該
// 有第二條路徑攞到「某個雞頭嘅」dashboard 數（同 GET
// /api/reports/my-receivable 同一設計判斷：雞頭專用 report 唔開俾內部
// 角色代入）。
//
// B10 驗收修正：`month` 唔可以直接掉入 `parseMonthParam()`（
// `src/lib/reports/money.ts`，其他頁仲用緊，唔改嗰個舊 helper）——
// 佢底層 `new Date()` 對住 `"garbage-01"` 呢類垃圾字串唔一定回
// `Invalid Date`（JS Date parser 好寬鬆，會估估吓解讀出一個「啱」嘅
// 日期），令 `month=garbage` 冇 400 就直接當咗做某個月處理。改用 zod
// 喺 `parseMonthParam()` 之前就做形狀驗證（`^\d{4}-\d{2}$`），同
// `src/lib/ai/tools/broker-stats.ts` 嘅 `monthParam` 一致做法。
import { z } from "zod";
import { requirePermission } from "@/lib/rbac/requirePermission";
import { isBrokerRole, requireOwnBrokerId, scrubForBrokerSession } from "@/lib/broker-isolation";
import { ok, withApiError } from "@/lib/api/http";
import { brandSafeResponse } from "@/lib/api/serialize";
import { parseMonthParam, monthStart } from "@/lib/reports/money";
import { buildBrokerDashboard } from "@/lib/reports/broker-dashboard";
import { Forbidden, BadRequest } from "@/lib/api/errors";

const monthParamSchema = z.string().regex(/^\d{4}-\d{2}$/, "月份格式要係 YYYY-MM");

export async function GET(req: Request) {
  return withApiError(async () => {
    const session = await requirePermission(req, "更表", "view");
    if (!isBrokerRole(session)) throw Forbidden("呢個 dashboard 淨係俾雞頭角色用——內部角色首頁請用 GET /api/reports/shortfall");
    const brokerId = requireOwnBrokerId(session);

    const url = new URL(req.url);
    const monthParamRaw = url.searchParams.get("month");
    let month: Date;
    if (monthParamRaw === null) {
      month = monthStart(new Date());
    } else {
      const parsed = monthParamSchema.safeParse(monthParamRaw);
      if (!parsed.success) throw BadRequest("month 格式唔啱（要 YYYY-MM）");
      const parsedMonth = parseMonthParam(parsed.data);
      if (!parsedMonth) throw BadRequest("month 格式唔啱（要 YYYY-MM）");
      month = parsedMonth;
    }

    const result = await buildBrokerDashboard(brokerId, month);
    return ok(scrubForBrokerSession(session, brandSafeResponse({ ...result })));
  });
}
