// WP-AI-OPS §28.4：`POST /api/triage/questions/:id/preview`——{answer}→ 影響預覽（dry-run，一定 rollback，唔寫任何資料）
// ＋ preview_hash。確認時（answer 路由）會重算並核對，資料中途變咗就 409。
import { requirePermission } from "@/lib/rbac/requirePermission";
import { getQuestionFor } from "@/lib/triage/session";
import { previewAnswer } from "@/lib/triage/apply";
import { previewBodySchema } from "@/lib/triage/types";
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
    if (!previewBodySchema.safeParse(body).success) throw BadRequest("答案格式唔啱");
    const out = await previewAnswer(actor, q, body.answer, await viewerCaps(actor), getClientIp(req));
    return ok(brandSafeResponse({ preview_hash: out.preview_hash, writes: out.writes, impact: { ...out.impact } }));
  });
}
