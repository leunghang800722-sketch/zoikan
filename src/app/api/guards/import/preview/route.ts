// WP-STAFF-IMPORT B3：`POST /api/guards/import/preview`——上載導入包（JSON body `{package}`）
// → 統計（逐欄 confirmed／review／missing＋逐人 link／create／conflict／needs_review）＋逐人結果。
// 唯讀、導入包唔入 DB。回應入面 hkid／電話／地址一律遮罩。
import { requireImportPermission, parsePackage, assertPackageSize, maskPreviewForViewer, previewBodySchema, mapDecisions } from "@/lib/guards/import/request";
import { previewImport } from "@/lib/guards/import/apply";
import { hasPermission } from "@/lib/rbac/requirePermission";
import { readJson } from "@/lib/api/query";
import { parseBody } from "@/lib/api/validate";
import { BadRequest } from "@/lib/api/errors";
import { assertImportQuota, auditImportPreview } from "@/lib/guards/import/limits";
import { ok, getClientIp, withApiError } from "@/lib/api/http";
import { brandSafeResponse } from "@/lib/api/serialize";

export async function POST(req: Request) {
  return withApiError(async () => {
    const session = await requireImportPermission(req, "preview");
    const body = parseBody(previewBodySchema, await readJson(req));
    const pkg = parsePackage(body.package);
    // decisions 淨係單人證件包 preview 用（令預覽 = 帶 decisions 嘅 apply）；批量包唔收
    if (body.decisions && pkg.source !== "single_ocr") throw BadRequest("decisions 淨係單人證件包可用");
    assertPackageSize(session, pkg);
    await assertImportQuota(session, undefined, pkg.source);
    const pii = await hasPermission(session, "安員個人資料", "view");
    const result = await previewImport(pkg, mapDecisions(body.decisions));
    await auditImportPreview(session, getClientIp(req), result.package_hash, result.package.persons, result.person_stats, pkg.source);
    const viewer = { pii_update: await hasPermission(session, "安員個人資料", "update"), guard_update: await hasPermission(session, "安員", "update") };
    return ok(brandSafeResponse({ ...maskPreviewForViewer(result, pii), viewer }));
  });
}
