// WP-ROSTER-UPLOAD Phase A（§15.3）：`POST /api/roster-uploads/:id/reparse`
// ——用返原檔 bytes 重新解析＋對照（唔使用戶重新上載），例如保安員名冊／
// 更別加咗新資料之後想重新配對一次。
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/rbac/requirePermission";
import { toRosterUploadDTO } from "@/lib/api/dto";
import { ok, getClientIp, withApiError } from "@/lib/api/http";
import { writeAudit } from "@/lib/audit";
import { NotFound, Conflict } from "@/lib/api/errors";
import { assertMonthNotLocked } from "@/lib/month-lock";
import { reparseRosterUpload } from "@/lib/roster-upload/service";
import { ROSTER_UPLOAD_META_SELECT } from "@/lib/roster-upload/meta-select";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withApiError(async () => {
    const session = await requirePermission(req, "更表上載", "update");
    const { id } = await params;
    const before = await prisma.rosterUpload.findUnique({ where: { id }, select: ROSTER_UPLOAD_META_SELECT });
    if (!before) throw NotFound();
    // WP-UPLOAD-VOID：已作廢嘅上載唔准重新解析——同 PATCH 一致嘅道理。
    if (before.status === "voided") throw Conflict("呢個上載已經作廢，唔可以重新解析");

    // Opus 驗收採納：人手重新解析會重寫配對（guard_id／match_basis）——已鎖月份 403（內部 reparse：
    // guard-fix／一鍵結算另有 confirmed 跳過邏輯，唔經呢條 route）。
    await assertMonthNotLocked({ workDate: before.month, actorUserId: session.userId, tableName: "roster_uploads", rowId: id, ip: getClientIp(req) });

    await reparseRosterUpload(id);

    const after = await prisma.rosterUpload.findUniqueOrThrow({ where: { id }, select: ROSTER_UPLOAD_META_SELECT });
    await writeAudit({ actorUserId: session.userId, tableName: "roster_uploads", rowId: id, action: "update", before, after, ip: getClientIp(req) });

    return ok(toRosterUploadDTO(after), 200);
  });
}
