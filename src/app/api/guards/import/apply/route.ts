// WP-STAFF-IMPORT B3：`POST /api/guards/import/apply`——套用導入包。
//   { package, person_keys?, decisions? }
//  - 冇 decisions：自動套用（link／create 嘅人，只寫 status=confirmed 嘅欄）。
//  - 有 decisions（覆核頁）：只處理有決定嘅人；逐欄 confirm／replace／skip。
// 冪等；分批 transaction；每筆 writeAuditTx。導入包唔入 DB（要重新帶）。
import { requireImportPermission, parsePackage, applyBodySchema, mapDecisions, assertPackageSize, maskApplyForViewer, assertDecisionTargets, assertSafeDecisionKeys, resolveDecisionKeys, assertBankPermissionForPackage, redactRowKeys } from "@/lib/guards/import/request";
import { hashPackage } from "@/lib/guards/import/package";
import { Conflict, Forbidden } from "@/lib/api/errors";
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
    const rawBody = await readJson(req);
    assertSafeDecisionKeys(rawBody);
    const body = parseBody(applyBodySchema, rawBody);
    const pkg = parsePackage(body.package);
    const decisions = resolveDecisionKeys(pkg, body.decisions);
    assertPackageSize(session, pkg);
    assertDecisionTargets(pkg, decisions);
    await assertBankPermissionForPackage(session, pkg);
    const pii = await hasPermission(session, "安員個人資料", "view");
    if (hashPackage(pkg) !== body.package_hash) throw Conflict("導入包同預覽唔一致，請重新預覽", { field: "package_hash" });
    // decisions.ext（繞過自動寫入閘）要「安員個人資料:view」＋「安員:update」
    const hasExtDecision = !!decisions && Object.values(decisions).some((d) => d.ext && Object.values(d.ext).some((a) => a !== "skip"));
    if (hasExtDecision && !(pii && (await hasPermission(session, "安員", "update")))) throw Forbidden("呢類決定要有安員個人資料查看＋安員修改權限嘅同事做");
    const canOverwritePii = await hasPermission(session, "安員個人資料", "update");
    const canEditGuard = await hasPermission(session, "安員", "update");
    const bankView = await hasPermission(session, "安員銀行資料", "view");
    const canEditBank = await hasPermission(session, "安員銀行資料", "update");
    // 預留配額（短 transaction；鎖外先套用）。single_ocr 單人包：獨立配額，apply（含 decisions）一律計；
    // 其他包照舊（有 decisions 嘅覆核唔計）。失敗唔退還次數。
    if (pkg.source === "single_ocr") await reserveQuota(session, "single_ocr");
    // 帶 decisions.ext 嘅請求同樣計配額（否則可以無限試 decisions 探測現值）
    else if (!decisions || Object.values(decisions).some((d) => d.ext)) await reserveQuota(session, "batch");
    const result = await applyImport(pkg, {
      actorUserId: session.userId,
      ip: getClientIp(req),
      personKeys: body.person_keys,
      decisions: mapDecisions(decisions),
      canOverwritePii,
      canEditGuard,
      canEditBank,
      fillOnlyPii: !pii,
      ...(pkg.source === "single_ocr" ? { via: "single_ocr" as const } : {}),
    });
    // WP-AI-OPS §28.4：自動項（冇 decisions）完成後開分診 session；失敗唔影響導入結果。回 triage＝上載者自己嗰批。
    let triage: Awaited<ReturnType<typeof createGuardImportTriage>> = null;
    // 單人證件包（single_ocr）apply 本身就帶 decisions（用戶已逐欄確認）：決定咗嘅欄當已解決，剩低嘅（同名候選、衝突…）照樣出題
    const triageEligible = !decisions || pkg.source === "single_ocr";
    if (triageEligible) {
      // 記錄＋作廢舊題一律做（唔受「導入分診:view」影響）；冇權限者唔開新題
      const canTriage = await hasPermission(session, "導入分診", "view");
      try {
        triage = await createGuardImportTriage({ pkg: pkg.source === "single_ocr" && decisions ? resolveDecidedFields(pkg, decisions) : pkg, packageHash: body.package_hash, actor: session, ip: getClientIp(req), personKeys: body.person_keys, results: result.results, openQuestions: canTriage });
      } catch (e) {
        console.error("triage session create failed", safeErrorSummary(e));
      }
    }
    const masked = maskApplyForViewer(result, { pii, bank: bankView });
    return ok(brandSafeResponse({ ...masked, results: redactRowKeys(pkg, masked.results), triage: triage ? { ...triage } : null }));
  });
}
