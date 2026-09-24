// WP-ROSTER-UPLOAD Phase B-1（B1-2）：`POST /api/roster-uploads/:id/reconcile/apply`
// ——逐項套用對數決定（apply_roster／keep_system／exception），全部喺
// 一個 transaction 入面（`applyReconcileDecisions()`，見
// src/lib/roster-upload/reconcile-apply.ts）。「更表上載」module 嘅
// `update`（同 `PATCH /api/roster-uploads/:id` 一致——呢個 action 本質
// 上都係「處理呢個上載」，唔開新 module）。
import { requirePermission } from "@/lib/rbac/requirePermission";
import { ok, getClientIp, withApiError } from "@/lib/api/http";
import { brandSafeResponse } from "@/lib/api/serialize";
import { readJson } from "@/lib/api/query";
import { parseBody } from "@/lib/api/validate";
import { RosterReconcileApplySchema } from "@/lib/api/schemas";
import { NotFound } from "@/lib/api/errors";
import { applyReconcileDecisions } from "@/lib/roster-upload/reconcile-apply";
import { prisma } from "@/lib/db";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withApiError(async () => {
    const session = await requirePermission(req, "更表上載", "update");
    const { id } = await params;
    const exists = await prisma.rosterUpload.findUnique({ where: { id }, select: { id: true } });
    if (!exists) throw NotFound();

    const body = await readJson(req);
    const parsed = parseBody(RosterReconcileApplySchema, body);

    const result = await applyReconcileDecisions({
      uploadId: id,
      actions: parsed.actions,
      actorUserId: session.userId,
      ip: getClientIp(req),
    });

    return ok(brandSafeResponse({ results: result.results, uploadStatus: result.uploadStatus, pendingCount: result.pendingCount }));
  });
}
