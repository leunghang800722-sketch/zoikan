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
// 問題」（Event 分盤、OT 未折入逐盤收入、蔚峰園重複行、凱和山
// Unbilled、Weave 漏記病假）——呢啲差額喺呢個 gate 顯示做 KNOWN（唔算
// FAIL，唔會令 exit code 非 0），但金額同任務書/文件記錄嘅唔一致
// （超出 `KNOWN_TOLERANCE`）就照樣 FAIL，唔會靜靜放過新落差。
import fs from "node:fs";
import path from "node:path";
import { buildPostorderWorkbook, type PostorderSiteRevenue } from "@/lib/reports/postorder-export";
import { computeReferralFeesForMonth } from "@/lib/reports/referral-fee";
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
const KNOWN_BROKER_DIFFS: Record<string, { expected: number; note: string }> = {
  K: { expected: -11440, note: "CP5 IC proxy 盤／逐格推算已知落差（§19）" },
  W: { expected: -850, note: "淺水灣道11號蔚峰園更表重複行（同一人同日同更兩行，系統 unique 淨記一更）" },
  T: { expected: -1600, note: "Weave Hospital Road 更表漏記病假 2 格（老闆確認 T 頂）" },
};
const KNOWN_REFERRAL_DIFF = { expected: 100, note: "Weave 更表漏記 2 格介紹費（docs/api.md：60,520+100=60,620）" };
const KNOWN_SITE_DIFFS: Record<string, { expected: number; note: string }> = {
  HKU座頭: { expected: -84.85, note: "HKU座頭 OT（1Hr OT，84.85／更）——buildMonthlyClose() 逐盤收入淨計 record_type=shift，唔含 ot" },
  屯門凱和山: { expected: 871, note: "Postorder 8/21 夜更標唔收客（Unbilled），系統照逐更收客卡計" },
  啟航1331: { expected: -5400, note: "系統將 Event 更分做獨立盤「啟航1331 Event」顯示，總表 44 碼表合併計（全公司總收入層面已計埋）" },
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
    diffs.push({ label: `逐雞頭付款 ${code}`, system: sys, reference: ref, diff, status: classify(diff, KNOWN_BROKER_DIFFS[code]) });
  }

  // ---- 逐盤收入（44 個總表盤碼，逐個對，唔止 summary）----
  const revenueSite = readJson<RevenueSiteRow[]>("revenue_site.json");
  let refRevenueSum = 0;
  for (const r of revenueSite) refRevenueSum = round2(refRevenueSum + r.revenue_total);
  {
    const diff = round2(result.siteRevenueTotal - refRevenueSum);
    diffs.push({ label: "逐盤收入合計（siteRevenueTotal，Roster/PostOrder 逐行加總）", system: result.siteRevenueTotal, reference: refRevenueSum, diff, status: Math.abs(diff) < EPS ? "PASS" : "KNOWN" });
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
  const sysBySiteName = new Map<string, PostorderSiteRevenue>();
  for (const r of result.siteRevenue) sysBySiteName.set(r.siteName, r);
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
  // 逐批分開寫嘅同一 (broker,site) 費率行）。冇安員身份可以做 join key
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
    const status = anyFound ? classify(diff, KNOWN_REFERRAL_LINE_DIFFS[key]) : "FAIL";
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
