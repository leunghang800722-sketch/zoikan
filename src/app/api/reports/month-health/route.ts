// WP-AI-OPS §28.3：`GET /api/reports/month-health?month=`（`月結總表:view`）——
// 鎖月前體檢＋資料補齊提示。**只提示，唔擋鎖月**。明細（姓名／工號）要「更表」view；
// 缺身份證要再有「保安員個人資料」view、缺銀行編號要再有「保安員銀行資料」view；
// 冇權限只回數量（`detail_withheld: true`）。hkid／電話號碼本身永遠唔回。
import { requirePermission, hasPermission } from "@/lib/rbac/requirePermission";
import { ok, withApiError } from "@/lib/api/http";
import { brandSafeResponse } from "@/lib/api/serialize";
import { parseMonthParam, monthStart } from "@/lib/reports/money";
import { buildMonthHealth, redactMonthHealth } from "@/lib/ops/month-health";
import { addMonths } from "@/lib/ops/digest";

export async function GET(req: Request) {
  return withApiError(async () => {
    const session = await requirePermission(req, "月結總表", "view");
    const url = new URL(req.url);
    const month = parseMonthParam(url.searchParams.get("month")) ?? addMonths(monthStart(new Date()), -1);
    const [roster, pii, bank, health] = await Promise.all([
      hasPermission(session, "更表", "view"),
      hasPermission(session, "安員個人資料", "view"),
      hasPermission(session, "安員銀行資料", "view"),
      buildMonthHealth(month, session),
    ]);
    const allowed = new Set<string>();
    if (roster) allowed.add("更表");
    if (pii) allowed.add("安員個人資料");
    if (bank) allowed.add("安員銀行資料");
    const redacted = redactMonthHealth(health, (m) => allowed.has(m));
    return ok(brandSafeResponse({ ...redacted, can_view_detail: roster }));
  });
}
