// P10.2：`GET /api/longterm/cover-rates/infer?months=2026-07,2026-08,2026-09`——由歷史反推頂位價目表＋回測。
// **老闆專用、純唯讀、唔寫任何嘢**。回應冇姓名／工號：只有盤／職級／金額／次數／人數／guard_id。
import { requirePermission } from "@/lib/rbac/requirePermission";
import { runCoverInference, parseMonthsList } from "@/lib/longterm-payroll/cover-infer-run";
import { ok, withApiError } from "@/lib/api/http";
import { brandSafeResponse } from "@/lib/api/serialize";
import { BadRequest, Forbidden } from "@/lib/api/errors";

export async function GET(req: Request) {
  return withApiError(async () => {
    const session = await requirePermission(req, "長工糧", "view");
    if (session.baseRole !== "老闆") throw Forbidden("頂位價推斷淨係老闆先可以用");
    const months = parseMonthsList(new URL(req.url).searchParams.get("months"));
    if (!months) throw BadRequest("要帶 months（逗號分隔 YYYY-MM，最多 6 個）");
    const result = await runCoverInference(months);
    return ok(brandSafeResponse({ ...result }));
  });
}
