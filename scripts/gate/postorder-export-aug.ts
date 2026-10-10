// §20.4 Phase 4：`buildPostorderWorkbook()` 8 月差異 gate——`npm run
// gate:postorder-export-aug`。
//
// **前置條件**（同 `scripts/gate/aug-e2e-check.ts` 完全一樣，呢個 gate
// 淨係讀，唔會自己去做）：dev DB 要已經行完 8 月 Part B 全套流程（db:reset
// /seed → build/apply-aug-plan → 真實上載 36 個 8 月更表 → guard-fix 收斂
// → 重新對數全月 → 重算介紹費 → 計長工糧）。對住一個未跑過呢套流程嘅
// dev DB，逐雞頭/逐盤會見到大額「系統缺」差異——嗰個係環境未準備好，
// 唔係 buildPostorderWorkbook() 本身嘅 bug。
//
// 比對對象：`data/2026-09/aug-payroll-trial/out/*.json`（8 月薪金試算
// oracle 輸出，同真 Postorder 總表逐格核對過，只讀，gitignored、冇真
// 姓名/工號）——同 aug-e2e-check.ts 用緊同一批檔案、同一個 EPS 容差。
//
// 呢個 gate 特別驗證嘅係 `buildPostorderWorkbook()`（`src/lib/reports/
// postorder-export.ts`）*本身*嘅輸出，唔係再重新驗證底層
// `buildPayrollTotals()`／`computeReferralFeesForMonth()`／
// `buildMonthlyClose()` 呢幾條 pure function（嗰啲已經係
// aug-e2e-check.ts／gate:reports 嘅工作）——呢度淨係證明 export 模組
// 冇喺呢層之上再計錯/漏轉。
//
// **KNOWN 分類**：§19／aug-e2e-check.ts B5 已經記錄低嘅「更表資料本身
// 問題」（OT 未折入逐盤收入、蔚峰園重複行、凱和山 Unbilled、Weave 漏記
// 病假；Event 分盤而家對總表前合返母盤，唔再係落差）——呢啲差額喺呢個 gate 顯示做 KNOWN（唔算
// FAIL，唔會令 exit code 非 0），但金額同任務書/文件記錄嘅唔一致
// （超出 `KNOWN_TOLERANCE`）就照樣 FAIL，唔會靜靜放過新落差。
import fs from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";
import { buildPostorderWorkbook, type PostorderSiteRevenue } from "@/lib/reports/postorder-export";
import { computeReferralFeesForMonth } from "@/lib/reports/referral-fee";
import { buildPayrollTotals } from "@/lib/reports/payroll";
import { buildMonthlyClose } from "@/lib/reports/monthly-close";
import { round2 } from "@/lib/reports/money";
import { prisma } from "@/lib/db";
import { SITE_ID_TO_CANONICAL_NAME } from "../opening/lib/site-code-map";

const TRIAL_OUT_DIR = path.resolve(process.cwd(), "data/2026-09/aug-payroll-trial/out");
const OUT_XLSX = path.resolve(process.cwd(), "out/postorder-export-aug.xlsx");
const AUG_MONTH = new Date(Date.UTC(2026, 7, 1));
const EPS = 0.5;
const KNOWN_TOLERANCE = 5; // 已知落差嘅金額容差（文件記錄嘅數同呢次實測可以有幾蚊嘅四捨五入差）

function readJson<T>(name: string): T {
  const p = path.join(TRIAL_OUT_DIR, name);
  if (!fs.existsSync(p)) throw new Error(`搵唔到參考檔 ${p}——呢個 gate 要 data/2026-09/aug-payroll-trial/out/ 存在（gitignored，見任務書）`);
  return JSON.parse(fs.readFileSync(p, "utf8")) as T;
}

type ByUnitEntry = { n: number; amt: number };
type RevenueSiteRow = { site_id: string; site: string; shifts: number; revenue_total: number };
type ReferralRow = { row: number; broker: string; rate: number; shifts: number; recomputed: number; site_ids: string[] };

type Status = "PASS" | "FAIL" | "KNOWN";
interface DiffRow {
  label: string;
  system: number | string;
  reference: number | string;
  diff: number | string;
  status: Status;
}

/** §19／aug-e2e-check.ts B5／docs/api.md 已經記錄低嘅逐雞頭已知落差（更表
 * 資料問題，唔關 export 模組事）。 */
// Opus 5.5 驗收（2026-09-27）：原本有 `K: -11,440「CP5 IC proxy」` 呢個
// KNOWN——實查唔係 CP5 IC：係 `gate:ltpay-aug` 舊版冇 `guard_fix_runs`
// 記錄 → Postorder 唔當權威 → 一位長工 13 格啟航1331 散更（880）被 ≥50%
// 推算崗位錯歸 B07。修咗 pipeline（改行一鍵 `stepGuardFix()`）之後 K 0 差，
// 呢個 KNOWN 刪走——再出現就係真 FAIL。
const KNOWN_BROKER_DIFFS: Record<string, { expected: number; note: string }> = {
  W: { expected: -850, note: "淺水灣道11號蔚峰園更表重複行（同一人同日同更兩行，系統 unique 淨記一更）" },
  T: { expected: -1600, note: "Weave Hospital Road 更表漏記病假 2 格（老闆確認 T 頂）" },
};
const KNOWN_REFERRAL_DIFF = { expected: 100, note: "Weave 更表漏記 2 格介紹費（docs/api.md：60,520+100=60,620）" };
// WP-BOSS5 §25.7（老闆 2026-09-28 追加決定 #7）：OT 已經折入 Roster／
// siteRevenue（`revenue` 含 OT），HKU座頭 OT（1Hr OT，84.85／更）呢個
// KNOWN 刪走——對總表 (C，下面「逐盤收入」section，用含 OT 嘅 `revenue`)
// 而家應該 0 差；再出現就係真 FAIL。
const KNOWN_SITE_DIFFS: Record<string, { expected: number; note: string }> = {
  屯門凱和山: { expected: 871, note: "Postorder 8/21 夜更標唔收客（Unbilled），系統照逐更收客卡計" },
  淺水灣道11號蔚峰園: { expected: -935, note: "更表重複行（同 W 雞頭差額同一根源）" },
};

function classify(diff: number, known: { expected: number } | undefined): Status {
  if (Math.abs(diff) < EPS) return "PASS";
  if (known && Math.abs(diff - known.expected) < KNOWN_TOLERANCE) return "KNOWN";
  return "FAIL";
}

async function main() {
  console.log(`[gate:postorder-export-aug] buildPostorderWorkbook(${AUG_MONTH.toISOString().slice(0, 7)}) 產生緊…`);
  const result = await buildPostorderWorkbook(AUG_MONTH);

  // Opus 5.5 覆核應修 c：Roster 0 行＝dev DB 根本未載 8 月 shift_records
  // （呢個 gate 嘅前置條件——見檔頭註解——係已經行完 db:reset/seed→
  // 8 月上載→guard-fix→重新對數全月→介紹費→長工糧成套流程；未行過呢套
  // 流程嘅 dev DB 逐雞頭/逐盤全部係「系統缺」）。呢種情況下面成套 diff
  // 邏輯會逐項噴 FAIL（83 項見過），淨係擾亂視線、冇任何診斷價值——
  // 直接喺呢度截停，出一句明確嘅指示，等操作員知道要先跑
  // `npm run gate:ltpay-aug`（呢個 script 會自己 reset→開 8 月→上載→
  // guard-fix→對數→長工糧，跑完先至有嘢俾呢個 gate 比對）。
  if (result.rosterRowCount === 0) {
    console.error("[gate:postorder-export-aug] FAIL — Roster 0 行：dev DB 未載 8 月數據，先跑 npm run gate:ltpay-aug。");
    process.exitCode = 1;
    return;
  }

  fs.mkdirSync(path.dirname(OUT_XLSX), { recursive: true });
  await result.workbook.xlsx.writeFile(OUT_XLSX);
  console.log(`[gate:postorder-export-aug] workbook 已寫去 ${OUT_XLSX}（${result.rosterRowCount} 行 Roster、4 個 sheet）`);

  const diffs: DiffRow[] = [];

  // ---- (A) 系統內部一致性（嚴格 0 差，冇 KNOWN）：Summary 逐雞頭＝
  // 糧單頁／一鍵報告同一個 buildPayrollTotals()；Roster 逐盤＝月結總表；
  // Summary 總收入／成本／毛利＝最新一鍵結算報告 report_json。全部由寫出
  // 嘅 xlsx 讀返（驗證寫檔冇漏轉），唔係淨睇 in-memory 結果。----
  const wbBack = new ExcelJS.Workbook();
  await wbBack.xlsx.readFile(OUT_XLSX);
  const strict = (label: string, sys: number, ref: number) => {
    const diff = round2(sys - ref);
    diffs.push({ label, system: sys, reference: ref, diff, status: Math.abs(diff) < 0.005 ? "PASS" : "FAIL" });
  };
  const sumRows: unknown[][] = [];
  wbBack.getWorksheet("Summary")!.eachRow({ includeEmpty: true }, (r, i) => {
    sumRows[i] = (r.values as unknown[]).slice(1);
  });
  const hdr = sumRows.findIndex((r) => r?.[0] === "雞頭代碼");
  const xlsxBroker = new Map<string, number>();
  let ri = hdr + 1;
  for (; sumRows[ri] && sumRows[ri][1] !== "合計"; ri++) xlsxBroker.set(String(sumRows[ri][0]), Number(sumRows[ri][5]));
  const halfHdr = sumRows.findIndex((r, i) => i > ri && r?.[0] === "雞頭代碼");
  const xlsxHalf = new Map<string, number>();
  for (let h = halfHdr + 1; sumRows[h]?.[0]; h++) xlsxHalf.set(String(sumRows[h][0]), round2(Number(sumRows[h][1] ?? 0) + Number(sumRows[h][2] ?? 0)));
  for (const t of await buildPayrollTotals(AUG_MONTH)) {
    const code = t.brokerCode || "—";
    strict(`[內部] Summary 逐雞頭 ${code} vs 糧單頁 buildPayrollTotals()`, xlsxBroker.get(code) ?? NaN, t.amount);
    if (t.brokerCode) strict(`[內部] 半月結 01-15＋16-31 ${code} vs 全月`, xlsxHalf.get(code) ?? 0, t.amount);
  }
  const close = await buildMonthlyClose(AUG_MONTH);
  // WP-BOSS5 §25.7（老闆 2026-09-28 追加決定 #7）：OT 而家折入 Roster／
  // siteRevenue（`revenue` 含 OT），但 `buildMonthlyClose()`（P0 口徑）
  // 刻意唔含 OT——呢兩個內部檢查（逐盤／Roster Σ）改比 `revenue −
  // otRevenue`，先至係同 `buildMonthlyClose()` 同一口徑嘅嚴格 0 差。
  const sysSite = new Map(result.siteRevenue.map((r) => [r.siteId, round2(r.revenue - r.otRevenue)]));
  const closeSites = [...close.mainRows, ...close.outsideRows];
  for (const r of closeSites) strict(`[內部] 逐盤收入（剔 OT）${r.canonicalName} vs 月結總表`, sysSite.get(r.siteId) ?? 0, r.revenue);
  for (const r of result.siteRevenue) if (!closeSites.some((c) => c.siteId === r.siteId)) strict(`[內部] 逐盤收入（剔 OT）${r.siteName}（月結總表冇呢個盤）`, round2(r.revenue - r.otRevenue), 0);
  const otRevenueTotal = round2(result.siteRevenue.reduce((a, r) => a + r.otRevenue, 0));
  {
    const ros = wbBack.getWorksheet("Roster")!;
    const head = (ros.getRow(1).values as unknown[]).slice(1);
    const revCol = head.indexOf("當月收入") + 1;
    let rosterRev = 0;
    ros.eachRow((r, i) => {
      if (i > 1) rosterRev += Number(r.getCell(revCol).value ?? 0);
    });
    strict("[內部] Roster Σ當月收入（剔 OT）vs 月結總表總收入", round2(rosterRev - otRevenueTotal), round2(closeSites.reduce((a, r) => a + r.revenue, 0)));
  }
  const lastRun = await prisma.monthCloseRun.findFirst({ where: { month: AUG_MONTH, status: "done" }, orderBy: { finishedAt: "desc" }, select: { reportJson: true } });
  const report = lastRun?.reportJson as { totals?: { revenue: number; marginRevenue: number; cost: number; grossMargin: number }; payrollByBroker?: Array<{ brokerCode: string; amount: number }>; referralFee?: { total: number }; longtermPayroll?: Record<string, number> | null } | null;
  if (report?.totals) {
    const t = result.summaryTotals;
    strict("[內部] Summary 總收入 vs 一鍵報告", t.revenue, report.totals.revenue);
    strict("[內部] Summary 毛利口徑營業額 vs 一鍵報告", t.marginRevenue, report.totals.marginRevenue);
    strict("[內部] Summary 總成本 vs 一鍵報告", t.cost, report.totals.cost);
    strict("[內部] Summary 毛利 vs 一鍵報告", t.grossMargin, report.totals.grossMargin);
    for (const p of report.payrollByBroker ?? []) strict(`[內部] Summary 逐雞頭 ${p.brokerCode || "—"} vs 一鍵報告`, xlsxBroker.get(p.brokerCode || "—") ?? NaN, p.amount);
    if (report.referralFee) strict("[內部] 介紹費 vs 一鍵報告", result.referralFeeTotal, report.referralFee.total);
    const ltRow = (label: string) => Number(sumRows.find((r) => r?.[0] === label)?.[1] ?? NaN);
    if (report.longtermPayroll) {
      strict("[內部] 長工糧 Gross vs 一鍵報告", ltRow("Gross"), report.longtermPayroll.grossTotal);
      strict("[內部] 長工糧 Autopay vs 一鍵報告", ltRow("Autopay"), report.longtermPayroll.autopayTotal);
      strict("[內部] 長工糧 MPF EE vs 一鍵報告", ltRow("MPF 僱員 (EE)"), report.longtermPayroll.mpfEeTotal);
      strict("[內部] 長工糧 MPF ER vs 一鍵報告", ltRow("MPF 僱主 (ER)"), report.longtermPayroll.mpfErTotal);
    }
  } else {
    console.log("[gate:postorder-export-aug] 注意：本月未有完成嘅一鍵結算 run（report_json），Summary 總收入／成本／毛利未對一鍵報告——想對就先撳一次一鍵結算");
  }

  // ---- 逐雞頭付款（K/W/T/G/D/Y/B07）----
  const byUnit = readJson<{ by_unit: Record<string, ByUnitEntry> }>("broker_settlement.json").by_unit;
  const sysByCode = new Map(result.brokerPayouts.map((p) => [p.brokerCode || "(未歸屬)", p]));
  for (const code of ["K", "W", "T", "G", "D", "Y", "B07"]) {
    const sys = sysByCode.get(code)?.amount ?? 0;
    const ref = byUnit[code]?.amt ?? 0;
    const diff = round2(sys - ref);
    diffs.push({ label: `逐雞頭付款 ${code}`, system: sys, reference: ref, diff, status: classify(diff, KNOWN_BROKER_DIFFS[code]) });
  }

  // ---- 逐盤收入（44 個總表盤碼，逐個對，唔止 summary）----
  const revenueSite = readJson<RevenueSiteRow[]>("revenue_site.json");
  let refRevenueSum = 0;
  for (const r of revenueSite) refRevenueSum = round2(refRevenueSum + r.revenue_total);
  {
    const diff = round2(result.siteRevenueTotal - refRevenueSum);
    diffs.push({ label: "逐盤收入合計（siteRevenueTotal，Roster/PostOrder 逐行加總）", system: result.siteRevenueTotal, reference: refRevenueSum, diff, status: classify(diff, { expected: round2(Object.values(KNOWN_SITE_DIFFS).reduce((a, k) => a + k.expected, 0)) }) });
  }

  // ---- 介紹費合計 ----
  const referralRows = readJson<ReferralRow[]>("referral_postorder.json");
  const refReferralTotal = round2(referralRows.reduce((a, r) => a + r.recomputed, 0));
  {
    const diff = round2(result.referralFeeTotal - refReferralTotal);
    diffs.push({ label: "介紹費合計（referralFeeTotal）", system: result.referralFeeTotal, reference: refReferralTotal, diff, status: classify(diff, KNOWN_REFERRAL_DIFF) });
  }

  // ---- 印差異表（逐雞頭／合計）----
  console.log("");
  console.log("[gate:postorder-export-aug] 差異表：");
  console.log("label | 系統 | 參考(總表 oracle) | 差額 | 結果");
  for (const d of diffs) {
    const note = d.status === "KNOWN" ? "（已知落差，見下面備註，唔計 FAIL）" : "";
    console.log(`${d.label} | ${d.system} | ${d.reference} | ${d.diff} | ${d.status}${note}`);
  }
  console.log("");

  // ---- 逐盤明細（44 個總表盤碼）----
  // Event 分盤（「X Event」）喺總表 44 碼表同母盤 X 同一個盤碼合併計——
  // 對總表時先合返落母盤（Roster 呈現亦係放喺母盤 block，見
  // postorder-export.ts `eventParentAlias`）。
  const sysBySiteName = new Map<string, PostorderSiteRevenue>();
  for (const r of result.siteRevenue) sysBySiteName.set(r.siteName, { ...r });
  for (const r of result.siteRevenue) {
    const m = /^(.+?)\s+Event$/.exec(r.siteName);
    const parent = m ? sysBySiteName.get(m[1]) : undefined;
    if (parent) {
      parent.revenue = round2(parent.revenue + r.revenue);
      parent.shifts += r.shifts;
    }
  }
  const siteDiffRows: DiffRow[] = [];
  for (const r of revenueSite) {
    const name = SITE_ID_TO_CANONICAL_NAME[r.site_id] ?? r.site_id;
    const sys = sysBySiteName.get(name);
    const sysRevenue = sys?.revenue ?? 0;
    const diff = round2(sysRevenue - r.revenue_total);
    const known = KNOWN_SITE_DIFFS[name];
    siteDiffRows.push({ label: `逐盤收入 ${name}（${r.site_id}）`, system: sys ? sysRevenue : "（系統缺）", reference: r.revenue_total, diff: sys ? diff : "n/a", status: sys ? classify(diff, known) : "FAIL" });
  }
  const siteNotPass = siteDiffRows.filter((d) => d.status !== "PASS");
  console.log(`[gate:postorder-export-aug] 逐盤收入：${revenueSite.length - siteNotPass.length}/${revenueSite.length} 個盤 0 差（EPS=${EPS}），${siteNotPass.length} 個有差異（見下面 status）：`);
  for (const d of siteNotPass) {
    const known = KNOWN_SITE_DIFFS[d.label.split("逐盤收入 ")[1]?.split("（")[0] ?? ""];
    console.log(`  ${d.label} | 系統=${d.system} | 總表=${d.reference} | 差=${d.diff} | ${d.status}${known ? `（${known.note}）` : ""}`);
  }
  diffs.push(...siteDiffRows);

  // ---- 介紹費逐行（21 行，雞頭＋盤＋金額）----
  // referral_postorder.json 每一「row」對應 Postorder 總表「長工雞頭費」
  // 表入面一個 formula 格，可以覆蓋 1 個或多個 site_id（同一雞頭、同一盤
  // 組合先合埋一行，例：啟航1331(S017) 逐雞頭有 5-7 行，係逐更表檔／
  // 逐批分開寫嘅同一 (broker,site) 費率行）。冇保安員身份可以做 join key
  // （PDPO：呢個 oracle JSON 冇工號/姓名），最幼嘅一致比對粒度就係
  // (broker, site_ids 組合) 複合鍵——同 key 嘅多行加埋先比。
  console.log("");
  console.log(`[gate:postorder-export-aug] 介紹費逐行（21 行 → 用 (雞頭,盤組合) 複合鍵合併重複行，冇工號/姓名做 join key，見上面註解）：`);
  const refByComposite = new Map<string, { broker: string; siteKey: string; siteNames: string; shifts: number; recomputed: number; rowCount: number }>();
  for (const r of referralRows) {
    const siteNames = r.site_ids.map((id) => SITE_ID_TO_CANONICAL_NAME[id] ?? id).join("+");
    const key = `${r.broker}|${siteNames}`;
    const cur = refByComposite.get(key);
    if (cur) {
      cur.shifts += r.shifts;
      cur.recomputed = round2(cur.recomputed + r.recomputed);
      cur.rowCount++;
    } else {
      refByComposite.set(key, { broker: r.broker, siteKey: siteNames, siteNames, shifts: r.shifts, recomputed: r.recomputed, rowCount: 1 });
    }
  }
  const referralResult = await computeReferralFeesForMonth(AUG_MONTH);
  const brokers = await prisma.broker.findMany({ select: { id: true, code: true } });
  const brokerCodeById = new Map(brokers.map((b) => [b.id, b.code]));
  const sites = await prisma.site.findMany({ select: { id: true, canonicalName: true } });
  const siteNameByIdMap = new Map(sites.map((s) => [s.id, s.canonicalName]));
  // 逐 (brokerCode, siteName) 單一盤先聚合（唔直接砌返複合鍵）——多盤
  // 嘅參考行（例：row25 K 跨數碼港CP5+數碼港數據中心）逐個 site_ids
  // 拆開加埋嚟同呢個 map 對，避免「複合鍵字面唔啱就當缺」嘅假陰性。
  const sysBySingle = new Map<string, { shifts: number; amount: number }>();
  for (const li of referralResult.lineItems) {
    const brokerCode = brokerCodeById.get(li.brokerId) ?? li.brokerId;
    const siteName = siteNameByIdMap.get(li.siteId) ?? li.siteId;
    const key = `${brokerCode}|${siteName}`;
    const cur = sysBySingle.get(key);
    if (cur) {
      cur.shifts += li.shifts;
      cur.amount = round2(cur.amount + li.amount);
    } else {
      sysBySingle.set(key, { shifts: li.shifts, amount: li.amount });
    }
  }
  const KNOWN_REFERRAL_LINE_DIFFS: Record<string, { expected: number; note: string }> = {
    "T|Weave Hospital Road": { expected: 100, note: "Weave 更表漏記 2 格（同上面「介紹費合計」KNOWN 同一根源）" },
  };
  let referralLineMatched = 0;
  let referralLineKnown = 0;
  let referralLineTotal = 0;
  for (const [key, ref] of refByComposite) {
    referralLineTotal++;
    // 逐個 site_ids 拆開加埋（一個 broker 可以喺多個盤各自有 lineItem）
    const brokerSingleKeys = ref.siteNames.split("+").map((siteName) => `${ref.broker}|${siteName}`);
    let sysAmount = 0;
    let sysShifts = 0;
    let anyFound = false;
    for (const k of brokerSingleKeys) {
      const v = sysBySingle.get(k);
      if (v) {
        anyFound = true;
        sysAmount = round2(sysAmount + v.amount);
        sysShifts += v.shifts;
      }
    }
    const diff = round2(sysAmount - ref.recomputed);
    // 驗收：更數都要一致（唔係淨睇金額——費率唔同嘅兩批人可以金額啱但更數錯）。
    const known = KNOWN_REFERRAL_LINE_DIFFS[key];
    let status: Status = anyFound ? classify(diff, known) : "FAIL";
    if (status === "PASS" && sysShifts !== ref.shifts) status = "FAIL";
    if (status === "PASS") referralLineMatched++;
    else if (status === "KNOWN") referralLineKnown++;
    console.log(
      `  ${key}（原始 ${ref.rowCount} 行）| 系統更數=${anyFound ? sysShifts : "（缺）"} 金額=${anyFound ? sysAmount : "（缺）"} | 總表更數=${ref.shifts} 金額=${ref.recomputed} | 差=${anyFound ? diff : "n/a"} | ${status}`,
    );
    if (status === "FAIL") diffs.push({ label: `介紹費逐行 ${key}`, system: anyFound ? sysAmount : "（缺）", reference: ref.recomputed, diff: anyFound ? diff : "n/a", status });
  }
  console.log(
    `[gate:postorder-export-aug] 介紹費逐行：${referralLineTotal} 個複合鍵（由 21 原始行合併）、${referralLineMatched} 個 0 差、${referralLineKnown} 個已知落差、${referralLineTotal - referralLineMatched - referralLineKnown} 個未解釋差異。`,
  );

  const fails = diffs.filter((d) => d.status === "FAIL");
  if (fails.length > 0) {
    console.log("");
    console.log(`[gate:postorder-export-aug] FAIL — ${fails.length} 項對唔到 0 差且唔係已知落差（EPS=${EPS}，已知落差容差=${KNOWN_TOLERANCE}）。`);
    process.exitCode = 1;
  } else {
    console.log("");
    console.log("[gate:postorder-export-aug] PASS — 逐雞頭付款／逐盤收入／介紹費全部 0 差或者係已記錄嘅已知落差（見上面 KNOWN 標記）。");
  }
}

main()
  .catch((err) => {
    console.error("[gate:postorder-export-aug] 執行失敗：", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
