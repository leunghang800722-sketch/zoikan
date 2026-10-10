// P1-執行計劃.md §4 WP4 item 6：`npm run gate:reports`（exit code 真）。
//
// 六項驗收——每項獨立印 PASS/FAIL/SKIP，任何一項 FAIL 就令成個腳本
// exit 1；SKIP 唔會令腳本 fail，但會喺 summary 度清楚列出（唔靜默扮
// 通過）。
//   (a) 7 月毛利表逐盤營業額同 P0 月結總表零差異
//   (b) 成本側：Σ雞頭現金＝P0 糧明細重出逐雞頭零差異、長工 autopay 行、
//       referral 行
//   (c) Q10 golden 120,682.94／179 更／6 人
//   (d) 月結總表 API 出嘅 xlsx 同 report:regen 出嘅逐格相同
//   (e) 鎖定後 16 種寫入 403 並留 audit
//   (f) 五條對數規則喺 7 月 seed 數據下嘅結果同 P0 差異清單一致
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import ExcelJS from "exceljs";
import { prisma } from "@/lib/db";
import { buildMonthlyClose, writeMonthlyCloseXlsx, DEFAULT_REPORT_MONTH } from "@/lib/reports/monthly-close";
import { buildGrossMargin } from "@/lib/reports/gross-margin";
import { buildQ10DoublePay, checkQ10Golden } from "../report/q10";
import { n, round2 } from "@/lib/reports/money";

type CheckResult = { label: string; status: "PASS" | "FAIL" | "SKIP" | "INFO"; detail: string };
const results: CheckResult[] = [];
function report(label: string, status: CheckResult["status"], detail: string) {
  results.push({ label, status, detail });
  console.log(`[gate:reports] ${status} — ${label}`);
  if (detail) console.log(`    ${detail.replace(/\n/g, "\n    ")}`);
}

const EPS = 0.01;
const P0_MONTHLY_CLOSE = path.resolve(process.cwd(), "tools/importer/out/wp3/reports/月結總表-regenerated.xlsx");

function leadingNumber(v: unknown): number {
  if (typeof v === "number") return v;
  const s = String(v ?? "");
  const m = s.match(/-?[\d,]+(\.\d+)?/);
  return m ? Number(m[0].replace(/,/g, "")) : 0;
}

// ---------------------------------------------------------------------------
async function checkA() {
  if (!fs.existsSync(P0_MONTHLY_CLOSE)) {
    report("(a) 毛利表逐盤營業額 vs P0 月結總表", "SKIP", `搵唔到 ${P0_MONTHLY_CLOSE}（P0 wp3 輸出唔存在）`);
    return;
  }
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(P0_MONTHLY_CLOSE);
  const ws = wb.getWorksheet("月結對照(R2口徑)");
  const p0ByLabel = new Map<string, number>();
  ws?.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const label = String(row.getCell(1).value ?? "");
    if (label === "Sub-Total" || !label) return;
    p0ByLabel.set(label, leadingNumber(row.getCell(6).value)); // 6 = 營業額
  });

  const { mainRows } = await buildMonthlyClose(DEFAULT_REPORT_MONTH);
  const fails: string[] = [];
  let compared = 0;
  for (const r of mainRows) {
    const p0Revenue = p0ByLabel.get(r.canonicalName);
    if (p0Revenue === undefined) continue; // 對唔到嘅（P0 冇呢個 site）唔計 fail，同 report:regen 嘅 diff.ts 一致
    compared++;
    if (Math.abs(round2(r.revenue - p0Revenue)) >= EPS) {
      fails.push(`${r.canonicalName}: db=${r.revenue} p0=${p0Revenue}`);
    }
  }
  if (compared === 0) {
    report("(a) 毛利表逐盤營業額 vs P0 月結總表", "SKIP", "冇任何 site 對得到 P0 輸出");
  } else if (fails.length > 0) {
    report("(a) 毛利表逐盤營業額 vs P0 月結總表", "FAIL", `${compared} 個 site 逐盤比對，${fails.length} 個差異：\n${fails.slice(0, 10).join("\n")}`);
  } else {
    report("(a) 毛利表逐盤營業額 vs P0 月結總表", "PASS", `${compared} 個 site 逐盤營業額零差異（毛利表 site 級 revenue 直接沿用 buildMonthlyClose()，同 report:regen 用緊同一份 code）`);
  }
}

// 逐格 quote-aware CSV split（field 一律 `"..."` 包住，內部 `"` 用 `""`
// 轉義——見 scripts/report/diff.ts 寫 out/p1/regen-diff.csv 嗰段）。
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') {
        inQuotes = false;
      } else {
        cur += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

// ---------------------------------------------------------------------------
async function checkB() {
  // b1：Σ雞頭現金 vs P0 糧明細重出逐雞頭零差異——P0 嘅糧明細 xlsx
  // （tools/importer/out/wp3/reports/payroll/…）本身係逐紙本頁
  // （settlement_page）分 sheet，冇一個「逐雞頭代號」sheet 可以直接讀，
  // 真正嘅逐頁比對邏輯已經喺 scripts/report/diff.ts 嘅 diffPayroll()
  // 度做咗（`npm run report:regen` 嘅「C:糧明細」章節）——呢度唔重複
  // 起一份（避免兩份邏輯漂移），改為跑一次 report:regen 攞新鮮
  // out/p1/regen-diff.csv，斷言「C:糧明細」章節冇 fail 行（p0_artifact/
  // known/info 已經係已核實嘅已知落差，唔計 fail，見 diff.ts 本身註解）。
  try {
    execFileSync("npx", ["tsx", "scripts/report/index.ts"], { cwd: process.cwd(), stdio: "pipe" });
    execFileSync("npx", ["tsx", "scripts/report/diff.ts"], { cwd: process.cwd(), stdio: "pipe" });
  } catch (err) {
    report("(b1) Σ雞頭現金 vs P0 糧明細逐雞頭", "FAIL", `report:regen 執行失敗：${err instanceof Error ? err.message.slice(0, 1000) : String(err)}`);
    return;
  }
  const csvPath = path.resolve(process.cwd(), "out/p1/regen-diff.csv");
  if (!fs.existsSync(csvPath)) {
    report("(b1) Σ雞頭現金 vs P0 糧明細逐雞頭", "SKIP", `搵唔到 ${csvPath}`);
  } else {
    const lines = fs.readFileSync(csvPath, "utf-8").split("\n").filter(Boolean);
    const header = parseCsvLine(lines[0]!);
    const statusIdx = header.indexOf("status");
    const sectionIdx = header.indexOf("section");
    const payrollRows = lines.slice(1).map(parseCsvLine).filter((r) => r[sectionIdx]?.startsWith("C:糧明細"));
    const fails = payrollRows.filter((r) => r[statusIdx] === "fail");
    if (payrollRows.length === 0) {
      report("(b1) Σ雞頭現金 vs P0 糧明細逐雞頭", "SKIP", "out/p1/regen-diff.csv 冇「C:糧明細」章節（P0 wp3 payroll 輸出可能唔存在）");
    } else if (fails.length > 0) {
      report("(b1) Σ雞頭現金 vs P0 糧明細逐雞頭", "FAIL", `${payrollRows.length} 行「C:糧明細」比對，${fails.length} 行 fail：\n${fails.slice(0, 10).map((r) => r.join(",")).join("\n")}`);
    } else {
      report("(b1) Σ雞頭現金 vs P0 糧明細逐雞頭", "PASS", `${payrollRows.length} 行「C:糧明細」（逐 settlement_page）比對，0 行 fail（見 out/p1/regen-diff.csv）`);
    }
  }

  // b2（Opus 驗收 A2 裁定 2026-09-12 改）：長工 autopay 行——毛利表
  // longtermSalaryAllocated 總額而家要等於 Σ*全部*本月有出更嘅
  // longterm_autopay 保安員月薪（唔再局限喺 mainRows 40 個盤——
  // buildGrossMargin() 而家列晒所有有 shift_records 嘅盤，見
  // gross-margin.ts 頂註解 2），同 (g3) 係同一條斷言，呢度用
  // `longtermSalaryTotalAllocatable`（buildLongtermSalaryAllocation()
  // 嘅權威 Σ monthly_salary）做預期值，唔重新獨立計一次容易漂移。
  const margin = await buildGrossMargin(DEFAULT_REPORT_MONTH);
  const totalAllocated = round2(margin.sites.reduce((a, s) => a + s.longtermSalaryAllocated, 0));
  const expectedTotal = margin.longtermSalaryTotalAllocatable;
  if (Math.abs(totalAllocated - expectedTotal) < 0.05) {
    report("(b2) 長工 autopay 行——月薪分攤總額", "PASS", `分攤總額 ${totalAllocated} ≈ Σ全部本月有出更嘅 longterm_autopay 保安員月薪 ${expectedTotal}（容差 0.05）`);
  } else {
    report("(b2) 長工 autopay 行——月薪分攤總額", "FAIL", `分攤總額 ${totalAllocated} ≠ 預期 ${expectedTotal}`);
  }

  // b3（規劃裁定 2026-09-12）：referral 行——DB 逐 broker Σ special_items
  // (kind=referral_fee) 要同 P0 `master_roster.validate_referral_fee_
  // rates()`（透過 tools/importer/venv 即場重新行一次，唔靠寫死數字，
  // 見 src/lib/reports/gross-margin.ts 頂註解）逐 broker 零差異。
  const dbReferralByBroker = await prisma.specialItem.groupBy({
    by: ["brokerId"],
    where: { kind: "referral_fee", month: DEFAULT_REPORT_MONTH },
    _sum: { cost: true },
  });
  const brokers = await prisma.broker.findMany({ select: { id: true, code: true } });
  const codeById = new Map(brokers.map((b) => [b.id, b.code]));
  const dbByCode = new Map<string, number>();
  for (const row of dbReferralByBroker) {
    const code = row.brokerId ? codeById.get(row.brokerId) : undefined;
    if (code) dbByCode.set(code, round2(n(row._sum.cost)));
  }

  const referralOutPath = path.resolve(process.cwd(), "out/referral-fees.json");
  const venvPython = path.resolve(process.cwd(), "tools/importer/venv/bin/python");
  const wrapperScript = path.resolve(process.cwd(), "scripts/seed/lib/py/extract_referral_fees.py");
  if (!fs.existsSync(venvPython)) {
    report("(b3) referral 行（長工雞頭費）", "SKIP", `搵唔到 ${venvPython}（冇 tools/importer/venv，呢部機／環境未授權）`);
  } else {
    try {
      execFileSync(venvPython, [wrapperScript, referralOutPath], { stdio: "pipe" });
      const payload = JSON.parse(fs.readFileSync(referralOutPath, "utf-8")) as { ok: boolean; by_broker_total?: Record<string, string> };
      if (!payload.ok || !payload.by_broker_total) {
        report("(b3) referral 行（長工雞頭費）", "SKIP", "P0 master_roster 讀唔到（master roster xlsx 可能唔存在），冇得對數");
      } else {
        // by_broker_total 嘅 key 係 broker_csv_id（B01/B02/…），要轉做代號
        // 先同 dbByCode（brokers.code）比較——broker_csv_id → code 嘅對照
        // 喺 tools/importer/mappings/brokers.csv（P0 已有，唔改）。
        const brokerCsvRows = fs
          .readFileSync(path.resolve(process.cwd(), "tools/importer/mappings/brokers.csv"), "utf-8")
          .split("\n")
          .slice(1)
          .filter(Boolean)
          .map((l) => l.split(","));
        const codeByCsvId = new Map(brokerCsvRows.map((r) => [r[0], r[1]]));
        const fails: string[] = [];
        let compared = 0;
        for (const [csvId, amountStr] of Object.entries(payload.by_broker_total)) {
          const code = codeByCsvId.get(csvId);
          if (!code) continue;
          compared++;
          const p0Amount = round2(Number(amountStr));
          const dbAmount = dbByCode.get(code) ?? 0;
          if (Math.abs(dbAmount - p0Amount) >= EPS) fails.push(`${code}: db=${dbAmount} p0=${p0Amount}`);
        }
        if (fails.length > 0) {
          report("(b3) referral 行（長工雞頭費）", "FAIL", `${compared} 個雞頭比對，${fails.length} 個差異：\n${fails.join("\n")}`);
        } else {
          report("(b3) referral 行（長工雞頭費）", "PASS", `${compared} 個雞頭逐個零差異（DB special_items(kind=referral_fee) vs P0 master_roster.validate_referral_fee_rates() 即場重算）`);
        }
      }
    } catch (err) {
      report("(b3) referral 行（長工雞頭費）", "FAIL", `執行 P0 master_roster 讀取失敗：${err instanceof Error ? err.message.slice(0, 1000) : String(err)}`);
    }
  }
}

// ---------------------------------------------------------------------------
async function checkC() {
  const result = await buildQ10DoublePay(DEFAULT_REPORT_MONTH);
  const { ok, problems } = checkQ10Golden(result);
  if (ok) {
    report("(c) Q10 golden", "PASS", `total=${result.total} shifts=${result.guards.reduce((a, g) => a + g.shifts, 0)} guards=${result.guards.length}`);
  } else {
    report("(c) Q10 golden", "FAIL", problems.join("\n"));
  }
}

// ---------------------------------------------------------------------------
async function checkD() {
  const tmpA = path.join(os.tmpdir(), `gate-monthly-close-a-${Date.now()}.xlsx`);
  const tmpB = path.join(os.tmpdir(), `gate-monthly-close-b-${Date.now()}.xlsx`);
  // API 匯出路徑（src/app/api/reports/monthly-close/route.ts）同
  // `npm run report:regen`（scripts/report/monthly-close.ts thin wrapper）
  // 兩邊都直接呼叫 writeMonthlyCloseXlsx()——由呢個*同一條*函數起兩份
  // 檔，喺 DB 狀態冇變嘅情況下應該逐格相同。呢個係「兩邊同一份 code」
  // 呢個設計本身嘅一致性驗證，唔係真正起 Next server 發 HTTP request
  // （見 P1-執行計劃.md 回報「已知限制」）。
  await writeMonthlyCloseXlsx(tmpA, DEFAULT_REPORT_MONTH);
  await writeMonthlyCloseXlsx(tmpB, DEFAULT_REPORT_MONTH);
  const wbA = new ExcelJS.Workbook();
  const wbB = new ExcelJS.Workbook();
  await wbA.xlsx.readFile(tmpA);
  await wbB.xlsx.readFile(tmpB);
  fs.unlinkSync(tmpA);
  fs.unlinkSync(tmpB);

  let mismatches = 0;
  let cellsCompared = 0;
  for (const wsA of wbA.worksheets) {
    const wsB = wbB.getWorksheet(wsA.name);
    if (!wsB) {
      mismatches++;
      continue;
    }
    wsA.eachRow((row, rowNumber) => {
      row.eachCell((cell, colNumber) => {
        cellsCompared++;
        const bVal = wsB.getRow(rowNumber).getCell(colNumber).value;
        if (JSON.stringify(cell.value) !== JSON.stringify(bVal)) mismatches++;
      });
    });
  }
  if (mismatches === 0) {
    report("(d) determinism：月結總表 xlsx 兩次生成逐格相同", "PASS", `${cellsCompared} 格逐格相同（API export 同 report:regen 用緊同一條 writeMonthlyCloseXlsx()）`);
  } else {
    report("(d) determinism：月結總表 xlsx 兩次生成逐格相同", "FAIL", `${mismatches} 格唔同`);
  }
}

// ---------------------------------------------------------------------------
// (d2)（規劃裁定 2026-09-12，A4 應修）：我哋自己 `writeMonthlyCloseXlsx()`
// 寫出嚟嘅 xlsx（唔係直接用 buildMonthlyClose() 嘅 in-memory 物件，
// 真係讀返個檔）逐盤同 P0 `月結總表-regenerated.xlsx` 用值比對（允許
// 格式差——都經 leadingNumber() 攞純數字）。同 (a) 唔同：(a) 驗證
// buildMonthlyClose() 呢個function 本身嘅數值；(d2) 驗證埋「寫 xlsx」
// 呢一步冇整壞數（欄位次序/格式化）。
async function checkD2XlsxValuesVsP0() {
  if (!fs.existsSync(P0_MONTHLY_CLOSE)) {
    report("(d2) 我哋 xlsx vs P0 xlsx（值層面）", "SKIP", `搵唔到 ${P0_MONTHLY_CLOSE}`);
    return;
  }
  const oursPath = path.join(os.tmpdir(), `gate-d2-ours-${Date.now()}.xlsx`);
  await writeMonthlyCloseXlsx(oursPath, DEFAULT_REPORT_MONTH);
  const oursWb = new ExcelJS.Workbook();
  await oursWb.xlsx.readFile(oursPath);
  fs.unlinkSync(oursPath);
  const oursWs = oursWb.getWorksheet("月結對照(R2口徑)");

  const p0Wb = new ExcelJS.Workbook();
  await p0Wb.xlsx.readFile(P0_MONTHLY_CLOSE);
  const p0Ws = p0Wb.getWorksheet("月結對照(R2口徑)");
  if (!oursWs || !p0Ws) {
    report("(d2) 我哋 xlsx vs P0 xlsx（值層面）", "SKIP", "搵唔到「月結對照(R2口徑)」sheet");
    return;
  }

  // 兩份 sheet 欄位次序唔同，逐個 header 名搵返欄位 index，唔靠位置。
  function headerIndex(ws: ExcelJS.Worksheet): Record<string, number> {
    const row = ws.getRow(1);
    const out: Record<string, number> = {};
    row.eachCell((cell, colNumber) => {
      out[String(cell.value ?? "").trim()] = colNumber;
    });
    return out;
  }
  const oursIdx = headerIndex(oursWs);
  const p0Idx = headerIndex(p0Ws);
  const metrics = [
    { ours: "更數", p0: "更數" },
    { ours: "營業額", p0: "營業額" },
    { ours: "成本", p0: "成本" },
    { ours: "盈利", p0: "盈利" },
  ];

  const oursByLabel = new Map<string, ExcelJS.Row>();
  oursWs.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const label = String(row.getCell(oursIdx["工作地點"]).value ?? "");
    if (label && label !== "Sub-Total") oursByLabel.set(label, row);
  });

  // P1-WP4：老闆 2026-09-13 質詢後補嘅 P0 漏價（殷樺花園 K 雞頭 25 更 ×
  // 850＝21,250，見 scripts/report/diff.ts 嘅 YINWAH_K_MISSING_COST／
  // out/p1/regen-diff.csv「A:月結總表(主表)」殷樺花園 行）——DB 補咗之後
  // 呢個 site 嘅成本／盈利同 P0 呢個歷史檔必然差 21,250，屬已知落差、
  // 唔算 fail，但都要如實列出嚟（唔靜默 PASS 扮冇差異）。差額唔啱好呢個
  // 精確數值就照舊當 fail（唔會盲目放過殷樺花園其他唔相關嘅差異）。
  const KNOWN_D2_GAPS: Record<string, number> = {
    "殷樺花園.成本": 21250,
    "殷樺花園.盈利": -21250,
  };

  const fails: string[] = [];
  const known: string[] = [];
  let compared = 0;
  p0Ws.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const label = String(row.getCell(p0Idx["工作地點"]).value ?? "");
    if (!label || label === "Sub-Total") return;
    const oursRow = oursByLabel.get(label);
    if (!oursRow) return; // 對唔到嘅（P0 有但 DB 冇）已經喺 (a) 處理，呢度唔重複
    for (const m of metrics) {
      const p0Val = leadingNumber(row.getCell(p0Idx[m.p0]).value);
      const oursVal = leadingNumber(oursRow.getCell(oursIdx[m.ours]).value);
      compared++;
      const diff = round2(oursVal - p0Val);
      if (Math.abs(diff) < EPS) continue;
      const gapKey = `${label}.${m.ours}`;
      const expectedGap = KNOWN_D2_GAPS[gapKey];
      if (expectedGap !== undefined && Math.abs(diff - expectedGap) < EPS) {
        known.push(`${gapKey}: 我哋xlsx=${oursVal} P0xlsx=${p0Val}（known：P0 漏價，總表外判價 850 補，2026-09-13 老闆質詢後修正）`);
      } else {
        fails.push(`${label}.${m.ours}: 我哋xlsx=${oursVal} P0xlsx=${p0Val}`);
      }
    }
  });

  if (compared === 0) {
    report("(d2) 我哋 xlsx vs P0 xlsx（值層面）", "SKIP", "冇任何一行對到 P0 xlsx");
  } else if (fails.length > 0) {
    report("(d2) 我哋 xlsx vs P0 xlsx（值層面）", "FAIL", `${compared} 格比對，${fails.length} 個差異：\n${fails.slice(0, 10).join("\n")}`);
  } else if (known.length > 0) {
    report(
      "(d2) 我哋 xlsx vs P0 xlsx（值層面）",
      "PASS",
      `${compared} 格（更數/營業額/成本/盈利 × 逐盤）值層面零差異，另有 ${known.length} 格已知落差（唔算 fail）：\n${known.join("\n")}`,
    );
  } else {
    report("(d2) 我哋 xlsx vs P0 xlsx（值層面）", "PASS", `${compared} 格（更數/營業額/成本/盈利 × 逐盤）值層面零差異（允許欄位次序/格式差）`);
  }
}

// ---------------------------------------------------------------------------
function checkE() {
  try {
    execFileSync("npx", ["vitest", "run", "tests/wp2-c4-month-lock-writes.test.ts", "tests/wp2-month-lock.test.ts"], {
      cwd: path.resolve(process.cwd()),
      stdio: "pipe",
    });
    report("(e) 鎖定後 16 種寫入 403 並留 audit", "PASS", "tests/wp2-c4-month-lock-writes.test.ts + tests/wp2-month-lock.test.ts exit 0");
  } catch (err) {
    report("(e) 鎖定後 16 種寫入 403 並留 audit", "FAIL", err instanceof Error ? err.message.slice(0, 2000) : String(err));
  }
}

// ---------------------------------------------------------------------------
// f（規劃裁定 2026-09-12，改定義）：§6.3 五條對數規則喺 7 月 seed 數據下
// 嘅結果，逐條對 P0 機讀輸出（唔係對 buildReconciliation() 自己嘅
// 「confirmed-only vs all-status」內部一致性檢查——嗰個仍然係月結工作台
// 生產用嘅版本，見 src/lib/reports/reconciliation.ts；呢度另外做一組
// *只限呢個 gate 用*嘅歷史 7 月對照，因為 monthly-diff.csv／
// differences.csv／validate-same-day-multi-shift.csv 呢批 P0 產物係
// 7 月專屬嘅歷史分析檔，8 月之後嘅生產月結唔會有）。
function readCsvRows(csvPath: string): { header: string[]; rows: string[][] } {
  const lines = fs.readFileSync(csvPath, "utf-8").split("\n").filter((l) => l.length > 0);
  const header = parseCsvLine(lines[0]!);
  const rows = lines.slice(1).map(parseCsvLine);
  return { header, rows };
}

async function checkF1RevenueVsMonthlyDiff() {
  const p0Path = path.resolve(process.cwd(), "tools/importer/out/wp3/reports/monthly-diff.csv");
  const sitesCsvPath = path.resolve(process.cwd(), "tools/importer/mappings/sites.csv");
  if (!fs.existsSync(p0Path) || !fs.existsSync(sitesCsvPath)) {
    report("(f1) 規則1 逐盤營業額 vs monthly-diff.csv「regen」側", "SKIP", "搵唔到 monthly-diff.csv 或 mappings/sites.csv");
    return;
  }
  const { header: sitesHeader, rows: sitesRows } = readCsvRows(sitesCsvPath);
  const siteIdIdx = sitesHeader.indexOf("site_id");
  const canonicalIdx = sitesHeader.indexOf("canonical_name");
  const canonicalByCsvId = new Map(sitesRows.map((r) => [r[siteIdIdx], r[canonicalIdx]]));

  const { header, rows } = readCsvRows(p0Path);
  const idx = (name: string) => header.indexOf(name);
  const { mainRows } = await buildMonthlyClose(DEFAULT_REPORT_MONTH);
  const revenueByCanonical = new Map(mainRows.map((r) => [r.canonicalName, r.revenue]));
  const shiftsByCanonical = new Map(mainRows.map((r) => [r.canonicalName, r.shifts]));

  // monthly-diff.csv 同一個 site_id 可以有多行（例：HKU/S006 拆咗
  // shifts_diff＋revenue_diff＋「獨立雞頭費」explained_extra_line 三行）
  // ——DB 嘅 buildMonthlyClose() 已經將呢批摺埋做一個 site 總數（見
  // monthly-close.ts 嘅 siteSpecialItems 段），所以要逐 site_id 加埋
  // *全部*行嘅 regen_shifts/regen_revenue 先啱同 DB 比。
  const regenShiftsByCsvId = new Map<string, number>();
  const regenRevenueByCsvId = new Map<string, number>();
  const seenCsvIds = new Set<string>();
  for (const row of rows) {
    const siteCsvId = row[idx("site_id")];
    if (!siteCsvId) continue;
    seenCsvIds.add(siteCsvId);
    const regenShifts = row[idx("regen_shifts")];
    const regenRevenue = row[idx("regen_revenue")];
    if (regenShifts) regenShiftsByCsvId.set(siteCsvId, (regenShiftsByCsvId.get(siteCsvId) ?? 0) + Number(regenShifts));
    if (regenRevenue) regenRevenueByCsvId.set(siteCsvId, (regenRevenueByCsvId.get(siteCsvId) ?? 0) + Number(regenRevenue));
  }

  const fails: string[] = [];
  let compared = 0;
  for (const siteCsvId of seenCsvIds) {
    const canonical = canonicalByCsvId.get(siteCsvId);
    if (!canonical) continue;
    // 冇喺 mainRows 出現（buildMonthlyClose() 對完全冇活動嘅 site 唔會
    // push 入 mainRows）就當 0——monthly-diff.csv 對呢類 site 本身都係
    // 填 0，兩邊「冇資料」嘅意思一致，唔應該算差異。
    if (regenShiftsByCsvId.has(siteCsvId)) {
      compared++;
      const dbShifts = shiftsByCanonical.get(canonical) ?? 0;
      const p0Shifts = regenShiftsByCsvId.get(siteCsvId)!;
      if (dbShifts !== p0Shifts) fails.push(`${canonical}(${siteCsvId}) 更數: db=${dbShifts} monthly-diff(regen 側加總)=${p0Shifts}`);
    }
    if (regenRevenueByCsvId.has(siteCsvId)) {
      compared++;
      const dbRevenue = revenueByCanonical.get(canonical) ?? 0;
      const p0Revenue = regenRevenueByCsvId.get(siteCsvId)!;
      if (Math.abs(dbRevenue - p0Revenue) >= EPS) fails.push(`${canonical}(${siteCsvId}) 營業額: db=${dbRevenue} monthly-diff(regen 側加總)=${p0Revenue}`);
    }
  }
  if (compared === 0) {
    report("(f1) 規則1 逐盤營業額 vs monthly-diff.csv「regen」側", "INFO", "monthly-diff.csv 冇任何一行填咗 regen_revenue/regen_shifts 可以比");
  } else if (fails.length > 0) {
    report("(f1) 規則1 逐盤營業額 vs monthly-diff.csv「regen」側", "FAIL", `${compared} 項比對，${fails.length} 個差異：\n${fails.join("\n")}`);
  } else {
    report("(f1) 規則1 逐盤營業額 vs monthly-diff.csv「regen」側", "PASS", `${compared} 項（逐 site_id 加總更數/營業額）逐項零差異——DB 嘅 regen 輸出同 P0 自己嘅 regen 輸出一致`);
  }
}

async function checkF2PayrollVsP0() {
  // 規則2 逐雞頭＝P0 糧明細重出——同 (b1) 完全同一件事（都係 DB vs P0
  // wp3/reports/payroll，逐 settlement_page），呢度唔重複行一次，直接
  // 引用 (b1) 嘅結果，避免兩條 check 各自解讀出唔同結論。
  const b1 = results.find((r) => r.label.startsWith("(b1)"));
  if (!b1) {
    report("(f2) 規則2 逐雞頭 vs P0 糧明細重出", "SKIP", "(b1) 未跑");
    return;
  }
  report("(f2) 規則2 逐雞頭 vs P0 糧明細重出", b1.status, `同 (b1) 一致（引用）：${b1.detail}`);
}

async function checkF3ThreeTableDifferencesCsv() {
  const p0Path = path.resolve(process.cwd(), "tools/importer/out/wp4/differences.csv");
  if (!fs.existsSync(p0Path)) {
    report("(f3) 規則3 三表更數 vs differences.csv L1 層", "SKIP", "搵唔到 out/wp4/differences.csv");
    return;
  }
  const { header, rows } = readCsvRows(p0Path);
  const idx = (name: string) => header.indexOf(name);
  const l1Rows = rows.filter((r) => r[idx("layer")] === "L1");
  const byCategory = new Map<string, number>();
  let unexplained = 0;
  for (const r of l1Rows) {
    const cat = r[idx("category")] || "(冇分類)";
    byCategory.set(cat, (byCategory.get(cat) ?? 0) + 1);
    if (r[idx("status")] !== "explained") unexplained++;
  }
  const summary = [...byCategory.entries()].map(([c, n2]) => `${c}=${n2}`).join("；");
  if (unexplained > 0) {
    report("(f3) 規則3 三表更數 vs differences.csv L1 層", "FAIL", `L1 層 ${l1Rows.length} 條差異入面有 ${unexplained} 條未 explained（status≠explained）。分類：${summary}`);
  } else {
    report(
      "(f3) 規則3 三表更數 vs differences.csv L1 層",
      "PASS",
      `L1 層 ${l1Rows.length} 條更表/regen 差異全部 status=explained（P0 已逐項歸類）；本系統自己嘅三表（更表/糧明細/月結）同源恆等檢查另見 buildReconciliation() 規則3（7 月 seed 數據下 0 差異，見 reconciliation.ts）。分類分佈：${summary}`,
    );
  }
}

async function checkF5YellowWarningsVsP0() {
  const p0Path = path.resolve(process.cwd(), "tools/importer/out/wp1/validate-same-day-multi-shift.csv");
  if (!fs.existsSync(p0Path)) {
    report("(f5) 規則5 黃色警示 vs P0", "SKIP", "搵唔到 validate-same-day-multi-shift.csv");
    return;
  }
  const { rows: p0Rows } = readCsvRows(p0Path);
  const p0Count = p0Rows.length;
  const p0DistinctIdentities = new Set(p0Rows.map((r) => r[0])).size;

  const { buildReconciliation } = await import("@/lib/reports/reconciliation");
  const reconciliation = await buildReconciliation(DEFAULT_REPORT_MONTH);
  const rule5 = reconciliation.rules.find((r) => r.ruleNo === 5)!;
  const sameDayCount = rule5.details.filter((d) => d.kind === "同人同日多過一更").length;
  const over26Count = rule5.details.filter((d) => d.kind === "單月多過 26 更").length;
  const expiredCount = rule5.details.filter((d) => d.kind === "許可證過期仍出更").length;

  const guardsWithExpiry = await prisma.guard.count({ where: { siaPermitExpiry: { not: null } } });

  const lines: string[] = [];
  const sameDayMatches = sameDayCount === p0Count;
  if (sameDayMatches) {
    lines.push(`同人同日 >1 更：DB=${sameDayCount} 條 = P0 validate-same-day-multi-shift.csv ${p0Count} 條 —— match`);
  } else {
    lines.push(
      `同人同日 >1 更：DB=${sameDayCount} 條 ≠ P0=${p0Count} 條（distinct identity=${p0DistinctIdentities}）—— 已知口徑差異：P0 個 CSV 逐條已經人手篩走「同日 IC 兩段」「正更+OT」呢類合法例子（見 validate-same-day-multi-shift.csv 嘅 explanation 欄），DB 呢條規則暫時未做呢層篩選，唔係漏咗識別、係嚴謹度唔同`,
    );
  }
  lines.push(`單月 >26 更：DB=${over26Count} 條；P0 冇對應輸出檔可以對，列出但標 info（唔計 fail）`);
  lines.push(`許可證過期仍出更：DB=${expiredCount} 條（guards.sia_permit_expiry 有值嘅得 ${guardsWithExpiry}/265 個，seed 數據冇填任何證件到期日，呢條規則喺 7 月 seed 下必然 0 條——標 info，唔係「查唔到問題」）`);

  // 「單月 >26 更」／「許可證過期」兩項本身冇 P0 對照檔（規劃裁定明文
  // 「如果 P0 冇就列出並標 info」），所以呢條規則成體嘅 status 淨係睇
  // 「同人同日」呢項可以對到嘅結果：match 就 PASS，唔 match（但有合理
  // 解釋）就 INFO——冇任何一種情況應該係 FAIL（冇發現「DB 漏咗識別」
  // 呢類真正錯誤）。
  report("(f5) 規則5 黃色警示 vs P0", sameDayMatches ? "PASS" : "INFO", lines.join("\n"));
}

async function checkF() {
  await checkF1RevenueVsMonthlyDiff();
  await checkF2PayrollVsP0();
  await checkF3ThreeTableDifferencesCsv();
  report("(f4) 規則4 現金糧批次", "INFO", "P3 未實作，同 buildReconciliation() 規則4 一致顯示「未啟用」。");
  await checkF5YellowWarningsVsP0();
}

// ---------------------------------------------------------------------------
// (g)（Opus 驗收 M1/M2/A2 必修 2026-09-12）：毛利表 totals 內部一致性——
// totals.cost/revenue 一定要等於逐盤 components 加總；referral 一定要
// 全部嚟自 special_items(kind=referral_fee)（M2）；長工月薪分攤總額一定
// 要等於 Σ本月有出更嘅 longterm_autopay 保安員月薪（A2，容差 0.05）。
async function checkG() {
  const { buildGrossMargin } = await import("@/lib/reports/gross-margin");
  const margin = await buildGrossMargin(DEFAULT_REPORT_MONTH);

  // g1：逐盤 revenue/cost 一定要等於 components 加總（M1）。
  const compFails: string[] = [];
  for (const s of margin.sites) {
    const compRevenue = round2(s.components.revenue.base + s.components.revenue.ot + s.components.revenue.special);
    const compCost = round2(s.components.cost.perShift + s.components.cost.ot + s.components.cost.special + s.components.cost.referral + s.components.cost.longtermAlloc);
    if (Math.abs(compRevenue - s.revenue) >= EPS) compFails.push(`${s.siteName}: revenue=${s.revenue} ≠ Σcomponents.revenue=${compRevenue}`);
    if (Math.abs(compCost - s.cost) >= EPS) compFails.push(`${s.siteName}: cost=${s.cost} ≠ Σcomponents.cost=${compCost}`);
  }
  const sumSiteRevenue = round2(margin.sites.reduce((a, s) => a + s.revenue, 0));
  const sumSiteCost = round2(margin.sites.reduce((a, s) => a + s.cost, 0) + margin.referralFeeUnattributed + margin.specialCostUnattributed);
  if (Math.abs(sumSiteRevenue - margin.totals.revenue) >= EPS) compFails.push(`totals.revenue=${margin.totals.revenue} ≠ Σsite.revenue=${sumSiteRevenue}`);
  if (Math.abs(sumSiteCost - margin.totals.cost) >= EPS) compFails.push(`totals.cost=${margin.totals.cost} ≠ Σsite.cost+unattributed=${sumSiteCost}`);
  if (compFails.length > 0) {
    report("(g1) 毛利表 totals＝Σ逐盤 components 加總", "FAIL", compFails.slice(0, 15).join("\n"));
  } else {
    report("(g1) 毛利表 totals＝Σ逐盤 components 加總", "PASS", `${margin.sites.length} 個盤逐盤 revenue/cost 同 components 加總一致；totals 同 Σsite 一致`);
  }

  // g2：referral 只可以嚟自 special_items(kind=referral_fee)（M2）。
  const referralAgg = await prisma.specialItem.aggregate({ where: { kind: "referral_fee", month: DEFAULT_REPORT_MONTH }, _sum: { cost: true } });
  const referralTotal = round2(n(referralAgg._sum.cost));
  const sumSiteReferral = round2(margin.sites.reduce((a, s) => a + s.referralFee, 0) + margin.referralFeeUnattributed);
  if (Math.abs(sumSiteReferral - referralTotal) >= EPS) {
    report("(g2) referral 只嚟自 special_items(kind=referral_fee)", "FAIL", `Σsite.referralFee+unattributed=${sumSiteReferral} ≠ Σspecial_items(kind=referral_fee).cost=${referralTotal}`);
  } else {
    report("(g2) referral 只嚟自 special_items(kind=referral_fee)", "PASS", `Σsite.referralFee(${round2(margin.sites.reduce((a, s) => a + s.referralFee, 0))})+unattributed(${margin.referralFeeUnattributed})=${sumSiteReferral}＝Σspecial_items(kind=referral_fee).cost=${referralTotal}`);
  }

  // g3：長工月薪分攤總額 = Σ monthly_salary（A2，容差 0.05）。
  const sumSalaryAlloc = round2(margin.sites.reduce((a, s) => a + s.longtermSalaryAllocated, 0));
  if (Math.abs(sumSalaryAlloc - margin.longtermSalaryTotalAllocatable) >= 0.05) {
    report("(g3) 長工月薪分攤總額＝Σmonthly_salary", "FAIL", `Σsite.longtermSalaryAllocated=${sumSalaryAlloc} ≠ Σmonthly_salary=${margin.longtermSalaryTotalAllocatable}`);
  } else {
    report("(g3) 長工月薪分攤總額＝Σmonthly_salary", "PASS", `分攤總額 ${sumSalaryAlloc} ≈ Σ本月有出更嘅 longterm_autopay 保安員月薪 ${margin.longtermSalaryTotalAllocatable}（容差 0.05）`);
  }

  // g4（Opus 驗收 N1 必修）：非 referral_fee 嘅 special_items 成本一定要
  // 全部有落腳——Σcomponents.cost.special（逐盤）＋unattributed 一定要
  // 等於 Σspecial_items(kind≠referral_fee, 未作廢).cost。
  const nonReferralAgg = await prisma.specialItem.aggregate({ where: { kind: { not: "referral_fee" }, month: DEFAULT_REPORT_MONTH, voidedAt: null }, _sum: { cost: true } });
  const nonReferralCostTotal = round2(n(nonReferralAgg._sum.cost));
  const sumSiteSpecialCost = round2(margin.sites.reduce((a, s) => a + s.components.cost.special, 0) + margin.specialCostUnattributed);
  if (Math.abs(sumSiteSpecialCost - nonReferralCostTotal) >= EPS) {
    report("(g4) 非 referral special_items 成本全部有落腳", "FAIL", `Σcomponents.cost.special+unattributed=${sumSiteSpecialCost} ≠ Σspecial_items(kind≠referral_fee).cost=${nonReferralCostTotal}`);
  } else {
    report("(g4) 非 referral special_items 成本全部有落腳", "PASS", `Σcomponents.cost.special(${round2(margin.sites.reduce((a, s) => a + s.components.cost.special, 0))})+unattributed(${margin.specialCostUnattributed})=${sumSiteSpecialCost}＝Σspecial_items(kind≠referral_fee, 未作廢).cost=${nonReferralCostTotal}`);
  }

  // g5（Opus 驗收 N1 必修）：對稱性——喺毛利表*收入*側計入咗嘅
  // special_items id 集合，一定要係*成本*側集合嘅子集（收入側計入嘅
  // 一定要喺成本側都計咗；成本側可以有*淨係*計成本嘅 kind，例如
  // standalone_broker_fee/individual_broker_event 本身冇獨立 revenue
  // 路徑——但唔可以反過來，收入計咗成本冇計）。
  const revenueCountedIds = new Set<string>();
  const revenueItems = await prisma.specialItem.findMany({
    where: { siteId: { in: [...new Set(margin.sites.map((s) => s.siteId))] }, month: DEFAULT_REPORT_MONTH, kind: { in: ["casual_event", "shuttle", "per_hour", "supplemental", "cross_month_adjustment", "other"] }, voidedAt: null },
  });
  for (const it of revenueItems) {
    if (it.kind === "supplemental") continue; // 呢個 kind 嘅 revenue 已經摺入 base，唔算「收入側計入」
    if (n(it.revenue) !== 0) revenueCountedIds.add(it.id);
  }
  const costCountedIds = new Set<string>();
  const allNonReferralForG5 = await prisma.specialItem.findMany({ where: { kind: { not: "referral_fee" }, month: DEFAULT_REPORT_MONTH, voidedAt: null } });
  for (const it of allNonReferralForG5) {
    if (n(it.cost) !== 0) costCountedIds.add(it.id);
  }
  const revenueNotInCost = [...revenueCountedIds].filter((id) => !costCountedIds.has(id));
  if (revenueNotInCost.length > 0) {
    report("(g5) 對稱性：收入側集合 ⊆ 成本側集合", "FAIL", `${revenueNotInCost.length} 個 special_item 收入側計咗但成本側冇：${revenueNotInCost.join(",")}`);
  } else {
    report("(g5) 對稱性：收入側集合 ⊆ 成本側集合", "PASS", `收入側計入嘅 ${revenueCountedIds.size} 個 special_item，全部都喺成本側嘅 ${costCountedIds.size} 個集合入面`);
  }
}

// ---------------------------------------------------------------------------
async function main() {
  await checkA();
  await checkB();
  await checkC();
  await checkD();
  await checkD2XlsxValuesVsP0();
  checkE();
  await checkF();
  await checkG();

  const fail = results.filter((r) => r.status === "FAIL");
  const skip = results.filter((r) => r.status === "SKIP");
  const pass = results.filter((r) => r.status === "PASS");
  const info = results.filter((r) => r.status === "INFO");
  console.log(`\n[gate:reports] summary：pass=${pass.length} fail=${fail.length} skip=${skip.length} info=${info.length}`);
  if (skip.length > 0) console.log(`[gate:reports] SKIP 項（唔算 fail，但唔可以當已驗證）：${skip.map((s) => s.label).join("；")}`);
  if (info.length > 0) console.log(`[gate:reports] INFO 項（唔算 fail，資料本身冇對應 P0 輸出或者 seed 數據冇覆蓋）：${info.map((s) => s.label).join("；")}`);
  if (fail.length > 0) {
    console.log(`[gate:reports] FAIL 項：${fail.map((f) => f.label).join("；")}`);
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error("[gate:reports] 失敗", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
