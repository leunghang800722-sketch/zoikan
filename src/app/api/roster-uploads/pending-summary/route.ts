// WP-ROSTER-UPLOAD Phase B-1（B1-2）：`GET /api/roster-uploads/pending-summary`
// ——「通知會計」嘅最簡單做法（任務書原話）：逐盤列「呢個月上載咗但未
// 對數完成」（status=parsed，仲有非 match 項未有決定）嘅數量，俾首頁
// 卡／對數頁頂部用。唔做 email。`?month=` 冇填就用今個月。
import { requirePermission } from "@/lib/rbac/requirePermission";
import { ok, withApiError } from "@/lib/api/http";
import { brandSafeResponse } from "@/lib/api/serialize";
import { BadRequest } from "@/lib/api/errors";
import { monthStart } from "@/lib/month-lock";
import { buildPendingSummary, PENDING_SUMMARY_DEFAULT_MONTHS } from "@/lib/roster-upload/pending-summary";
import { buildNameOnlySummary } from "@/lib/roster-upload/name-only";

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])(-\d{2})?$/;

export async function GET(req: Request) {
  return withApiError(async () => {
    await requirePermission(req, "更表上載", "view");
    const url = new URL(req.url);
    const monthParam = url.searchParams.get("month");
    if (monthParam && !MONTH_RE.test(monthParam)) throw BadRequest("month 格式要係 YYYY-MM 或 YYYY-MM-DD");
    // 驗收修正（Opus 5.5）：冇帶 month＝唔限定單一月份（8 月更表係 9 月先上載對數，首頁卡要見到上個月未對完嘅數）；
    // P3-1.5：預設收窄做「本月＋上月」（`months=2`），要全部月份用 `?months=0`。有帶 month 就淨係嗰個月（舊行為）。
    const month = monthParam ? monthStart(new Date(monthParam)) : null;
    // P3-1.5（additive）：冇帶 month 時，`?months=N`＝只計「本月往前數 N 個月」（預設 2＝本月＋上月，首頁用法）；
    // `months=0`＝全部月份（舊行為）。帶 month 時 months 唔生效。
    const monthsParam = url.searchParams.get("months");
    let months = PENDING_SUMMARY_DEFAULT_MONTHS;
    if (monthsParam !== null) {
      if (!/^\d{1,3}$/.test(monthsParam)) throw BadRequest("months 要係 0–999 嘅整數（0＝全部月份）");
      months = Number(monthsParam);
    }

    // 核心抽做 lib（Opus 5.5 驗收建議 2026-09-28），perf:snapshot 同用。
    // WP-STAFF-IMPORT B2：加 `name_only`（淨靠姓名配對格數警告；additive，原有欄位不變）。
    return ok(brandSafeResponse({ ...(await buildPendingSummary(month, { months })), name_only: await buildNameOnlySummary(month, { months }) }));
  });
}
