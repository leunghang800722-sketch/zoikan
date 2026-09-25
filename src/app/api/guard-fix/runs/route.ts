// WP-GUARD-FIX-UI：`GET /api/guard-fix/runs`——歷史 runs 列表（頁面
// 「歷史 runs 列表」用），淨係 `summary_json`／`result_json`（冇 PII），
// 唔帶 `plan_json`。
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/rbac/requirePermission";
import { brandSafeResponse } from "@/lib/api/serialize";
import { ok, withApiError } from "@/lib/api/http";

export async function GET(req: Request) {
  return withApiError(async () => {
    await requirePermission(req, "安員配對修復", "view");
    const runs = await prisma.guardFixRun.findMany({
      orderBy: { createdAt: "desc" },
      take: 50,
      select: { id: true, month: true, status: true, createdAt: true, appliedAt: true, summaryJson: true, resultJson: true, staffListUpload: { select: { fileName: true, uploadedAt: true } } },
    });
    return ok(
      brandSafeResponse({
        runs: runs.map((r) =>
          brandSafeResponse({
            id: r.id,
            month: r.month.toISOString().slice(0, 10),
            status: r.status,
            createdAt: r.createdAt.toISOString(),
            appliedAt: r.appliedAt?.toISOString() ?? null,
            summary: r.summaryJson,
            result: r.resultJson,
            staffListFileName: r.staffListUpload.fileName,
          }),
        ),
      }),
    );
  });
}
