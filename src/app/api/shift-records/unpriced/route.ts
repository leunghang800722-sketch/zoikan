// WP-PRICE §3：`GET /api/shift-records/unpriced?month=YYYY-MM[&site_id=]`——
// 純讀，權限「更表:view」（同更表編輯器/報表頁本身嘅睇權一致；雞頭
// session 經 `scopeShiftRecordWhere()` 淨係見到自己嘅未定价格）。
import { z } from "zod";
import { requirePermission } from "@/lib/rbac/requirePermission";
import { ok, withApiError } from "@/lib/api/http";
import { brandSafeResponse } from "@/lib/api/serialize";
import { parseMonthParam } from "@/lib/reports/money";
import { buildUnpricedSummary } from "@/lib/pricing/unpriced";
import { BadRequest } from "@/lib/api/errors";

const monthParamSchema = z.string().regex(/^\d{4}-\d{2}$/, "月份格式要係 YYYY-MM");

export async function GET(req: Request) {
  return withApiError(async () => {
    const session = await requirePermission(req, "更表", "view");
    const url = new URL(req.url);
    const parsedMonth = monthParamSchema.safeParse(url.searchParams.get("month"));
    if (!parsedMonth.success) throw BadRequest("month 要帶值（YYYY-MM）");
    const month = parseMonthParam(parsedMonth.data);
    if (!month) throw BadRequest("month 要帶值（YYYY-MM）");
    const siteId = url.searchParams.get("site_id");

    const summary = await buildUnpricedSummary(session, month, siteId);
    return ok(brandSafeResponse({ ...summary }));
  });
}
