// WP-AI-OPS §28.4：`POST /api/triage/sessions/:id/reassign`——老闆專屬，轉交俾另一位老闆／會計／主管（改擁有人）。
import { requirePermission } from "@/lib/rbac/requirePermission";
import { reassignSession } from "@/lib/triage/session";
import { reassignBodySchema } from "@/lib/triage/types";
import { getClientIp, ok, withApiError } from "@/lib/api/http";
import { readJson } from "@/lib/api/query";
import { parseBody } from "@/lib/api/validate";
import { brandSafeResponse } from "@/lib/api/serialize";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withApiError(async () => {
    const actor = await requirePermission(req, "導入分診", "update");
    const { id } = await params;
    const body = parseBody(reassignBodySchema, await readJson(req));
    const s = await reassignSession(actor, id, body.owner_user_id, getClientIp(req));
    return ok(brandSafeResponse({ id: s.id, owner_user_id: s.ownerUserId }));
  });
}
