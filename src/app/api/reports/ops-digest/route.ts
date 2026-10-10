// WP-AI-OPS §28.2：`GET /api/reports/ops-digest?month=`（`月結總表:view`，老闆／會計）
// ——每月修正摘要＋基線。純讀、冇人名／工號／hkid／電話。
import { requirePermission } from "@/lib/rbac/requirePermission";
import { ok, withApiError } from "@/lib/api/http";
import { brandSafeResponse } from "@/lib/api/serialize";
import { parseMonthParam } from "@/lib/reports/money";
import { hkMonthStart } from "@/lib/dates";
import { isAiConfigured } from "@/lib/ai/config";
import { buildOpsDigest, addMonths } from "@/lib/ops/digest";

export async function GET(req: Request) {
  return withApiError(async () => {
    const session = await requirePermission(req, "月結總表", "view");
    const url = new URL(req.url);
    // 預設上個月（結算通常喺月尾之後做）。
    const month = parseMonthParam(url.searchParams.get("month")) ?? addMonths(hkMonthStart(), -1);
    const digest = await buildOpsDigest(month, session);
    return ok(brandSafeResponse({ ...digest, ai_available: isAiConfigured() }));
  });
}
