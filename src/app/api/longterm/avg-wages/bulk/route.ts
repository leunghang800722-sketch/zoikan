// P15.2：`POST /api/longterm/avg-wages/bulk`——平均工資批量導入（≤500 行；老闆／會計＝長工糧:create）。
// `?dry_run=1` 只預覽。月份必須未鎖。回應唔含姓名。
import { requirePermission } from "@/lib/rbac/requirePermission";
import { ok, getClientIp, withApiError } from "@/lib/api/http";
import { brandSafeResponse } from "@/lib/api/serialize";
import { readJson } from "@/lib/api/query";
import { parseBody } from "@/lib/api/validate";
import { GuardAvgWageBulkSchema } from "@/lib/api/schemas";
import { bulkImportAvgWages, type BulkAvgWageRow } from "@/lib/longterm-payroll/bulk-avg-wages";
import { monthStart } from "@/lib/month-lock";

export async function POST(req: Request) {
  return withApiError(async () => {
    const session = await requirePermission(req, "長工糧", "create");
    const dryRun = new URL(req.url).searchParams.get("dry_run") === "1";
    const parsed = parseBody(GuardAvgWageBulkSchema, await readJson(req));
    const result = await bulkImportAvgWages({ month: monthStart(parsed.month), rows: parsed.rows as BulkAvgWageRow[], actorUserId: session.userId, ip: getClientIp(req), dryRun });
    return ok(brandSafeResponse({ ...result }), dryRun ? 200 : 201);
  });
}
