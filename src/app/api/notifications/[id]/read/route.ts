// P7.1：`POST /api/notifications/:id/read`——標記本人已讀（唔喺本人 audience 一律 404）。
import { requireSession } from "@/lib/rbac/requirePermission";
import { ok, withApiError } from "@/lib/api/http";
import { brandSafeResponse } from "@/lib/api/serialize";
import { NotFound } from "@/lib/api/errors";
import { markNotificationRead } from "@/lib/notify/queries";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withApiError(async () => {
    const session = await requireSession(req);
    const { id } = await params;
    const r = await markNotificationRead(id, session.userId, session.baseRole);
    if (r === "notfound") throw NotFound("搵唔到呢條通知");
    return ok(brandSafeResponse({ id, read: true }));
  });
}
