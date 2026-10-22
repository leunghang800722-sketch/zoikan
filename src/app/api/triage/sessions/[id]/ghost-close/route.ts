// TE-13.2：`POST /api/triage/sessions/:id/ghost-close[?dry_run=0]`——收埋 session 內 ghost（空記錄）嘅舊「同一工號出現喺多個人」題。
// **預設 dry run**（唔寫 DB，淨係列出會收嘅題 id）；要明確 `dry_run=0` 先真收，每條被收嘅題逐條 audit（triage_ghost_close）。
// 權限同 proposals 一樣（導入分診:update＋老闆／session 擁有人）。
import { requirePermission } from "@/lib/rbac/requirePermission";
import { getSessionFor } from "@/lib/triage/session";
import { closeGhostStaffnoQuestions } from "@/lib/triage/ghost-close";
import { BadRequest } from "@/lib/api/errors";
import { getClientIp, ok, withApiError } from "@/lib/api/http";
import { brandSafeResponse } from "@/lib/api/serialize";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withApiError(async () => {
    const actor = await requirePermission(req, "導入分診", "update");
    const { id } = await params;
    const session = await getSessionFor(actor, id);
    if (session.sourceType !== "guard_import") throw BadRequest("淨係保安員證件資料導入嘅分診先可以收 ghost 題");
    const dryRun = new URL(req.url).searchParams.get("dry_run") !== "0";
    const out = await closeGhostStaffnoQuestions(session.id, { dryRun, actorUserId: actor.userId, ip: getClientIp(req) });
    return ok(brandSafeResponse({ ...out, count: out.question_ids.length }));
  });
}
