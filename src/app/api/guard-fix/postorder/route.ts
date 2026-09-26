// WP-LTSHIFT §19（老闆 2026-09-26 第二部分）：Postorder 總表上載——
// `POST /api/guard-fix/postorder`（multipart .xlsm/.xlsx，同 `/api/
// guard-fix/staff-list` 一致「即時存 bytes＋sha256→解析→存摘要」
// pattern，唔另存逐行 PII——`buildGuardFixPlan()` 要用嗰陣先由 bytes
// 重新解析）；`GET` 列現用（呢個月 status=parsed 最新一份）＋歷史。
// `安員配對修復` module 老闆專用（同 staff-list 一致 gate）。
import crypto from "node:crypto";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/rbac/requirePermission";
import { brandSafeResponse } from "@/lib/api/serialize";
import { ok, getClientIp, withApiError } from "@/lib/api/http";
import { writeAudit } from "@/lib/audit";
import { BadRequest } from "@/lib/api/errors";
import { monthStart } from "@/lib/month-lock";
import type { Prisma } from "@prisma/client";
import { parsePostorderWorkbookBuffer, summarizePostorderParse } from "@/lib/guard-fix/postorder";

const MAX_UPLOAD_BYTES = 30 * 1024 * 1024; // Postorder 總表帶 rich text／樣式，比 U Team 名單大好多
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const OLE_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0]);

function toPostorderDTO(row: { id: string; month: Date; uploadedAt: Date; fileName: string; fileSize: number; rowCount: number; status: string; parseSummary: unknown; uploaderId: string }) {
  return brandSafeResponse({
    id: row.id,
    month: row.month.toISOString().slice(0, 10),
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
    const url = new URL(req.url);
    const monthParam = url.searchParams.get("month");
    const month = monthParam ? monthStart(new Date(monthParam)) : null;
    const [current, history] = await Promise.all([
      prisma.postorderUpload.findFirst({ where: { status: "parsed", ...(month ? { month } : {}) }, orderBy: { uploadedAt: "desc" } }),
      prisma.postorderUpload.findMany({ where: month ? { month } : undefined, orderBy: { uploadedAt: "desc" }, take: 20 }),
    ]);
    return ok(
      brandSafeResponse({
        current: current ? toPostorderDTO(current) : null,
        history: history.map(toPostorderDTO),
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
      throw BadRequest("要用 multipart/form-data 上載（file + month）");
    }
    const fileEntry = formData.get("file");
    if (!(fileEntry instanceof File)) throw BadRequest("要帶 file（Postorder 總表 .xlsm/.xlsx）");
    const monthRaw = formData.get("month");
    if (typeof monthRaw !== "string" || !monthRaw) throw BadRequest("要帶 month（YYYY-MM-DD 或 YYYY-MM，呢份 Postorder 對應邊個月）");
    const month = monthStart(new Date(monthRaw));
    if (Number.isNaN(month.getTime())) throw BadRequest("month 格式錯");

    if (fileEntry.size > MAX_UPLOAD_BYTES) throw BadRequest(`檔案太大（上限 ${MAX_UPLOAD_BYTES / 1024 / 1024}MB）`);
    const arrayBuffer = await fileEntry.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    if (!buffer.length) throw BadRequest("檔案係空嘅");
    if (buffer.subarray(0, 4).equals(OLE_MAGIC)) throw BadRequest("呢個係舊版 .xls 檔，請用 Excel 另存做 .xlsx/.xlsm 先上載");
    if (!buffer.subarray(0, 4).equals(ZIP_MAGIC)) throw BadRequest("唔係 xlsx/xlsm 檔案（請上載 Postorder 總表）");

    const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");

    let parseError: string | null = null;
    let rowCount = 0;
    let parseSummary: Prisma.InputJsonValue = {};
    try {
      const result = await parsePostorderWorkbookBuffer(buffer);
      if (result.missingSheets.length > 0) {
        parseError = `搵唔到 sheet：${result.missingSheets.join("、")}（要有 Roster／PostOrder 兩個 sheet）`;
      }
      rowCount = result.longtermPosts.length + result.referralRows.length;
      // 鐵則：唔存逐行 PII——`parseSummary` 淨係數目。
      parseSummary = { ...summarizePostorderParse(result), parse_error: parseError };
    } catch (e) {
      parseError = e instanceof Error ? e.message : String(e);
      parseSummary = { parse_error: parseError };
    }

    const created = await prisma.postorderUpload.create({
      data: {
        month,
        uploaderId: session.userId,
        fileName: fileEntry.name || "postorder.xlsm",
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
      tableName: "postorder_uploads",
      rowId: created.id,
      action: "create",
      after: { id: created.id, month: created.month.toISOString().slice(0, 10), fileSize: created.fileSize, rowCount: created.rowCount, status: created.status, parseSummary },
      ip: getClientIp(req),
    });

    return ok(brandSafeResponse({ upload: toPostorderDTO(created), parseOk: !parseError, parseError }), 201);
  });
}
