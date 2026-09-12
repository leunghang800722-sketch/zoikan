// npm run report:regen —— 由 DB 重出三份報表 + 跑對數腳本
import path from "node:path";
import fs from "node:fs";
import { prisma } from "../seed/lib/db";
import { prisma as appPrisma } from "@/lib/db";
import { writeMonthlyCloseXlsx } from "./monthly-close";
import { writeRosterXlsx } from "./roster";
import { writePayrollXlsx } from "./payroll";
import { parseMonthArg } from "./lib/cli-month";

async function main() {
  // P1-WP3：去除寫死 2026-07——`npx tsx scripts/report/index.ts --month
  // 2026-08`；冇傳跌返 2026-07（`npm run report:regen` 舊用法行為不變）。
  const month = parseMonthArg(process.argv.slice(2));
  const outDir = path.resolve(process.cwd(), "out/p1");
  fs.mkdirSync(outDir, { recursive: true });
  fs.mkdirSync(path.join(outDir, "roster"), { recursive: true });

  console.log("[report] 生成月結總表...");
  await writeMonthlyCloseXlsx(path.join(outDir, "月結總表-regenerated.xlsx"), month);

  console.log("[report] 生成更表...");
  await writeRosterXlsx(path.join(outDir, "roster"), month);

  console.log("[report] 生成糧明細...");
  await writePayrollXlsx(path.join(outDir, "雞頭糧明細-regenerated.xlsx"), month);

  console.log("[report] 三份報表已生成喺", outDir);
  console.log("[report] 跑對數：npx tsx scripts/report/diff.ts");
}

main()
  .catch((err) => {
    console.error("[report] 失敗", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    // P1-WP4：monthly-close.ts／payroll.ts 而家用 @/lib/db 嗰個 App
    // runtime 單例（俾 API route 共用），roster.ts 仲用返舊嘅
    // scripts/seed/lib/db 獨立 client——兩個都要 disconnect，唔係
    // process 唔會自然結束（`npm run report:regen` 會卡住）。
    await Promise.all([prisma.$disconnect(), appPrisma.$disconnect()]);
  });
