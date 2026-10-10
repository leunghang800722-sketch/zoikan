// P1-執行計劃.md §4 WP4 item 2：`GET /api/reports/shortfall?date=`／
// `?month=`（`尚欠總覽:view`）——今日/指定日各盤 confirmed vs
// daily_requirements，尚欠標紅；待審批數；本月毛利進度。
//
// 「本月毛利進度」嗰部分嚴格嚟講屬於「收客價/出街價」性質嘅金錢資料，
// 但設計文件§6.1「尚欠總覽」明文「開俾全部主管」（matrix.ts 已經將
// 「尚欠總覽」設做主管出廠 ✓，冇財務敏感度嘅定位）——所以呢個 route
// 刻意唔做收客價/出街價 field-level gate（同 matrix.ts 註解「尚欠總覽
// 冇財務敏感度，開俾全部主管」原意一致：呢個畫面本身就係俾睇唔到
// 收客價嘅主管都可以追月結進度用嘅，剝走反而違反設計原意）。
import { requirePermission } from "@/lib/rbac/requirePermission";
import { ok, withApiError } from "@/lib/api/http";
import { brandSafeResponse } from "@/lib/api/serialize";
import { buildShortfall, buildDayShortfall } from "@/lib/reports/shortfall";
import { BadRequest } from "@/lib/api/errors";

export async function GET(req: Request) {
  return withApiError(async () => {
    await requirePermission(req, "尚欠總覽", "view");
    const url = new URL(req.url);
    const dateRaw = url.searchParams.get("date") ?? url.searchParams.get("month");
    const date = dateRaw ? new Date(dateRaw.length <= 7 ? `${dateRaw}-01` : dateRaw) : new Date();
    if (Number.isNaN(date.getTime())) throw BadRequest("date/month 格式唔啱");
    // P3-2.2（additive）：`?include_margin=0` 只回日級部分（唔含 month_progress，唔跑毛利表）；
    // 月級毛利進度改由 `GET /api/reports/margin-progress?month=` 提供。唔帶參數＝舊 shape。
    const includeMargin = url.searchParams.get("include_margin") !== "0";
    const result = includeMargin ? await buildShortfall(date) : await buildDayShortfall(date);
    return ok(brandSafeResponse({ ...result }));
  });
}
