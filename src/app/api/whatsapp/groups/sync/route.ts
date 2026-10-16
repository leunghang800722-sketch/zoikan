// W0：POST /api/whatsapp/groups/sync——向 WAHA 攞群組列表，新群 kind=ignored 入 whatsapp_groups。
// update 權（淨係老闆）。WAHA 未設定／連唔到 → 明確錯誤碼（唔洩漏 URL／key）。
import { requirePermission } from "@/lib/rbac/requirePermission";
import { ok, getClientIp, withApiError } from "@/lib/api/http";
import { ApiError } from "@/lib/api/errors";
import { brandSafeResponse } from "@/lib/api/serialize";
import { syncGroupsFromWaha } from "@/lib/whatsapp/groups";

export async function POST(req: Request) {
  return withApiError(async () => {
    const actor = await requirePermission(req, "WhatsApp 報更", "update");
    const r = await syncGroupsFromWaha(actor.userId, getClientIp(req));
    if (!r.ok) {
      if (r.error === "not_configured") throw new ApiError(503, "waha_not_configured", "WAHA 未設定（WAHA_BASE_URL）");
      throw new ApiError(502, "waha_unavailable", "連唔到 WAHA，請稍後再試");
    }
    return ok(brandSafeResponse({ total: r.summary.total, created: r.summary.created, relabelled: r.summary.relabelled }));
  });
}
