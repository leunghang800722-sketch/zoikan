// WP-POSTORDER-PAIRS-CSV（老闆 2026-09-27 緊急）：正式站操作員只可以
// 上載文字檔——Google Sheets 匯出完整 Roster 分頁（2,996 行、760KB）
// 持續 503，AI 轉錄 63KB CSV 又會令格位錯位。呢個 script 由 Postorder
// 總表（`.xlsm`，本機檔案，唔上 git）用現有
// `parsePostorderLongtermPostsFromWorkbook()` 抽出「(盤,人) 組合＋格數」
// 呢個極精簡摘要，寫成 `data/2026-09/postorder-csv/longterm-pairs.csv`
// （4 欄、約 60 行、~3KB，人手／AI 都可以準確轉錄），俾操作員代替
// 完整 Roster CSV 上載（見 `src/lib/guard-fix/postorder.ts`
// `parseLongtermPairsCsv()`／`POST /api/guard-fix/postorder` 第三條
// 路徑）。
//
// 用法：
//   npx tsx scripts/guard-fix/export-postorder-pairs.ts [xlsm 路徑]
// 冇帶路徑就用預設 `data/2026-09/msg-file/Postorder - Aug 2026.xlsm`。
//
// 鐵則：呢個 script 淨係印組數／格數（summary），唔印人名——輸出檔案
// 本身雖然帶人名（`guard_name`），但落到 `data/`（gitignored），唔會
// 入 git；console log 一律唔准帶姓名。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadPostorderWorkbook, parsePostorderLongtermPostsFromWorkbook, type PostorderLongtermPostCell } from "@/lib/guard-fix/postorder";

const DEFAULT_INPUT_PATH = "data/2026-09/msg-file/Postorder - Aug 2026.xlsm";
const OUTPUT_DIR = "data/2026-09/postorder-csv";
const OUTPUT_PATH = path.join(OUTPUT_DIR, "longterm-pairs.csv");

/** RFC4180 CSV escape——欄位有逗號／引號／換行先加雙引號（同
 * `tests/wp-postorder-csv-upload-route.test.ts` 嘅 `csvEscape()` 一致
 * 手法）。 */
function csvEscape(s: string): string {
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function toCsvLine(cell: PostorderLongtermPostCell): string {
  const siteShort = cell.siteLabelFallbackRaw ?? "";
  return [csvEscape(cell.siteLabelRaw), csvEscape(siteShort), csvEscape(cell.guardNameRaw), String(cell.cellCount)].join(",");
}

async function main() {
  const inputPath = process.argv[2] || DEFAULT_INPUT_PATH;
  if (!existsSync(inputPath)) {
    throw new Error(`搵唔到 Postorder 總表：${inputPath}（可以帶第一個參數指定路徑）`);
  }
  console.log(`[export-postorder-pairs] 讀 ${inputPath}`);

  const buffer = readFileSync(inputPath);
  const wb = await loadPostorderWorkbook(buffer);
  const cells = parsePostorderLongtermPostsFromWorkbook(wb);
  if (cells.length === 0) {
    throw new Error("解析唔到任何 (盤,人) 長工組合——請檢查係咪 Roster sheet、表頭係咪有「客戶名稱」／「物業名稱」／「雞頭名」字眼");
  }

  const sorted = [...cells].sort((a, b) => {
    const bySite = a.siteLabelRaw.localeCompare(b.siteLabelRaw, "zh-Hant");
    if (bySite !== 0) return bySite;
    return a.guardNameRaw.localeCompare(b.guardNameRaw, "zh-Hant");
  });

  const lines = ["site_label,site_short,guard_name,cell_count", ...sorted.map(toCsvLine)];
  const csvText = lines.join("\r\n") + "\r\n";

  mkdirSync(OUTPUT_DIR, { recursive: true });
  writeFileSync(OUTPUT_PATH, csvText, "utf8");

  const totalCells = sorted.reduce((acc, c) => acc + c.cellCount, 0);
  const byteSize = Buffer.byteLength(csvText, "utf8");
  console.log(`[export-postorder-pairs] ${sorted.length} 個 (盤,人) 組合、${totalCells} 格「(8) 長工」`);
  console.log(`[export-postorder-pairs] → ${OUTPUT_PATH}（${sorted.length + 1} 行，${byteSize} bytes）`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
