// WP-AI-OPS §28.4：`POST /api/triage/questions/:id/answer`——{answer, preview_hash}→ 確認後經現有導入路徑寫入。
// 跳過（option=skip）唔使 preview_hash。失敗（409/422/400）唔改題目狀態、唔寫任何資料（同一 transaction rollback）。
import { requirePermission } from "@/lib/rbac/requirePermission";
import { getQuestionFor } from "@/lib/triage/session";
import { submitAnswer } from "@/lib/triage/apply";
import { submitMcAnswer } from "@/lib/month-close/auto/triage";
import { answerBodySchema } from "@/lib/triage/types";
import { viewerCaps } from "@/lib/triage/view";
import { getClientIp, ok, withApiError } from "@/lib/api/http";
import { readJson } from "@/lib/api/query";
import { brandSafeResponse } from "@/lib/api/serialize";
import { BadRequest } from "@/lib/api/errors";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withApiError(async () => {
    const actor = await requirePermission(req, "導入分診", "update");
    const { id } = await params;
    const q = await getQuestionFor(actor, id);
    const body = (await readJson(req)) as Record<string, unknown>;
    const parsed = answerBodySchema.safeParse({ ...body, preview_hash: body.preview_hash ?? "0".repeat(64) });
    if (!parsed.success) throw BadRequest("答案格式唔啱");
    if (q.session.sourceType === "month_close" || q.session.sourceType === "postorder_backfill") {
      const mc = await submitMcAnswer(actor, q, body.answer, typeof body.preview_hash === "string" ? body.preview_hash : undefined, getClientIp(req));
      return ok(brandSafeResponse({ status: mc.status, impact: mc.impact ? { ...mc.impact } : null, session_status: mc.session_status, open_remaining: mc.open_remaining, result: mc.result, note: mc.note }));
    }
    const out = await submitAnswer(actor, q, body.answer, typeof body.preview_hash === "string" ? body.preview_hash : undefined, await viewerCaps(actor), getClientIp(req));
    return ok(brandSafeResponse({ status: out.status, impact: out.impact ? { ...out.impact } : null, session_status: out.session_status, open_remaining: out.open_remaining }));
  });
}
