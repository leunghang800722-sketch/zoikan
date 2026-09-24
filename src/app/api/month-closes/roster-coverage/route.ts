// WP-ROSTER-UPLOAD Phase B-1（B1-6）：`GET /api/month-closes/roster-coverage?month=`
// ——月結工作台入頁／揀月份時查一次，等鎖定之前用戶就見到「邊啲盤未上
// 載／未對數完成」（規則 10），唔使撳「鎖定」先俾 400 先知。跟
// `GET /api/month-closes` 一樣用「更表」module 嘅 view（月結鎖定狀態相
// 關讀取歸「更表」關注面，見 month-closes/route.ts 頂註解）。
import { requirePermission } from "@/lib/rbac/requirePermission";
import { ok, withApiError } from "@/lib/api/http";
import { brandSafeResponse } from "@/lib/api/serialize";
import { BadRequest } from "@/lib/api/errors";
import { monthStart } from "@/lib/month-lock";
import { checkRosterUploadCoverage } from "@/lib/roster-upload/lock-precondition";

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])(-\d{2})?$/;

export async function GET(req: Request) {
  return withApiError(async () => {
    await requirePermission(req, "更表", "view");
    const url = new URL(req.url);
    const monthParam = url.searchParams.get("month");
    if (!monthParam || !MONTH_RE.test(monthParam)) throw BadRequest("要帶 month（YYYY-MM 或 YYYY-MM-DD）");
    const month = monthStart(new Date(monthParam));
    const coverage = await checkRosterUploadCoverage(month);
    return ok(brandSafeResponse({ missingUploadSites: coverage.missingUploadSites, unconfirmedUploadSites: coverage.unconfirmedUploadSites }));
  });
}
