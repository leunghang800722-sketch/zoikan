// WP-STAFF-IMPORT B3：`POST /api/guards/import/preview`——上載導入包（JSON body `{package}`）
// → 統計（逐欄 confirmed／review／missing＋逐人 link／create／conflict／needs_review）＋逐人結果。
// 唯讀、導入包唔入 DB。回應入面 hkid／電話／地址一律遮罩。
import { requireImportPermission, parsePackage, assertPackageSize, maskPreviewForViewer } from "@/lib/guards/import/request";
import { previewImport } from "@/lib/guards/import/apply";
import { hasPermission } from "@/lib/rbac/requirePermission";
import { readJson } from "@/lib/api/query";
import { ok, withApiError } from "@/lib/api/http";
import { brandSafeResponse } from "@/lib/api/serialize";

export async function POST(req: Request) {
  return withApiError(async () => {
    const session = await requireImportPermission(req, "preview");
    const body = await readJson(req);
    const pkg = parsePackage((body as Record<string, unknown>).package);
    assertPackageSize(session, pkg);
    const pii = await hasPermission(session, "安員個人資料", "view");
    return ok(brandSafeResponse({ ...maskPreviewForViewer(await previewImport(pkg), pii) }));
  });
}
