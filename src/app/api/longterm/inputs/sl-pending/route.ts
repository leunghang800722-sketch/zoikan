// P17：`GET /api/longterm/inputs/sl-pending?month=YYYY-MM`——未確認嘅更表 SL 草稿逐段（日期、連續日數、夠唔夠 4 日提示、結餘、預計津貼金額）。
// 唯讀；module「長工糧」view。含姓名（同草稿列表一致），只喺頁面用；通知／報告只有數字。
import { requirePermission } from "@/lib/rbac/requirePermission";
import { ok, withApiError } from "@/lib/api/http";
import { brandSafeResponse } from "@/lib/api/serialize";
import { parseMonthParam } from "@/lib/reports/money";
import { BadRequest } from "@/lib/api/errors";
import { listSlPending } from "@/lib/longterm-payroll/sl-confirm";

export async function GET(req: Request) {
  return withApiError(async () => {
    await requirePermission(req, "長工糧", "view");
    const month = parseMonthParam(new URL(req.url).searchParams.get("month"));
    if (!month) throw BadRequest("要帶 month（YYYY-MM）");
    return ok(brandSafeResponse({ ...(await listSlPending(month)) }));
  });
}
