// P7.1：`GET /api/notifications?unread=1&take=&skip=`——本人（audience＝base_role 名或 user id）通知清單。
// 任何已登入角色都得；冇新 RBAC module（通知內容已無 PII，且按 audience 過濾）。
import { requireSession } from "@/lib/rbac/requirePermission";
import { ok, withApiError } from "@/lib/api/http";
import { brandSafeResponse } from "@/lib/api/serialize";
import { paginationParams } from "@/lib/api/query";
import { listNotificationsFor } from "@/lib/notify/queries";

export async function GET(req: Request) {
  return withApiError(async () => {
    const session = await requireSession(req);
    const url = new URL(req.url);
    const { skip, take } = paginationParams(url);
    const r = await listNotificationsFor(session.userId, session.baseRole, { unreadOnly: url.searchParams.get("unread") === "1", take, skip });
    const rows = r.rows.map((n) => ({ id: n.id, created_at: n.created_at.toISOString(), kind: n.kind, title: n.title, body: n.body, href: n.href, read: n.read }));
    return ok(brandSafeResponse({ rows, total: r.total, unread: r.unread, skip, take }));
  });
}
