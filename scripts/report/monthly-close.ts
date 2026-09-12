// P1-WP4 thin wrapper：實際邏輯搬咗去 src/lib/reports/monthly-close.ts
// （單一 source of truth，`npm run report:regen` 同
// `GET /api/reports/monthly-close` 兩邊行同一份 code）。呢個檔案淨係
// 保留原本嘅 export 名同 CLI 入口，唔改任何呼叫方（diff.ts／index.ts）
// 嘅 import 路徑。
import path from "node:path";
import { prisma } from "@/lib/db";
import { parseMonthArg } from "./lib/cli-month";

export { DEFAULT_REPORT_MONTH, buildMonthlyClose, writeMonthlyCloseXlsx, type MonthlyCloseSiteRow } from "@/lib/reports/monthly-close";

if (import.meta.url === `file://${process.argv[1]}`) {
  import("@/lib/reports/monthly-close").then(async ({ writeMonthlyCloseXlsx }) => {
    const out = path.resolve(process.cwd(), "out/p1/月結總表-regenerated.xlsx");
    const month = parseMonthArg(process.argv.slice(2));
    await writeMonthlyCloseXlsx(out, month);
    console.log("wrote", out);
    // CLI wrapper 用嘅係 @/lib/db 嗰個 App runtime 單例（同 buildMonthlyClose
    // 內部用嘅同一個 client）——一定要 disconnect 呢個，唔係另一個
    // client，否則 process 唔會自然結束。
    await prisma.$disconnect();
  });
}
