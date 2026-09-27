// WP-LTPAY §21 任務 5b：`POST /api/longterm/payroll/:month/recompute`——
// 頁面「重算本月」掣，直接呼叫 `recomputeLongtermPayroll()`（同一鍵結算
// `stepCompute()` 用嗰個函數，冪等：void 舊 run 建新）。月鎖後唯讀——
// 唔准喺已鎖定嘅月份重算（會靜靜哋改咗個 run 但頁面/糧單已經鎖定，
// 令人以為個月結數字係鎖定嗰刻嘅數）。module「長工糧」`update`
// action（「重算」係寫入動作，唔係新增一項獨立資源）。
import { requirePermission } from "@/lib/rbac/requirePermission";
import { assertMonthNotLocked } from "@/lib/month-lock";
import { recomputeLongtermPayroll } from "@/lib/longterm-payroll/aggregate";
import { ok, getClientIp, withApiError } from "@/lib/api/http";
import { brandSafeResponse } from "@/lib/api/serialize";
import { BadRequest } from "@/lib/api/errors";
import { parseMonthParam, monthLabel } from "@/lib/reports/money";

export async function POST(req: Request, { params }: { params: Promise<{ month: string }> }) {
  return withApiError(async () => {
    const session = await requirePermission(req, "長工糧", "update");
    const { month: monthParam } = await params;
    const month = parseMonthParam(monthParam);
    if (!month) throw BadRequest(`唔啱嘅月份格式：${monthParam}（要 YYYY-MM）`);
    const ip = getClientIp(req);
    await assertMonthNotLocked({ workDate: month, actorUserId: session.userId, tableName: "longterm_payroll_runs", rowId: "new", ip });
    const result = await recomputeLongtermPayroll(month, session.userId, ip);
    return ok(brandSafeResponse({ month: monthLabel(month), run_id: result.runId, totals: result.totals, warnings: result.warnings }));
  });
}
