// P3-2.2：`GET /api/reports/margin-progress?month=YYYY-MM`（`尚欠總覽:view`，同日級 route 一樣）
// ——首頁「本月毛利進度」卡專用月級 API，回 `{ month, revenue, cost, profit, margin_pct,
// threshold_pct, below_threshold_site_count }`，數字＝`buildGrossMargin(month).totals`。
//
// 老闆決定第 6 條：每次開／換月都**即時重計**，呢度冇任何 TTL／跨 request cache
// （只有 request-scoped memo，見 src/lib/reports/context.ts）。
// 權限口徑同舊 `/api/reports/shortfall` 內嵌 month_progress 完全一致（刻意唔做收客價／
// 出街價 field-level gate，原因見 ../shortfall/route.ts 檔頭）。
import { requirePermission } from "@/lib/rbac/requirePermission";
import { ok, withApiError } from "@/lib/api/http";
import { brandSafeResponse } from "@/lib/api/serialize";
import { buildMarginProgress } from "@/lib/reports/shortfall";
import { parseMonthParam } from "@/lib/reports/money";
import { BadRequest } from "@/lib/api/errors";

export async function GET(req: Request) {
  return withApiError(async () => {
    await requirePermission(req, "尚欠總覽", "view");
    const raw = new URL(req.url).searchParams.get("month");
    const month = raw ? (/^\d{4}-\d{2}$/.test(raw) ? parseMonthParam(raw) : null) : new Date();
    if (!month) throw BadRequest("month 格式唔啱（YYYY-MM）");
    const result = await buildMarginProgress(month);
    return ok(brandSafeResponse({ ...result }));
  });
}
