// P15.1：`POST /api/longterm/payroll/:month/void`（老闆；body `{ reason }` 必填）——作廢該月長工糧計算並回滾假期結餘，
// 令可以倒序重算。只准作廢最近一個已計月份（後面月份仲有效 → 409）；月鎖 → 403。回應唔含姓名。
import { requirePermission } from "@/lib/rbac/requirePermission";
import { assertMonthNotLocked } from "@/lib/month-lock";
import { voidLongtermPayrollMonth, previewVoidLongtermPayrollMonth } from "@/lib/longterm-payroll/void-month";
import { ok, getClientIp, withApiError } from "@/lib/api/http";
import { brandSafeResponse } from "@/lib/api/serialize";
import { readJson } from "@/lib/api/query";
import { parseBody } from "@/lib/api/validate";
import { LongtermPayrollVoidSchema } from "@/lib/api/schemas";
import { BadRequest, Forbidden } from "@/lib/api/errors";
import { parseMonthParam } from "@/lib/reports/money";

export async function POST(req: Request, { params }: { params: Promise<{ month: string }> }) {
  return withApiError(async () => {
    const session = await requirePermission(req, "長工糧", "update");
    if (session.baseRole !== "老闆") throw Forbidden("只有老闆可以作廢長工糧計算");
    const { month: monthParam } = await params;
    const month = parseMonthParam(monthParam);
    if (!month) throw BadRequest(`唔啱嘅月份格式：${monthParam}（要 YYYY-MM）`);
    const parsed = parseBody(LongtermPayrollVoidSchema, await readJson(req));
    const ip = getClientIp(req);
    await assertMonthNotLocked({ workDate: month, actorUserId: session.userId, tableName: "longterm_payroll_runs", rowId: "void", ip });
    const result = await voidLongtermPayrollMonth(month, session.userId, parsed.reason, ip, { confirmApprox: parsed.confirm_approx === true });
    return ok(brandSafeResponse({ ...result }));
  });
}

/** 唯讀前置檢查：`earlier_valid_runs`（之前仲有效嘅 run 月份）、`rollback_method`（snapshot／exact_rebuild／approx_rebuild／none）、後月阻擋。 */
export async function GET(req: Request, { params }: { params: Promise<{ month: string }> }) {
  return withApiError(async () => {
    await requirePermission(req, "長工糧", "view");
    const { month: monthParam } = await params;
    const month = parseMonthParam(monthParam);
    if (!month) throw BadRequest(`唔啱嘅月份格式：${monthParam}（要 YYYY-MM）`);
    return ok(brandSafeResponse({ ...(await previewVoidLongtermPayrollMonth(month)) }));
  });
}
