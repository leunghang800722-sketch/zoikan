// P3-1.6：`GET /api/month-close/one-click/:id`——單一 run 全份（steps／report），
// 同列表 `?include=full` 每個 run 一樣嘅 shape。月結頁 polling 同報告顯示用。
import { requirePermission } from "@/lib/rbac/requirePermission";
import { brandSafeResponse } from "@/lib/api/serialize";
import { ok, withApiError } from "@/lib/api/http";
import { NotFound } from "@/lib/api/errors";
import { findOneClickRunById, oneClickRunToDTO } from "@/lib/month-close/one-click-read";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withApiError(async () => {
    await requirePermission(req, "一鍵結算", "view");
    const { id } = await params;
    const run = await findOneClickRunById(id);
    if (!run) throw NotFound();
    return ok(brandSafeResponse({ run: oneClickRunToDTO(run) }));
  });
}
