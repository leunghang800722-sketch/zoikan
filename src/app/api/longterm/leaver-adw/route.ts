// P19b：`GET /api/longterm/leaver-adw?month=YYYY-MM`——離職者平均工資待確認（導航卡資料源）。唯讀；module「長工糧」view。
// 輸入平均工資用現有 `POST /api/longterm/avg-wages`（source 預填 `source_prefill`）；儲存後重算本月先套用。
import { requirePermission, hasPermission } from "@/lib/rbac/requirePermission";
import { ok, withApiError } from "@/lib/api/http";
import { brandSafeResponse } from "@/lib/api/serialize";
import { parseMonthParam } from "@/lib/reports/money";
import { BadRequest } from "@/lib/api/errors";
import { listLeaverAdwPending } from "@/lib/longterm-payroll/leaver-adw-pending";

export async function GET(req: Request) {
  return withApiError(async () => {
    const session = await requirePermission(req, "長工糧", "view");
    const month = parseMonthParam(new URL(req.url).searchParams.get("month"));
    if (!month) throw BadRequest("要帶 month（YYYY-MM）");
    return ok(brandSafeResponse({ ...(await listLeaverAdwPending(month)), can_create: await hasPermission(session, "長工糧", "create") }));
  });
}
