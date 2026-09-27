// `npm run gate:ltpay-july`——WP-LTPAY Phase 2 §21 任務 3b：長工月薪糧
// aggregate 層（`src/lib/longterm-payroll/aggregate.ts`）對 7 月真實
// 計糧表嘅驗收 gate。
//
// Oracle：`data/2026-07/reference/2026-07-長工月薪表-Maxwell-Frontline-
// GoogleSheet.xlsx`「7.2026」分頁——呢張唔係試算，係**公司實際上已經
// 出咗嘅 7 月糧單**（Alpha 出糧用嗰張表），48 人，總 Gross 835,408.14／
// Autopay 803,353.32（同 P2-版面重設計計劃.md §21 引用嘅數字一致）。
//
// 做法：讀呢張表逐人攞 (a) 合約基本資料（Staff No／Monthly Salary／
// Commencement Date／Working Hour／DOB）寫入 `guard_longterm_contracts`
// （唔存在先寫，用 note 標記嚟源方便重跑清走）；(b) 表入面已經摘埋嘅
// 「Special Allowance」／「Rest Day Payment」／「Other Allowance」寫做
// `longterm_payroll_inputs`（津貼類，人手輸入項嘅 gate 版本）——**淨係
// 呢兩類**，唔碰「Leave Deduction」／「Sick Leave Payment(4/5)」／
// 「Statutory Holiday Payment」／「Overtime」（呢幾樣要由 aggregate 層
// 自己由 `shift_records` 嘅正更／OT／leave 記錄計返嚟，唔可以由表嘅
// 已完成結果倒推人手輸入，否則個 gate 冧唔到真係計啱定計啱橋）。
// 之後跑 `recomputeLongtermPayroll(2026-07)`，逐人比對 Net Basic／
// Gross／MPF EE／MPF ER／Autopay，容差 0.05。
//
// **老實講低（唔扮做完）**：呢個 gate 目前**未達 0 差異**——實測
// 48 人有 109 個欄位差異（gross=29、mpfEe=24、mpfEr=25、autopay=29、
// netBasic=2；MPF EE/ER 差異同 gross 差異一定同時出現，因為 MPF 係跟
// Gross 算，唔係獨立錯誤）。已知落差原因（逐項查證過先寫低，唔係亂猜）：
//   1. **`shift_records` 嘅 OT 記錄完全冇覆蓋長工**（dev seed 7 月
//      `recordType="ot"` 得 6 條，全部 cash_casual，0 條屬
//      longterm_autopay）——表入面 12 位有 Overtime 金額嘅人呢層計出
//      嚟係 0。「更表資料管線」缺口，唔係計算引擎本身錯。
//   2. **NPSH（法定假日未做滿 3 個月扣款）冇觸發**——`aggregate.ts`
//      `computeShDeduction()` 邏輯已經寫低（`after_3_months` 分支），
//      但要跟 `guards.hireDate` 先啱；試過喺呢個 gate 直接將呢個 dev
//      seed 嘅 guards 全部設 `statutoryHolidayPaidFrom="after_3_months"`
//      —— **差異不跌反升**（29→35 條），因為唔少長工 `guards.hireDate`
//      已經俾另一個嚟源（同呢張 7 月表冇關）填咗，同呢張表嘅
//      Commencement Date 對唔上，令「做滿 3 個月未」判斷錯咗一批人。
//      跌返用 default（"immediate"，唔扣），呢個差異保留。
//   3. **SL 4/5／NPL Leave Deduction 未必完全對應**——呢個 gate 冇建
//      `longterm_payroll_inputs`（kind=leave，醫生紙 flag），SL 段一律
//      跌落 aggregate.ts 嘅 fallback（有 SL 更表記錄冇對應人手輸入 →
//      全部當無薪假），未必同表入面實際判定（邊段有攞到 4/5）一致。
//   4. **日薪制長工（`used_monthly < 5000` 嗰種——`monthlySalary` 欄
//      實際上係「每更 X 蚊」嘅日薪，唔係月薪）**——oracle（s07
//      `daily_rate_staff`）有呢個特判（Net Basic=日薪×更數），呢層
//      aggregate.ts／compute.ts **完全未做**，1 個人巨大差異（netBasic
//      少咗成 1 萬蚊）。
//   5. 有 1 人 Commencement Date 喺月中，Net Basic 表入面係足月（冇按
//      比例），呢層 aggregate.ts 用該表 Commencement Date 做入職日按
//      比例拆算，得出嚟嘅數細過表——懷疑呢張表嘅 Commencement Date
//      呢一行代表緊「呢個崗位╱職位轉任日」而唔係「呢個人喺公司做嘅
//      最早一日」（同 s07 oracle 用 Maxwell 名單獨立 commencement
//      唔同源），未查證。
//   6. 「平均工資」表未搬入系統——SL 4/5／AL 派彩 fallback 用「日薪＝
//      月薪/當月曆日數」，同表入面真正用嘅「平均工資」欄唔一定相等。
// 呢個 gate 嘅價值：畀下一手一個可執行、可以逐項收窄差異嘅 harness，
// 連同已經查證過嘅 5 個具體落差原因，唔係假裝 0 差異、都唔係亂咁猜。
import fs from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";
import { PrismaClient, Prisma } from "@prisma/client";
import { recomputeLongtermPayroll } from "@/lib/longterm-payroll/aggregate";
import { round2 } from "@/lib/reports/money";

const REPO_ROOT = path.resolve(__dirname, "../..");
const XLSX_PATH = path.resolve(REPO_ROOT, "data/2026-07/reference/2026-07-長工月薪表-Maxwell-Frontline-GoogleSheet.xlsx");
const FIXTURE_PATH = path.resolve(REPO_ROOT, "data/2026-07/longterm-payroll-fixture.json");
const GATE_TAG = "gate:ltpay-july";
const MONTH = new Date(Date.UTC(2026, 6, 1));

interface FixtureRow {
  staffNo: string;
  site: string | null;
  workingHour: number | null;
  commencementDate: string | null;
  monthlySalary: number;
  netBasic: number;
  overtime: number;
  restDayPayment: number;
  npsh: number;
  leaveDeduction: number;
  specialAllowance: number;
  otherAllowance: number;
  annualLeavePayment: number;
  sickLeavePayment45: number;
  statutoryHolidayPayment: number;
  salaryAdjustment: number;
  gross: number;
  mpfEe: number;
  mpfEr: number;
  autopay: number;
  dob: string | null;
}

function cellNum(v: unknown): number {
  if (v && typeof v === "object" && "result" in (v as Record<string, unknown>)) {
    const r = (v as { result: unknown }).result;
    return typeof r === "number" ? r : 0;
  }
  return typeof v === "number" ? v : 0;
}
function cellDate(v: unknown): string | null {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return null;
}

async function buildFixture(): Promise<FixtureRow[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(XLSX_PATH);
  const ws = wb.getWorksheet("7.2026");
  if (!ws) throw new Error(`揾唔到分頁 "7.2026"`);
  const rows: FixtureRow[] = [];
  for (let r = 4; r <= 51; r++) {
    const row = ws.getRow(r);
    const staffNo = row.getCell(3).value;
    if (!staffNo || typeof staffNo !== "string") continue;
    rows.push({
      staffNo,
      site: (row.getCell(2).value as string) || null,
      workingHour: cellNum(row.getCell(8).value) || null,
      commencementDate: cellDate(row.getCell(7).value),
      monthlySalary: cellNum(row.getCell(11).value),
      netBasic: cellNum(row.getCell(16).value),
      overtime: cellNum(row.getCell(17).value),
      restDayPayment: cellNum(row.getCell(18).value),
      npsh: cellNum(row.getCell(19).value),
      leaveDeduction: cellNum(row.getCell(20).value),
      specialAllowance: cellNum(row.getCell(21).value),
      otherAllowance: cellNum(row.getCell(22).value),
      annualLeavePayment: cellNum(row.getCell(23).value),
      sickLeavePayment45: cellNum(row.getCell(24).value),
      statutoryHolidayPayment: cellNum(row.getCell(25).value),
      salaryAdjustment: cellNum(row.getCell(26).value),
      gross: cellNum(row.getCell(27).value),
      mpfEe: cellNum(row.getCell(28).value),
      mpfEr: cellNum(row.getCell(29).value),
      autopay: cellNum(row.getCell(30).value),
      dob: cellDate(row.getCell(37).value),
    });
  }
  return rows;
}

async function main() {
  if (!fs.existsSync(XLSX_PATH)) {
    console.log(`[${GATE_TAG}] SKIP —— 揾唔到 ${XLSX_PATH}（呢個檔案唔入 git，本機冇呢份 data/ 就跳過，唔擋 CI／新 clone 環境）`);
    return;
  }

  const fixture = await buildFixture();
  fs.mkdirSync(path.dirname(FIXTURE_PATH), { recursive: true });
  fs.writeFileSync(FIXTURE_PATH, JSON.stringify(fixture, null, 1));
  console.log(`[${GATE_TAG}] 由 xlsx 生成 fixture：${fixture.length} 人，寫入 ${FIXTURE_PATH}（gitignored，唔入 git）`);

  const prisma = new PrismaClient();
  try {
    const actor = await prisma.user.findFirst({ where: { role: { name: "老闆" } }, select: { id: true } });
    if (!actor) throw new Error("dev DB 揾唔到「老闆」角色用戶——先 npm run db:seed");
    const actorUserId = actor.id;

    let matched = 0;
    const unmatched: string[] = [];
    for (const row of fixture) {
      const guard = await prisma.guard.findFirst({ where: { OR: [{ staffNoMw: row.staffNo }, { staffNo: row.staffNo }] } });
      if (!guard) {
        unmatched.push(row.staffNo);
        continue;
      }
      matched += 1;

      // (a) 合約——冪等：void 呢個 gate 之前建嘅版本，重新建（source=
      // manual，note 標 GATE_TAG 方便識別/清走，唔會撞已有嘅 maxwell_
      // import 合約，因為呢個係獨立 dev-only 驗收流程）。
      const existingGate = await prisma.guardLongtermContract.findMany({ where: { guardId: guard.id, voidedAt: null, note: { contains: GATE_TAG } } });
      for (const e of existingGate) await prisma.guardLongtermContract.update({ where: { id: e.id }, data: { voidedAt: new Date(), voidedBy: actorUserId } });
      const hasOtherOpenContract = await prisma.guardLongtermContract.findFirst({ where: { guardId: guard.id, voidedAt: null, NOT: { note: { contains: GATE_TAG } } } });
      if (!hasOtherOpenContract) {
        const effectiveFrom = row.commencementDate && row.commencementDate < "2026-07-01" ? new Date("2026-07-01") : row.commencementDate ? new Date(row.commencementDate) : new Date("2026-07-01");
        await prisma.guardLongtermContract.create({
          data: {
            guardId: guard.id,
            monthlySalary: row.monthlySalary,
            effectiveFrom,
            effectiveTo: null,
            shiftHours: row.workingHour ?? undefined,
            // ★ 試過將呢欄設做 "after_3_months"（7 月真實計糧表 col19
            // 「Leave Deduction (NPSH)」對部分新入職長工有扣款，睇落配
            // shift_records leaveCode=SH 記錄，似係《僱傭條例》「未做滿
            // 3 個月冇薪出法定假」）——但實測會令另一批「已做滿 3 個月」
            // 嘅人被錯誤扣款（差異由 29 條升到 35 條），追查發現係
            // `guards.hireDate` 唔一定等於呢張 7 月表嘅 Commencement
            // Date（唔少長工喺呢個 dev seed 已經由第啲嚟源填咗個
            // hireDate，同 Maxwell 真實入職日唔同步）——即係話呢個判斷
            // 要跟返「呢張表嘅 commencement date」先準確，唔可以淨係靠
            // `guards.hireDate`。跌返用 default（"immediate"，冇扣款），
            // 留返 npsh 呢個差異做已知落差（見檔頭註解），未收窄。
            mpfExemptReason: "auto",
            source: "manual",
            note: `${GATE_TAG}：由 7 月實際計糧表建（Monthly Salary/Commencement/Working Hour）`,
            createdBy: actorUserId,
          },
        });
      }
      const guardUpdate: Prisma.GuardUpdateInput = {};
      if (!guard.hireDate && row.commencementDate) guardUpdate.hireDate = new Date(row.commencementDate);
      if (!guard.dateOfBirth && row.dob) guardUpdate.dateOfBirth = new Date(row.dob);
      if (Object.keys(guardUpdate).length) await prisma.guard.update({ where: { id: guard.id }, data: guardUpdate });

      // (b) 人手輸入項——淨係津貼類（見檔頭註解：扣款/OT/SL/SH/AL 一律
      // 由 aggregate 層自己計，唔可以由表嘅已完成結果倒推）。
      await prisma.longtermPayrollInput.updateMany({ where: { month: MONTH, guardId: guard.id, note: { contains: GATE_TAG } }, data: { voidedAt: new Date(), voidedBy: actorUserId } });
      const allowanceTotal = round2(row.restDayPayment + row.otherAllowance);
      if (row.specialAllowance) {
        await prisma.longtermPayrollInput.create({ data: { month: MONTH, guardId: guard.id, kind: "special_allowance", amount: row.specialAllowance, note: `${GATE_TAG}：Special Allowance 欄`, createdBy: actorUserId } });
      }
      if (allowanceTotal) {
        await prisma.longtermPayrollInput.create({ data: { month: MONTH, guardId: guard.id, kind: "other_allowance", amount: allowanceTotal, note: `${GATE_TAG}：Rest Day Payment + Other Allowance 欄`, createdBy: actorUserId } });
      }
    }
    console.log(`[${GATE_TAG}] 配對：${matched}/${fixture.length}；未配對（staff no）：${unmatched.join("、") || "（無）"}`);

    const result = await recomputeLongtermPayroll(MONTH, actorUserId, null);
    console.log(`[${GATE_TAG}] recomputeLongtermPayroll(2026-07) → ${result.totals.guardCount} 人，Gross ${result.totals.grossTotal}／Autopay ${result.totals.autopayTotal}／MPF EE ${result.totals.mpfEeTotal}／ER ${result.totals.mpfErTotal}`);
    if (result.warnings.length) {
      console.log(`[${GATE_TAG}] warnings（${result.warnings.length}）：`);
      for (const w of result.warnings.slice(0, 20)) console.log(`  ${w}`);
    }

    const lines = await prisma.longtermPayrollLine.findMany({ where: { runId: result.runId }, include: { guard: { select: { staffNoMw: true, staffNo: true } } } });
    const lineByStaffNo = new Map(lines.map((l) => [l.guard.staffNoMw ?? l.guard.staffNo ?? "", l]));

    const TOL = 0.05;
    type DiffRow = { staffNo: string; field: string; oracle: number; system: number; diff: number };
    const diffs: DiffRow[] = [];
    let compared = 0;
    for (const row of fixture) {
      const line = lineByStaffNo.get(row.staffNo);
      if (!line) continue;
      compared += 1;
      // 表入面「MPF EE MC」／「MPF ER Cont.」兩欄嘅正負號唔一致——部分行
      // Autopay 公式係「Gross + MPF EE」（即 MPF EE 存負數，扣減語意），
      // 部分行係「Gross − MPF EE」（MPF EE 存正數）；MPF 供款經濟上恆
      // 非負，比較用 `Math.abs()` 先啱（唔係計算引擎有錯，係表嘅正負號
      // 唔統一）。
      const checks: Array<[string, number, number]> = [
        ["netBasic", row.netBasic, Number(line.netBasic)],
        ["gross", row.gross, Number(line.gross)],
        ["mpfEe", Math.abs(row.mpfEe), Number(line.mpfEe)],
        ["mpfEr", Math.abs(row.mpfEr), Number(line.mpfEr)],
        ["autopay", row.autopay, Number(line.autopay)],
      ];
      for (const [field, oracle, system] of checks) {
        const diff = round2(system - oracle);
        if (Math.abs(diff) > TOL) diffs.push({ staffNo: row.staffNo, field, oracle, system, diff });
      }
    }

    console.log(`\n[${GATE_TAG}] 逐人比對：${compared}/${fixture.length} 人有對到 line；${diffs.length} 個欄位差異（容差 ${TOL}）`);
    if (diffs.length) {
      console.log(`[${GATE_TAG}] 差異表（代號・欄・oracle・system・差額）：`);
      for (const d of diffs) console.log(`  ${d.staffNo}\t${d.field}\t${d.oracle}\t${d.system}\t${d.diff >= 0 ? "+" : ""}${d.diff}`);
      const byField = new Map<string, number>();
      for (const d of diffs) byField.set(d.field, (byField.get(d.field) ?? 0) + 1);
      console.log(`[${GATE_TAG}] 逐欄差異數：${[...byField.entries()].map(([f, c]) => `${f}=${c}`).join("、")}`);
      console.log(`[${GATE_TAG}] FAIL（未達 0 差異，已知原因見檔頭註解——呢個 gate 現階段係 harness／diagnostic，唔擋交付，見 P2-版面重設計計劃.md §21.2）`);
      process.exitCode = 1;
    } else {
      console.log(`[${GATE_TAG}] PASS —— 0 差異`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(`[${"gate:ltpay-july"}] 執行失敗`, err);
  process.exitCode = 1;
});
