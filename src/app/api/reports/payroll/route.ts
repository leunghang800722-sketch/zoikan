// P1-執行計劃.md §4 WP4 item 3：糧明細報表（`糧明細:view/export`）——搬入
// src/lib/reports/payroll.ts 出 API＋xlsx（同 `npm run report:regen` 同
//一份 code）。逐雞頭結算單位一行；`?export=1` 匯出 xlsx（含逐保安員明細
// sheet）。
import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/rbac/requirePermission";
import { ok, withApiError } from "@/lib/api/http";
import { brandSafeResponse } from "@/lib/api/serialize";
import { parseMonthParam, monthLabel } from "@/lib/reports/money";
import { buildPayrollTotals, buildPayrollSourceSummary, writePayrollBuffer, DEFAULT_REPORT_MONTH } from "@/lib/reports/payroll";
// WP-PRICE §3：頁頂「N 更未定價，金額未計入」Notice 要用嘅 additive 欄。
import { buildUnpricedSummary } from "@/lib/pricing/unpriced";

export async function GET(req: Request) {
  return withApiError(async () => {
    const session = await requirePermission(req, "糧明細", "view");
    const url = new URL(req.url);
    const month = parseMonthParam(url.searchParams.get("month")) ?? DEFAULT_REPORT_MONTH;
    const isExport = url.searchParams.get("export") === "1";

    if (isExport) {
      await requirePermission(req, "糧明細", "export");
      const buf = await writePayrollBuffer(month); // P8.3：直接 Buffer，唔落 tmp 檔（內容同 writePayrollXlsx 一樣）
      return new NextResponse(new Uint8Array(buf), {
        status: 200,
        headers: { "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "Content-Disposition": `attachment; filename="payroll.xlsx"` },
      });
    }

    const [totals, unpriced, sourceSummary] = await Promise.all([buildPayrollTotals(month), buildUnpricedSummary(session, month), buildPayrollSourceSummary(month)]);
    // 應修 1：`no_settlement_count` 獨立於 `unpriced_count`（口徑已經喺
    // computeUnpricedSummary() 分開計，唔會重複計入），等前端顯示獨立
    // 「N 格冇結算單位」警告，就算 unpriced_count=0 都要顯示。
    return ok(
      brandSafeResponse({
        month: monthLabel(month),
        totals,
        unpriced_count: unpriced.count,
        unpriced_groups: unpriced.groups,
        no_settlement_count: unpriced.noSettlementCount,
        // WP-MIXED-BILLING：OT 未定價獨立數目（見 gross-margin/route.ts 同一段註解）。
        ot_unpriced_count: unpriced.otUnpricedCount,
        // B1-7：additive——糧明細嚟源標記摘要（roster_upload 更數 vs
        // 其他來源），唔改任何既有欄位。
        source_summary: sourceSummary,
      }),
    );
  });
}
