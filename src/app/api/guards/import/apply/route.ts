// WP-STAFF-IMPORT B3：`POST /api/guards/import/apply`——套用導入包。
//   { package, person_keys?, decisions? }
//  - 冇 decisions：自動套用（link／create 嘅人，只寫 status=confirmed 嘅欄）。
//  - 有 decisions（覆核頁）：只處理有決定嘅人；逐欄 confirm／replace／skip。
// 冪等；分批 transaction；每筆 writeAuditTx。導入包唔入 DB（要重新帶）。
import { requireImportPermission, parsePackage, applyBodySchema, mapDecisions } from "@/lib/guards/import/request";
import { hashPackage } from "@/lib/guards/import/package";
import { Conflict } from "@/lib/api/errors";
import { applyImport } from "@/lib/guards/import/apply";
import { readJson } from "@/lib/api/query";
import { parseBody } from "@/lib/api/validate";
import { createGuardImportTriage } from "@/lib/triage/session";
import { hasPermission } from "@/lib/rbac/requirePermission";
import { ok, getClientIp, safeErrorSummary, withApiError } from "@/lib/api/http";
import { brandSafeResponse } from "@/lib/api/serialize";

export async function POST(req: Request) {
  return withApiError(async () => {
    const session = await requireImportPermission(req, "apply");
    const body = parseBody(applyBodySchema, await readJson(req));
    const pkg = parsePackage(body.package);
    if (hashPackage(pkg) !== body.package_hash) throw Conflict("導入包同預覽唔一致，請重新預覽", { field: "package_hash" });
    const result = await applyImport(pkg, {
      actorUserId: session.userId,
      ip: getClientIp(req),
      personKeys: body.person_keys,
      decisions: mapDecisions(body.decisions),
    });
    // WP-AI-OPS §28.4：自動項（冇 decisions）完成後開分診 session；失敗唔影響導入結果。回 triage＝上載者自己嗰批。
    let triage: { session_id: string; open_questions: number; new_questions: number; total_questions: number } | null = null;
    if (!body.decisions && (await hasPermission(session, "導入分診", "view"))) {
      try {
        triage = await createGuardImportTriage({ pkg, packageHash: body.package_hash, actor: session, ip: getClientIp(req), personKeys: body.person_keys });
      } catch (e) {
        console.error("triage session create failed", safeErrorSummary(e));
      }
    }
    return ok(brandSafeResponse({ ...result, triage: triage ? { ...triage } : null }));
  });
}
