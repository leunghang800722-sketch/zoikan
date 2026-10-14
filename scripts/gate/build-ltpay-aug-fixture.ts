// WP-LTPAY §21 任務 4a（老闆 2026-09-26 指令）：8 月長工糧 fixture 產生器
// ——由 8 月試算 oracle 產出（`data/2026-09/aug-payroll-trial/out/{longterm_
// payroll,maxwell_staff}.json`）抽每人「18 個人手輸入項」，寫成結構化
// fixture `data/2026-09/ltpay-aug-fixture.json`（gitignored，可以有真
// 姓名/工號——只喺 `data/` 底下先准，鐵則見 CLAUDE.md／任務書：code／
// test／commit 唔准真名真工號）。呢個 script 本身純讀 JSON 轉 JSON，
// 冇 DB 依賴、冇上載，`npm run gate:ltpay-aug` 先用呢個 fixture 寫入
// dev DB。
//
// 逐人抽嘅嘢（同時就係「呢啲資料以後喺系統內應該由邊個表輸入」嘅答案，
// 見下面 FixtureRow 每個欄嘅註解）：
//   1. 合約基本資料：monthlySalary／payBasis／dailyRate（日薪制特判，
//      §21 任務 4b(a)）、commencement、workingHour、probationMonths、
//      annualLeaveDays、mid-month 轉約（newBasic/newBasicEff）——
//      應該由「長工合約」management 頁面（未起，見 §21.2 第 4 點）人手
//      輸入／Maxwell 匯入（`maxwell-import.ts` 已有）。
//   2. Guard 層面：hireDate／leaveDate／dob——`guards` 表現有欄位，
//      Maxwell 匯入已經寫（`import-service.ts`）。
//   3. 人手輸入項（`longterm_payroll_inputs`）：
//      - special_allowance（勤工獎）／other_allowance（賣假＋頂位津貼
//        合計，§14 規則 9 價目表由會計對照，呢層唔喺引擎寫死）——
//        會計每月喺「人手輸入表」（未起）填。
//      - leave（SL 段＋醫生紙 flag）——oracle 假設「有醫生紙，要 HR
//        核實」（`SL_DOCTOR_NOTE` 常數），fixture 跟呢個假設寫
//        doctorNoteVerified=true；實際運作應該由 HR 逐段核實先至可以
//        提交。
//      - 離職補年假：**唔再**由 oracle 抽 `annual_leave_payout`（嗰個係
//        oracle 嘅*輸出*，抽落嚟做 override 等於 gate 冇驗到年假按比例
//        引擎——Opus 5.5 驗收 2026-09-27 修正）。而家淨係俾輸入（離職日、
//        入職日、試用期、每年年假日數、平均工資、8 月前已放 AL），由
//        `aggregate.ts` 自己計，再同 oracle 比。
//   ★ 已知仍然係「oracle 輸出當輸入」嘅一項：`otherAllowanceCombined`
//     ＝oracle `rest_day_pay`（賣假：返工日−26 × 盤級價目表）＋
//     `other_allow`（1331 IC/兵頂位 ±100）。引擎而家冇呢兩條規則（設計上
//     交會計人手輸入），所以 gate 對呢 6,950 係冇驗證能力——見
//     P2-版面重設計計劃.md §21.7。
//   4. 平均工資（`guard_avg_wages`，§21 任務 4b(b)）——嚟源係 7 月計糧表
//      「平均工資」欄（`july_payroll.json` `avg_wage`，喺 oracle 入面
//      已經摺埋落 `longterm_payroll.json` 嘅 `sl_avg_wage`／
//      `al_daily_rate_basis`），未來應該由「過去 12 個月 lines 自動計」
//      （有 lines 先計，冇就人手，見任務書）。
//   5. 病假累積（`guard_leave_balances` 開波結餘）——oracle 用
//      `prior_sick_leave.json`（7 月或之前已經攞咗嘅有薪病假日數）做
//      SL accrual 起點，呢層寫做 `guard_leave_balances` 8 月開波
//      slTaken（8 月 1 號前）。
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "../..");
const TRIAL_OUT_DIR = path.resolve(REPO_ROOT, "data/2026-09/aug-payroll-trial/out");
const FIXTURE_PATH = path.resolve(REPO_ROOT, "data/2026-09/ltpay-aug-fixture.json");
const GATE_TAG = "gate:ltpay-aug";
const AUG_MONTH_ISO = "2026-08-01";

interface OracleAlInfo {
  probation_months: string | number | null;
  taken_before_aug?: number | null;
}
interface OracleSlSegment {
  start: string;
  end: string;
  sl_days: number;
  qualify: boolean;
}
interface OracleRow {
  staff_no: string;
  name: string;
  site: string | null;
  status: string;
  commencement: string | null;
  last_day: string | null;
  monthly: number;
  monthly_maxwell: number | null;
  new_basic: number | null;
  new_basic_eff: string | null;
  mid_month_change: boolean;
  prorate_old_monthly: number | null;
  work_days: number;
  sl_segments: OracleSlSegment[];
  sl_avg_wage: number | null;
  visa_sponsor: boolean;
  is_leaver: boolean;
  leave_date: string | null;
  annual_leave_entitle_year: number | null;
  annual_leave_payout: number;
  al_daily_rate_basis: string | null;
  al_info: OracleAlInfo | null;
  visa_broker: string | null;
  sell_leave_rate: number;
  rest_day_pay: number;
  other_allow: number;
  special_allow: number | null;
  net_basic: number;
  ot: number;
  npsh: number;
  npl_deduct: number;
  sl_pay: number;
  gross: number;
  mpf_ee: number;
  mpf_er: number;
  autopay: number;
}
interface MaxwellStaffRow {
  staff_no: string;
  dob: string | null;
  working_hour: number | null;
  probation_months: string | number | null;
  rest_day: string | null;
  stat_holiday: string | null;
}
interface PriorSickLeaveRow {
  staff_no: string;
  month: string;
  paid_days: number;
}

export interface LtpayAugFixtureRow {
  staffNo: string;
  name: string; // 只喺 data/ gitignored fixture 出現，唔准流入 code/test/commit
  site: string | null;
  contract: {
    payBasis: "monthly" | "daily";
    monthlySalary: number; // payBasis=daily 嗰陣＝dailyRate×當月曆日數（等 dailyRateOnDate() 逐日/月薪/31 公式喺其他扣款計算保持一致，見 aggregate.ts 4b(a) 註解）
    dailyRate: number | null;
    effectiveFrom: string;
    workingHour: number | null;
    probationMonths: number | null;
    annualLeaveDays: number;
    statutoryHolidayPaidFrom: "immediate" | "after_3_months";
    midMonthChange: { newBasic: number; newBasicEff: string; oldMonthly: number } | null;
  };
  guard: {
    hireDate: string | null;
    leaveDate: string | null;
    dob: string | null;
  };
  /** §14 規則 12 簽證形式長工——贊助雞頭代號（gate 用嚟設 guards.visaSponsoredByBrokerId）。 */
  visaBrokerCode: string | null;
  /** 8 月前已放年假日數（oracle 輸入：boss_answers LEAVERS al_taken_before_aug；冇就 0）。 */
  priorAlTakenDays: number;
  inputs: {
    specialAllowance: number;
    otherAllowanceCombined: number; // 賣假(rest_day_pay)＋頂位/其他(other_allow) 合計，餵 aggregate.ts otherAllowance（restDayPayment 呢層恆為 0，見 aggregate.ts 檔頭）
    slSegments: Array<{ dateFrom: string; dateTo: string; doctorNoteVerified: boolean; note?: string }>;
    leaverSettlement: { amount: number | null; dateFrom: string } | null;
  };
  avgWage: { value: number; source: string } | null;
  priorSlPaidDays: number; // guard_leave_balances 8 月開波 slTaken
  oracle: { netBasic: number; ot: number; npsh: number; npl: number; slPay: number; gross: number; mpfEe: number; mpfEr: number; autopay: number; workDays: number };
}

function readJson<T>(name: string): T {
  return JSON.parse(fs.readFileSync(path.join(TRIAL_OUT_DIR, name), "utf8")) as T;
}

function normProbation(v: string | number | null | undefined): number | null {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s || s === "None" || s.toLowerCase() === "no") return null;
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function daysInMonth(iso: string): number {
  const [y, m] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function main() {
  const oracleFile = path.join(TRIAL_OUT_DIR, "longterm_payroll.json");
  if (!fs.existsSync(oracleFile)) {
    console.log(`[${GATE_TAG}-fixture] SKIP —— 揾唔到 ${path.relative(REPO_ROOT, oracleFile)}，本機冇 8 月試算 oracle 輸出，跳過（同其他 data/ 依賴 gate 一致做法）`);
    return;
  }
  const rows = readJson<OracleRow[]>("longterm_payroll.json");
  const maxwellStaff = readJson<MaxwellStaffRow[]>("maxwell_staff.json");
  const maxwellByStaffNo = new Map(maxwellStaff.map((s) => [s.staff_no, s]));
  const priorSl = readJson<PriorSickLeaveRow[]>("prior_sick_leave.json");
  const priorSlByStaffNo = new Map<string, number>();
  for (const r of priorSl) {
    priorSlByStaffNo.set(r.staff_no, (priorSlByStaffNo.get(r.staff_no) ?? 0) + (r.paid_days || 0));
  }

  const fixture: LtpayAugFixtureRow[] = [];
  let visaCount = 0;
  for (const row of rows) {
    // §14 規則 12：簽證形式長工公司照出糧（autopay＋MPF），照入長工糧 run
    // （Opus 5.5 驗收修正：原本跳過，令系統總數同 8 月定稿差一個人）。
    if (row.visa_sponsor) visaCount += 1;
    const mw = maxwellByStaffNo.get(row.staff_no);
    const monthDaysCount = daysInMonth(AUG_MONTH_ISO);
    const isDailyRateStaff = row.monthly < 5000; // 同 s07 daily_rate_staff = used_monthly < 5000 一致（§21 任務 4b(a)）
    const dailyRate = isDailyRateStaff ? row.monthly : null;
    const monthlySalary = isDailyRateStaff ? Math.round(row.monthly * monthDaysCount * 100) / 100 : row.monthly;

    const commencement = row.commencement || "2026-01-01";
    const midMonthChange = row.mid_month_change && row.new_basic != null && row.new_basic_eff ? { newBasic: row.new_basic, newBasicEff: row.new_basic_eff, oldMonthly: row.prorate_old_monthly ?? row.monthly_maxwell ?? row.monthly } : null;

    fixture.push({
      staffNo: row.staff_no,
      name: row.name,
      site: row.site,
      contract: {
        payBasis: isDailyRateStaff ? "daily" : "monthly",
        monthlySalary,
        dailyRate,
        effectiveFrom: commencement,
        workingHour: mw?.working_hour ?? null,
        probationMonths: normProbation(mw?.probation_months ?? row.al_info?.probation_months ?? null),
        annualLeaveDays: row.annual_leave_entitle_year ?? 7,
        // 8 月試算 boss_answers 查證：maxwell_staff.json `stat_holiday`
        // 觀察到嘅值淨係「即時享有薪SH」或 null，未見任何 after_3_months
        // 個案（見 P2-版面重設計計劃.md §21），fixture 一律用 default。
        statutoryHolidayPaidFrom: "immediate",
        midMonthChange,
      },
      visaBrokerCode: row.visa_sponsor ? row.visa_broker || null : null,
      priorAlTakenDays: row.al_info?.taken_before_aug ?? 0,
      guard: {
        hireDate: commencement,
        leaveDate: row.is_leaver ? row.leave_date : row.last_day,
        dob: mw?.dob ?? null,
      },
      inputs: {
        specialAllowance: row.special_allow || 0,
        otherAllowanceCombined: Math.round(((row.rest_day_pay || 0) + (row.other_allow || 0)) * 100) / 100,
        // P17：確認醫生紙＝出津貼（SL_CONFIRMED_SHORT_PAID=true，唔理連續幾日）。底稿對所有 SL 段一律「假設有，要 HR 核實」，
        // 但 oracle 實際只對連續 ≥4 日、而且該人 sl_pay > 0 嘅段出津貼（銀行 8 月對短段亦冇出）——所以只喺 oracle 真係出咗津貼嘅段標已核實，
        // 其餘標未核實（當無薪），gate 先反映 oracle 真實。
        slSegments: row.sl_segments.map((s) => {
          const span = Math.round((Date.parse(`${s.end}T00:00:00Z`) - Date.parse(`${s.start}T00:00:00Z`)) / 86400000) + 1;
          const paid = (row.sl_pay ?? 0) > 0 && span >= 4;
          return paid ? { dateFrom: s.start, dateTo: s.end, doctorNoteVerified: true } : { dateFrom: s.start, dateTo: s.end, doctorNoteVerified: false, note: "底稿假設有醫生紙但 oracle 未出津貼→當未核實" };
        }),
        // amount=null → 引擎自動計（唔抽 oracle 輸出）；dateFrom 淨係離職日（輸入）。
        leaverSettlement: row.is_leaver ? { amount: null, dateFrom: row.leave_date as string } : null,
      },
      avgWage: row.sl_avg_wage != null ? { value: row.sl_avg_wage, source: row.al_daily_rate_basis || "7 月計糧表「平均工資」欄" } : null,
      priorSlPaidDays: priorSlByStaffNo.get(row.staff_no) ?? 0,
      oracle: {
        netBasic: row.net_basic,
        ot: row.ot,
        npsh: row.npsh,
        npl: row.npl_deduct,
        slPay: row.sl_pay,
        gross: row.gross,
        mpfEe: Math.abs(row.mpf_ee),
        mpfEr: Math.abs(row.mpf_er),
        autopay: row.autopay,
        workDays: row.work_days,
      },
    });
  }

  fs.mkdirSync(path.dirname(FIXTURE_PATH), { recursive: true });
  fs.writeFileSync(FIXTURE_PATH, JSON.stringify(fixture, null, 1));
  console.log(`[${GATE_TAG}-fixture] 由 oracle 產生 fixture：${fixture.length} 人（其中 ${visaCount} 人簽證形式長工，照入 run），寫入 ${path.relative(REPO_ROOT, FIXTURE_PATH)}（gitignored）`);
  const dailyRateCount = fixture.filter((f) => f.contract.payBasis === "daily").length;
  const leaverCount = fixture.filter((f) => f.inputs.leaverSettlement).length;
  const midChangeCount = fixture.filter((f) => f.contract.midMonthChange).length;
  console.log(`[${GATE_TAG}-fixture] 日薪制 ${dailyRateCount} 人；離職結算 override ${leaverCount} 人；月中轉約 ${midChangeCount} 人`);
}

main();
