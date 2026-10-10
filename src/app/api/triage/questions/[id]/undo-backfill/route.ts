// WP-POSTORDER-FREE（§34 A）：`POST /api/triage/questions/:id/undo-backfill`——撤銷一條已確認嘅補齊價目卡題
// （作廢新建嘅正式卡、恢復被作廢嘅一鍵自動卡、還原補價；題目回到 open）。已鎖月份 409。
import { requirePermission } from "@/lib/rbac/requirePermission";
import { getQuestionFor } from "@/lib/triage/session";
import { undoBackfillAnswer } from "@/lib/month-close/auto/triage";
import { getClientIp, ok, withApiError } from "@/lib/api/http";
import { brandSafeResponse } from "@/lib/api/serialize";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withApiError(async () => {
    const actor = await requirePermission(req, "導入分診", "update");
    const { id } = await params;
    const q = await getQuestionFor(actor, id);
    const out = await undoBackfillAnswer(actor, q, getClientIp(req));
    return ok(brandSafeResponse({ ...out }));
  });
}
