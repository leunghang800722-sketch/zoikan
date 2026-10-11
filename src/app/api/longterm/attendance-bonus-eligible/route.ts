// P9.1：`GET /api/longterm/attendance-bonus-eligible?month=YYYY-MM-01`——勤工獎合資格清單（唯讀，唔建 input、唔填金額）。
// 規則：該月有長工合約，更表冇 SL／NL／NPL；系統冇遲到紀錄（late_checked=false）。姓名只喺回應內，通知唔含。
import { requirePermission } from "@/lib/rbac/requirePermission";
import { ok, withApiError } from "@/lib/api/http";
import { brandSafeResponse } from "@/lib/api/serialize";
import { parseMonthParam } from "@/lib/reports/money";
import { BadRequest } from "@/lib/api/errors";
import { listAttendanceBonusEligible } from "@/lib/longterm-payroll/drafts";

export async function GET(req: Request) {
  return withApiError(async () => {
    await requirePermission(req, "長工糧", "view");
    const month = parseMonthParam(new URL(req.url).searchParams.get("month"));
    if (!month) throw BadRequest("要帶 month（YYYY-MM-01）");
    return ok(brandSafeResponse({ ...(await listAttendanceBonusEligible(month)) }));
  });
}
