// WP-ROSTER-UPLOAD Phase B-1（B1-2）：`GET /api/roster-uploads/pending-summary`
// ——「通知會計」嘅最簡單做法（任務書原話）：逐盤列「呢個月上載咗但未
// 對數完成」（status=parsed，仲有非 match 項未有決定）嘅數量，俾首頁
// 卡／對數頁頂部用。唔做 email。`?month=` 冇填就用今個月。
import { requirePermission } from "@/lib/rbac/requirePermission";
import { ok, withApiError } from "@/lib/api/http";
import { brandSafeResponse } from "@/lib/api/serialize";
import { BadRequest } from "@/lib/api/errors";
import { monthStart } from "@/lib/month-lock";
import { buildPendingSummary } from "@/lib/roster-upload/pending-summary";

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])(-\d{2})?$/;

export async function GET(req: Request) {
  return withApiError(async () => {
    await requirePermission(req, "更表上載", "view");
    const url = new URL(req.url);
    const monthParam = url.searchParams.get("month");
    if (monthParam && !MONTH_RE.test(monthParam)) throw BadRequest("month 格式要係 YYYY-MM 或 YYYY-MM-DD");
    // 驗收修正（Opus 5.5）：冇帶 month＝所有月份（之前預設「今個月」——但
    // 8 月更表係 9 月先上載對數，首頁卡用今日個月就永遠見唔到上個月未對
    // 完嘅數）。有帶 month 就淨係嗰個月（舊行為）。
    const month = monthParam ? monthStart(new Date(monthParam)) : null;

    // 核心抽做 lib（Opus 5.5 驗收建議 2026-09-28），perf:snapshot 同用。
    return ok(brandSafeResponse({ ...(await buildPendingSummary(month)) }));
  });
}
