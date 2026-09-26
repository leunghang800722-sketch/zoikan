// WP-GUARD-FIX-UI：`GET /api/guard-fix/runs/:id`——單一 run 詳情（摘要
// 卡＋needs_boss 逐條，PII 受「安員個人資料:view」gate）。
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/rbac/requirePermission";
import { brandSafeResponse } from "@/lib/api/serialize";
import { ok, withApiError } from "@/lib/api/http";
import { NotFound } from "@/lib/api/errors";
import { buildNeedsBossView, applyAllowed } from "@/lib/guard-fix/view";
import type { GuardFixPlan } from "@/lib/guard-fix/types";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withApiError(async () => {
    const session = await requirePermission(req, "安員配對修復", "view");
    const { id } = await params;
    const run = await prisma.guardFixRun.findUnique({
      where: { id },
      include: {
        staffListUpload: { select: { fileName: true, uploadedAt: true, rowCount: true } },
        postorderUpload: { select: { fileName: true, uploadedAt: true } },
      },
    });
    if (!run) throw NotFound();

    const plan = run.planJson as unknown as GuardFixPlan;
    const needsBoss = await buildNeedsBossView(prisma, session, plan);

    return ok(
      brandSafeResponse({
        id: run.id,
        month: run.month.toISOString().slice(0, 10),
        status: run.status,
        createdAt: run.createdAt.toISOString(),
        appliedAt: run.appliedAt?.toISOString() ?? null,
        applyStartedAt: run.applyStartedAt?.toISOString() ?? null,
        // Opus 5.5 驗收：頁面「套用／重新套用」掣用（planned、failed、卡死
        // 超過 15 分鐘嘅 applying）。
        applyAllowed: applyAllowed(run),
        summary: run.summaryJson,
        result: run.resultJson,
        staffListUpload: { fileName: run.staffListUpload.fileName, uploadedAt: run.staffListUpload.uploadedAt.toISOString(), rowCount: run.staffListUpload.rowCount },
        postorderUpload: run.postorderUpload ? { fileName: run.postorderUpload.fileName, uploadedAt: run.postorderUpload.uploadedAt.toISOString() } : null,
        needsBoss,
      }),
    );
  });
}
