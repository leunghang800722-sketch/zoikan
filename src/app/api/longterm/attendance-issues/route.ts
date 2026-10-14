// P18.2：`GET /api/longterm/attendance-issues?month=YYYY-MM-01`——長工糧「出勤修正」面板資料（唯讀）。
// 列出該月 ① 同日多來源衝突日（系統而家採用邊個＋對糧嘅影響）② 全部更歸雞頭（settlement≠B07）嘅長工。
// 寫入走 POST /api/longterm/attendance-fix（長工糧:update；人手紀錄 source="manual"；歸公司兵設 B07）。`can_update` 俾前端停用掣。姓名只喺回應內。
import { requirePermission, hasPermission } from "@/lib/rbac/requirePermission";
import { ok, withApiError } from "@/lib/api/http";
import { brandSafeResponse } from "@/lib/api/serialize";
import { parseMonthParam } from "@/lib/reports/money";
import { BadRequest } from "@/lib/api/errors";
import { listAttendanceIssues } from "@/lib/longterm-payroll/attendance-issues";

export async function GET(req: Request) {
  return withApiError(async () => {
    const session = await requirePermission(req, "長工糧", "view");
    const month = parseMonthParam(new URL(req.url).searchParams.get("month"));
    if (!month) throw BadRequest("要帶 month（YYYY-MM-01）");
    return ok(brandSafeResponse({ ...(await listAttendanceIssues(month)), can_update: await hasPermission(session, "長工糧", "update") }));
  });
}
