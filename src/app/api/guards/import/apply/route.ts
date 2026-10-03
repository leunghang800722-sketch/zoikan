// WP-STAFF-IMPORT B3：`POST /api/guards/import/apply`——套用導入包。
//   { package, person_keys?, decisions? }
//  - 冇 decisions：自動套用（link／create 嘅人，只寫 status=confirmed 嘅欄）。
//  - 有 decisions（覆核頁）：只處理有決定嘅人；逐欄 confirm／replace／skip。
// 冪等；分批 transaction；每筆 writeAuditTx。導入包唔入 DB（要重新帶）。
import { requireImportPermission, parsePackage, applyBodySchema, mapDecisions } from "@/lib/guards/import/request";
import { applyImport } from "@/lib/guards/import/apply";
import { readJson } from "@/lib/api/query";
import { parseBody } from "@/lib/api/validate";
import { ok, getClientIp, withApiError } from "@/lib/api/http";
import { brandSafeResponse } from "@/lib/api/serialize";

export async function POST(req: Request) {
  return withApiError(async () => {
    const session = await requireImportPermission(req, "apply");
    const body = parseBody(applyBodySchema, await readJson(req));
    const pkg = parsePackage(body.package);
    const result = await applyImport(pkg, {
      actorUserId: session.userId,
      ip: getClientIp(req),
      personKeys: body.person_keys,
      decisions: mapDecisions(body.decisions),
    });
    return ok(brandSafeResponse({ ...result }));
  });
}
