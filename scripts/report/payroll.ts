// P1-WP4 thin wrapper：實際邏輯搬咗去 src/lib/reports/payroll.ts（單一
// source of truth，`npm run report:regen` 同 `GET /api/reports/payroll`
// 兩邊行同一份 code）。
import path from "node:path";
import { prisma } from "@/lib/db";
import { parseMonthArg } from "./lib/cli-month";

export { DEFAULT_REPORT_MONTH, buildPayrollTotals, writePayrollXlsx, type BrokerPayrollTotal } from "@/lib/reports/payroll";

if (import.meta.url === `file://${process.argv[1]}`) {
  import("@/lib/reports/payroll").then(async ({ writePayrollXlsx }) => {
    const out = path.resolve(process.cwd(), "out/p1/雞頭糧明細-regenerated.xlsx");
    const month = parseMonthArg(process.argv.slice(2));
    await writePayrollXlsx(out, month);
    console.log("wrote", out);
    await prisma.$disconnect();
  });
}
