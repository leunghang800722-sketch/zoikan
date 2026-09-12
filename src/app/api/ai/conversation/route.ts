// WP-AI1：`GET /api/ai/conversation`（攞返自己同助手嘅對話記錄）／
// `DELETE /api/ai/conversation`（清空自己嘅對話）。同 chat route 一樣要
// `助手:view`。
import { requirePermission } from "@/lib/rbac/requirePermission";
import { ok, withApiError } from "@/lib/api/http";
import { brandSafeResponse } from "@/lib/api/serialize";
import { getConversation, clearConversation } from "@/lib/ai-conversation";

export async function GET(req: Request) {
  return withApiError(async () => {
    const session = await requirePermission(req, "助手", "view");
    const messages = await getConversation(session.userId);
    return ok(brandSafeResponse({ messages }));
  });
}

export async function DELETE(req: Request) {
  return withApiError(async () => {
    const session = await requirePermission(req, "助手", "view");
    await clearConversation(session.userId);
    return ok(brandSafeResponse({ ok: true }));
  });
}
