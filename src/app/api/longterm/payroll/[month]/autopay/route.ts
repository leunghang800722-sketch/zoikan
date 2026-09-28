// WP-LTPAY §21 任務 5c → WP-BOSS5 §25.4（老闆 2026-09-28 決定 6，取代
// 底下歷史「格式待銀行核實」段）：`GET /api/longterm/payroll/:month/
// autopay`——BOCHK autopay 檔下載（老闆／會計，module「長工糧」`export`
// action）。
//
// **格式已核實**：老闆實際操作係用 BOCHK **Payroll（Payment Type）
// Editor（Excel 巨集）**貼資料再由佢產生正式 `.DAT`；系統出嘅係「Payroll
// Editor 明細欄位次序」嘅 xlsx（唔係最終 `.DAT`），格式跟 BOCHK 公開文件
// 《Payroll (Payment Type) Editor and File Specification (FPS) v1.2》
// 核實（詳細欄位/sheet 見 `src/lib/longterm-payroll/bochk-autopay-
// export.ts` 頂註解）。以前呢度出自訂 5 欄 CSV、`format_verified:false`
// ——而家改出 xlsx，`format_verified:true`。
import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/rbac/requirePermission";
import { ok, getClientIp, withApiError } from "@/lib/api/http";
import { brandSafeResponse } from "@/lib/api/serialize";
import { BadRequest } from "@/lib/api/errors";
import { parseMonthParam } from "@/lib/reports/money";
import { writeAudit } from "@/lib/audit";
import { buildBochkAutopayWorkbook } from "@/lib/longterm-payroll/bochk-autopay-export";

export async function GET(req: Request, { params }: { params: Promise<{ month: string }> }) {
  return withApiError(async () => {
    const session = await requirePermission(req, "長工糧", "export");
    const { month: monthParam } = await params;
    const month = parseMonthParam(monthParam);
    if (!month) throw BadRequest(`唔啱嘅月份格式：${monthParam}（要 YYYY-MM）`);

    let result;
    try {
      result = await buildBochkAutopayWorkbook(month);
    } catch (e) {
      throw BadRequest(e instanceof Error ? e.message : "計唔到 BOCHK autopay 檔");
    }

    const isPreview = new URL(req.url).searchParams.get("preview") === "1";
    await writeAudit({
      actorUserId: session.userId,
      tableName: "longterm_payroll_runs",
      rowId: `bochk-autopay:${result.month}`,
      action: "export_download",
      after: {
        month: result.month,
        rowCount: result.rowCount,
        totalAmount: result.totalAmount,
        missingCount: result.missing.length,
        preview: isPreview,
        formatVerified: result.formatVerified,
      },
      ip: getClientIp(req),
    });

    if (isPreview) {
      return ok(
        brandSafeResponse({
          month: result.month,
          row_count: result.rowCount,
          total_amount: result.totalAmount,
          missing: result.missing,
          format_verified: result.formatVerified,
          format_source: result.formatSource,
        }),
      );
    }

    const buffer = await result.workbook.xlsx.writeBuffer();
    const filename = `longterm-autopay-BOCHK-PayrollEditor-${result.month}.xlsx`;
    return new NextResponse(new Uint8Array(buffer), {
      status: 200,
      headers: {
        "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "content-disposition": `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
        "X-Missing-Bank-Info-Count": String(result.missing.length),
        "X-Format-Verified": "true",
      },
    });
  });
}
