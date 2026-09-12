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

    const [{ mainRows, outsideRows }, canClient, monthClose] = await Promise.all([
      buildMonthlyClose(month),
      hasPermission(session, "收客價", "view"),
      prisma.monthClose.findUnique({ where: { month: monthStart(month) }, select: { lockedAt: true } }),
    ]);

    return ok(
      brandSafeResponse({
        month: monthLabel(month),
        locked: !!monthClose?.lockedAt,
        main_rows: mainRows.map((r) => scrubRow(r, canClient)),
        outside_rows: outsideRows.map((r) => scrubRow(r, canClient)),
      }),
    );
  });
}
