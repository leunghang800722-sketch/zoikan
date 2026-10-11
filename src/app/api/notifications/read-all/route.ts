// P7.1：`POST /api/notifications/read-all`——本人全部標記已讀。
import { requireSession } from "@/lib/rbac/requirePermission";
import { ok, withApiError } from "@/lib/api/http";
import { brandSafeResponse } from "@/lib/api/serialize";
import { markAllNotificationsRead } from "@/lib/notify/queries";

export async function POST(req: Request) {
  return withApiError(async () => {
    const session = await requireSession(req);
    const updated = await markAllNotificationsRead(session.userId, session.baseRole);
    return ok(brandSafeResponse({ updated }));
  });
}
