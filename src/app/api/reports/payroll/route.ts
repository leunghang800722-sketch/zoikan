// P1-執行計劃.md §4 WP4 item 3：糧明細報表（`糧明細:view/export`）——搬入
// src/lib/reports/payroll.ts 出 API＋xlsx（同 `npm run report:regen` 同
//一份 code）。逐雞頭結算單位一行；`?export=1` 匯出 xlsx（含逐安員明細
// sheet）。
import fs from "node:fs";
import { NextResponse } from "next/server";
import os from "node:os";
import path from "node:path";
import { requirePermission } from "@/lib/rbac/requirePermission";
import { ok, withApiError } from "@/lib/api/http";
import { brandSafeResponse } from "@/lib/api/serialize";
import { parseMonthParam, monthLabel } from "@/lib/reports/money";
import { buildPayrollTotals, writePayrollXlsx, DEFAULT_REPORT_MONTH } from "@/lib/reports/payroll";

export async function GET(req: Request) {
  return withApiError(async () => {
    await requirePermission(req, "糧明細", "view");
    const url = new URL(req.url);
    const month = parseMonthParam(url.searchParams.get("month")) ?? DEFAULT_REPORT_MONTH;
    const isExport = url.searchParams.get("export") === "1";

    if (isExport) {
      await requirePermission(req, "糧明細", "export");
      const tmpPath = path.join(os.tmpdir(), `payroll-${Date.now()}.xlsx`);
      await writePayrollXlsx(tmpPath, month);
      const buf = fs.readFileSync(tmpPath);
      fs.unlinkSync(tmpPath);
      return new NextResponse(new Uint8Array(buf), {
        status: 200,
        headers: { "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "Content-Disposition": `attachment; filename="payroll.xlsx"` },
      });
    }

    const totals = await buildPayrollTotals(month);
    return ok(brandSafeResponse({ month: monthLabel(month), totals }));
  });
}
