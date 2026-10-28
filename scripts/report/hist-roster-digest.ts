// HIST-2：本機歷史更表消化報告（唔入正式站、唔用 DB、唔寫任何資料）。
//   npx tsx scripts/report/hist-roster-digest.ts <month-dir>... [--out-dir <dir>]
//   例：npx tsx scripts/report/hist-roster-digest.ts /abs/path/data/2026-01 /abs/path/data/2026-02 --out-dir /abs/path/data/2026-hist
// 每個 <month-dir>（資料夾名 `YYYY-MM`）讀 `roster/*.xlsx`（repo parser）＋ `postorder/csv/Roster.csv`（可選），
// 輸出 `<out-dir>/digest-YYYY-MM.md`：逐盤 格數／更數／leave 數／OT／unknown codes、Postorder 同盤總更數、差異；全檔警告摘要。
// out-dir 預設 `data/2026-hist`，路徑必須有 `data` 或 `out` 段（gitignored，唔入 git）。
// 鐵則：輸出只有盤名＋數字，**唔准**出姓名／工號／電話——unknown code 只列短 ASCII 代號，其餘（可能係備註人名）只計格數；
// 警告一律歸類做固定句式（引號內容、數字抹走）。
import { fileURLToPath } from "node:url";
import path from "node:path";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { parseRosterWorkbook, type ParseResult } from "../../src/lib/roster-upload/parse";
import { gridFromCsvText } from "../../src/lib/guard-fix/postorder";
import { parsePostorderRosterRows, type PostorderRosterRow } from "../../src/lib/month-close/auto/postorder-evidence";
import { compareRosterVsPostorder } from "../../src/lib/month-close/historical-compare";

export interface FileDigest {
  /** 顯示用：盤名（parser siteRaw），讀唔到就用檔名（檔名本身就係盤名）。 */
  label: string;
  ok: boolean;
  error: string | null;
  layoutKey: string | null;
  sheets: number;
  totalCells: number;
  /** 資料夾月份內嘅格數（其餘＝月份不符，import 時會變 unresolved「日期唔係上載月份」）。 */
  inMonthCells: number;
  outOfMonthCells: number;
  /** 表頭日期涉及嘅月份（YYYY-MM）。 */
  headerMonths: string[];
  /** 以下全部只計資料夾月份內嘅格。 */
  shiftCells: number;
  otCells: number;
  otHours: number;
  leaveCells: number;
  leaveByCode: Record<string, number>;
  markerCells: number;
  unknownCells: number;
  unknownCodes: Record<string, number>;
  unknownOtherCells: number;
  warningCategories: Record<string, number>;
  skippedSheets: number;
}

const SHORT_CODE_RE = /^[A-Za-z0-9+\-/.]{1,8}$/;

/** 警告歸類：抹走引號內容同數字，只剩固定句式。 */
export function categorizeWarning(w: string): string {
  return w
    .replace(/^\[[^\]]*\]\s*(row \d+：)?/, "")
    .replace(/「[^」]*」/g, "「…」")
    .replace(/\([A-Z]+\d+[^)]*\)|（[A-Z]+\d+[^）]*）/g, "（格）")
    .replace(/[A-Z]{1,3}\d+/g, "格")
    .replace(/\d+/g, "N")
    .slice(0, 120);
}

export function digestParsed(result: ParseResult, folderMonth: string, fallbackLabel: string): FileDigest {
  const base: FileDigest = {
    label: fallbackLabel,
    ok: false,
    error: null,
    layoutKey: null,
    sheets: 0,
    totalCells: 0,
    inMonthCells: 0,
    outOfMonthCells: 0,
    headerMonths: [],
    shiftCells: 0,
    otCells: 0,
    otHours: 0,
    leaveCells: 0,
    leaveByCode: {},
    markerCells: 0,
    unknownCells: 0,
    unknownCodes: {},
    unknownOtherCells: 0,
    warningCategories: {},
    skippedSheets: result.skippedSheets.length,
  };
  if (!result.ok) {
    return { ...base, error: result.error.slice(0, 160) };
  }
  const d: FileDigest = { ...base, ok: true, label: result.siteRaw?.trim() || fallbackLabel, layoutKey: result.layoutKey, sheets: result.sheets.length, totalCells: result.rows.length };
  d.headerMonths = [...new Set(result.headerDates.map((x) => x.slice(0, 7)))].sort();
  for (const r of result.rows) {
    if (!r.workDate.startsWith(`${folderMonth}-`)) {
      d.outOfMonthCells++;
      continue;
    }
    d.inMonthCells++;
    if (r.codeKind === "shift") d.shiftCells++;
    else if (r.codeKind === "ot") {
      d.otCells++;
      d.otHours += r.hours ?? 0;
    } else if (r.codeKind === "leave") {
      d.leaveCells++;
      const code = r.rawCode.trim().toUpperCase();
      d.leaveByCode[code] = (d.leaveByCode[code] ?? 0) + 1;
    } else if (r.codeKind === "marker") d.markerCells++;
    else {
      d.unknownCells++;
      const code = r.rawCode.trim();
      if (SHORT_CODE_RE.test(code)) d.unknownCodes[code] = (d.unknownCodes[code] ?? 0) + 1;
      else d.unknownOtherCells++;
    }
  }
  for (const w of result.warnings) {
    const c = categorizeWarning(w);
    d.warningCategories[c] = (d.warningCategories[c] ?? 0) + 1;
  }
  return d;
}

const fmtMap = (m: Record<string, number>): string => {
  const e = Object.entries(m).sort((a, b) => b[1] - a[1]);
  return e.length ? e.map(([k, v]) => `${k}×${v}`).join("、") : "—";
};

export interface MonthDigest {
  month: string;
  files: FileDigest[];
  postorder: ReturnType<typeof compareRosterVsPostorder> | null;
  postorderTotalCells: number | null;
}

export function buildMonthDigest(month: string, files: FileDigest[], postorderRows: PostorderRosterRow[] | null): MonthDigest {
  if (!postorderRows) return { month, files, postorder: null, postorderTotalCells: null };
  const sites = files
    .filter((f) => f.ok)
    .map((f) => ({ label: f.label, names: [f.label], cells: f.shiftCells + f.otCells }));
  return { month, files, postorder: compareRosterVsPostorder(sites, postorderRows, { loose: true }), postorderTotalCells: postorderRows.reduce((a, r) => a + r.cells, 0) };
}

export function renderMonthDigest(d: MonthDigest): string {
  const ok = d.files.filter((f) => f.ok);
  const failed = d.files.filter((f) => !f.ok);
  const sum = (pick: (f: FileDigest) => number) => ok.reduce((a, f) => a + pick(f), 0);
  const L: string[] = [];
  L.push(`# 歷史更表消化報告 ${d.month}`);
  L.push("");
  L.push("> 本機報告（唔入 git）：只有盤名＋數字，冇姓名／工號／電話。「格」＝更表入面有代號嘅日格；只計資料夾月份內嘅格（其餘列做「月份不符」）。");
  L.push("");
  L.push("## 月總覽");
  L.push("");
  L.push(`- 檔案 ${d.files.length}：解析成功 ${ok.length}、失敗 ${failed.length}`);
  L.push(`- 總格 ${sum((f) => f.totalCells)}：本月 ${sum((f) => f.inMonthCells)}、月份不符 ${sum((f) => f.outOfMonthCells)}`);
  L.push(`- 本月：更（shift）${sum((f) => f.shiftCells)}、OT 格 ${sum((f) => f.otCells)}（${sum((f) => f.otHours)} 小時）、leave ${sum((f) => f.leaveCells)}、marker ${sum((f) => f.markerCells)}、unknown ${sum((f) => f.unknownCells)}`);
  const leaveAll: Record<string, number> = {};
  for (const f of ok) for (const [k, v] of Object.entries(f.leaveByCode)) leaveAll[k] = (leaveAll[k] ?? 0) + v;
  L.push(`- leave 分佈：${fmtMap(leaveAll)}`);
  if (d.postorder) {
    const t = d.postorder.totals;
    L.push(`- 更表 shift＋OT＋unknown 本月合共 ${sum((f) => f.shiftCells + f.otCells + f.unknownCells)} 格（對照 Postorder 全表：unknown 多數係未入代號表嘅真更別，例如 A／B）`);
    L.push(`- Postorder（Roster 分頁）全表有人當值 ${d.postorderTotalCells} 格；更表 shift＋OT ${t.rosterCells} 格 vs 配到盤嘅 Postorder ${t.postorderCells} 格；配到 ${t.matchedSites} 個盤（含約略配對）、對唔到 ${t.unmatchedSites} 個盤、有差異 ${t.sitesWithDiff} 個盤`);
  } else L.push("- Postorder Roster.csv：冇（唔做比對）");
  L.push("");
  L.push("## 逐檔（盤）");
  L.push("");
  L.push("| 盤 | layout | 分頁 | 總格 | 本月格 | 月份不符 | 表頭月份 | 更 | OT格(時) | leave | marker | unknown | Postorder 格 | 差(更表−Postorder) |");
  L.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  // postorder.perSite 次序＝ok 檔次序（同名盤可以有多個檔，所以按次序配對）
  const rowsOrdered = ok.map((f, i) => ({ f, po: d.postorder?.perSite[i] }));
  for (const { f, po } of [...rowsOrdered].sort((a, b) => a.f.label.localeCompare(b.f.label, "zh-Hant"))) {
    L.push(
      `| ${f.label} | ${f.layoutKey} | ${f.sheets} | ${f.totalCells} | ${f.inMonthCells} | ${f.outOfMonthCells} | ${f.headerMonths.join("/")} | ${f.shiftCells} | ${f.otCells}(${f.otHours}) | ${f.leaveCells} | ${f.markerCells} | ${f.unknownCells} | ${po ? (po.postorderCells === null ? "對唔到" : `${po.postorderCells}${po.loose ? "(約)" : ""}`) : "—"} | ${po && po.diff !== null ? po.diff : "—"} |`,
    );
  }
  L.push("");
  const withLeave = ok.filter((f) => f.leaveCells > 0);
  if (withLeave.length) {
    L.push("## leave 代號分佈（逐盤）");
    L.push("");
    for (const f of withLeave) L.push(`- ${f.label}：${fmtMap(f.leaveByCode)}`);
    L.push("");
  }
  const withUnknown = ok.filter((f) => f.unknownCells > 0);
  if (withUnknown.length) {
    L.push("## unknown 代號（逐盤；非短代號文字只計格數）");
    L.push("");
    for (const f of withUnknown) L.push(`- ${f.label}：${fmtMap(f.unknownCodes)}${f.unknownOtherCells ? `；其他文字 ${f.unknownOtherCells} 格` : ""}`);
    L.push("");
  }
  const mismatch = ok.filter((f) => f.outOfMonthCells > 0);
  if (mismatch.length) {
    L.push("## 月份不符（import 時會變 unresolved「格仔日期唔係上載月份」，要用正確月份上載）");
    L.push("");
    for (const f of mismatch) L.push(`- ${f.label}：表頭月份 ${f.headerMonths.join("/")}；本月 ${f.inMonthCells} 格、月份不符 ${f.outOfMonthCells} 格`);
    L.push("");
  }
  if (failed.length) {
    L.push("## 解析失敗");
    L.push("");
    for (const f of failed) L.push(`- ${f.label}：${f.error}`);
    L.push("");
  }
  const warnAll: Record<string, number> = {};
  for (const f of ok) for (const [k, v] of Object.entries(f.warningCategories)) warnAll[k] = (warnAll[k] ?? 0) + v;
  L.push("## 全檔警告摘要（歸類，句式固定）");
  L.push("");
  const wE = Object.entries(warnAll).sort((a, b) => b[1] - a[1]);
  if (wE.length === 0) L.push("- 冇警告");
  for (const [k, v] of wE) L.push(`- ${k} ×${v}（${ok.filter((f) => f.warningCategories[k]).length} 個檔）`);
  L.push("");
  if (d.postorder) {
    const un = d.postorder.perSite.filter((p) => p.postorderCells === null);
    L.push("## 更表 vs Postorder（Roster 分頁）");
    L.push("");
    const diffs = d.postorder.perSite.filter((p) => p.diff !== null && p.diff !== 0);
    L.push(`### 配到盤但格數有差異（${diffs.length}）`);
    L.push("");
    for (const p of diffs) L.push(`- ${p.label}：更表 ${p.rosterCells}、Postorder ${p.postorderCells}${p.loose ? "(約，物業短代號配對)" : ""}（${p.postorderRows} 行）、差 ${p.diff}`);
    L.push("");
    L.push(`### 更表有盤、Postorder 對唔到崗位（${un.length}）`);
    L.push("");
    for (const p of un) L.push(`- ${p.label}：更表 ${p.rosterCells} 格`);
    L.push("");
    L.push(`### Postorder 有人當值、冇更表盤對到（按物業短代號，${d.postorder.unmatchedPostorder.length}）`);
    L.push("");
    for (const p of d.postorder.unmatchedPostorder) L.push(`- ${p.property}：${p.cells} 格`);
    L.push("");
  }
  return L.join("\n");
}

async function digestMonthDir(monthDir: string): Promise<MonthDigest> {
  const month = path.basename(monthDir.replace(/\/+$/, ""));
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error(`資料夾名要係 YYYY-MM：${month}`);
  const rosterDir = path.join(monthDir, "roster");
  const names = (await readdir(rosterDir)).filter((n) => n.toLowerCase().endsWith(".xlsx") && !n.startsWith("~$")).sort();
  const files: FileDigest[] = [];
  for (const n of names) {
    const buf = await readFile(path.join(rosterDir, n));
    const res = await parseRosterWorkbook(buf, n);
    files.push(digestParsed(res, month, n.replace(/\.xlsx$/i, "")));
  }
  let rows: PostorderRosterRow[] | null = null;
  try {
    const csv = await readFile(path.join(monthDir, "postorder", "csv", "Roster.csv"), "utf-8");
    const [y, m] = month.split("-").map(Number) as [number, number];
    rows = parsePostorderRosterRows(gridFromCsvText(csv), new Date(Date.UTC(y, m - 1, 1)));
  } catch {
    rows = null;
  }
  return buildMonthDigest(month, files, rows);
}

const isMain = process.argv[1] != null && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const argv = process.argv.slice(2);
  const oi = argv.indexOf("--out-dir");
  const outDir = path.resolve(oi >= 0 ? (argv[oi + 1] ?? "") : "data/2026-hist");
  const dirs = argv.filter((a, i) => !a.startsWith("--") && !(oi >= 0 && i === oi + 1));
  (async () => {
    if (dirs.length === 0) throw new Error("用法：hist-roster-digest.ts <month-dir>... [--out-dir <dir>]");
    if (!outDir.split(path.sep).some((seg) => seg === "data" || seg === "out")) throw new Error("--out-dir 必須喺 data/ 或 out/ 之下（gitignored，唔入 git）");
    await mkdir(outDir, { recursive: true });
    for (const dir of dirs) {
      const d = await digestMonthDir(path.resolve(dir));
      const file = path.join(outDir, `digest-${d.month}.md`);
      await writeFile(file, renderMonthDigest(d));
      const ok = d.files.filter((f) => f.ok);
      console.log(`[hist-digest] ${d.month}：檔 ${d.files.length}（成功 ${ok.length}／失敗 ${d.files.length - ok.length}）｜總格 ${ok.reduce((a, f) => a + f.totalCells, 0)}｜本月 ${ok.reduce((a, f) => a + f.inMonthCells, 0)}｜月份不符 ${ok.reduce((a, f) => a + f.outOfMonthCells, 0)}｜更 ${ok.reduce((a, f) => a + f.shiftCells, 0)}｜leave ${ok.reduce((a, f) => a + f.leaveCells, 0)} → ${file}`);
    }
  })().catch((e) => {
    console.error("[hist-digest] 失敗", e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
