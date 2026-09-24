// WP-ROSTER-UPLOAD Phase B-1（B1-2）：`GET /api/roster-uploads/pending-summary`
// ——「通知會計」嘅最簡單做法（任務書原話）：逐盤列「呢個月上載咗但未
// 對數完成」（status=parsed，仲有非 match 項未有決定）嘅數量，俾首頁
// 卡／對數頁頂部用。唔做 email。`?month=` 冇填就用今個月。
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/rbac/requirePermission";
import { ok, withApiError } from "@/lib/api/http";
import { brandSafeResponse } from "@/lib/api/serialize";
import { BadRequest } from "@/lib/api/errors";
import { monthStart } from "@/lib/month-lock";
import { reconcileUpload } from "@/lib/roster-upload/reconcile";

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])(-\d{2})?$/;

export async function GET(req: Request) {
  return withApiError(async () => {
    await requirePermission(req, "更表上載", "view");
    const url = new URL(req.url);
    const monthParam = url.searchParams.get("month");
    if (monthParam && !MONTH_RE.test(monthParam)) throw BadRequest("month 格式要係 YYYY-MM 或 YYYY-MM-DD");
    const month = monthStart(monthParam ? new Date(monthParam) : new Date());

    const uploads = await prisma.rosterUpload.findMany({
      where: { month, status: "parsed" },
      select: { id: true, siteId: true, siteNameRaw: true },
    });

    const entries: { site_id: string | null; site_name: string; upload_id: string; pending_count: number }[] = [];
    for (const u of uploads) {
      const { items } = await reconcileUpload(u.id);
      const pending = items.filter((i) => i.category !== "match").length;
      if (pending > 0) entries.push({ site_id: u.siteId, site_name: u.siteNameRaw, upload_id: u.id, pending_count: pending });
    }
    entries.sort((a, b) => b.pending_count - a.pending_count);

    return ok(brandSafeResponse({ month: month.toISOString().slice(0, 7), entries, total: entries.reduce((a, e) => a + e.pending_count, 0) }));
  });
}
