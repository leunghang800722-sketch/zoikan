// WP-AI-OPS §28.4：`GET /api/triage/sessions/:id[?status=open]`——session＋逐題（證據按「安員個人資料」欄位權限遮罩）。
// 非老闆攞人哋嘅 session id → 403。
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/rbac/requirePermission";
import { getSessionFor, isSupplementary } from "@/lib/triage/session";
import { questionViews, viewerCaps } from "@/lib/triage/view";
import { ok, withApiError } from "@/lib/api/http";
import { brandSafeResponse } from "@/lib/api/serialize";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withApiError(async () => {
    const actor = await requirePermission(req, "導入分診", "view");
    const { id } = await params;
    const session = await getSessionFor(actor, id);
    const onlyOpen = new URL(req.url).searchParams.get("status") === "open";
    const rows = await prisma.triageQuestion.findMany({ where: { sessionId: session.id, ...(onlyOpen ? { status: "open" } : {}) }, orderBy: [{ sort: "asc" }, { id: "asc" }] });
    const counts = await prisma.triageQuestion.groupBy({ by: ["status", "kind"], where: { sessionId: session.id }, _count: { _all: true } });
    const c = { open: 0, answered: 0, skipped: 0, total: 0, important_open: 0, supplementary_open: 0 };
    for (const g of counts) {
      if (g.status === "open" || g.status === "answered" || g.status === "skipped") c[g.status] += g._count._all;
      if (g.status === "open") c[isSupplementary(g.kind) ? "supplementary_open" : "important_open"] += g._count._all;
      c.total += g._count._all;
    }
    const questions = await questionViews(rows, await viewerCaps(actor));
    return ok(
      brandSafeResponse({
        session: { id: session.id, source_type: session.sourceType, owner_user_id: session.ownerUserId, status: session.status, created_at: session.createdAt, completed_at: session.completedAt, counts: c },
        questions: questions.map((q) => ({ ...q })),
      }),
    );
  });
}
