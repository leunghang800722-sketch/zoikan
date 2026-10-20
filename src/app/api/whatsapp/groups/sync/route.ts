// W0：POST /api/whatsapp/groups/sync——向 WAHA 攞群組列表，新群 kind=ignored 入 whatsapp_groups。
// update 權（淨係老闆）。WA-6：WAHA 列表失敗（未設定／超時／HTTP 錯／格式錯／連唔到）唔令 sync 失敗——照樣由已收訊息補群，
// 回 200＋waha_error { kind, status?, code, message }（分類碼＋人話，唔洩漏 URL／key）。
import { requirePermission } from "@/lib/rbac/requirePermission";
import { ok, getClientIp, withApiError } from "@/lib/api/http";
import { brandSafeResponse } from "@/lib/api/serialize";
import { syncGroupsFromWaha } from "@/lib/whatsapp/groups";

export async function POST(req: Request) {
  return withApiError(async () => {
    const actor = await requirePermission(req, "WhatsApp 報更", "update");
    const r = await syncGroupsFromWaha(actor.userId, getClientIp(req));
    // WA-6：WAHA 唔可達／回錯都照樣由訊息補群，回 200＋waha_error（錯誤碼 only，唔洩漏 URL／key）
    return ok(brandSafeResponse({ total: r.summary.total, created: r.summary.created, relabelled: r.summary.relabelled, from_messages: r.summary.from_messages, summary: r.summary, ...(r.waha_error ? { waha_error: r.waha_error } : {}) }));
  });
}
