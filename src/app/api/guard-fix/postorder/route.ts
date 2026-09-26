// WP-LTSHIFT §19（老闆 2026-09-26 第二部分）：Postorder 總表上載——
// `POST /api/guard-fix/postorder`（multipart .xlsm/.xlsx，同 `/api/
// guard-fix/staff-list` 一致「即時存 bytes＋sha256→解析→存摘要」
// pattern，唔另存逐行 PII——`buildGuardFixPlan()` 要用嗰陣先由 bytes
// 重新解析）；`GET` 列現用（呢個月 status=parsed 最新一份）＋歷史。
// `安員配對修復` module 老闆專用（同 staff-list 一致 gate）。
//
// WP-POSTORDER-CSV（老闆 2026-09-26 緊急）：正式站操作員（老闆帳號）用
// 嘅工具處理唔到 binary（.xlsm／.xlsx），淨係可以喺 Google Drive 網頁用
// Google Sheets 打開再逐個 sheet「下載為 CSV」。所以呢個 route 加多一條
// 路徑：multipart 帶 `roster_csv`＋`postorder_csv` 兩個 CSV 檔（唔帶
// `file`）就行 CSV 路徑——解析結果（`parseSummary` 形狀）同 xlsm 路徑
// 一樣，見 `src/lib/guard-fix/postorder.ts` 檔頭註解。`fileBytes`／
// `fileName`／`fileSha256`／`fileSize` 呢幾欄 CSV 路徑照樣要填（NOT
// NULL），存嘅係兩個 CSV 併埋一齊嘅 bytes——純粹佔位／sha256 audit
// 用途，真正解析用 `rosterCsvBytes`／`postorderCsvBytes`（見
// `parsePostorderUploadRow()`）。
import crypto from "node:crypto";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/rbac/requirePermission";
import { brandSafeResponse } from "@/lib/api/serialize";
import { ok, getClientIp, withApiError } from "@/lib/api/http";
import { writeAudit } from "@/lib/audit";
import { BadRequest } from "@/lib/api/errors";
import { monthStart } from "@/lib/month-lock";
import type { Prisma } from "@prisma/client";
import { parsePostorderWorkbookBuffer, parsePostorderFromCsv, summarizePostorderParse, type PostorderParseResult } from "@/lib/guard-fix/postorder";

const MAX_UPLOAD_BYTES = 30 * 1024 * 1024; // Postorder 總表帶 rich text／樣式，比 U Team 名單大好多
const MAX_CSV_BYTES = 30 * 1024 * 1024; // 每個 CSV 檔上限（同 xlsm 一致，見§19 指示）
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

/** 兩條上載路徑共用嘅「解析→組 parseSummary／parseError」邏輯。 */
function summarizeParseOutcome(runParse: () => Promise<PostorderParseResult>) {
  return runParse().then(
    (result) => {
      let parseError: string | null = null;
      if (result.missingSheets.length > 0) {
        parseError = `搵唔到 sheet：${result.missingSheets.join("、")}（要有 Roster／PostOrder 兩個 sheet）`;
      }
      const rowCount = result.longtermPosts.length + result.referralRows.length;
      // 鐵則：唔存逐行 PII——`parseSummary` 淨係數目。
      const parseSummary: Prisma.InputJsonValue = { ...summarizePostorderParse(result), parse_error: parseError };
      return { parseError, rowCount, parseSummary };
    },
    (e: unknown) => {
      const parseError = e instanceof Error ? e.message : String(e);
      return { parseError, rowCount: 0, parseSummary: { parse_error: parseError } as Prisma.InputJsonValue };
    },
  );
}

export async function POST(req: Request) {
  return withApiError(async () => {
    const session = await requirePermission(req, "安員配對修復", "create");

    let formData: FormData;
    try {
      formData = await req.formData();
    } catch {
      throw BadRequest("要用 multipart/form-data 上載（file + month，或者 roster_csv + postorder_csv + month）");
    }
    const monthRaw = formData.get("month");
    if (typeof monthRaw !== "string" || !monthRaw) throw BadRequest("要帶 month（YYYY-MM-DD 或 YYYY-MM，呢份 Postorder 對應邊個月）");
    const month = monthStart(new Date(monthRaw));
    if (Number.isNaN(month.getTime())) throw BadRequest("month 格式錯");

    const fileEntry = formData.get("file");
    const rosterCsvEntry = formData.get("roster_csv");
    const postorderCsvEntry = formData.get("postorder_csv");

    let created: Awaited<ReturnType<typeof prisma.postorderUpload.create>>;
    let parseError: string | null;

    if (fileEntry instanceof File) {
      // --- xlsm/xlsx 路徑（原有）---
      if (fileEntry.size > MAX_UPLOAD_BYTES) throw BadRequest(`檔案太大（上限 ${MAX_UPLOAD_BYTES / 1024 / 1024}MB）`);
      const buffer = Buffer.from(await fileEntry.arrayBuffer());
      if (!buffer.length) throw BadRequest("檔案係空嘅");
      if (buffer.subarray(0, 4).equals(OLE_MAGIC)) throw BadRequest("呢個係舊版 .xls 檔，請用 Excel 另存做 .xlsx/.xlsm 先上載");
      if (!buffer.subarray(0, 4).equals(ZIP_MAGIC)) throw BadRequest("唔係 xlsx/xlsm 檔案（請上載 Postorder 總表）");

      const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");
      const outcome = await summarizeParseOutcome(() => parsePostorderWorkbookBuffer(buffer));
      parseError = outcome.parseError;

      created = await prisma.postorderUpload.create({
        data: {
          month,
          uploaderId: session.userId,
          fileName: fileEntry.name || "postorder.xlsm",
          fileSha256: sha256,
          fileBytes: buffer,
          fileSize: buffer.length,
          rowCount: outcome.rowCount,
          status: parseError ? "parse_failed" : "parsed",
          parseSummary: outcome.parseSummary,
        },
      });
    } else if (rosterCsvEntry instanceof File && postorderCsvEntry instanceof File) {
      // --- CSV 路徑（WP-POSTORDER-CSV）：Google Sheets「下載為 CSV」
      // 匯出嘅 Roster／PostOrder 兩份分頁 CSV，唔係 binary，正式站操作員
      // 工具讀得到 ---
      if (rosterCsvEntry.size > MAX_CSV_BYTES || postorderCsvEntry.size > MAX_CSV_BYTES) {
        throw BadRequest(`CSV 檔案太大（每個上限 ${MAX_CSV_BYTES / 1024 / 1024}MB）`);
      }
      const rosterBuffer = Buffer.from(await rosterCsvEntry.arrayBuffer());
      const postorderBuffer = Buffer.from(await postorderCsvEntry.arrayBuffer());
      if (!rosterBuffer.length || !postorderBuffer.length) throw BadRequest("CSV 檔案係空嘅（Roster／PostOrder 兩個都要有）");

      const combined = Buffer.concat([rosterBuffer, postorderBuffer]);
      const sha256 = crypto.createHash("sha256").update(combined).digest("hex");
      const rosterCsvText = rosterBuffer.toString("utf-8");
      const postorderCsvText = postorderBuffer.toString("utf-8");
      const outcome = await summarizeParseOutcome(() =>
        Promise.resolve(parsePostorderFromCsv({ rosterCsv: rosterCsvText, postorderCsv: postorderCsvText })),
      );
      parseError = outcome.parseError;

      created = await prisma.postorderUpload.create({
        data: {
          month,
          uploaderId: session.userId,
          // fileName/fileBytes/fileSha256/fileSize 呢幾欄 NOT NULL、CSV
          // 路徑冧唔到一個真正嘅「檔案」，淨係做佔位／sha256 audit 用途
          // ——真正解析用 rosterCsvBytes/postorderCsvBytes。
          fileName: `${rosterCsvEntry.name || "roster.csv"} + ${postorderCsvEntry.name || "postorder.csv"}`,
          fileSha256: sha256,
          fileBytes: combined,
          fileSize: combined.length,
          rowCount: outcome.rowCount,
          status: parseError ? "parse_failed" : "parsed",
          parseSummary: outcome.parseSummary,
          rosterCsvBytes: rosterBuffer,
          postorderCsvBytes: postorderBuffer,
        },
      });
    } else {
      throw BadRequest("要帶 file（Postorder 總表 .xlsm/.xlsx）或者 roster_csv + postorder_csv 兩個 CSV 檔");
    }

    await writeAudit({
      actorUserId: session.userId,
      tableName: "postorder_uploads",
      rowId: created.id,
      action: "create",
      after: {
        id: created.id,
        month: created.month.toISOString().slice(0, 10),
        fileSize: created.fileSize,
        rowCount: created.rowCount,
        status: created.status,
        parseSummary: created.parseSummary,
        csvUpload: created.rosterCsvBytes !== null || created.postorderCsvBytes !== null,
      },
      ip: getClientIp(req),
    });

    return ok(brandSafeResponse({ upload: toPostorderDTO(created), parseOk: !parseError, parseError }), 201);
  });
}
