// P8.2：`GET /api/triage/questions/batch-accept/preview?session_id=|month=`——可批量接受清單（唔寫任何嘢）。
import { requirePermission } from "@/lib/rbac/requirePermission";
import { listBatchAcceptable } from "@/lib/triage/batch-accept";
import { ok, withApiError } from "@/lib/api/http";
import { brandSafeResponse } from "@/lib/api/serialize";
import { BadRequest } from "@/lib/api/errors";

export async function GET(req: Request) {
  return withApiError(async () => {
    const actor = await requirePermission(req, "導入分診", "view");
    const url = new URL(req.url);
    const sessionId = url.searchParams.get("session_id") ?? undefined;
    const month = url.searchParams.get("month") ?? undefined;
    if (!sessionId && !month) throw BadRequest("請傳 session_id 或 month（YYYY-MM）");
    if (month && !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw BadRequest("month 要 YYYY-MM");
    const items = await listBatchAcceptable(actor, { sessionId, month });
    return ok(brandSafeResponse({ items, total: items.length }));
  });
}
