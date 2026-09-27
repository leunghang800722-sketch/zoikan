// §20.4 Phase 4：`GET /api/reports/postorder/:month`——輸出 Postorder 格式
// 總表 xlsx（老闆／會計，「月結總表」module `export` action——呢個
// export 同「睇月結總表/毛利」屬於同一個財務敏感度分組，跟
// `src/lib/rbac/matrix.ts` 既有粒度，冇加新 module）。
//
// 路徑冇跟任務書字面 `:month.xlsx`（Next.js route segment 帶副檔名會令
// `[month]` 動態參數解析多咗個 `.xlsx` 尾巴，同呢個 repo 現有兩個 xlsx
// 下載 route 嘅慣例唔一致）——跟返 `GET /api/sites/:id/roster-export`
// （src/app/api/sites/[id]/roster-export/route.ts）同
// `GET /api/longterm/payroll/:month/autopay`
// （src/app/api/longterm/payroll/[month]/autopay/route.ts）嘅寫法：路徑
// 淨係到 `:month`，靠 `Content-Disposition` header 帶返 `.xlsx` 檔名。
//
// 月結鎖定之後仍然可以下載（任務書明文）——呢度冇加鎖定檢查。
import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/rbac/requirePermission";
import { withApiError, getClientIp } from "@/lib/api/http";
import { BadRequest } from "@/lib/api/errors";
import { parseMonthParam, monthLabel } from "@/lib/reports/money";
import { buildPostorderWorkbook } from "@/lib/reports/postorder-export";
import { writeAudit } from "@/lib/audit";

export async function GET(req: Request, { params }: { params: Promise<{ month: string }> }) {
  return withApiError(async () => {
    const session = await requirePermission(req, "月結總表", "export");
    const { month: monthParam } = await params;
    const month = parseMonthParam(monthParam);
    if (!month) throw BadRequest(`唔啱嘅月份格式：${monthParam}（要 YYYY-MM）`);

    const result = await buildPostorderWorkbook(month);
    const buffer = await result.workbook.xlsx.writeBuffer();

    await writeAudit({
      actorUserId: session.userId,
      tableName: "shift_records",
      rowId: `postorder-export:${result.month}`,
      action: "export_download",
      after: {
        month: result.month,
        rosterRowCount: result.rosterRowCount,
        brokerPayoutCount: result.brokerPayouts.length,
        referralFeeTotal: result.referralFeeTotal,
        siteRevenueTotal: result.siteRevenueTotal,
        siteCostTotal: result.siteCostTotal,
      },
      ip: getClientIp(req),
    });

    const filename = `Postorder - ${monthLabel(month)}.xlsx`;
    return new NextResponse(new Uint8Array(buffer), {
      status: 200,
      headers: {
        "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "content-disposition": `attachment; filename="${encodeURIComponent(filename)}"`,
      },
    });
  });
}
