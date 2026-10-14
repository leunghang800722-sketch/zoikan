// P18 驗收 M2：`POST /api/longterm/attendance-fix`——「出勤修正」面板寫入（長工糧:update＝老闆／會計；主管／雞頭 403；已鎖月 403）。
// body：{ month:"YYYY-MM", actions:[{ guard_id, work_date, site_id, shift_type_id?, set_code?("SHIFT"|LeaveCode), settle_internal?:true }] }
// → { results:[{guard_id,work_date,site_id,action:"updated"|"noop"}], updated, noop }。全 noop 時 noop:true（前端唔好顯示「已寫入」）。
import { requirePermission } from "@/lib/rbac/requirePermission";
import { ok, getClientIp, withApiError } from "@/lib/api/http";
import { brandSafeResponse } from "@/lib/api/serialize";
import { readJson } from "@/lib/api/query";
import { parseBody } from "@/lib/api/validate";
import { LongtermAttendanceFixSchema } from "@/lib/api/schemas";
import { applyAttendanceFix } from "@/lib/longterm-payroll/attendance-fix";

export async function POST(req: Request) {
  return withApiError(async () => {
    const session = await requirePermission(req, "長工糧", "update");
    const body = parseBody(LongtermAttendanceFixSchema, await readJson(req));
    const month = new Date(`${body.month}-01T00:00:00Z`);
    const out = await applyAttendanceFix({ month, actions: body.actions, actorUserId: session.userId, ip: getClientIp(req) });
    return ok(brandSafeResponse({ ...out }));
  });
}
