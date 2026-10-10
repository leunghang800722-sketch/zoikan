// P1-執行計劃.md §4 WP4 item 3：`GET /api/reports/monthly-close?month=`
// （`月結總表:view/export`）——由 DB 出月結總表（主表＋月結以外），邏輯
// 喺 src/lib/reports/monthly-close.ts（同 `npm run report:regen` 同一份
// code）。`?export=1` 匯出 xlsx。五條自動對數規則見
// `POST /api/month-closes/:id/generate`（月結工作台用嗰個接口一次過攞
// 埋 reconciliation）。
import fs from "node:fs";
import { NextResponse } from "next/server";
import os from "node:os";
import path from "node:path";
import { requirePermission, hasPermission } from "@/lib/rbac/requirePermission";
import { ok, withApiError } from "@/lib/api/http";
import { brandSafeResponse } from "@/lib/api/serialize";
import { parseMonthParam, monthLabel, monthStart } from "@/lib/reports/money";
import { buildMonthlyClose, writeMonthlyCloseXlsx, DEFAULT_REPORT_MONTH, type MonthlyCloseSiteRow } from "@/lib/reports/monthly-close";
import { prisma } from "@/lib/db";
// WP-PRICE §3：頁頂「N 更未定價，金額未計入」Notice 要用嘅 additive 欄。
import { buildUnpricedSummary } from "@/lib/pricing/unpriced";

function scrubRow(row: MonthlyCloseSiteRow, canClient: boolean): Record<string, unknown> {
  if (canClient) return row;
  const out: Record<string, unknown> = { ...row };
  delete out.revenue;
  delete out.profit;
  delete out.marginPct;
  delete out.fullProfit;
  delete out.fullMarginPct;
  return out;
}

export async function GET(req: Request) {
  return withApiError(async () => {
    const session = await requirePermission(req, "月結總表", "view");
    const url = new URL(req.url);
    const month = parseMonthParam(url.searchParams.get("month")) ?? DEFAULT_REPORT_MONTH;
    const isExport = url.searchParams.get("export") === "1";

    if (isExport) {
      await requirePermission(req, "月結總表", "export");
      const tmpPath = path.join(os.tmpdir(), `monthly-close-${Date.now()}.xlsx`);
      await writeMonthlyCloseXlsx(tmpPath, month);
      const buf = fs.readFileSync(tmpPath);
      fs.unlinkSync(tmpPath);
      return new NextResponse(new Uint8Array(buf), {
        status: 200,
        headers: { "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "Content-Disposition": `attachment; filename="monthly-close.xlsx"` },
      });
    }

    const [{ mainRows, outsideRows, longtermPayrollActual, combinedCostSummary }, canClient, canSettlement, monthClose, unpriced] = await Promise.all([
      buildMonthlyClose(month),
      hasPermission(session, "收客價", "view"),
      hasPermission(session, "出街價", "view"),
      prisma.monthClose.findUnique({ where: { month: monthStart(month) }, select: { lockedAt: true } }),
      buildUnpricedSummary(session, month),
    ]);

    return ok(
      brandSafeResponse({
        month: monthLabel(month),
        locked: !!monthClose?.lockedAt,
        main_rows: mainRows.map((r) => scrubRow(r, canClient)),
        outside_rows: outsideRows.map((r) => scrubRow(r, canClient)),
        unpriced_count: unpriced.count,
        unpriced_groups: unpriced.groups,
        // 應修 1：獨立畀前端顯示「N 格冇結算單位」警告。
        no_settlement_count: unpriced.noSettlementCount,
        // WP-MIXED-BILLING：OT 未定價獨立數目（見 gross-margin/route.ts 同一段註解）。
        ot_unpriced_count: unpriced.otUnpricedCount,
        // §21 任務 5a：長工糧實際總數／合併成本摘要——成本類數字，跟
        // gross-margin/route.ts 一致，淨係「出街價:view」先睇得到。
        longterm_payroll_actual: canSettlement ? longtermPayrollActual : undefined,
        combined_cost_summary: canSettlement ? combinedCostSummary : undefined,
      }),
    );
  });
}
