// WP-ROSTER-UPLOAD Phase A（§15.3）：`GET /api/roster-uploads/:id`（rows
// 分頁＋summary，`?guard_match=unmatched` 篩未配對）、`PATCH
// /api/roster-uploads/:id`（人手指定 site_id——上載時盤名對唔到，之後
// 由會計/主管/老闆補；指定咗之後即刻重新對照一次，等更別/安員配對用返
// 啱嘅盤範圍）。
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/rbac/requirePermission";
import { toRosterUploadDTO, toRosterUploadRowDTO, mapListDTO } from "@/lib/api/dto";
import { applyFieldGroupGateToList, applyFieldGroupGate } from "@/lib/api/field-groups";
import { brandSafeResponse } from "@/lib/api/serialize";
import { ok, getClientIp, withApiError } from "@/lib/api/http";
import { paginationParams } from "@/lib/api/query";
import { readJson } from "@/lib/api/query";
import { parseBody } from "@/lib/api/validate";
import { RosterUploadPatchSchema } from "@/lib/api/schemas";
import { writeAudit } from "@/lib/audit";
import { NotFound, BadRequest } from "@/lib/api/errors";
import { assignRosterUploadSite, reparseRosterUpload } from "@/lib/roster-upload/service";
import type { Prisma } from "@prisma/client";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withApiError(async () => {
    const session = await requirePermission(req, "更表上載", "view");
    const { id } = await params;
    const upload = await prisma.rosterUpload.findUnique({ where: { id } });
    if (!upload) throw NotFound();

    const url = new URL(req.url);
    const { skip, take } = paginationParams(url);
    const guardMatchParam = url.searchParams.get("guard_match"); // ?guard_match=unmatched 篩未配對（UI 用）
    const ALLOWED_GUARD_MATCH = ["by_staff_no", "by_name_tel", "by_name", "unmatched", "ambiguous"] as const;
    type GuardMatchValue = (typeof ALLOWED_GUARD_MATCH)[number];
    if (guardMatchParam && !(ALLOWED_GUARD_MATCH as readonly string[]).includes(guardMatchParam)) {
      throw BadRequest(`guard_match 要係其中一個：${ALLOWED_GUARD_MATCH.join("/")}`);
    }
    const where: Prisma.RosterUploadRowWhereInput = {
      uploadId: id,
      ...(guardMatchParam ? { guardMatch: guardMatchParam as GuardMatchValue } : {}),
    };

    const [rows, total] = await Promise.all([
      prisma.rosterUploadRow.findMany({ where, skip, take, orderBy: [{ workDate: "asc" }, { rowIndex: "asc" }] }),
      prisma.rosterUploadRow.count({ where }),
    ]);

    const uploadDto = await applyFieldGroupGate(session, "roster_uploads", toRosterUploadDTO(upload));
    const rowsListDto = mapListDTO({ rows, total, skip, take }, toRosterUploadRowDTO);
    const rowsDto = await applyFieldGroupGateToList(session, "roster_upload_rows", rowsListDto);

    return ok(brandSafeResponse({ upload: uploadDto, rows: rowsDto }));
  });
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withApiError(async () => {
    const session = await requirePermission(req, "更表上載", "update");
    const { id } = await params;
    const before = await prisma.rosterUpload.findUnique({ where: { id } });
    if (!before) throw NotFound();

    const body = await readJson(req);
    const parsed = parseBody(RosterUploadPatchSchema, body);

    if (parsed.site_id) {
      const site = await prisma.site.findUnique({ where: { id: parsed.site_id }, select: { id: true } });
      if (!site) throw BadRequest("site_id 唔存在");
    }

    // 驗收 2026-09-23：改盤要同時處理版本序列（目標盤呢個月已經有 active
    // 上載嘅話，唔可以變兩個 active v1）——見 assignRosterUploadSite()。
    const { supersededIds } = await assignRosterUploadSite(id, parsed.site_id);
    // 重新對照一次（更別配對要跟返新盤嘅 shift_types 範圍）——`reparseRosterUpload`
    // 用返原檔 bytes，唔使用戶重新上載。壞檔（parse_failed）冇 rows 可以重配，
    // 但 site_id 本身已經update咗，`reparseRosterUpload` 一樣會行（照樣搵唔到 Date 表頭）。
    // autoResolveSite=false：人手清返 null 就係 null，唔好又用盤名自動配返。
    await reparseRosterUpload(id, { autoResolveSite: false });

    const after = await prisma.rosterUpload.findUniqueOrThrow({ where: { id } });
    await writeAudit({
      actorUserId: session.userId,
      tableName: "roster_uploads",
      rowId: id,
      action: "update",
      before,
      after: { ...after, superseded_upload_ids: supersededIds },
      ip: getClientIp(req),
    });

    return ok(toRosterUploadDTO(after));
  });
}
