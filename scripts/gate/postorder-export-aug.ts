// §20.4 Phase 4：`buildPostorderWorkbook()` 8 月差異 gate——`npm run
// gate:postorder-export-aug`。
//
// **前置條件**（同 `scripts/gate/aug-e2e-check.ts` 完全一樣，呢個 gate
// 淨係讀，唔會自己去做）：dev DB 要已經行完 8 月 Part B 全套流程（db:reset
// /seed → build/apply-aug-plan → 真實上載 36 個 8 月更表 → guard-fix 收斂
// → 重新對數全月 → 重算介紹費 → 計長工糧）。呢個 gate 冇做呢步（成個
// pipeline 好重，`aug-e2e-check.ts` 頂註解已經記低步驟），對住一個未跑
// 過呢套流程嘅 dev DB（例如淨係 `db:seed` 嘅 7 月底），逐雞頭/逐盤會
// 見到大額「系統缺」差異——嗰個係環境未準備好，唔係 buildPostorderWorkbook()
// 本身嘅 bug（跟 aug-e2e-check.ts 同一個前提）。
//
// 比對對象：`data/2026-09/aug-payroll-trial/out/*.json`（8 月薪金試算
// oracle 輸出，同真 Postorder 總表逐格核對過，只讀，gitignored、冇真
// 姓名/工號）——同 aug-e2e-check.ts 用緊同一批檔案、同一個 EPS 容差。
//
// 呢個 gate 特別驗證嘅係 `buildPostorderWorkbook()`（`src/lib/reports/
// postorder-export.ts`）*本身*嘅輸出（`brokerPayouts`／`siteRevenueTotal`／
// `referralFeeTotal`），唔係再重新驗證底層 `buildPayrollTotals()`／
// `computeReferralFeesForMonth()`／`buildMonthlyClose()` 呢幾條 pure
// function（嗰啲已經係 aug-e2e-check.ts／gate:reports 嘅工作）——呢度
// 淨係證明 export 模組冇喺呢層之上再計錯/漏轉。
import fs from "node:fs";
import path from "node:path";
import { buildPostorderWorkbook, type PostorderSiteRevenue } from "@/lib/reports/postorder-export";
import { round2 } from "@/lib/reports/money";
import { SITE_ID_TO_CANONICAL_NAME } from "../opening/lib/site-code-map";

const TRIAL_OUT_DIR = path.resolve(process.cwd(), "data/2026-09/aug-payroll-trial/out");
const OUT_XLSX = path.resolve(process.cwd(), "out/postorder-export-aug.xlsx");
const AUG_MONTH = new Date(Date.UTC(2026, 7, 1));
const EPS = 0.5;

function readJson<T>(name: string): T {
  const p = path.join(TRIAL_OUT_DIR, name);
  if (!fs.existsSync(p)) throw new Error(`搵唔到參考檔 ${p}——呢個 gate 要 data/2026-09/aug-payroll-trial/out/ 存在（gitignored，見任務書）`);
  return JSON.parse(fs.readFileSync(p, "utf8")) as T;
}

type ByUnitEntry = { n: number; amt: number };
type RevenueSiteRow = { site_id: string; site: string; shifts: number; revenue_total: number };
type ReferralRow = { broker: string; recomputed: number };

interface DiffRow {
  label: string;
  system: number | string;
  reference: number | string;
  diff: number | string;
  ok: boolean;
}

async function main() {
  console.log(`[gate:postorder-export-aug] buildPostorderWorkbook(${AUG_MONTH.toISOString().slice(0, 7)}) 產生緊…`);
  const result = await buildPostorderWorkbook(AUG_MONTH);
  fs.mkdirSync(path.dirname(OUT_XLSX), { recursive: true });
  await result.workbook.xlsx.writeFile(OUT_XLSX);
  console.log(`[gate:postorder-export-aug] workbook 已寫去 ${OUT_XLSX}（${result.rosterRowCount} 行 Roster、4 個 sheet）`);

  const diffs: DiffRow[] = [];

  // ---- 逐雞頭付款（K/W/T/G/D/Y/B07）----
  const byUnit = readJson<{ by_unit: Record<string, ByUnitEntry> }>("broker_settlement.json").by_unit;
  const sysByCode = new Map(result.brokerPayouts.map((p) => [p.brokerCode || "(未歸屬)", p]));
  for (const code of ["K", "W", "T", "G", "D", "Y", "B07"]) {
    const sys = sysByCode.get(code)?.amount ?? 0;
    const ref = byUnit[code]?.amt ?? 0;
    const diff = round2(sys - ref);
    diffs.push({ label: `逐雞頭付款 ${code}`, system: sys, reference: ref, diff, ok: Math.abs(diff) < EPS });
  }

  // ---- 逐盤收入（44 個總表盤碼，逐個對，唔止 summary）----
  const revenueSite = readJson<RevenueSiteRow[]>("revenue_site.json");
  let refRevenueSum = 0;
  for (const r of revenueSite) refRevenueSum = round2(refRevenueSum + r.revenue_total);
  diffs.push({ label: "逐盤收入合計（siteRevenueTotal，Roster/PostOrder 逐行加總）", system: result.siteRevenueTotal, reference: refRevenueSum, diff: round2(result.siteRevenueTotal - refRevenueSum), ok: Math.abs(result.siteRevenueTotal - refRevenueSum) < EPS });

  // ---- 介紹費 ----
  const referralRows = readJson<ReferralRow[]>("referral_postorder.json");
  const refReferralTotal = round2(referralRows.reduce((a, r) => a + r.recomputed, 0));
  diffs.push({ label: "介紹費合計（referralFeeTotal）", system: result.referralFeeTotal, reference: refReferralTotal, diff: round2(result.referralFeeTotal - refReferralTotal), ok: Math.abs(result.referralFeeTotal - refReferralTotal) < EPS });
  diffs.push({ label: "介紹費行數（referral_postorder.json 行數 vs 系統 special_items 行數，見下面備註）", system: "—", reference: referralRows.length, diff: "—", ok: true });

  // ---- 印差異表 ----
  console.log("");
  console.log("[gate:postorder-export-aug] 差異表：");
  console.log("label | 系統 | 參考(總表 oracle) | 差額 | 結果");
  for (const d of diffs) {
    console.log(`${d.label} | ${d.system} | ${d.reference} | ${d.diff} | ${d.ok ? "PASS" : "FAIL"}`);
  }
  console.log("");

  // ---- 逐盤明細（44 個總表盤碼，淨係印對唔到嘅——已知落差見
  // aug-e2e-check.ts B5：Event 分盤、OT 記錄未折入、蔚峰園重複行、
  // 凱和山 Unbilled 判斷、CP5 IC proxy） ----
  const sysBySiteName = new Map<string, PostorderSiteRevenue>();
  for (const r of result.siteRevenue) sysBySiteName.set(r.siteName, r);
  const siteDiffRows: DiffRow[] = [];
  for (const r of revenueSite) {
    const name = SITE_ID_TO_CANONICAL_NAME[r.site_id] ?? r.site_id;
    const sys = sysBySiteName.get(name);
    const sysRevenue = sys?.revenue ?? 0;
    const diff = round2(sysRevenue - r.revenue_total);
    siteDiffRows.push({ label: `逐盤收入 ${name}（${r.site_id}）`, system: sys ? sysRevenue : "（系統缺）", reference: r.revenue_total, diff: sys ? diff : "n/a", ok: sys ? Math.abs(diff) < EPS : false });
  }
  const siteFails = siteDiffRows.filter((d) => !d.ok);
  console.log(`[gate:postorder-export-aug] 逐盤收入：${revenueSite.length - siteFails.length}/${revenueSite.length} 個盤 0 差（EPS=${EPS}），${siteFails.length} 個有差異：`);
  for (const d of siteFails) console.log(`  ${d.label} | 系統=${d.system} | 總表=${d.reference} | 差=${d.diff}`);
  console.log(
    "  已知落差（見 §19／aug-e2e-check.ts B5，唔算 export 模組 bug）：Event 分盤（啟航1331 Event 獨立成盤 vs 總表合併計）、OT 記錄未計入 record_type=shift 逐盤收入、蔚峰園更表重複行、凱和山 Unbilled 判斷、CP5 IC proxy 盤。",
  );
  diffs.push(...siteDiffRows);

  const fails = diffs.filter((d) => !d.ok);
  if (fails.length > 0) {
    console.log(`[gate:postorder-export-aug] FAIL — ${fails.length} 項對唔到 0 差（EPS=${EPS}）。`);
    console.log(
      "如果係環境未準備好（dev DB 未跑過 8 月 Part B 全套流程：db:reset/seed → build/apply-aug-plan → 真實上載 36 個 8 月更表 → guard-fix 收斂 → 重新對數全月 → 重算介紹費），呢啲差異係預期（系統側全部/大部分係 0），唔係 buildPostorderWorkbook() 本身嘅 bug——見 scripts/gate/aug-e2e-check.ts 頂註解同一個前提。跑完 Part B 之後再跑呢個 gate 先應該 0 差。",
    );
    process.exitCode = 1;
  } else {
    console.log("[gate:postorder-export-aug] PASS — 逐雞頭付款／逐盤收入合計／介紹費合計全部 0 差。");
  }
}

main()
  .catch((err) => {
    console.error("[gate:postorder-export-aug] 執行失敗：", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    const { prisma } = await import("@/lib/db");
    await prisma.$disconnect();
  });
