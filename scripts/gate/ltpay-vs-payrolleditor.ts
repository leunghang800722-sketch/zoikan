// P11.2（dev-only，唔入正式站）：`tsx scripts/gate/ltpay-vs-payrolleditor.ts <payrolleditor.xls> --month YYYY-MM [--out <json>] [--sheet <name>]`
// 系統該月長工糧 run 嘅逐人 autopay vs BOCHK Payroll Editor 檔。console 只印數字（唔印人名／戶口／工號）；
// 逐人明細（工號＋金額）寫去 --out（建議放 data/，由規劃者本機睇）。
import fs from "node:fs";
import path from "node:path";
import { parsePayrollEditorXls, loadSystemLines, comparePayrollEditor } from "./lib/payroll-editor-compare";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const file = process.argv.slice(2).find((a, i, all) => !a.startsWith("--") && !(i > 0 && all[i - 1].startsWith("--")));
  const month = arg("--month");
  if (!file || !month || !/^\d{4}-\d{2}$/.test(month)) {
    console.error("用法：tsx scripts/gate/ltpay-vs-payrolleditor.ts <payrolleditor.xls> --month YYYY-MM [--out <json>] [--sheet <name>]");
    process.exitCode = 2;
    return;
  }
  const { PrismaClient } = await import("@prisma/client");
  const prisma = new PrismaClient();
  try {
    const parsed = parsePayrollEditorXls(fs.readFileSync(path.resolve(file)), arg("--sheet"));
    const [y, m] = month.split("-").map(Number);
    const system = await loadSystemLines(prisma, new Date(Date.UTC(y, m - 1, 1)));
    const result = comparePayrollEditor(parsed, system);
    const s = result.summary;
    console.log(`[ltpay-vs-payrolleditor] ${month}  分頁「${parsed.sheetName}」`);
    console.log(`  Payroll Editor ${s.payrollEditorRows} 行／系統 ${s.systemLines} 人／配對到 ${s.matched}／吻合(±0.01) ${s.equal}／差額 ${s.differing}`);
    console.log(`  差額分佈：≤1 ${s.diffBuckets.within1}／1–100 ${s.diffBuckets.from1To100}／>100 ${s.diffBuckets.over100}；最大差額 ${s.maxAbsDiff}`);
    console.log(`  只喺 Payroll Editor ${s.onlyInPayrollEditor}／只喺系統 ${s.onlyInSystem}／重複鍵 ${s.duplicatePayrollEditorKeys}／金額解析失敗 ${s.badAmountRows}`);
    console.log(`  總額：Payroll Editor ${s.totals.payrollEditor}／系統 ${s.totals.system}／差 ${s.totals.diff}`);
    const out = arg("--out");
    if (out) {
      fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
      fs.writeFileSync(path.resolve(out), JSON.stringify({ month, ...result }, null, 2));
      console.log(`  逐人明細已寫入 ${out}（工號＋金額，冇人名／戶口）`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error("[ltpay-vs-payrolleditor] 執行失敗：", e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
