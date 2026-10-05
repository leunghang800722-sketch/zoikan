// WP-STAFF-IMPORT B3：`POST /api/guards/import/apply`——套用導入包。
//   { package, person_keys?, decisions? }
//  - 冇 decisions：自動套用（link／create 嘅人，只寫 status=confirmed 嘅欄）。
//  - 有 decisions（覆核頁）：只處理有決定嘅人；逐欄 confirm／replace／skip。
// 冪等；分批 transaction；每筆 writeAuditTx。導入包唔入 DB（要重新帶）。
import { requireImportPermission, parsePackage, applyBodySchema, mapDecisions, assertPackageSize, maskApplyForViewer, assertDecisionTargets, assertBankPermissionForPackage } from "@/lib/guards/import/request";
import { hashPackage } from "@/lib/guards/import/package";
import { Conflict } from "@/lib/api/errors";
import { applyImport } from "@/lib/guards/import/apply";
import { readJson } from "@/lib/api/query";
import { parseBody } from "@/lib/api/validate";
import { createGuardImportTriage } from "@/lib/triage/session";
import { hasPermission } from "@/lib/rbac/requirePermission";
import { resolveDecidedFields } from "@/lib/guards/import/single-ocr";
import { reserveQuota } from "@/lib/guards/import/limits";
import { ok, getClientIp, safeErrorSummary, withApiError } from "@/lib/api/http";
import { brandSafeResponse } from "@/lib/api/serialize";

export async function POST(req: Request) {
  return withApiError(async () => {
    const session = await requireImportPermission(req, "apply");
    const body = parseBody(applyBodySchema, await readJson(req));
    const pkg = parsePackage(body.package);
    assertPackageSize(session, pkg);
    assertDecisionTargets(pkg, body.decisions);
    await assertBankPermissionForPackage(session, pkg);
    const pii = await hasPermission(session, "安員個人資料", "view");
    if (hashPackage(pkg) !== body.package_hash) throw Conflict("導入包同預覽唔一致，請重新預覽", { field: "package_hash" });
    const canOverwritePii = await hasPermission(session, "安員個人資料", "update");
    const canEditGuard = await hasPermission(session, "安員", "update");
    const bankView = await hasPermission(session, "安員銀行資料", "view");
    const canEditBank = await hasPermission(session, "安員銀行資料", "update");
    // 預留配額（短 transaction；鎖外先套用）。single_ocr 單人包：獨立配額，apply（含 decisions）一律計；
    // 其他包照舊（有 decisions 嘅覆核唔計）。失敗唔退還次數。
    if (pkg.source === "single_ocr") await reserveQuota(session, "single_ocr");
    else if (!body.decisions) await reserveQuota(session, "batch");
    const result = await applyImport(pkg, {
      actorUserId: session.userId,
      ip: getClientIp(req),
      personKeys: body.person_keys,
      decisions: mapDecisions(body.decisions),
      canOverwritePii,
      canEditGuard,
      canEditBank,
      fillOnlyPii: !pii,
      ...(pkg.source === "single_ocr" ? { via: "single_ocr" as const } : {}),
    });
    // WP-AI-OPS §28.4：自動項（冇 decisions）完成後開分診 session；失敗唔影響導入結果。回 triage＝上載者自己嗰批。
    let triage: Awaited<ReturnType<typeof createGuardImportTriage>> = null;
    // 單人證件包（single_ocr）apply 本身就帶 decisions（用戶已逐欄確認）：決定咗嘅欄當已解決，剩低嘅（同名候選、衝突…）照樣出題
    const triageEligible = !body.decisions || pkg.source === "single_ocr";
    if (triageEligible && (await hasPermission(session, "導入分診", "view"))) {
      try {
        triage = await createGuardImportTriage({ pkg: pkg.source === "single_ocr" && body.decisions ? resolveDecidedFields(pkg, body.decisions) : pkg, packageHash: body.package_hash, actor: session, ip: getClientIp(req), personKeys: body.person_keys });
      } catch (e) {
        console.error("triage session create failed", safeErrorSummary(e));
      }
    }
    return ok(brandSafeResponse({ ...maskApplyForViewer(result, { pii, bank: bankView }), triage: triage ? { ...triage } : null }));
  });
}
