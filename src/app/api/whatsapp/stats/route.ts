// W1：GET /api/whatsapp/stats?from=&to=&group=——dry-run 統計（view 權；只有數字）。
import { requirePermission } from "@/lib/rbac/requirePermission";
import { ok, withApiError } from "@/lib/api/http";
import { brandSafeResponse } from "@/lib/api/serialize";
import { computeStats, parseRange, resolveGroupJid } from "@/lib/whatsapp/stats";

export async function GET(req: Request) {
  return withApiError(async () => {
    await requirePermission(req, "WhatsApp 報更", "view");
    const url = new URL(req.url);
    const range = parseRange(url.searchParams.get("from"), url.searchParams.get("to"));
    const jid = await resolveGroupJid(url.searchParams.get("group"));
    return ok(brandSafeResponse({ ...(await computeStats(range, jid)) }));
  });
}
