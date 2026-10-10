// WP-GUARD-FIX-UI：U Team 名單上載——`POST /api/guard-fix/staff-list`
// （multipart xlsx，同 `/api/roster-uploads` 一致「即時存 bytes＋sha256
// →解析→存摘要」pattern，但唔另存逐行 PII——`buildGuardFixPlan()` 要用
// 嗰陣先由 bytes 重新解析）；`GET` 列現用（最新一份 status=parsed）＋
// 歷史。`保安員配對修復` module 老闆專用。
import crypto from "node:crypto";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/rbac/requirePermission";
import { brandSafeResponse } from "@/lib/api/serialize";
import { ok, getClientIp, withApiError } from "@/lib/api/http";
import { writeAudit } from "@/lib/audit";
import { BadRequest } from "@/lib/api/errors";
import { parseUTeamWorkbookBuffer } from "@/lib/guard-fix/sources";

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const OLE_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0]);

function toStaffListDTO(row: { id: string; uploadedAt: Date; fileName: string; fileSize: number; rowCount: number; status: string; parseSummary: unknown; uploaderId: string }) {
  return brandSafeResponse({
    id: row.id,
    uploadedAt: row.uploadedAt.toISOString(),
    fileName: row.fileName,
    fileSize: row.fileSize,
    rowCount: row.rowCount,
    status: row.status,
    parseSummary: row.parseSummary,
    uploaderId: row.uploaderId,
  });
}

export async function GET(req: Request) {
  return withApiError(async () => {
    await requirePermission(req, "安員配對修復", "view");
    const [current, history] = await Promise.all([
      prisma.staffListUpload.findFirst({ where: { status: "parsed" }, orderBy: { uploadedAt: "desc" } }),
      prisma.staffListUpload.findMany({ orderBy: { uploadedAt: "desc" }, take: 20 }),
    ]);
    return ok(
      brandSafeResponse({
        current: current ? toStaffListDTO(current) : null,
        history: history.map(toStaffListDTO),
      }),
    );
  });
}

export async function POST(req: Request) {
  return withApiError(async () => {
    const session = await requirePermission(req, "安員配對修復", "create");

    let formData: FormData;
    try {
      formData = await req.formData();
    } catch {
      throw BadRequest("要用 multipart/form-data 上載（file）");
    }
    const fileEntry = formData.get("file");
    if (!(fileEntry instanceof File)) throw BadRequest("要帶 file（U Team 名單 xlsx）");
    if (fileEntry.size > MAX_UPLOAD_BYTES) throw BadRequest(`檔案太大（上限 ${MAX_UPLOAD_BYTES / 1024 / 1024}MB）`);
    const arrayBuffer = await fileEntry.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    if (!buffer.length) throw BadRequest("檔案係空嘅");
    if (buffer.subarray(0, 4).equals(OLE_MAGIC)) throw BadRequest("呢個係舊版 .xls 檔，請用 Excel 另存做 .xlsx 先上載");
    if (!buffer.subarray(0, 4).equals(ZIP_MAGIC)) throw BadRequest("唔係 xlsx 檔案（請上載 Excel .xlsx 名單）");

    const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");

    let parseError: string | null = null;
    let rowCount = 0;
    let uNumberCount = 0;
    let hkidValidCount = 0;
    let hkidInvalidCount = 0;
    try {
      const rows = await parseUTeamWorkbookBuffer(buffer);
      rowCount = rows.length;
      uNumberCount = rows.filter((r) => r.uNumber).length;
      hkidValidCount = rows.filter((r) => r.hkid).length;
      hkidInvalidCount = rows.filter((r) => r.hkidNote === "invalid" || r.hkidNote === "mentions_other_number").length;
      if (rowCount === 0) parseError = "解析到 0 行（sheet1 係咪啱？）";
    } catch (e) {
      parseError = e instanceof Error ? e.message : String(e);
    }

    // 鐵則：唔存逐行 PII——`parseSummary` 淨係數目。
    const parseSummary = { row_count: rowCount, u_number_count: uNumberCount, hkid_valid_count: hkidValidCount, hkid_invalid_count: hkidInvalidCount, parse_error: parseError };

    const created = await prisma.staffListUpload.create({
      data: {
        uploaderId: session.userId,
        fileName: fileEntry.name || "u-team.xlsx",
        fileSha256: sha256,
        fileBytes: buffer,
        fileSize: buffer.length,
        rowCount,
        status: parseError ? "parse_failed" : "parsed",
        parseSummary,
      },
    });

    await writeAudit({
      actorUserId: session.userId,
      tableName: "staff_list_uploads",
      rowId: created.id,
      action: "create",
      after: { id: created.id, fileSize: created.fileSize, rowCount: created.rowCount, status: created.status, parseSummary },
      ip: getClientIp(req),
    });

    return ok(brandSafeResponse({ upload: toStaffListDTO(created), parseOk: !parseError, parseError }), 201);
  });
}
