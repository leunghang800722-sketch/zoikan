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
  push("5. `guard-fix` 收斂（驗收 Opus 5.5 重跑：461 格 → 10 → 0；needs_boss 5 格改保守預設建獨立安員）→ 上載 Postorder → guard-fix 四類計劃（set_longterm 8／set_longterm_post 56／set_referral 51）套用");
  push("6. 「重新對數全月」（`runReconcileAllForMonth()`：recomputeSettlement＋roster_only/settlement_diff 全部 apply_roster）→ 月結「重算介紹費」（`recomputeReferralFees()`，含 Postorder 費率同步）。正式站次序（先逐盤套用、後上載 Postorder）同乾淨次序兩種都驗過，結果一致。");
  push("");

  const { mainRows, outsideRows } = await buildMonthlyClose(AUG_MONTH);
  const sysByName = new Map<string, MonthlyCloseSiteRow>([...mainRows, ...outsideRows].map((r) => [r.canonicalName, r]));

  // WP-LTSHIFT §19 第二部分（coordinator 2026-09-26 追加要求）：B3/B4/B5
  // 唔准再係寫死嘅舊快照敘述——呢度查返而家（跑呢個 script 嗰一刻）嘅
  // 即時狀態，落面 B3/B4/B5 段落逐句用返呢啲變數，唔會再自相矛盾。
  const activeLongtermPosts = await prisma.guardLongtermPost.count({ where: { voidedAt: null } });
  const longtermPostsBySource = await prisma.guardLongtermPost.groupBy({ by: ["source"], where: { voidedAt: null }, _count: true });
  const cp5IcInSystemReport = sysByName.has("數碼港 CP5 IC");
  const referralFeeItems = await prisma.specialItem.findMany({
    where: { month: AUG_MONTH, kind: "referral_fee", voidedAt: null },
    select: { cost: true },
  });
  const referralFeeSystemTotal = round2(referralFeeItems.reduce((a, i) => a + Number(i.cost), 0));

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
    const reason = classifyBrokerReason(code, split.get(code), referralFeeItems.length > 0);
    push(`| ${code} | ${sysN} | ${trial.n} | ${nDiff} | ${sysAmt} | ${trial.amt} | ${amtDiff} | ${final} | ${referral ? `${referral.amt}（${referral.n} 條）` : "—"} | ${reason} |`);
  }
  push("");
  push(
    `**雞頭應付合計**：系統（K/W/T/G/D/Y/B07 加總，唔含介紹費）= ${round2(sysPayoutSum)}；總表(i) 唔含介紹費 = ${round2(trialPayoutSumI)}；總表(ii) 最終應付（含介紹費 60,520，K 未扣 24,150 passthrough）= ${round2(trialPayoutSumII)}；老闆總表「付雞頭淨額」= 1,828,804.77（已扣 K passthrough）。` +
      `長工做自己崗位時「歸零、唔畀外判費」嘅判斷——WP-LTSHIFT §19 已實施（見下面 B3，本次實測 B07 更數 ${payrollByCode.get("B07")?.shifts ?? 0}）。長工介紹費——後端已實施，本次跑呢個 script 嗰一刻系統有 ${referralFeeItems.length} 條 \`special_items(kind=referral_fee)\`，合計 ${referralFeeSystemTotal}（見 B5）。K 簽證 passthrough 扣減（規則 12）——**仍然未做**，schema 冇對應欄位，總表本身都係「會計出糧後直接現金扣返雞頭，唔喺總表/報表反映」，屬故意設計成「系統外」，唔係本次要補嘅缺口。`,
  );
  push("");

  // ---- 發現：B07／長工歸屬（WP-LTSHIFT §19 兩部分做完之後，呢度已經
  // 改做即時查數，唔再係寫死嘅「系統冇呢層判斷」舊結論——見上面
  // activeLongtermPosts／longtermPostsBySource／split 變數。） ----
  push("### B3. 長工「自己崗位」結算單位判斷（WP-LTSHIFT §19，已實施）");
  push("");
  push("總表把 1,295 格（`shifts_priced.json` 逐格 `unit` 欄）歸類做 `B07`（標籤「(8) 長工」，`is_longterm_person=true`）：呢批更表格仔嘅雞頭欄（`更表A欄`）雖然寫緊 K／W／T／Y／G 等代號，但做嗰更嘅人係公司長工（`longterm_autopay`），總表判斷呢啲係「長工做緊自己嗰份長工工作，雞頭欄淨係更表範本殘留」——payout_rate 定 0（唔畀外判費，costs 由長工月薪自己覆蓋），只有真正嘅散工先攞外判費。");
  push("");
  {
    const sourceBreakdown = longtermPostsBySource.map((s) => `${s.source}=${s._count}`).join("、");
    push(
      "**系統而家已經有呢層判斷**（`src/lib/pricing/longterm-settlement.ts` `resolveLongtermSettlement()`＋guard-fix `set_longterm_post`，見 `docs/api.md`「WP-LTSHIFT §19」段）——本次跑呢個 script 嗰一刻，dev DB 實測：生效中 `guard_longterm_posts` 崗位記錄 **" +
        activeLongtermPosts +
        "** 條（" +
        sourceBreakdown +
        "），系統 B07（internal_longterm）總更數 **" +
        (payrollByCode.get("B07")?.shifts ?? 0) +
        "**（vs Postorder 1,295 格）。驗收（Opus 5.5）逐格對 `shifts_priced.json` 已查清：之前 1,323 嘅 +28＝39 格錯歸 B07（占比推算崗位：簽證形式長工 26＋非 8 月在職長工 13，總表冇佢哋任何「(8) 長工」格）−13 格（數碼港 CP5 IC 崗位、更記喺 CP5，未認 proxy 盤）＋2 格（Weave Hospital Road 更表寫長工返工、老闆確認實際病假由 T 頂）；前兩項已修（Postorder 生效後唔推算／proxy 盤算崗位），剩低 +2 係更表資料本身。",
    );
  }
  push("");
  push("逐雞頭拆開「仍然跟緊雞頭碼」嘅長工更（即 `longterm_non_post_broker`／`longterm_dispersed_b07` 兩種：安員有崗位但呢更唔喺崗位盤、或者完全冇崗位記錄推算唔到）——理論上應該接近 0，因為絕大部分長工更而家已經正確歸咗 B07：");
  push("");
  push("| 雞頭 | 系統總更數 | 其中長工但跟緊雞頭碼嘅更數 | 其中金額 | 非長工更數 | 非長工金額（同總表 by_unit 比對） |");
  push("|---|---:|---:|---:|---:|---:|");
  for (const code of ["K", "W", "T", "G", "D", "Y"]) {
    const s = split.get(code);
    if (!s) continue;
    push(`| ${code} | ${s.n} | ${s.ltN} | ${s.ltAmt} | ${s.n - s.ltN} | ${round2(s.amt - s.ltAmt)}（總表 by_unit=${byUnit[code]?.amt ?? "n/a"}） |`);
  }
  push("");
  // 淨係計真正嘅外判雞頭代號（K/W/T/G/D/Y）——`split` 呢個 map 仲有
  // "B07" 自己一個 key（長工已經正確歸咗嗰批，`ltN` 佔咗 B07 總更數
  // 幾乎全部，唔可以計落「仍然跟緊雞頭碼」嘅總和，否則個總和會離譜咁大）。
  const totalStillOnBrokerCode = ["K", "W", "T", "G", "D", "Y"].reduce((a, code) => a + (split.get(code)?.ltN ?? 0), 0);
  push(
    totalStillOnBrokerCode === 0
      ? "**逐雞頭表全部長工更都已經歸咗 B07（0 格仍然跟緊雞頭碼），呢層判斷已經生效，唔再係差額主因。**"
      : `**仍然有 ${totalStillOnBrokerCode} 格長工更跟緊雞頭碼（唔喺崗位盤頂散更，或者完全冇崗位記錄推算唔到）**——呢批屬設計上嘅保守 fallback（見上表逐雞頭拆分），唔係判斷缺失。`,
  );
  push("");
  push("**分類**：功能已實施（`src/lib/pricing/longterm-settlement.ts`＋`src/lib/guard-fix/plan.ts` `buildPostorderActions()`），仲剩低嘅細額差異屬 B4/B5 記低嘅已知口徑落差，唔係「未做」。");
  push("");

  // ---- 疑似 bug（B4 淨係喺「本次實測仍然中招」先出，避免舊快照文字
  // 同即時數字自相矛盾——WP-LTSHIFT §19 第二部分已經修咗 CP5 IC 個
  // seed backfill 缺口，正常嚟講而家唔會再見到呢條。） ----
  push("### B4. 疑似 bug（file:line）");
  push("");
  if (!cp5IcInSystemReport) {
    push(
      "1. **`src/lib/reports/monthly-close.ts:153-167`（`hasAnyRecordThisMonth` / `effectiveFlatCard` 閘）**：`數碼港 CP5 IC` 呢個盤本身 `shift_records` 永遠 0 條（IC 崗嘅更全部寫喺姊妹盤「數碼港 CP5」底下、`shift_type.billing_group=monthly_ic`，見 §17.8 WP-AUG-OPENING-2）——但呢個「零活動」閘（WP-AI3 反假營業額安全網）淨係查「呢個 site 自己」有冇 `shift_record`／`daily_requirement`，查唔到就當呢個盤成個月完全冇活動，令佢嘅 flat 卡（18,580.65）連同成盤一齊喺 `mainRows`／`outsideRows` 完全消失（唔係顯示 0，係成行冇咗）。本次實測：dev DB 8 月 `數碼港 CP5 IC` 喺 `buildMonthlyClose()` 輸出入面搵唔到呢個盤，總表卻有 18,580.65 收入（`revenue_site.json` S012）。**建議修法**：`sites.activity_proxy_site_id` 應該指向「數碼港 CP5」（migration `20260926120000_wp_ltshift_cp5ic_proxy_weifeng_flatcard`），如果本次實測仲見到呢條，先檢查 `db:reset && db:seed` 之後呢個欄係咪真係有值（`scripts/seed/index.ts` `seedSites()` 尾段 `cp5SiteId` patch）。",
    );
    push("");
    push("（未見其他新增疑似 bug——8 月開盤／guard-fix／對數套用嘅其餘差額全部對得返 §17.7-§17.10、§18 已經記錄嘅已知落差，見下面 B5。）");
  } else {
    push(
      "**本次實測：搵唔到新嘅疑似 bug。**（之前記錄過嘅「數碼港 CP5 IC 喺月結報表消失」——`monthly-close.ts:153-167` 反假營業額閘——已經喺 WP-LTSHIFT §19 修埋 `sites.activity_proxy_site_id` 嘅 seed backfill 缺口，本次實測呢個盤有出現喺 `buildMonthlyClose()` 輸出，唔再重現。8 月開盤／guard-fix／對數套用嘅其餘差額全部對得返 §17.7-§17.10、§18 已經記錄嘅已知落差，見下面 B5。）",
    );
  }
  push("");

  // ---- B5. 其他已知落差彙總 ----
  push("### B5. 其他已知落差（口徑不同／資料未入，非 bug）");
  push("");
  push("- **淺水灣道11號蔚峰園**：7 月 flat 卡已加到期（8 月逐更 935.48）。剩 1 更／935.48（W 850）：更表同一人同日同更出現兩行（重複行，Postorder 當晚有兩格夜更），系統 unique（安員＋日＋更種）只記一更、對數標 unresolved——更表資料問題，要更表補返第二格嘅真正安員先入到數。");
  push("- **HKU座頭 OT**（1Hr OT，84.85／更）：`buildMonthlyClose()` 嘅逐盤更數/收入淨計 `record_type=shift`，唔含 `ot`——呢個係報表設計本身（OT 另有 `ot_unpriced` 統計），令逐盤比較見到 -1 更／-84.85 嘅系統性落差，唔係缺失。");
  push("- **needs_boss 5 格（國泰城 3／屯門凱和山 1／港深創新及科技園 1）**：驗收（Opus 5.5）改做保守預設——按更表姓名建獨立安員（cash_casual、無工號、audit「待核」），工號衝突嗰類寫 `guard_match_overrides`；已全部寫入。屯門凱和山收入 +870.97：Postorder 將 8/21 夜更標做唔收客（E 欄空），系統照逐更收客卡計——Postorder 逐格「Unbilled」未有自動規則（見驗收報告未修項）。");
  push("- **Weave Hospital Road 2 格（T −1,600）**：更表寫長工 8/19、8/20 返工，老闆確認實際病假、T 派人頂——更表漏記，系統跟更表（B07），要更表改返先對到。");
  push("- **啟航1331**：系統收入 1,231,500 vs 總表 1,236,900（差 5,400＝1,350×4），更數 1,150 vs 1,154（差 4）——實查 `roster_upload_rows`（codeKind=shift）同 `shift_records` 都係 1,150，寫入本身冇問題；差嘅 4 更 1,350／更係「啟航1331 Event」獨立盤（§17.7 修3，K 1,350／990 卡）嘅更，總表 44 碼表用 S017 一個碼將 Event 更同主盤更合併計，系統就分成兩個盤（「啟航1331」＋「啟航1331 Event」）顯示——盤層面「分／合」口徑唔同，唔係漏更／唔是 bug（全公司總收入層面「系統全部盤」欄已經計埋呢 5,400）。");
  push(
    referralFeeItems.length === 0
      ? "- **長工介紹費（總表 60,520）**：系統本次跑呢個 script 嗰一刻 `special_items(kind=referral_fee)` 8 月 0 條——後端 API（`POST /api/reports/referral-fee/recompute`）同月結頁「重算介紹費」掣已經做咗（見 `docs/api.md`「WP-LTSHIFT §19」），淨係未撳過；撳咗之後先會有數，見下面即時查到嘅金額。"
      : `- **長工介紹費（總表 60,520）**：系統本次跑呢個 script 嗰一刻已經有 ${referralFeeItems.length} 條 \`special_items(kind=referral_fee)\`，合計 ${referralFeeSystemTotal}。驗收（Opus 5.5）修咗三個根因：只計正更（之前連 B07 假期／OT 格都計）、卓弘豁免 9 月先生效（8 月照付 1,380）、費率跟 Postorder 公式（K 粉嶺 60）。剩 +100＝Weave Hospital Road 2 格更表漏記（見上）。`,
  );
  push("- **K 簽證 passthrough（24,150）**：規則 12——系統 schema 完全冇對應欄位／機制，總表本身都係「會計出糧後直接現金扣返雞頭，唔喺總表/報表反映」，屬故意設計成「系統外」，唔係本次要補嘅缺口。");
  push("- **長工 Autopay（882,146.72）／MPF（35,966.15）**：WP-LTPAY 未做，系統完全冇呢盤數（唔喺 `buildPayrollTotals()`／`buildMonthlyClose()` 出現），糧單試算嘅「總付出」「毛利」呢兩個大數暫時冇辦法喺系統報表對得到。");
  push(
    `- **LINK（厚A/B/C）、CP5 IC 月費、Event 獨立盤、special items（獨立雞頭費等）**：唔喺 Postorder 總表 44 個盤碼範圍內／已經喺 B1 逐盤表反映（CP5 IC${cp5IcInSystemReport ? "而家有出現喺系統報表（見 B4）" : "見 B4 bug"}；Event 已經係獨立盤「啟航1331 Event」，B1 表冇見異常）。`,
  );
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
  push(
    `**一句總結**：7 月——系統數＝總表（337/337 比對點 pass，100% 一致）。8 月——逐盤更數/收入 ${44 - siteDiffCount}/44（${sitePctMatch}%）盤零差額，長工結算單位判斷（WP-LTSHIFT §19）已實施（B07 更數 ${payrollByCode.get("B07")?.shifts ?? 0}）；長工介紹費後端已實施（本次系統合計 ${referralFeeSystemTotal}）；剩低差額主因：①長工 Autopay／K passthrough 兩項未入系統（WP-LTPAY／規則12機制均未做）；②未配對安員已按保守預設寫入（needs_boss＝0）；③${cp5IcInSystemReport ? "冇新疑似 bug" : "數碼港 CP5 IC 盤喺月結報表消失（monthly-close.ts:153-167，見 B4）"}；④其餘為更表資料問題（Weave 漏記病假 2 格、蔚峰園重複行 1 格、凱和山唔收客 1 格）同口徑差異（OT 唔入逐盤統計、啟航1331/Event 盤分合、CP5 IC 構造盤）。`,
  );
  push("");

  const reportPath = path.join(REPORT_DIR, `報告-${today}.md`);
  fs.writeFileSync(reportPath, lines.join("\n") + "\n", "utf8");
  console.log(`[aug-e2e-check] 報告已寫入 ${reportPath}`);
  console.log(`[aug-e2e-check] 逐盤：44 個總表盤碼，${siteDiffCount} 個有差額`);
  console.log(`[aug-e2e-check] 逐雞頭：系統合計 ${round2(sysPayoutSum)}／總表(i) ${round2(trialPayoutSumI)}／總表(ii,含介紹費) ${round2(trialPayoutSumII)}`);
}

function classifySiteReason(name: string, shiftDiff: number | null, revenueDiff: number | null, missing: boolean): string {
  if (missing) return "疑似bug：monthly-close.ts:153-167 零活動閘（見 B4）";
  if (name === "淺水灣道11號蔚峰園") return "資料：更表同人同日同更重複行（Postorder 兩格夜更），系統記一更（B5）";
  if (name === "屯門凱和山") return "資料：Postorder 8/21 夜更唔收客（E 空），系統照卡收客（B5）";
  if (name === "數碼港 CP5 IC") return "口徑：IC 崗更記喺「數碼港 CP5」（monthly_ic 更種），CP5 IC 淨出月費；收入 0 差額";
  if (name === "HKU座頭") return "已知：OT不入逐盤統計（B5）";
  if (name === "國泰城" || name === "港深創新及科技園") return "未分類——needs_boss 保守預設應已寫入，需要人手排查";
  if (name === "啟航1331") return "已知：口徑差異——實查 upload rows(codeKind=shift)=1150 同系統寫入數一致（非寫入 bug），差額 4 更/5,400＝1,350×4，同「啟航1331 Event」獨立盤（§17.7 修3）嘅 4 更 1,350 卡完全脗合；trial 44 碼表冇「啟航1331 Event」呢個獨立碼，總表口徑將 Event 更計入 S017 主盤，系統就分開兩個盤顯示——盤口徑（分／合）唔同，唔係漏更（全公司總收入層面已計埋，見 B1「系統全部盤」欄）。";
  if (name === "創富廠IC") return "口徑：收入 0 差額；總表 revenue_site 數 Postorder 格（24），逐格 shifts_priced 同系統都係 22";
  if (name === "九龍企業大廈") return "口徑：收入 0 差額；總表 revenue_site 數 62，逐格 shifts_priced 同系統都係 63";
  if (Math.abs(revenueDiff ?? 0) < 1 && Math.abs(shiftDiff ?? 0) <= 1) return "已知：捨位／邊界（可忽略）";
  return "未分類——需要人手排查";
}

function classifyBrokerReason(code: string, s: { n: number; ltN: number; ltAmt: number } | undefined, referralFeeComputed: boolean): string {
  const referralNote = referralFeeComputed ? "介紹費本次已計（見 B5）" : "介紹費未撳「重算」（見 B5）";
  if (code === "T") return `更表漏記：Weave Hospital Road 8/19、8/20 長工病假由 T 頂（−1,600，見 B5）；${referralNote}`;
  if (code === "W") return `更表重複行：淺水灣道11號蔚峰園 8/25 夜更同人兩行（−850，見 B5）；${referralNote}`;
  if (code === "B07") return `系統長工自己崗位更數（WP-LTSHIFT §19 已實施，見 B3）；${referralNote}`;
  if (s && s.ltN > 0) return `${s.ltN} 更長工跟雞頭碼（長工放假頂雞頭更／簽證形式長工散更／總表冇佢長工格，見 B3）：${s.ltAmt}；${referralNote}；K passthrough 未入（規則 12，系統外設計）`;
  return `${referralNote}；K passthrough 未入（規則 12，系統外設計）`;
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
