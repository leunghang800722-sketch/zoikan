// W5：GET /api/whatsapp/metrics?days=7——近 N 日運維指標（整體＋按群；view 權；只有數字）。
import { requirePermission } from "@/lib/rbac/requirePermission";
import { ok, withApiError } from "@/lib/api/http";
import { brandSafeResponse } from "@/lib/api/serialize";
import { computeMetrics, parseDays } from "@/lib/whatsapp/metrics";

export async function GET(req: Request) {
  return withApiError(async () => {
    await requirePermission(req, "WhatsApp 報更", "view");
    const days = parseDays(new URL(req.url).searchParams.get("days"));
    const m = await computeMetrics(days);
    return ok(brandSafeResponse({ ...m, totals: { ...m.totals }, groups: m.groups.map((g) => ({ ...g })) }));
  });
}
