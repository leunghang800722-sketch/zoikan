// P2-B：GET /api/roster/overview?month=YYYY-MM（唯讀，`更表:view`）——
// 更表索引頁「最近開過」列表用。見 src/lib/reports/roster-overview.ts
// 註解：用「該月有更表記錄或雞頭指派」代替真正嘅瀏覽歷史，雞頭 session
// 經 scopeShiftRecordWhere()／scopeBrokerSiteAssignmentWhere() 隔離，淨
// 係見返自己有份嘅盤，人數／更數淨係計自己。
import { z } from "zod";
import { requirePermission } from "@/lib/rbac/requirePermission";
import { scrubForBrokerSession } from "@/lib/broker-isolation";
import { ok, withApiError } from "@/lib/api/http";
import { brandSafeResponse } from "@/lib/api/serialize";
import { parseMonthParam } from "@/lib/reports/money";
import { buildRosterOverview } from "@/lib/reports/roster-overview";
import { BadRequest } from "@/lib/api/errors";

const monthParamSchema = z.string().regex(/^\d{4}-\d{2}$/, "月份格式要係 YYYY-MM");

export async function GET(req: Request) {
  return withApiError(async () => {
    const session = await requirePermission(req, "更表", "view");

    const url = new URL(req.url);
    const monthParamRaw = url.searchParams.get("month");
    const parsed = monthParamSchema.safeParse(monthParamRaw);
    if (!parsed.success) throw BadRequest("month 要帶值（YYYY-MM）");
    const month = parseMonthParam(parsed.data);
    if (!month) throw BadRequest("month 要帶值（YYYY-MM）");

    const result = await buildRosterOverview(session, month);
    return ok(scrubForBrokerSession(session, brandSafeResponse({ ...result })));
  });
}
