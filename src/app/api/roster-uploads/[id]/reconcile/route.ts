// WP-ROSTER-UPLOAD Phase B-1（B1-2）：`GET /api/roster-uploads/:id/reconcile`
// ——對數分類結果（分頁、`?category=` 篩單一分類）＋summary 各類數目。
// 「更表上載」module 嘅 `view`（同 `GET /api/roster-uploads/:id` 一致）
// ——雞頭／安員喺 rbac/matrix.ts 已經硬性 deny 呢個 module，唔使呢度再
// 加隔離邏輯（規則：對數 API 一律 403 俾雞頭/安員，對數係會計/主管/
// 老闆）。
import { requirePermission } from "@/lib/rbac/requirePermission";
import { ok, withApiError } from "@/lib/api/http";
import { brandSafeResponse } from "@/lib/api/serialize";
import { BadRequest, NotFound } from "@/lib/api/errors";
import { reconcileUpload, RECONCILE_CATEGORIES, type ReconcileCategory } from "@/lib/roster-upload/reconcile";
import { prisma } from "@/lib/db";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withApiError(async () => {
    await requirePermission(req, "更表上載", "view");
    const { id } = await params;
    const exists = await prisma.rosterUpload.findUnique({ where: { id }, select: { id: true } });
    if (!exists) throw NotFound();

    const url = new URL(req.url);
    const categoryParam = url.searchParams.get("category");
    if (categoryParam && !(RECONCILE_CATEGORIES as readonly string[]).includes(categoryParam)) {
      throw BadRequest(`category 要係其中一個：${RECONCILE_CATEGORIES.join("/")}`);
    }
    const skipRaw = Number(url.searchParams.get("skip"));
    const skip = Number.isFinite(skipRaw) ? Math.max(0, Math.floor(skipRaw)) : 0;
    const takeRaw = Number(url.searchParams.get("take"));
    const take = Number.isFinite(takeRaw) ? Math.max(1, Math.min(500, Math.floor(takeRaw))) : 200;

    const { items, summary, upload } = await reconcileUpload(id);
    const filtered = categoryParam ? items.filter((i) => i.category === (categoryParam as ReconcileCategory)) : items;
    const page = filtered.slice(skip, skip + take);

    return ok(
      brandSafeResponse({
        upload: { id: upload.id, month: upload.month, siteId: upload.siteId, status: upload.status, version: upload.version },
        summary,
        items: { rows: page, total: filtered.length, skip, take },
      }),
    );
  });
}
