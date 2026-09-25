// WP-GUARD-FIX 第二輪（老闆 2026-09-25 要求）：`POST /api/roster-uploads/
// :id/reconcile/resolve-subsite`——對數頁「批量指定子盤」／「全部歸母盤
// 確認」，淨係俾「三層推斷（見 src/lib/roster-upload/service.ts
// matchRowsAndSummarize() 大註解）都冧唔到、留 resolved_site_id=null」
// 嗰批行用。「更表上載」module 嘅 `update`（同 reparse／reconcile/apply
// 一致，呢個 action 本質上都係「處理呢個上載」，唔開新 module）。
import { requirePermission } from "@/lib/rbac/requirePermission";
import { ok, getClientIp, withApiError } from "@/lib/api/http";
import { brandSafeResponse } from "@/lib/api/serialize";
import { readJson } from "@/lib/api/query";
import { parseBody } from "@/lib/api/validate";
import { RosterReconcileResolveSubSiteSchema } from "@/lib/api/schemas";
import { Conflict, NotFound } from "@/lib/api/errors";
import { bulkResolveAmbiguousSubSite } from "@/lib/roster-upload/service";
import { prisma } from "@/lib/db";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withApiError(async () => {
    const session = await requirePermission(req, "更表上載", "update");
    const { id } = await params;
    const exists = await prisma.rosterUpload.findUnique({ where: { id }, select: { id: true, status: true } });
    if (!exists) throw NotFound();
    if (exists.status === "voided") throw Conflict("呢個上載已經作廢，唔可以對數");

    const body = await readJson(req);
    const parsed = parseBody(RosterReconcileResolveSubSiteSchema, body);

    const result = await bulkResolveAmbiguousSubSite({
      uploadId: id,
      rowIds: parsed.row_ids,
      siteId: parsed.site_id,
      actorUserId: session.userId,
      ip: getClientIp(req),
    });

    return ok(brandSafeResponse({ updated: result.updated, skipped: result.skipped }));
  });
}
