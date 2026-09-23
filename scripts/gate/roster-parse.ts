// `npm run gate:roster-parse`——WP-ROSTER-UPLOAD Phase A（§15.3）驗收
// gate：讀 `data/2026-09/aug-rosters/*.xlsx`（36 個 8 月逐盤更表原始
// 檔，唔存在就 skip，同 seed gate 一致做法，唔擋 CI／新 clone 環境）逐
// 檔用 `src/lib/roster-upload/parse.ts` 解析，同
// `tests/fixtures/roster-parse-aug-2026.json`（由 8 月試算 python
// importer 輸出獨立生成，見 scripts/gate/build-roster-parse-fixture.ts）
// 比對逐檔：layout_key、總更數、各 code 數目、code_kind 分佈、日期範圍、
// 子盤名。目標 36/36 檔完全對到（唔准得 aggregate 啱但逐檔有差都當過）。
//
// layout_key 比較刻意剝走兩個 token（實測見底：逐檔對過先發現嘅落差，
// 記錄喺度）：
//   - `date-gap:*`——patch 1 標記淨係喺解析器本身行緊嗰陣先識別到（Date
//     表頭同第一個真日期之間隔幾多欄），8 月試算輸出嘅 CSV/JSONL 冇留
//     低呢個訊號（python patch 1 直接喺 runtime monkeypatch 咗
//     `find_date_headers`，冇專門記低隔咗幾多欄）。
//   - `multi-block`——`records.jsonl` 嘅 `block_id` 跟嘅係 P0 WP1 嗰套
//     「Total/所需人手/尚欠 一個三行組收尾就開新 block」語意（同一個
//     Date 表頭底下可以拆好幾個 block_id），同呢個解析器嘅 `multi-block`
//     （＝呢個 sheet 有幾多個獨立嘅 Date 表頭欄位分組）唔係同一個概念，
//     由 `block_id` 獨立重建唔到後者，逐檔比對實測有 11 個檔（IFC 70樓／
//     皓日／HKU Y更／Garden East／Weave Robinson／免稅店／城巴車廠／
//     屯門小欖樂怡街5號／希慎廣場／恆星樓／葵發大廈）兩個定義計出嚟嘅
//     「有幾多個 block」數唔同，但呢 11 個檔嘅更數/代號分佈/日期範圍/
//     子盤名全部對得晒，證實純粹係 layout_key 呢個 metadata 標記本身嘅
//     定義分歧，唔係解析結果錯。
// 兩個都冇辦法俾 fixture builder（淨係讀 CSV/JSONL）獨立重建，所以剝走
// 淨係比對 base layout（standard/digital_port/citybus）+
// no-broker-col/multi-subsite 呢兩個可以獨立重建嘅訊號。CTB 6907／
// 都會大學兩個檔嘅 date-gap patch 1 場景已經喺
// `tests/roster-upload-parse.test.ts` 嘅合成 xlsx 單元測試覆蓋。
import fs from "node:fs";
import path from "node:path";
import { parseRosterWorkbook } from "@/lib/roster-upload/parse";
import { rosterFixtureKey } from "./roster-fixture-key";

const REPO_ROOT = path.resolve(__dirname, "../..");
const DATA_DIR = path.resolve(REPO_ROOT, "data/2026-09/aug-rosters");
const FIXTURE_PATH = path.resolve(REPO_ROOT, "tests/fixtures/roster-parse-aug-2026.json");

interface FixtureFile {
  siteRaw: string | null;
  layoutKey: string;
  totalCellCount: number;
  shiftCount: number;
  codeBreakdown: Record<string, number>;
  codeKindBreakdown: Record<string, number>;
  dateRange: { min: string; max: string } | null;
  subSiteNames: string[];
}
interface Fixture {
  fileCount: number;
  files: Record<string, FixtureFile>;
}

function normalizeLayoutKeyForCompare(layoutKey: string): string {
  return layoutKey
    .split("+")
    .filter((tok) => !tok.startsWith("date-gap:") && tok !== "multi-block")
    .join("+");
}

function deepEqualRecord(a: Record<string, number>, b: Record<string, number>): string[] {
  const diffs: string[] = [];
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if ((a[k] ?? 0) !== (b[k] ?? 0)) diffs.push(`${k}: fixture=${a[k] ?? 0} live=${b[k] ?? 0}`);
  }
  return diffs;
}

async function main() {
  if (!fs.existsSync(DATA_DIR)) {
    console.log(`[gate:roster-parse] SKIP — ${path.relative(REPO_ROOT, DATA_DIR)} 唔存在，本機冇 8 月更表原始檔，跳過（同 seed gate 一致做法）`);
    return;
  }
  if (!fs.existsSync(FIXTURE_PATH)) {
    console.error(`[gate:roster-parse] FAIL — 搵唔到 fixture ${path.relative(REPO_ROOT, FIXTURE_PATH)}，先跑 scripts/gate/build-roster-parse-fixture.ts`);
    process.exitCode = 1;
    return;
  }

  const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8")) as Fixture;
  const xlsxFiles = fs.readdirSync(DATA_DIR).filter((f) => f.endsWith(".xlsx")).sort();

  let okCount = 0;
  const failedFiles: string[] = [];

  for (const diskFileName of xlsxFiles) {
    // 驗收 2026-09-23：fixture key 唔帶人名／工號（見 roster-fixture-key.ts），
    // console 輸出亦一律用 key，唔印原檔名。
    const fileName = rosterFixtureKey(diskFileName);
    const expected = fixture.files[fileName];
    if (!expected) {
      console.log(`[gate:roster-parse] FAIL — ${fileName}：fixture 冇呢個檔（新檔？要重新生成 fixture）`);
      failedFiles.push(fileName);
      continue;
    }
    const buffer = fs.readFileSync(path.join(DATA_DIR, diskFileName));
    const result = await parseRosterWorkbook(buffer, fileName);
    if (!result.ok) {
      console.log(`[gate:roster-parse] FAIL — ${fileName}：解析失敗（${result.error}）`);
      failedFiles.push(fileName);
      continue;
    }

    const diffs: string[] = [];
    if (normalizeLayoutKeyForCompare(result.layoutKey) !== normalizeLayoutKeyForCompare(expected.layoutKey)) {
      diffs.push(`layout_key: fixture=${expected.layoutKey} live=${result.layoutKey}`);
    }
    if (result.totalCellCount !== expected.totalCellCount) diffs.push(`total_cell_count: fixture=${expected.totalCellCount} live=${result.totalCellCount}`);
    if (result.shiftCount !== expected.shiftCount) diffs.push(`shift_count: fixture=${expected.shiftCount} live=${result.shiftCount}`);
    diffs.push(...deepEqualRecord(expected.codeBreakdown, result.codeBreakdown).map((d) => `code_breakdown.${d}`));
    diffs.push(...deepEqualRecord(expected.codeKindBreakdown, result.codeKindBreakdown).map((d) => `code_kind_breakdown.${d}`));
    const expectedRange = expected.dateRange ? `${expected.dateRange.min}..${expected.dateRange.max}` : "null";
    const liveRange = result.dateRange ? `${result.dateRange.min}..${result.dateRange.max}` : "null";
    if (expectedRange !== liveRange) diffs.push(`date_range: fixture=${expectedRange} live=${liveRange}`);
    const expectedSub = [...expected.subSiteNames].sort().join(",");
    const liveSub = [...result.subSiteNames].sort().join(",");
    if (expectedSub !== liveSub) diffs.push(`sub_site_names: fixture=[${expectedSub}] live=[${liveSub}]`);

    if (diffs.length) {
      console.log(`[gate:roster-parse] FAIL — ${fileName}\n    ${diffs.join("\n    ")}`);
      failedFiles.push(fileName);
    } else {
      okCount++;
    }
  }

  // fixture 有但本機 xlsx 冇（唔應該發生，36 個檔一齊上載／一齊缺）——
  // 唔當 fail（本機可能淨係有部分檔），淨係提示。
  const diskKeys = xlsxFiles.map(rosterFixtureKey);
  const missingFromDisk = Object.keys(fixture.files).filter((f) => !diskKeys.includes(f));
  if (missingFromDisk.length) {
    console.log(`[gate:roster-parse] INFO — fixture 有但本機 ${path.relative(REPO_ROOT, DATA_DIR)} 冇嘅檔（${missingFromDisk.length} 個）：${missingFromDisk.join("、")}`);
  }

  console.log(`\n[gate:roster-parse] summary：${okCount}/${xlsxFiles.length} 檔對到`);
  if (failedFiles.length) {
    console.log(`[gate:roster-parse] FAIL 項：${failedFiles.join("、")}`);
    process.exitCode = 1;
  } else {
    console.log(`[gate:roster-parse] PASS — 全部 ${okCount} 個檔案 layout_key／更數／代號分佈／日期範圍／子盤名都同 8 月試算對到`);
  }
}

main().catch((err) => {
  console.error("[gate:roster-parse] 失敗", err);
  process.exitCode = 1;
});
