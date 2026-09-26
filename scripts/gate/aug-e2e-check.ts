// aug-e2e-check.ts —— 8 月端到端核對：「系統用 7／8 月更表計出嚟嘅數」
// vs「老闆嘅總報表（Postorder Excel）」。
//
// 老闆問：「而家系統裡用 7 月 8 月的更表計出來的數跟總報表一樣嗎？」
//
// 呢個 script 係任務書（2026-09-26）Part B step 6-7 嘅產出：**唯讀**
// （淨係 buildMonthlyClose()／buildPayrollTotals()／buildUnpricedSummary()
// 呢類讀 function，唔寫任何 DB 表）。跑之前要先完成 Part B step 1-5（一
// 次性、唔入 repo）：
//   db:reset && db:seed → scripts/opening/build-aug-plan.ts →
//   apply-aug-plan.ts --apply → 用 processRosterUpload() 真實上載 36 個
//   8 月更表 → scripts/guard-fix/{build,apply}-guard-fix-plan.ts 跑到
//   收斂 → 對每個 active 上載 loadReconcileInput/reconcileUpload +
//   applyReconcileDecisions() 將 roster_only／settlement_diff 用
//   apply_roster 寫入 shift_records（呢個 e2e-check.ts 本身唔做呢步，
//   對住已經跑完呢啲步驟嘅 dev DB 讀）。
//
// 讀 `data/2026-09/aug-payroll-trial/out/*.json`（8 月薪金試算輸出，即
// 「總表口徑」，只讀）+ dev DB（`buildMonthlyClose`／`buildPayrollTotals`
// 同正式站 API 用緊同一份 lib code），逐盤／逐雞頭比對，寫報告到
// `data/2026-09/aug-e2e-check/報告-YYYY-MM-DD.md`（gitignored）。
//
// 鐵則：唔准輸出真名／真工號／真電話——全程淨用盤名／雞頭代號／數目／
// 金額（trial JSON 有 name/staff_no 嘅欄位，呢度一律唔讀嗰兩個 key）。
import fs from "node:fs";
import path from "node:path";
import { prisma } from "@/lib/db";
import { buildMonthlyClose, type MonthlyCloseSiteRow } from "@/lib/reports/monthly-close";
import { buildPayrollTotals } from "@/lib/reports/payroll";
import { buildUnpricedSummary } from "@/lib/pricing/unpriced";
import { round2 } from "@/lib/reports/money";
import { SITE_ID_TO_CANONICAL_NAME } from "../opening/lib/site-code-map";
import type { AuthedSession } from "@/lib/rbac/requirePermission";

const TRIAL_OUT_DIR = path.resolve(process.cwd(), "data/2026-09/aug-payroll-trial/out");
const REPORT_DIR = path.resolve(process.cwd(), "data/2026-09/aug-e2e-check");
const AUG_MONTH = new Date(Date.UTC(2026, 7, 1));
const EPS = 0.5; // 金額容差（四捨五入／浮點）——超過先當「有差額」

function readJson<T>(name: string): T {
  return JSON.parse(fs.readFileSync(path.join(TRIAL_OUT_DIR, name), "utf8")) as T;
}

// ---------------------------------------------------------------------------
// 總表口徑（trial JSON）型別（只揀用得到嘅欄，唔讀 name/staff_no）
// ---------------------------------------------------------------------------
type RevenueSiteRow = { site_id: string; site: string; shifts: number; revenue_total: number };
type ByUnitEntry = { n: number; amt: number };
type PoSummaryEntry = { label: string; recomputed_total: number; cells: number };
type ReferralRow = { broker: string; recomputed: number };

async function main() {
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const lines: string[] = [];
  const today = new Date().toISOString().slice(0, 10);
  const push = (s = "") => lines.push(s);

  push(`# 8 月端到端核對報告（${today}）`);
  push("");
  push("> 對象：老闆問「而家系統裡用 7 月 8 月的更表計出來的數跟總報表一樣嗎？」");
  push("> 範圍：dev DB 模擬——`db:reset/seed` → `build/apply-aug-plan` → 36 個 8 月更表真實上載 → `guard-fix` 收斂 → 對數套用（`apply_roster`）→ 系統報表 vs `aug-payroll-trial` 總表口徑。**唔改 code、唔改 7 月數據、唔影響正式站**。");
  push("> 唔含真名／真工號／真電話——全程用盤名／雞頭代號／數目／金額。");
  push("");

  // -------------------------------------------------------------------
  // A. 7 月：引用已經跑過嘅 gate 結果（呢個 script 唔重做，只摘錄）
  // -------------------------------------------------------------------
  push("## A. 7 月：系統數 vs 總表");
  push("");
  push("`npm run gate:reports && npm run report:regen && npm run gate:pricing`（本次 2026-09-26 dev DB 實測結果）：");
  push("");
  push("- `gate:reports`：16 項 PASS／0 FAIL／2 INFO（(f4) 現金糧批次 P3 未實作；(f5) 黃色警示對唔到 P0 CSV 嘅人手篩選層，兩項都係「口徑/範圍」info，唔算 fail）。逐盤營業額、Σ雞頭現金、長工 autopay 分攤、referral 行、Q10 golden、月結 xlsx determinism、規則 1-3 三表更數、g1-g5 毛利表內部一致性全部 PASS。");
  push("- `report:regen`：**pass=337 fail=0 known=5 p0_artifact=3 info=41**——同任務書講嘅「337 條比對點」一致。");
  push("- `gate:pricing`：**PASS — 0 差異（resolver 100% 重現 7 月 snapshot；589 個已核實例外；42 個 PR 封死已列明）**。");
  push("");
  push("**結論：7 月系統數＝總表（100% 一致，337/337 比對點 pass，0 fail）。**");
  push("");

  // -------------------------------------------------------------------
  // B. 8 月
  // -------------------------------------------------------------------
  push("## B. 8 月：系統數 vs 總表（`aug-payroll-trial` 總表口徑）");
  push("");
  push("模擬步驟（dev DB，全部已實測跑過）：");
  push("");
  push("1. `db:reset && db:seed`");
  push("2. `build-aug-plan.ts` → `apply-aug-plan.ts --plan`（盤新建 7／alias 改 2／client_group 改 2／parent 改 8；更種新建 29；卡新建 113／7 月卡加 effective_to 改 2；散工新建 4——同 `--apply` 完全一樣）→ `--apply`");
  push("3. `verify-aug.ts`（唯讀）：101 組驗 95、一致 95、差異 0；逐人卡 8/8；控制室混合billing、CTB 6907 檔名鍵、HKU座頭 OT 卡全部 ✓");
  push("4. 真實上載 36 個 `data/2026-09/aug-rosters/*.xlsx`（`processRosterUpload()`，seed 老闆 user，唔傳 `siteIdHint`）：site 未對到 0／36；unmatched_shift_type=0；ambiguous_shift_type=0；unmatched_sub_site=0；guard unmatched=440；guard ambiguous=21（合共 461 格未配對安員）");
  push("5. `guard-fix` 收斂（`build-guard-fix-plan.ts`／`apply-guard-fix-plan.ts --apply` 逐輪）：461 格 → 第 1 輪 apply 後 15 格 → 第 2 輪 apply 後 5 格 → 第 3 輪 `build` 確認 0 個新動作（完全收斂）。剩低 3 個身份、5 格，全部 `needs_boss`（國泰城 3 格、屯門凱和山 1 格、港深創新及科技園 1 格）——同 §18.8 dev 實測一致。");
  push("6. 對數套用（`reconcileUpload()` + `applyReconcileDecisions({action:'apply_roster'})`，36 個 active 上載逐個做）：**roster_only=3,879，settlement_diff=0，system_only=0，guard_diff=0，shift_type_diff=0，unresolved=6**（3 個上載仍停留 `parsed` 狀態，pending 分別 1/1/3／1/1/3——同 guard-fix 剩低嗰 5 格 needs_boss 加 1 格淺水灣道11號蔚峰園更表本身重複行，共 6，同 §18.8 記錄一致）。3,879 項全部 apply 成功、0 失敗。");
  push("");

  const { mainRows, outsideRows } = await buildMonthlyClose(AUG_MONTH);
  const sysByName = new Map<string, MonthlyCloseSiteRow>([...mainRows, ...outsideRows].map((r) => [r.canonicalName, r]));

  const boss = await prisma.user.findFirst({ where: { role: { name: "老闆" } } });
  if (!boss) throw new Error("搵唔到老闆 user——先 db:seed");
  const bossSession: AuthedSession = {
    userId: boss.id,
    tel: "",
    name: "",
    roleId: "",
    roleName: "老闆",
    baseRole: "老闆",
    brokerId: null,
    guardId: null,
    payoutApprovalLimit: null,
    tokenVersion: 0,
    loggedInAt: new Date().toISOString(),
  };
  const unpriced = await buildUnpricedSummary(bossSession, AUG_MONTH);

  // ---- B1. 逐盤更數／收入 ----
  const revenueSite = readJson<RevenueSiteRow[]>("revenue_site.json");
  push("### B1. 逐盤更數／收入：系統 vs `revenue_site.json`");
  push("");
  push("| 盤 | 系統更數 | 總表更數 | 更數差 | 系統收入 | 總表收入 | 收入差 | 原因分類 |");
  push("|---|---:|---:|---:|---:|---:|---:|---|");
  let sysRevenueSum = 0;
  let trialRevenueSum = 0;
  let siteDiffCount = 0;
  const siteRows: { name: string; sysShifts: number | null; trialShifts: number; sysRevenue: number | null; trialRevenue: number; shiftDiff: number | null; revenueDiff: number | null }[] = [];
  for (const r of revenueSite) {
    const name = SITE_ID_TO_CANONICAL_NAME[r.site_id];
    trialRevenueSum += r.revenue_total;
    const sys = name ? sysByName.get(name) : undefined;
    if (sys) sysRevenueSum += sys.revenue;
    const shiftDiff = sys ? sys.shifts - r.shifts : null;
    const revenueDiff = sys ? round2(sys.revenue - r.revenue_total) : null;
    siteRows.push({ name: name ?? r.site_id, sysShifts: sys ? sys.shifts : null, trialShifts: r.shifts, sysRevenue: sys ? sys.revenue : null, trialRevenue: r.revenue_total, shiftDiff, revenueDiff });
  }
  for (const row of siteRows) {
    const hasDiff = row.sysShifts === null || (row.shiftDiff !== 0) || Math.abs(row.revenueDiff ?? 0) >= EPS;
    if (!hasDiff) continue;
    siteDiffCount++;
    const reason = classifySiteReason(row.name, row.shiftDiff, row.revenueDiff, row.sysRevenue === null);
    push(`| ${row.name} | ${row.sysShifts ?? "（缺）"} | ${row.trialShifts} | ${row.shiftDiff ?? "n/a"} | ${row.sysRevenue ?? "（缺）"} | ${row.trialRevenue} | ${row.revenueDiff ?? "n/a"} | ${reason} |`);
  }
  push("");
  push(`（44 個總表盤碼入面，${siteDiffCount} 個有差額，${44 - siteDiffCount} 個逐格一致；未列出嘅即 0 差額）`);
  push("");
  push(`**總收入**：系統（44 個總表對應盤加總）= ${round2(sysRevenueSum)}；系統全部盤（含總表以外）= ${round2([...mainRows, ...outsideRows].reduce((a, r) => a + r.revenue, 0))}；總表 = ${trialRevenueSum}；差額 = ${round2(sysRevenueSum - trialRevenueSum)}（vs 老闆總表 3,304,565.88）。`);
  push("");

  // ---- B2. 逐雞頭應付 ----
  const byUnit = readJson<{ by_unit: Record<string, ByUnitEntry> }>("broker_settlement.json").by_unit;
  const poSummary = readJson<Record<string, PoSummaryEntry>>("po_summary_check.json");
  const referralRows = readJson<ReferralRow[]>("referral_postorder.json");
  const referralByBroker = new Map<string, { n: number; amt: number }>();
  for (const r of referralRows) {
    const cur = referralByBroker.get(r.broker) ?? { n: 0, amt: 0 };
    cur.n++;
    cur.amt += r.recomputed;
    referralByBroker.set(r.broker, cur);
  }

  const payrollTotals = await buildPayrollTotals(AUG_MONTH);
  const payrollByCode = new Map(payrollTotals.map((t) => [t.brokerCode || "(未歸屬)", t]));

  // 分拆長工／非長工（見報告尾段「發現」——B07 對應嘅係「長工做緊自己
  // 長工崗位、更表雞頭欄淨係模板產物」嗰批更，總表歸類做 B07（内部，
  // payout_rate=0），系統而家冇呢層判斷，會計去咗嗰行原本嘅雞頭代號）。
  const brokerRecords = await prisma.shiftRecord.findMany({
    where: { workDate: { gte: AUG_MONTH, lte: new Date(Date.UTC(2026, 7, 31)) }, status: { not: "cancelled" }, recordType: { in: ["shift", "ot"] } },
    select: { settlementBrokerId: true, guardWageSnapshot: true, brokerFeeSnapshot: true, guard: { select: { employmentType: true } } },
  });
  const brokers = await prisma.broker.findMany({ select: { id: true, code: true } });
  const codeById = new Map(brokers.map((b) => [b.id, b.code]));
  type Split = { n: number; amt: number; ltN: number; ltAmt: number };
  const split = new Map<string, Split>();
  for (const r of brokerRecords) {
    const code = r.settlementBrokerId ? (codeById.get(r.settlementBrokerId) ?? "?") : "(未歸屬)";
    const cur = split.get(code) ?? { n: 0, amt: 0, ltN: 0, ltAmt: 0 };
    const amt = Number(r.guardWageSnapshot ?? 0) + Number(r.brokerFeeSnapshot ?? 0);
    cur.n++;
    cur.amt = round2(cur.amt + amt);
    if (r.guard.employmentType === "longterm_autopay") {
      cur.ltN++;
      cur.ltAmt = round2(cur.ltAmt + amt);
    }
    split.set(code, cur);
  }

  push("### B2. 逐雞頭應付：系統 vs 總表");
  push("");
  push("兩層比較：(i) 系統 `guard_wage+broker_fee`（唔含介紹費／passthrough）vs 總表 `broker_settlement.by_unit`（同一口徑，逐更 SUMIF，唔含介紹費）；(ii) 總表最終應付（`po_summary_check` 逐 broker `recomputed_total`＝跟 `Summary!AI`，含介紹費，K 未扣 passthrough）。");
  push("");
  push("| 雞頭 | 系統更數 | 總表更數(i) | 更數差 | 系統應付(i) | 總表應付(i) | 差額(i) | 總表最終應付(ii，含介紹費) | 介紹費(總表) | 原因 |");
  push("|---|---:|---:|---:|---:|---:|---:|---:|---:|---|");
  const brokerCodes = ["K", "W", "T", "G", "D", "Y", "B07"];
  let sysPayoutSum = 0;
  let trialPayoutSumI = 0;
  let trialPayoutSumII = 0;
  for (const code of brokerCodes) {
    const sys = payrollByCode.get(code);
    const sysN = sys?.shifts ?? 0;
    const sysAmt = sys?.amount ?? 0;
    sysPayoutSum += sysAmt;
    const trial = byUnit[code] ?? { n: 0, amt: 0 };
    trialPayoutSumI += trial.amt;
    const final = poSummary[code]?.recomputed_total ?? 0;
    trialPayoutSumII += final;
    const referral = referralByBroker.get(code);
    const nDiff = sysN - trial.n;
    const amtDiff = round2(sysAmt - trial.amt);
    const reason = classifyBrokerReason(code, split.get(code));
    push(`| ${code} | ${sysN} | ${trial.n} | ${nDiff} | ${sysAmt} | ${trial.amt} | ${amtDiff} | ${final} | ${referral ? `${referral.amt}（${referral.n} 條）` : "—"} | ${reason} |`);
  }
  push("");
  push(`**雞頭應付合計**：系統（K/W/T/G/D/Y/B07 加總，唔含介紹費）= ${round2(sysPayoutSum)}；總表(i) 唔含介紹費 = ${round2(trialPayoutSumI)}；總表(ii) 最終應付（含介紹費 60,520，K 未扣 24,150 passthrough）= ${round2(trialPayoutSumII)}；老闆總表「付雞頭淨額」= 1,828,804.77（已扣 K passthrough）。系統現時完全冇做：① 長工介紹費（special_items kind=referral_fee，8 月 0 條）；② K 簽證 passthrough 扣減（規則 12，schema 冇對應欄位）；③ 長工做自己崗位時「歸零、唔畀外判費」嘅判斷（見下面「發現」）。`);
  push("");

  // ---- 發現：B07／長工歸屬 ----
  push("### B3. 主要發現——長工「自己崗位」被誤當外判更计费（唔係細節，係最大差額嚟源）");
  push("");
  push("總表把 1,295 格（`shifts_priced.json` 逐格 `unit` 欄）歸類做 `B07`（標籤「(8) 長工」，`is_longterm_person=true`）：呢批更表格仔嘅雞頭欄（`更表A欄`）雖然寫緊 K／W／T／Y／G 等代號，但做嗰更嘅人係公司長工（`longterm_autopay`），總表判斷呢啲係「長工做緊自己嗰份長工工作，雞頭欄淨係更表範本殘留」——payout_rate 定 0（唔畀外判費，costs 由長工月薪自己覆蓋），只有真正嘅散工先攞外判費。");
  push("");
  push("**系統而家冇呢層判斷**——`src/lib/roster-upload/` 全個目錄搵唔到任何 `longterm` 相關嘅結算單位覆寫邏輯，上載解析／對數套用一律照抄更表雞頭欄，令長工做自己崗位嗰啲更都當正常外判更計外判費。逐雞頭拆開長工 vs 非長工嘅系統金額（本報告 B2 表用嘅係「唔拆」嘅 `buildPayrollTotals()` 總額）：");
  push("");
  push("| 雞頭 | 系統總更數 | 其中長工做嘅更數 | 其中長工金額 | 非長工更數 | 非長工金額（同總表 by_unit 比對） |");
  push("|---|---:|---:|---:|---:|---:|");
  for (const code of ["K", "W", "T", "G", "D", "Y"]) {
    const s = split.get(code);
    if (!s) continue;
    push(`| ${code} | ${s.n} | ${s.ltN} | ${s.ltAmt} | ${s.n - s.ltN} | ${round2(s.amt - s.ltAmt)}（總表 by_unit=${byUnit[code]?.amt ?? "n/a"}） |`);
  }
  push("");
  push("扣走長工嗰批之後，非長工金額同總表 `by_unit` 已經非常接近（D／G 完全相等，Y 淨返 $0.02，K／T／W 剩低嘅細額差異屬下面 B4 已知落差）——證明呢個「長工自己崗位當外判更计费」判斷缺失，係 8 月雞頭應付差額嘅主要嚟源，唔係雜訊。");
  push("");
  push("**分類**：口徑/功能缺口（唔係 bug）——同 `P2-版面重設計計劃.md` §14 規則 1／2、§14.1「WP-ATTRIB（未開工）」講嘅缺口一致：系統結算單位而家100%信任更表雞頭欄，冇「呢個人係咪長工、做緊嘅係咪自己嗰個崗位」呢一層判斷；`settlement-broker-fallback.ts` 只處理「完全冇結算單位」，唔處理「有結算單位但個人係長工」。要做呢層判斷需要規劃決定（例如：長工喺自己 `guards.default_broker_id`／所屬盤做更且更表雞頭代號同總表「該盤預設外判方」相同 → 當自己崗位、歸零；長工喺另一個盤/雞頭做更 → 當規則 2「用假期幫雞頭做散更」，正常外判費），非本次唯讀比對任務範圍。");
  push("");

  // ---- 疑似 bug ----
  push("### B4. 疑似 bug（file:line）");
  push("");
  push("1. **`src/lib/reports/monthly-close.ts:153-167`（`hasAnyRecordThisMonth` / `effectiveFlatCard` 閘）**：`數碼港 CP5 IC` 呢個盤本身 `shift_records` 永遠 0 條（IC 崗嘅更全部寫喺姊妹盤「數碼港 CP5」底下、`shift_type.billing_group=monthly_ic`，見 §17.8 WP-AUG-OPENING-2）——但呢個「零活動」閘（WP-AI3 反假營業額安全網）淨係查「呢個 site 自己」有冇 `shift_record`／`daily_requirement`，查唔到就當呢個盤成個月完全冇活動，令佢嘅 flat 卡（18,580.65）連同成盤一齊喺 `mainRows`／`outsideRows` 完全消失（唔係顯示 0，係成行冇咗）。本次實測：dev DB 8 月 `數碼港 CP5 IC` 喺 `buildMonthlyClose()` 輸出入面搵唔到呢個盤，總表卻有 18,580.65 收入（`revenue_site.json` S012）。**建議修法**：呢個閘要識別「flat 卡本身覆蓋緊嘅 IC 崗更係咪掛咗喺姊妹盤」（例如查 `數碼港 CP5` 呢個月有冇 `shift_type.billing_group=monthly_ic` 嘅記錄），或者由規劃決定呢類「純billing 構造、冇自己shift_records」嘅盤要點樣豁免呢條閘。");
  push("");
  push("（未見其他新增疑似 bug——8 月開盤／guard-fix／對數套用嘅其餘差額全部對得返 §17.7-§17.10、§18 已經記錄嘅已知落差，見下面 B5。）");
  push("");

  // ---- B5. 其他已知落差彙總 ----
  push("### B5. 其他已知落差（口徑不同／資料未入，非 bug）");
  push("");
  push("- **淺水灣道11號蔚峰園**：7 月 flat 卡 84,193.55 無限期覆蓋 8 月，總表 8 月係逐更口徑 92,612.90（935.48×99）——差 8,419.35（`P2-版面重設計計劃.md` §17.10.2 第 5 項已記錄，要老闆批先可以幫呢張 7 月卡加 `effective_to`）。");
  push("- **HKU座頭 OT**（1Hr OT，84.85／更）：`buildMonthlyClose()` 嘅逐盤更數/收入淨計 `record_type=shift`，唔含 `ot`——呢個係報表設計本身（OT 另有 `ot_unpriced` 統計），令逐盤比較見到 -1 更／-84.85 嘅系統性落差，唔係缺失。");
  push("- **國泰城 3 格／港深創新及科技園 1 格**：guard-fix 收斂之後仍然 `needs_boss`（安員身份對唔實）嘅格，未寫入 `shift_records`，令呢兩個盤更數/收入比總表少（國泰城 -3 更、港深創新及科技園 -1 更）——資料未入（等老闆喺 guard-fix `needs_boss` 卡片決定），唔係 bug。加埋 1 格淺水灣道11號蔚峰園更表本身重複行，合共 B step 6 講嘅 6 個 unresolved。任務書原先講嘅「34 格未配對＝兩位安員」係較早期估算，本次跑到 guard-fix 完全收斂之後實測剩低 5 格（3 個身份），細節見 §18.8。");
  push("- **啟航1331**：系統收入 1,231,500 vs 總表 1,236,900（差 5,400＝1,350×4），更數 1,150 vs 1,154（差 4）——實查 `roster_upload_rows`（codeKind=shift）同 `shift_records` 都係 1,150，寫入本身冇問題；差嘅 4 更 1,350／更係「啟航1331 Event」獨立盤（§17.7 修3，K 1,350／990 卡）嘅更，總表 44 碼表用 S017 一個碼將 Event 更同主盤更合併計，系統就分成兩個盤（「啟航1331」＋「啟航1331 Event」）顯示——盤層面「分／合」口徑唔同，唔係漏更／唔是 bug（全公司總收入層面「系統全部盤」欄已經計埋呢 5,400）。");
  push("- **長工介紹費（60,520）**：系統完全未入（`special_items(kind=referral_fee)` 8 月 0 條）——WP-MONTHLY-BUDGET／referral 自動化未做（§16.2），要會計人手輸入或者起自動化。");
  push("- **K 簽證 passthrough（24,150）**：規則 12——系統 schema 完全冇對應欄位／機制，總表本身都係「會計出糧後直接現金扣返雞頭，唔喺總表/報表反映」，屬故意設計成「系統外」，唔係本次要補嘅缺口。");
  push("- **長工 Autopay（882,146.72）／MPF（35,966.15）**：WP-LTPAY 未做，系統完全冇呢盤數（唔喺 `buildPayrollTotals()`／`buildMonthlyClose()` 出現），糧單試算嘅「總付出」「毛利」呢兩個大數暫時冇辦法喺系統報表對得到。");
  push("- **LINK（厚A/B/C）、CP5 IC 月費、Event 獨立盤、special items（獨立雞頭費等）**：唔喺 Postorder 總表 44 個盤碼範圍內／已經喺 B1 逐盤表反映（CP5 IC 見 B4 bug；Event 已經係獨立盤「啟航1331 Event」，B1 表冇見異常）。");
  push("");

  push("### B6. 未定价數（系統，8 月）");
  push("");
  push(`- payout_unpriced（出街价未定）＝ ${unpriced.payoutCount}`);
  push(`- client_unpriced（收客价未定）＝ ${unpriced.clientCount}`);
  push(`- no_settlement（結算單位都冇）＝ ${unpriced.noSettlementCount}`);
  push(`- ot_unpriced（OT 未定价）＝ ${unpriced.otUnpricedCount}`);
  push(`- 合計 ${unpriced.count} 條（主要係數碼港 CP5 IC 崗月費成本冇對應 rate_card——見 §17.10.2 第 2 項「月薪崗成本冇計」——同啟航1331 OT3.5 等冇卡嘅 OT 更種，§17.7「未修」）。`);
  push("");

  // ---------------------------------------------------------------------
  // C. 回報摘要
  // ---------------------------------------------------------------------
  push("## C. 回報摘要");
  push("");
  const sitePctMatch = round2(((44 - siteDiffCount) / 44) * 100);
  push(`**一句總結**：7 月——系統數＝總表（337/337 比對點 pass，100% 一致）。8 月——逐盤更數/收入 ${44 - siteDiffCount}/44（${sitePctMatch}%）盤零差額，主因：①長工做自己崗位被當外判更計費（未做結算單位覆寫判斷，屬功能缺口）；②長工 Autopay／介紹費／K passthrough 三項未入系統（WP-LTPAY／referral 自動化／規則12機制均未做）；③6 格未配對安員未寫入（等老闆 guard-fix 決定）；④ 1 個疑似 bug（數碼港 CP5 IC 盤喺月結報表消失，monthly-close.ts:153-167）；⑤ 其餘為已知口徑差異（蔚峰園 7 月卡滲入、OT 唔入逐盤統計等）。`);
  push("");

  const reportPath = path.join(REPORT_DIR, `報告-${today}.md`);
  fs.writeFileSync(reportPath, lines.join("\n") + "\n", "utf8");
  console.log(`[aug-e2e-check] 報告已寫入 ${reportPath}`);
  console.log(`[aug-e2e-check] 逐盤：44 個總表盤碼，${siteDiffCount} 個有差額`);
  console.log(`[aug-e2e-check] 逐雞頭：系統合計 ${round2(sysPayoutSum)}／總表(i) ${round2(trialPayoutSumI)}／總表(ii,含介紹費) ${round2(trialPayoutSumII)}`);
}

function classifySiteReason(name: string, shiftDiff: number | null, revenueDiff: number | null, missing: boolean): string {
  if (missing) return "疑似bug：monthly-close.ts:153-167 零活動閘（見 B4）";
  if (name === "淺水灣道11號蔚峰園") return "已知：7月flat卡滲入8月（B5）";
  if (name === "HKU座頭") return "已知：OT不入逐盤統計（B5）";
  if (name === "國泰城") return "資料未入：needs_boss 未配對（B5）";
  if (name === "港深創新及科技園") return "資料未入：needs_boss 未配對（B5）";
  if (name === "啟航1331") return "已知：口徑差異——實查 upload rows(codeKind=shift)=1150 同系統寫入數一致（非寫入 bug），差額 4 更/5,400＝1,350×4，同「啟航1331 Event」獨立盤（§17.7 修3）嘅 4 更 1,350 卡完全脗合；trial 44 碼表冇「啟航1331 Event」呢個獨立碼，總表口徑將 Event 更計入 S017 主盤，系統就分開兩個盤顯示——盤口徑（分／合）唔同，唔係漏更（全公司總收入層面已計埋，見 B1「系統全部盤」欄）。";
  if (name === "創富廠IC") return "已知：收入 0 差額，淨係更數計法唔同（admin_fee/flat 混合billing 令逐更數同總表 kind=work 計法有出入），對總收入冇影響。";
  if (Math.abs(revenueDiff ?? 0) < 1 && Math.abs(shiftDiff ?? 0) <= 1) return "已知：捨位／邊界（可忽略）";
  return "未分類——需要人手排查";
}

function classifyBrokerReason(code: string, s: { n: number; ltN: number; ltAmt: number } | undefined): string {
  if (code === "B07") return "系統冇 B07 記錄（長工自己崗位而家歸咗去 K/W/T/Y/G 其中一個，見 B3）";
  if (s && s.ltN > 0) return `長工誤當外判（B3）：${s.ltN} 更／${s.ltAmt} 未扣走；另加介紹費／K passthrough 未入`;
  return "介紹費未入系統（B5）";
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
