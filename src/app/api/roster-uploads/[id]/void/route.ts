// WP-UPLOAD-VOID（老闆 2026-09-25 要求）：`POST /api/roster-uploads/:id/void`
// ——正式站揀錯月份上載咗 8 月更表，之前 UI 完全冇刪除／撤銷，錯誤記錄
// 會一路留喺清單／會計首頁「待處理」／月結鎖定前置檢查。人手作廢（唔
// hard delete，`voidRosterUpload()` 淨係轉 `status='voided'`，file_bytes／
// rows／reconcile_decisions 全部留底）。權限「更表上載」`void`（老闆／
// 主管／會計 G，雞頭／保安員硬性 deny）。
import { requirePermission } from "@/lib/rbac/requirePermission";
import { toRosterUploadDTO } from "@/lib/api/dto";
import { brandSafeResponse } from "@/lib/api/serialize";
import { ok, getClientIp, withApiError } from "@/lib/api/http";
import { readJson } from "@/lib/api/query";
import { parseBody } from "@/lib/api/validate";
import { RosterUploadVoidSchema } from "@/lib/api/schemas";
import { NotFound } from "@/lib/api/errors";
import { voidRosterUpload } from "@/lib/roster-upload/service";
import { prisma } from "@/lib/db";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withApiError(async () => {
    const session = await requirePermission(req, "更表上載", "void");
    const { id } = await params;
    const exists = await prisma.rosterUpload.findUnique({ where: { id }, select: { id: true } });
    if (!exists) throw NotFound();

    const body = await readJson(req);
    const { reason } = parseBody(RosterUploadVoidSchema, body);

    // 業務規則（confirmed→409／已作廢→409／該月已鎖→403）全部喺
    // `voidRosterUpload()` 入面做（同 `applyReconcileDecisions()` 一致嘅
    // 「transaction 之前檢查、transaction 入面攞 lock 之後覆核多一次」
    // 做法）。
    const result = await voidRosterUpload({ uploadId: id, reason, actorUserId: session.userId, ip: getClientIp(req) });

    return ok(
      brandSafeResponse({
        upload: toRosterUploadDTO(result.upload),
        revivedUploadId: result.revivedUploadId,
        revivedVersion: result.revivedVersion,
      }),
    );
  });
}
