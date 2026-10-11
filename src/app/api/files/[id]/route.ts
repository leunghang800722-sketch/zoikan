// P8.3：`GET /api/files/:id`——下載鎖月後自動生成嘅檔（Content-Disposition）。
// 權限＝原匯出 route 嘅 module `export`（糧明細／月結總表／長工糧）；冇權 403（含雞頭）。
// BOCHK autopay 檔沿用原 route 嘅「已鎖月份要 confirm_locked=1」防重複出糧閘；每次下載寫 export_download audit。
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireSession, requirePermission, hasPermission } from "@/lib/rbac/requirePermission";
import { withApiError, getClientIp } from "@/lib/api/http";
import { BadRequest, Forbidden, NotFound } from "@/lib/api/errors";
import { writeAudit } from "@/lib/audit";
import { FILE_KINDS, FILE_KIND_META, XLSX_MIME, type FileKind } from "@/lib/files/generated";

const AUTOPAY_CONFIRM_MSG = "呢份係 BOCHK autopay 檔，入銀行前請先人手覆核，確認未出過糧（下載要加 confirm_locked=1）";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withApiError(async () => {
    const session = await requireSession(req);
    const { id } = await params;
    const file = await prisma.generatedFile.findUnique({ where: { id } });
    if (!file) {
      // 冇任何 export 權限嘅人（雞頭）一律 403，唔洩露 id 存唔存在
      let any = false;
      for (const k of FILE_KINDS) any ||= await hasPermission(session, FILE_KIND_META[k].module, "export");
      if (!any) throw Forbidden("冇權下載已生成檔案");
      throw NotFound("搵唔到檔案");
    }
    const meta = FILE_KIND_META[file.kind as FileKind];
    if (!meta) throw NotFound("搵唔到檔案");
    await requirePermission(req, meta.module, "export");
    const ip = getClientIp(req);
    const month = file.month.toISOString().slice(0, 7);
    if (file.kind === "longterm_autopay" && new URL(req.url).searchParams.get("confirm_locked") !== "1") {
      await writeAudit({ actorUserId: session.userId, tableName: "generated_files", rowId: file.id, action: "export_download_blocked", after: { month, kind: file.kind, reason: "locked_month_not_confirmed" }, ip });
      throw BadRequest(AUTOPAY_CONFIRM_MSG);
    }
    await writeAudit({ actorUserId: session.userId, tableName: "generated_files", rowId: file.id, action: "export_download", after: { month, kind: file.kind, size: file.size, current: file.current }, ip });
    return new NextResponse(new Uint8Array(file.content), {
      status: 200,
      headers: {
        "content-type": XLSX_MIME,
        "content-disposition": `attachment; filename="${file.filename}"; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
        "x-file-sha256": file.sha256,
      },
    });
  });
}
