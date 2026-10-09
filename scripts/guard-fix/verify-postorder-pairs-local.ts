// 本機工具（唔係測試，唔入 vitest）：用 data/ 入面真實 Postorder xlsm，驗證「xlsm 直讀」同「匯出
// longterm-pairs.csv 再解析」組數／格數逐項相等。data/ gitignored，冇檔就提示退出。
// 用法：npx tsx scripts/guard-fix/verify-postorder-pairs-local.ts [檔案路徑]
// 注意：伺服器端 loadPostorderWorkbook 對 >1.5MB 嘅 xlsm 會拒收（防 OOM），呢個工具繞過大小閘
// 直接用 exceljs（本機一次性，要夠 heap：NODE_OPTIONS=--max-old-space-size=12000）。
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";
import { parseLongtermPairsCsv, parsePostorderLongtermPostsFromWorkbook } from "../../src/lib/guard-fix/postorder";

async function main() {
  const file = process.argv[2] ?? path.resolve(process.cwd(), "data/2026-09/msg-file/Postorder - Aug 2026.xlsm");
  if (!existsSync(file)) {
    console.log(`[verify-postorder-pairs-local] 搵唔到 ${file}，略過`);
    return;
  }
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(readFileSync(file) as unknown as ArrayBuffer);
  const fromWorkbook = parsePostorderLongtermPostsFromWorkbook(wb);
  const csvEscape = (s: string) => (/[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const sorted = [...fromWorkbook].sort((a, b) => a.siteLabelRaw.localeCompare(b.siteLabelRaw, "zh-Hant") || a.guardNameRaw.localeCompare(b.guardNameRaw, "zh-Hant"));
  const csvText = ["site_label,site_short,guard_name,cell_count", ...sorted.map((c) => [csvEscape(c.siteLabelRaw), csvEscape(c.siteLabelFallbackRaw ?? ""), csvEscape(c.guardNameRaw), String(c.cellCount)].join(","))].join("\r\n") + "\r\n";
  const outcome = parseLongtermPairsCsv(csvText);
  const cells = (xs: Array<{ cellCount: number }>) => xs.reduce((a, c) => a + c.cellCount, 0);
  const ok = outcome.parseError === null && outcome.cells.length === fromWorkbook.length && cells(outcome.cells) === cells(fromWorkbook);
  console.log(`[verify-postorder-pairs-local] xlsm ${fromWorkbook.length} 組／${cells(fromWorkbook)} 格；pairs-csv ${outcome.cells.length} 組／${cells(outcome.cells)} 格 → ${ok ? "一致" : "唔一致"}`);
  process.exit(ok ? 0 : 1);
}
void main();
