// P14.2：`POST /api/longterm/inputs/bulk`——人手輸入批量導入（≤500 行）。權限同 POST /api/longterm/inputs（長工糧:create）；
// 月份必須未鎖；`?dry_run=1` 只預覽（行數／配到／配唔到／重複／重疊），唔寫入。回應唔含姓名。
import { requirePermission } from "@/lib/rbac/requirePermission";
import { ok, getClientIp, withApiError } from "@/lib/api/http";
import { brandSafeResponse } from "@/lib/api/serialize";
import { readJson } from "@/lib/api/query";
import { parseBody } from "@/lib/api/validate";
import { LongtermInputBulkSchema } from "@/lib/api/schemas";
import { bulkImportInputs, type BulkInputRow } from "@/lib/longterm-payroll/bulk-inputs";
import { monthStart } from "@/lib/month-lock";

export async function POST(req: Request) {
  return withApiError(async () => {
    const session = await requirePermission(req, "長工糧", "create");
    const dryRun = new URL(req.url).searchParams.get("dry_run") === "1";
    const parsed = parseBody(LongtermInputBulkSchema, await readJson(req));
    const result = await bulkImportInputs({ month: monthStart(parsed.month), rows: parsed.rows as BulkInputRow[], actorUserId: session.userId, ip: getClientIp(req), dryRun });
    return ok(brandSafeResponse(result), dryRun ? 200 : 201);
  });
}
