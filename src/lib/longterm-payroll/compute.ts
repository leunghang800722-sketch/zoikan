// WP-LTPAY Phase 2（老闆 2026-09-26 指令；§14 規則 9／§14.1／§20.4 Phase 2）：
// 長工月薪糧（Maxwell 口徑）計算引擎——**純函數**，冇任何 DB／IO 依賴，
// 方便單元測試（oracle＝8 月試算 `data/2026-09/aug-payroll-trial/scripts/
// s07_longterm_payroll.py`／`boss_answers.py`，呢個檔逐條規則喺 JSDoc
// 引用返對應嘅 python 常數／函數名，方便對照）。
//
// 呢個檔**唔負責**：邊條更係雞頭頂更／賣假價目表逐盤逐職級嘅具體數字
// （呢啲屬於配置／資料，由 caller 透過參數傳入，唔喺呢層寫死 8 月個別
// 盤嘅價錢）、OT 時薪公式（老闆已定「OT 冇統一公式，個個盤個個人唔
// 同」——冇卡＝未定價，唔可以自動套公式，見 §15.2 老闆 2026-09-24 答
// (6)）、逐更資料嚟源（B07 更／請假段點樣變成 `LongtermMonthInput`，
// 由 `src/lib/longterm-payroll/aggregate.ts`（Phase 2 導入／一鍵串連嗰層）
// 負責砌）。

// ---------------------------------------------------------------------------
// 常數（§14 規則 9；同 s07_longterm_payroll.py 頂部常數一致）
// ---------------------------------------------------------------------------
const MPF_RATE = 0.05;
export const MPF_CAP = 1500;
export const MPF_MIN_GROSS = 7100;
const MPF_MIN_DAYS_EMPLOYED = 60;
const MPF_EXEMPT_AGE = 65;

// 老闆 2026-09-28（WP-BOSS5 §25.6 追加決定 #3）：MPF 首月唔再用「入職未滿
// 60 日全免」——首月（＝入職日所在嗰個月）改做「員工唔供、公司照供 ER
// 5%」，之後正常（EE＋ER 都供，Gross<7,100／≥65 歲維持原規則）。淨係
// `monthStart >= MPF_FIRST_MONTH_RULE_FROM` 先生效；之前月份（8 月同以前）
// 完全維持舊 60 日全免規則，鎖月 gate 唔變。老闆冇講第二個月點計，跟
// 法例精神當正常供款（呢個係假設，非老闆逐字確認）。
export const MPF_FIRST_MONTH_RULE_FROM = "2026-09-01";

// 老闆 2026-09-28（WP-BOSS5 決定 4）確認：病假每月 累積 2 日——第十三版
// 口徑冇變，唔准手多改（有單元測試 assert 呢個常數＝2，見
// tests/longterm-payroll-compute.test.ts）。
export const SL_ACCRUAL_PER_MONTH = 2; // BA.SL_ACCRUAL_PER_MONTH
const SL_ACCRUAL_START_MONTHS = 1; // BA.SL_ACCRUAL_START_MONTHS——做滿 1 個月先開始儲
const SL_ACCRUAL_CAP = 120; // BA.SL_ACCRUAL_CAP——《僱傭條例》上限
const SL_MIN_CONSECUTIVE = 4; // BA.SL_MIN_CONSECUTIVE
const SL_RATE = 0.8; // BA.SL_RATE——4/5 疾病津貼

// 老闆 2026-09-23（第十六節）：試用期滿嗰日唔算「已經過咗」——要離完結日
// 之後（leave_date >= 完結日）先算過。BA.PROBATION_END_DAY_COUNTS_AS_PASSED
// 現值 False；呢個常數保留做文件對照，compute.ts 主線行為固定跟 False。
const PROBATION_END_DAY_COUNTS_AS_PASSED = false;

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/** 四捨五入到 2 位小數（同 python `r2()` 一致：加 1e-9 避免浮點誤差令
 * 0.005 呢類臨界值錯捨入）。 */
export function round2(x: number): number {
  return Math.round((x + 1e-9) * 100) / 100;
}

/** 當月曆日數（§14 規則 9：日薪＝月薪÷當月曆日數）。`month` 用嗰個月
 * 任何一日都得，只睇 year/month。 */
export function daysInMonth(year: number, month1to12: number): number {
  return new Date(Date.UTC(year, month1to12, 0)).getUTCDate();
}

/** 純日期工具：用 UTC 避免時區令「日數」計錯（呢個系統其餘部分一律用
 * `@db.Date`，即冇時間部分，UTC 午夜當「嗰一日」最安全）。 */
export function toUtcDate(isoOrDate: string | Date): Date {
  if (isoOrDate instanceof Date) return new Date(Date.UTC(isoOrDate.getUTCFullYear(), isoOrDate.getUTCMonth(), isoOrDate.getUTCDate()));
  const [y, m, d] = isoOrDate.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

export function diffDaysInclusive(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / 86400000) + 1;
}

/** 月份加 n 個月，處理月底邊界（同 python `_add_months()`一致：例如
 * 1/31 加 1 個月 → 2/28（非閏年）；跟 JS Date 溢位語意做同一件事）。 */
export function addMonths(d: Date, n: number): Date {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + n;
  const targetY = y + Math.floor(m / 12);
  const targetM = ((m % 12) + 12) % 12;
  const lastDayOfTargetMonth = new Date(Date.UTC(targetY, targetM + 1, 0)).getUTCDate();
  const day = Math.min(d.getUTCDate(), lastDayOfTargetMonth);
  return new Date(Date.UTC(targetY, targetM, day));
}

// ---------------------------------------------------------------------------
// 1. 日薪／Net Basic（§14 規則 9：日薪＝月薪÷當月曆日數；月中轉合約／
//    調薪按日拆——生效日之前用舊合約價、生效日當日起用新合約價）
// ---------------------------------------------------------------------------

export interface ContractSegment {
  /** 呢段合約嘅月薪（payBasis="daily" 嗰陣呢個數冇月薪意義，保留歷史）。 */
  monthlySalary: number;
  /** 生效日（含）。 */
  effectiveFrom: Date;
  /** 終止日（含），null＝仲生效緊。 */
  effectiveTo: Date | null;
  /** §21 任務 4b(a)：日薪制長工特判——"daily" 嗰陣 Net Basic 唔跟呢個
   * segment 嘅日薪公式，改用 `computeNetBasicDaily(dailyRate, workDays)`
   * （由 caller／aggregate.ts 判斷）。冇提供＝"monthly"（預設，原有行為）。 */
  payBasis?: "monthly" | "daily";
  /** payBasis="daily" 先有意義：每更價。 */
  dailyRate?: number | null;
}

/** 揀返 `date` 嗰日所屬嘅合約段（§14 規則 9 A-9b：「無薪假／病假扣款
 * 日薪、OT 日薪、賣假 fallback 日薪全部跟返嗰一日所屬合約」）。搵唔到
 * 就 fallback 用最後一段（理論上唔應該發生——合約段理應覆蓋成個在職
 * 月份，搵唔到代表資料有缺）。 */
export function contractSegmentForDate(segments: ContractSegment[], date: Date): ContractSegment {
  const hit = segments.find((s) => s.effectiveFrom.getTime() <= date.getTime() && (s.effectiveTo === null || s.effectiveTo.getTime() >= date.getTime()));
  if (hit) return hit;
  const sorted = [...segments].sort((a, b) => a.effectiveFrom.getTime() - b.effectiveFrom.getTime());
  return sorted[sorted.length - 1];
}

/** 嗰一日嘅日薪＝嗰日所屬合約月薪 ÷ 當月曆日數；日薪制（payBasis=daily）
 * 合約直接用每更價（Opus 5.5 驗收修正：原本日薪制都用 monthlySalary÷曆日，
 * 如果 monthlySalary 存嘅係每更價——Maxwell 導入就係咁——OT／4/5／年假
 * fallback 日薪會細 30 倍）。 */
export function dailyRateOnDate(segments: ContractSegment[], date: Date, daysInMonthCount: number): number {
  const seg = contractSegmentForDate(segments, date);
  if (seg.payBasis === "daily" && seg.dailyRate != null) return seg.dailyRate;
  return seg.monthlySalary / daysInMonthCount;
}

/** Net Basic：喺 `employStart..employEnd`（含首尾，該長工當月喺職嘅
 * 日子——已經剔走月首之前未入職／月尾之後已離職嘅日子）逐日加返嗰日
 * 所屬合約嘅日薪。
 *
 * 全月在職＋冇轉約 ＝ 直接等於果段合約嘅月薪（同 s07 `net_basic =
 * float(used_monthly)` 一致，呢度用逐日加總都會得出同一個數，唔使
 * 特判，但保留呢個 fast path 避免浮點捨入令「全月」都唔啱好對嘅巧合）。
 */
export function computeNetBasic(segments: ContractSegment[], employStart: Date, employEnd: Date, monthDaysCount: number): number {
  if (employStart.getTime() > employEnd.getTime()) return 0;
  let total = 0;
  for (let t = employStart.getTime(); t <= employEnd.getTime(); t += 86400000) {
    total += dailyRateOnDate(segments, new Date(t), monthDaysCount);
  }
  return round2(total);
}

// ---------------------------------------------------------------------------
// 1b. 日薪制長工特判（§21 任務 4b(a)；oracle s07 `daily_rate_staff =
//     used_monthly < 5000`，例：恆星樓「Rest Day No」個案，`monthlySalary`
//     欄實際上係「每更 X 蚊」）——Net Basic 唔跟曆日／在職日子比例，
//     淨係「每更價 × 實際返工更數」（`workDays` 由 aggregate.ts 用
//     shift_records 逐日 B07 正更計出嚟，呢層淨係做乘數，唔識點計
//     workDays）。
// ---------------------------------------------------------------------------

/** Net Basic（日薪制）＝ dailyRate × workDays（同 s07 `net_basic =
 * r2(rate * work_days)` 一致）。 */
export function computeNetBasicDaily(dailyRate: number, workDays: number): number {
  return round2(dailyRate * workDays);
}

// ---------------------------------------------------------------------------
// 2. MPF（§14 規則 9：MPF 僱員／僱主各 min(Gross×5%,1500)；Gross<7,100
//    僱員免；≥65 歲免；入職未滿 60 日免）
// ---------------------------------------------------------------------------

export interface MpfExemptionInput {
  /** 截至月尾嘅歲數（虛歲／實歲由 caller 決定，s07 用 `(monthEnd-dob).
   * days/365.25`）。 */
  ageAtMonthEnd?: number | null;
  /** 入職日。 */
  hireDate?: Date | null;
  /** 呢個月月尾（含）。 */
  monthEnd: Date;
  /** §25.6：呢個月月首。淨係用嚟判斷 MPF 首月新／舊規則生效（`monthStart
   * >= MPF_FIRST_MONTH_RULE_FROM`）；冇提供＝當舊規則（8 月以前 caller
   * 可以唔傳，行為不變）。 */
  monthStart?: Date | null;
}

export interface MpfExemptionResult {
  exempt: boolean;
  reason: "over65" | "under60days" | null;
}

/** 判斷成人係咪 MPF 全免（EE＋ER 都免）——≥65 歲；`monthStart` 未生效
 * §25.6 新規則嗰陣，入職未滿 60 日都全免（舊規則，8 月以前）。§25.6
 * 新規則生效之後（`monthStart >= MPF_FIRST_MONTH_RULE_FROM`）冇「未滿
 * 60 日全免」呢一種——首月改做 `computeMpf()` 入面嘅「員工免供、公司
 * 照供」，唔係全免，所以呢度唔再回 `under60days`。呢個判斷同 Gross<7,100
 * 嗰條獨立（Gross<7,100 淨係免 EE，ER 照供）。 */
export function checkMpfExemption(input: MpfExemptionInput): MpfExemptionResult {
  const { ageAtMonthEnd, hireDate, monthEnd, monthStart } = input;
  if (ageAtMonthEnd != null && ageAtMonthEnd >= MPF_EXEMPT_AGE) return { exempt: true, reason: "over65" };
  const newFirstMonthRuleInEffect = monthStart != null && monthStart.getTime() >= toUtcDate(MPF_FIRST_MONTH_RULE_FROM).getTime();
  if (!newFirstMonthRuleInEffect && hireDate) {
    const daysEmployed = diffDaysInclusive(hireDate, monthEnd);
    if (daysEmployed < MPF_MIN_DAYS_EMPLOYED) return { exempt: true, reason: "under60days" };
  }
  return { exempt: false, reason: null };
}

export interface MpfResult {
  mpfEe: number;
  mpfEr: number;
  exemptReason: "over65" | "under60days" | "low_gross" | "first_month_ee" | null;
}

/** 逐人 MPF 僱員／僱主供款（§14 規則 9；首月規則見 §25.6）。`gross` 一定
 * 要先計完成（包晒 OT／津貼／扣款之後）先可以傳入。 */
export function computeMpf(gross: number, exemption: MpfExemptionInput): MpfResult {
  const { exempt, reason } = checkMpfExemption(exemption);
  if (exempt) return { mpfEe: 0, mpfEr: 0, exemptReason: reason };

  const contribution = round2(Math.min(gross * MPF_RATE, MPF_CAP));

  // §25.6：monthStart >= MPF_FIRST_MONTH_RULE_FROM 而且入職日喺呢個月
  // 之內 → 首月，員工唔供，公司照供 ER（5%，封頂 1500）。
  const newFirstMonthRuleInEffect = exemption.monthStart != null && exemption.monthStart.getTime() >= toUtcDate(MPF_FIRST_MONTH_RULE_FROM).getTime();
  if (newFirstMonthRuleInEffect && exemption.hireDate) {
    const hireInThisMonth = exemption.hireDate.getTime() >= (exemption.monthStart as Date).getTime() && exemption.hireDate.getTime() <= exemption.monthEnd.getTime();
    if (hireInThisMonth) {
      return { mpfEe: 0, mpfEr: contribution, exemptReason: "first_month_ee" };
    }
  }

  const eeExempt = gross < MPF_MIN_GROSS;
  return {
    mpfEe: eeExempt ? 0 : contribution,
    mpfEr: contribution,
    exemptReason: eeExempt ? "low_gross" : null,
  };
}

// ---------------------------------------------------------------------------
// 3. 病假 4/5（§14 規則 9：做滿 1 個月先儲、之後每月儲 2 日、上限 120 日；
//    要攞 4/5 必須同時 (a) 結餘夠 (b) 連續 ≥4 日有醫生紙，否則全部當
//    無薪假）
// ---------------------------------------------------------------------------

/** 由入職日計到 `asOf` 嘅**完整服務月數**（同 python `sl_completed_
 * months()` 一致：未夠一個公曆月＝0，之後每滿一個公曆月 +1）。 */
export function slCompletedMonths(hireDate: Date, asOf: Date): number {
  let months = (asOf.getUTCFullYear() - hireDate.getUTCFullYear()) * 12 + (asOf.getUTCMonth() - hireDate.getUTCMonth());
  if (asOf.getUTCDate() < hireDate.getUTCDate()) months -= 1;
  return Math.max(0, months);
}

/** 截至 `asOf` 嘅累積病假結餘（做滿 1 個月先開始儲，之後每月 2 日，
 * 上限 120 日）。 */
export function slAccrued(hireDate: Date, asOf: Date): number {
  const months = slCompletedMonths(hireDate, asOf);
  if (months < SL_ACCRUAL_START_MONTHS) return 0;
  return Math.min(SL_ACCRUAL_CAP, months * SL_ACCRUAL_PER_MONTH);
}

export interface SlSegmentVerdict {
  qualifies: boolean;
  reason: string;
}

/** 一段病假嘅判定（§14 規則 9）：`segDays`＝呢段入面真正 SL 嘅日數
 * （會扣錢／食結餘嗰啲），`spanDays`＝呢段嘅連續日數（含夾喺中間嘅
 * RD／OFF——RD 夾喺兩段病假中間當同一段連續病假，計入連續日數但唔
 * 扣錢唔食結餘，呢個由 caller 分段嗰陣處理），`balance`＝呢段開始嗰日
 * 嘅病假結餘，`doctorNoteVerified`＝有冇香港註冊醫生病假紙（冇提供
 * 就當冇，唔可以假設有——同 s07 用「假設有，要 HR 核實」唔同，
 * compute.ts 呢層淨係計純規則，醫生紙核實與否由人手輸入項
 * `doctorNoteVerified` 決定，冇資料一律當「未核實」＝唔合資格，穩陣
 * 方向）。 */
export function slSegmentVerdict(segDays: number, spanDays: number, balance: number, doctorNoteVerified: boolean): SlSegmentVerdict {
  const okConsecutive = spanDays >= SL_MIN_CONSECUTIVE;
  const okBalance = balance + 1e-9 >= segDays;
  if (okConsecutive && okBalance && doctorNoteVerified) {
    return { qualifies: true, reason: `連續 ${spanDays} 日 ≥ ${SL_MIN_CONSECUTIVE} 日、結餘 ${balance} 日 ≥ ${segDays} 日、有醫生紙 → 4/5 疾病津貼` };
  }
  const why: string[] = [];
  if (!okConsecutive) why.push(`連續得 ${spanDays} 日 < ${SL_MIN_CONSECUTIVE} 日`);
  if (!okBalance) why.push(`結餘得 ${balance} 日 < ${segDays} 日`);
  if (!doctorNoteVerified) why.push("冇（或未核實）香港註冊醫生病假紙");
  return { qualifies: false, reason: `${why.join("；")} → 呢段全部當無薪假（扣日薪，冇津貼）` };
}

/** 4/5 疾病津貼金額＝平均工資 × 0.8 × 日數。 */
export function sl45Payment(avgWage: number, days: number): number {
  return round2(avgWage * SL_RATE * days);
}

// ---------------------------------------------------------------------------
// 4. 年假（§14 規則 9：過咗試用期就按比例累積，entitlement＝服務日數÷
//    365×entitle_year；離職時未放結餘×平均工資一次過補；試用期滿嗰日
//    唔算過咗；年假年資唔計轉長工前嘅散工段）
// ---------------------------------------------------------------------------

export interface AlEntitlementResult {
  entitled: number;
  passedProbation: boolean;
  reason: string;
}

/** 試用期完結日（`hireDate` 起計 `probationMonths` 個月後嗰日；
 * `probationMonths` 為 null／0＝冇試用期，即刻生效，回傳 null）。 */
export function probationEndDate(hireDate: Date, probationMonths: number | null | undefined): Date | null {
  if (!probationMonths) return null;
  return addMonths(hireDate, probationMonths);
}

/** 截至 `asOfDate` 有冇「已經過咗試用期」（§14 規則 9 邊界：試用期滿
 * 嗰日當日唔算過咗——要離完結日之後，即 `asOfDate >= probationEnd`）。 */
export function hasPassedProbation(hireDate: Date, probationMonths: number | null | undefined, asOfDate: Date): boolean {
  const end = probationEndDate(hireDate, probationMonths);
  if (end === null) return true; // 冇試用期＝即刻生效
  return asOfDate.getTime() >= end.getTime();
}

/**
 * 年假 entitlement（§14 規則 9，第十五節最終規則）：
 *   entitlement = entitleYearDays × 服務日數(serviceStart→asOfDate) ÷ 365
 * 服務日數由「開始服務日」（一般＝長工合約 `hireDate`，**唔計轉長工前
 * 嘅散工段**）起計；試用期入面（`asOfDate` 未過試用期）entitlement
 * 恆等於 0；一過咗試用期，entitlement 追溯返由 `serviceStart` 起計
 * 成段服務期（唔係由試用期完結日起計）。
 */
export function alEntitlementProrata(entitleYearDays: number, serviceStart: Date, asOfDate: Date, hireDateForProbation: Date, probationMonths: number | null | undefined): AlEntitlementResult {
  const svcDays = diffDaysInclusive(serviceStart, asOfDate);
  const rawEntitled = round2((entitleYearDays * svcDays) / 365);
  const passed = hasPassedProbation(hireDateForProbation, probationMonths, asOfDate);
  if (!passed) {
    const end = probationEndDate(hireDateForProbation, probationMonths);
    return {
      entitled: 0,
      passedProbation: false,
      reason: `開始服務日 ${isoDate(serviceStart)} → ${isoDate(asOfDate)} 共 ${svcDays} 日；試用期未過（完結日 ${end ? isoDate(end) : "-"}）→ entitlement = 0（如已過試用期本應 ${rawEntitled.toFixed(2)} 日）`,
    };
  }
  return {
    entitled: rawEntitled,
    passedProbation: true,
    reason: `開始服務日 ${isoDate(serviceStart)} → ${isoDate(asOfDate)} 共 ${svcDays} 日；已過試用期 → entitlement = ${entitleYearDays} × ${svcDays}/365 = ${rawEntitled.toFixed(2)} 日`,
  };
}

/** 離職年假結算＝（entitlement − 已放）× 平均工資（§14 規則 9：「離職
 * 年假結算＝餘額×平均工資」）。`balance` 唔可以為負（用 `Math.max(0,…)`
 * 保護，同 s07 `al_bal = max(0, ent-taken)` 一致）。 */
export function alLeaverBalance(entitled: number, taken: number): number {
  return round2(Math.max(0, entitled - taken));
}

export function alLeaverPayout(balance: number, avgWage: number): number {
  return round2(balance * avgWage);
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// 5. 勤工獎／OT／賣假／頂位——呢啲唔喺呢層寫死公式（老闆已定「OT 冇統一
//    公式」；賣假/頂位價目表逐盤逐職級唔同），淨係提供組裝 Gross 嘅
//    工具，實際金額由 caller（人手輸入項／rate card）決定。
// ---------------------------------------------------------------------------

export interface GrossComponents {
  netBasic: number;
  otAmount?: number;
  restDayPayment?: number; // 以薪代假（賣假）
  npsh?: number; // 無薪法定假扣款（負數或 0）
  nplDeduction?: number; // 無薪假扣款（負數或 0）
  sl45Amount?: number;
  specialAllowance?: number; // 勤工獎等
  otherAllowance?: number; // 頂位津貼等
  alPayment?: number;
}

/** Gross = Net Basic + OT + Rest Day Payment − NPSH − NPL/NPSL + 4/5 +
 * 津貼 + 年假薪（§14 規則 9／s07 `gross =` 公式，扣款分量傳負數）。 */
export function computeGross(c: GrossComponents): number {
  return round2((c.netBasic || 0) + (c.otAmount || 0) + (c.restDayPayment || 0) + (c.npsh || 0) + (c.nplDeduction || 0) + (c.sl45Amount || 0) + (c.specialAllowance || 0) + (c.otherAllowance || 0) + (c.alPayment || 0));
}

/** Autopay = Gross − MPF(僱員)。 */
export function computeAutopay(gross: number, mpfEe: number): number {
  return round2(gross - mpfEe);
}
