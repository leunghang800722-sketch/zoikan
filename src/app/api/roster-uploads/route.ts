// WP-ROSTER-UPLOAD Phase A（§15.3）：`GET /api/roster-uploads?month=`
// （逐盤狀態：未上載／已上載 vN／解析失敗）、`POST /api/roster-uploads`
// （multipart：file、month、site_id 可選——即時存 bytes＋sha256→解析→
// 存 rows→回 summary；同盤同月舊版自動 supersede）。`更表上載` module
// ——老闆／主管／會計 G，雞頭／安員硬性 deny（`requirePermission()` 第
// 一道閘已經擋晒，呢個 route 唔使額外雞頭隔離邏輯）。**唔寫入
// shift_records**（Phase A 範圍）。
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/rbac/requirePermission";
import { toRosterUploadDTO } from "@/lib/api/dto";
import { brandSafeResponse } from "@/lib/api/serialize";
import { ok, getClientIp, withApiError } from "@/lib/api/http";
import { parseBody } from "@/lib/api/validate";
import { RosterUploadFormFieldsSchema } from "@/lib/api/schemas";
import { monthStart } from "@/lib/month-lock";
import { writeAudit } from "@/lib/audit";
import { BadRequest } from "@/lib/api/errors";
import { processRosterUpload } from "@/lib/roster-upload/service";
import type { RosterUpload } from "@prisma/client";

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024; // 20MB——更表 xlsx 正常幾百 KB，呢個上限純粹防呆

export async function GET(req: Request) {
  return withApiError(async () => {
    await requirePermission(req, "更表上載", "view");
    const url = new URL(req.url);
    const monthParam = url.searchParams.get("month");
    if (!monthParam) throw BadRequest("要帶 month（YYYY-MM 或 YYYY-MM-DD）");
    const monthDate = new Date(monthParam);
    if (Number.isNaN(monthDate.getTime())) throw BadRequest("month 格式唔啱");
    const month = monthStart(monthDate);

    const [sites, uploads] = await Promise.all([
      prisma.site.findMany({ where: { status: { not: "ended" } }, select: { id: true, canonicalName: true }, orderBy: { canonicalName: "asc" } }),
      prisma.rosterUpload.findMany({ where: { month, status: { not: "superseded" } }, orderBy: { version: "desc" } }),
    ]);

    const bySite = new Map<string, RosterUpload>();
    const unresolved: RosterUpload[] = [];
    for (const u of uploads) {
      if (u.siteId) {
        if (!bySite.has(u.siteId)) bySite.set(u.siteId, u); // version desc 排咗先，第一個掃到即最新
      } else {
        unresolved.push(u);
      }
    }

    const siteEntries = sites.map((s) => {
      const u = bySite.get(s.id) ?? null;
      return brandSafeResponse({
        siteId: s.id,
        siteName: s.canonicalName,
        uploadStatus: u ? u.status : "not_uploaded",
        upload: u ? toRosterUploadDTO(u) : null,
      });
    });
    const unresolvedEntries = unresolved.map((u) =>
      brandSafeResponse({
        siteId: null,
        siteName: u.siteNameRaw,
        uploadStatus: u.status,
        upload: toRosterUploadDTO(u),
      }),
    );

    return ok(brandSafeResponse({ month: monthParam, sites: siteEntries, unresolvedUploads: unresolvedEntries }));
  });
}

export async function POST(req: Request) {
  return withApiError(async () => {
    const session = await requirePermission(req, "更表上載", "create");

    let formData: FormData;
    try {
      formData = await req.formData();
    } catch {
      throw BadRequest("要用 multipart/form-data 上載（file/month/site_id）");
    }
    const fileEntry = formData.get("file");
    if (!(fileEntry instanceof File)) throw BadRequest("要帶 file（xlsx）");
    const parsedFields = parseBody(RosterUploadFormFieldsSchema, {
      month: String(formData.get("month") ?? ""),
      site_id: formData.get("site_id") ? String(formData.get("site_id")) : undefined,
    });

    if (parsedFields.site_id) {
      const site = await prisma.site.findUnique({ where: { id: parsedFields.site_id }, select: { id: true } });
      if (!site) throw BadRequest("site_id 唔存在");
    }

    const arrayBuffer = await fileEntry.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    if (!buffer.length) throw BadRequest("檔案係空嘅");
    if (buffer.length > MAX_UPLOAD_BYTES) throw BadRequest(`檔案太大（上限 ${MAX_UPLOAD_BYTES / 1024 / 1024}MB）`);

    const result = await processRosterUpload({
      fileBuffer: buffer,
      fileName: fileEntry.name || "roster.xlsx",
      month: new Date(parsedFields.month),
      siteIdHint: parsedFields.site_id ?? null,
      uploaderUserId: session.userId,
    });

    await writeAudit({
      actorUserId: session.userId,
      tableName: "roster_uploads",
      rowId: result.upload.id,
      action: "create",
      after: { ...result.upload, superseded_upload_ids: result.supersededIds },
      ip: getClientIp(req),
    });

    return ok(
      brandSafeResponse({
        upload: toRosterUploadDTO(result.upload),
        supersededCount: result.supersededIds.length,
        parseOk: result.parseResult.ok,
        parseError: result.parseResult.ok ? null : result.parseResult.error,
      }),
      201,
    );
  });
}
