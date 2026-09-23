// WP-ROSTER-UPLOAD Phase A（§15.3）：由 8 月試算輸出
// `data/2026-09/aug-payroll-trial/out-rosters/records.jsonl`（P0 python
// importer 加 7 個 patch，跑 `data/2026-09/aug-payroll-trial/scripts/
// s02_extract.py` 產生嘅、已經人手核對過嘅解析結果）生成
// `tests/fixtures/roster-parse-aug-2026.json`——俾 `npm run
// gate:roster-parse` 用嚟獨立核對 TS 解析器（`src/lib/roster-upload/
// parse.ts`）嘅輸出啱唔啱，唔係「TS 解析器同自己比」，係同一個獨立、已
// 經人手驗證過嘅 python 結果比。
//
// **PII 鐵則**：`records.jsonl` 本身有真實姓名／電話／工號（8 月試算真
// 數據，`data/` 全個 gitignore）。呢個 script 淨係讀 `file`／`code_raw`／
// `kind`／`work_date`／`sub_site`／`layout`／`broker_code`／`block_id`／
// `site_raw`（`site_raw` 係盤名，唔係個人資料）呢幾個安全欄位，逐個彙總
// 做聚合數字先寫出去；`name`／`name_raw`／`name_en`／`staff_no`／`tel`
// 一律唔讀入呢個 script 嘅任何變量。輸出檔案（`tests/fixtures/roster-
// parse-aug-2026.json`）本身**入 git**（冇 PII，同 `mappings/*.csv` 一
// 個級別），同 `data/` 全個 gitignore 唔矛盾。
//
// 淨係要行一次（試算數據唔會變）；跑法：
//   npx tsx scripts/gate/build-roster-parse-fixture.ts
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { rosterFixtureKey } from "./roster-fixture-key";

const REPO_ROOT = path.resolve(__dirname, "../..");
const RECORDS_JSONL = path.resolve(REPO_ROOT, "data/2026-09/aug-payroll-trial/out-rosters/records.jsonl");
const OUT_FIXTURE = path.resolve(REPO_ROOT, "tests/fixtures/roster-parse-aug-2026.json");

// python kind → 呢個系統嘅 code_kind（同 src/lib/roster-upload/cell-codes.ts 一致）。
const KIND_MAP: Record<string, string> = { work: "shift", leave: "leave", ot: "ot", pointer: "marker", unknown: "unknown" };

interface SafeRecord {
  file: string;
  code_raw: string;
  kind: string;
  work_date: string;
  sub_site: string | null;
  layout: string;
  broker_code: string | null;
  block_id: string;
  site_raw: string | null;
}

interface FileAgg {
  siteRaw: string | null;
  totalCellCount: number;
  shiftCount: number;
  codeBreakdown: Record<string, number>;
  codeKindBreakdown: Record<string, number>;
  dateMin: string | null;
  dateMax: string | null;
  subSiteNames: Set<string>;
  layouts: Set<string>;
  blockIds: Set<string>;
  brokerCodeSeenNonNull: boolean;
  standardLayoutRowCount: number;
}

async function main() {
  if (!fs.existsSync(RECORDS_JSONL)) {
    console.error(`[build-roster-parse-fixture] 搵唔到 ${RECORDS_JSONL}——本機冇 8 月試算輸出，冇嘢好生成`);
    process.exitCode = 1;
    return;
  }

  const byFile = new Map<string, FileAgg>();
  const rl = readline.createInterface({ input: fs.createReadStream(RECORDS_JSONL, "utf8"), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    const raw = JSON.parse(line) as Record<string, unknown>;
    // 白名單讀取——淨係呢幾個安全欄位，唔理成個 raw object 仲有咩（防止
    // 之後加咗 PII 欄都唔會漏入嚟）。
    const rec: SafeRecord = {
      file: String(raw.file),
      code_raw: String(raw.code_raw),
      kind: String(raw.kind),
      work_date: String(raw.work_date),
      sub_site: (raw.sub_site as string | null) ?? null,
      layout: String(raw.layout),
      broker_code: (raw.broker_code as string | null) ?? null,
      block_id: String(raw.block_id),
      site_raw: (raw.site_raw as string | null) ?? null,
    };

    let agg = byFile.get(rosterFixtureKey(rec.file));
    if (!agg) {
      agg = {
        siteRaw: rec.site_raw,
        totalCellCount: 0,
        shiftCount: 0,
        codeBreakdown: {},
        codeKindBreakdown: { shift: 0, leave: 0, ot: 0, marker: 0, unknown: 0 },
        dateMin: null,
        dateMax: null,
        subSiteNames: new Set(),
        layouts: new Set(),
        blockIds: new Set(),
        brokerCodeSeenNonNull: false,
        standardLayoutRowCount: 0,
      };
      byFile.set(rosterFixtureKey(rec.file), agg);
    }

    agg.totalCellCount += 1;
    const codeKind = KIND_MAP[rec.kind] ?? "unknown";
    agg.codeKindBreakdown[codeKind] = (agg.codeKindBreakdown[codeKind] ?? 0) + 1;
    if (codeKind === "shift") agg.shiftCount += 1;
    agg.codeBreakdown[rec.code_raw] = (agg.codeBreakdown[rec.code_raw] ?? 0) + 1;
    if (agg.dateMin === null || rec.work_date < agg.dateMin) agg.dateMin = rec.work_date;
    if (agg.dateMax === null || rec.work_date > agg.dateMax) agg.dateMax = rec.work_date;
    if (rec.sub_site) agg.subSiteNames.add(rec.sub_site);
    agg.layouts.add(rec.layout);
    agg.blockIds.add(rec.block_id);
    if (rec.layout === "standard") {
      agg.standardLayoutRowCount += 1;
      if (rec.broker_code) agg.brokerCodeSeenNonNull = true;
    }
  }

  const files: Record<string, unknown> = {};
  for (const [file, agg] of [...byFile.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const modifiers: string[] = [];
    if (agg.layouts.has("standard") && agg.standardLayoutRowCount > 0 && !agg.brokerCodeSeenNonNull) modifiers.push("no-broker-col");
    if (agg.subSiteNames.size > 1) modifiers.push("multi-subsite");
    if (agg.blockIds.size > 1) modifiers.push("multi-block");
    const base = [...agg.layouts].sort().join(",");
    const layoutKey = [base, ...modifiers.sort()].join("+");

    files[file] = {
      siteRaw: agg.siteRaw,
      layoutKey,
      totalCellCount: agg.totalCellCount,
      shiftCount: agg.shiftCount,
      codeBreakdown: agg.codeBreakdown,
      codeKindBreakdown: agg.codeKindBreakdown,
      dateRange: agg.dateMin && agg.dateMax ? { min: agg.dateMin, max: agg.dateMax } : null,
      subSiteNames: [...agg.subSiteNames].sort(),
    };
  }

  const fixture = {
    note: "由 data/2026-09/aug-payroll-trial/out-rosters/records.jsonl（8 月試算，python importer + 7 patch）彙總生成，只存數目/日期範圍/盤名/子盤名，冇任何姓名/電話/工號。生成方式：npx tsx scripts/gate/build-roster-parse-fixture.ts。layout_key 嘅 date-gap/multi-block 呢兩個 token 由呢個 CSV 獨立重建唔到，gate 比對時會剝走（見 scripts/gate/roster-parse.ts 頂註解），呢度存低嘅 layoutKey 對呢兩個 token 嚟講純粹參考用。",
    generatedAt: new Date().toISOString(),
    fileCount: byFile.size,
    files,
  };

  fs.writeFileSync(OUT_FIXTURE, `${JSON.stringify(fixture, null, 2)}\n`, "utf8");
  console.log(`[build-roster-parse-fixture] 寫咗 ${byFile.size} 個檔案嘅聚合數字 -> ${path.relative(REPO_ROOT, OUT_FIXTURE)}`);
}

main().catch((err) => {
  console.error("[build-roster-parse-fixture] 失敗", err);
  process.exitCode = 1;
});
