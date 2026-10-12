// WP-LTPAY Phase 2 §21 任務 3a（老闆 2026-09-26 指令）：aggregate 層——
// 將真實 DB 資料砌成 `compute.ts` 嘅輸入，逐人跑純函數，寫
// `longterm_payroll_runs`／`longterm_payroll_lines`。呢層係接連「計算
// 引擎」同「真實更表資料」嘅橋（見 P2-版面重設計計劃.md §21.2 第 2 點）。
//
// 資料來源（逐一對應任務書）：
//   (a) `shift_records`（該月、非 cancelled）：
//       - recordType=shift、settlementBrokerId=kind=internal_longterm
//         （B07）嘅正更 → 長工自己崗位嘅返工日（`workDays`）；
//       - recordType=shift、settlementBrokerId＝其他雞頭 → §14 規則 2
//         「長工用自己假期幫雞頭做散更」，嗰日唔當長工返工日（雞頭現金
//         結算，唔重複喺長工糧計）；
//       - recordType=ot → OT 小時，逐日跟返嗰日所屬合約嘅日薪（A-9b）；
//       - recordType=leave＋leaveCode → RD/OFF、AL、SL、NL/NPL、SH 逐日
//         代號（NL/NPL 扣日薪；AL／SH 淨係計日數，唔喺呢層扣錢，AL 淨係
//         離職結算先用得著；SH 扣款睇合約 `statutoryHolidayPaidFrom`）。
//   (b) `longterm_payroll_inputs`：
//       - kind=leave：SL 病假**連續段**（含醫生紙 `doctorNoteVerified`）
//         ——shift_records 冇醫生紙欄，所以 4/5 判定要靠會計逐段人手輸入
//         嘅呢張表；segDays 由段內 shift_records leaveCode=SL 嘅日子數
//         返嚟（唔靠人手再打日數，避免兩處數唔同步）。
//       - kind=special_allowance／other_allowance／uniform／deduction：
//         勤工獎、**賣假／頂位津貼**（§14 規則 9「賣假／頂位價...只適用
//         於由雞頭供應入公司嘅長工」——價目表逐盤逐職級，屬配置數據，
//         **刻意冇喺呢層寫死**，由會計用 other_allowance 人手金額輸入）、
//         制服、扣款，逐項加/減 Gross。
//       - kind=leaver_settlement：離職結算——`dateFrom`＝離職日 override
//         （冧唔到 `guards.leaveDate` 嗰陣用），`amount` 有值就直接當
//         離職年假補水金額（覆蓋自動計算，會計已經用「終止僱傭合約薪酬
//         計算表」核實過嗰種情況）。
//   (c) `guard_leave_balances`：SL 累積結餘、AL 已放（`alTaken`）起點——
//       淨係讀，呢層**唔會自動寫回**（見下面「刻意冇做」）。
//   (d) `guard_longterm_contracts`：月中轉約多段，交返 `compute.ts` 嘅
//       `contractSegmentForDate()`/`computeNetBasic()` 逐日拆算。
//
// 個案業務規則（跟 §21 任務書 3a 段）：
//   - 簽證形式長工（`guard.visaSponsoredByBrokerId` 有值）——§14 規則 12：
//     公司每月**照出** autopay＋MPF（人工照計），所以**照入長工糧 run**
//     （Autopay 檔先會有佢，唔會漏出糧／漏供 MPF）。佢喺雞頭盤做嘅散更
//     屬雞頭自己對數，唔當長工返工日，亦**唔同「幫雞頭頂散更」撈埋**
//     （notes 另寫簽證形式標記）。嗰筆錢每月由雞頭結算扣返（系統外現金
//     扣減），所以 `totals.visaPassthrough` 另外合計，月結「合併成本」
//     （§16.2 預算表第一層口徑，8 月預算表 B5＝55 人唔含佢）要剔走。
//     （Opus 5.5 驗收 2026-09-27 修正：原本成個人跳過，會令 autopay 檔
//     漏咗佢、MPF 漏供，同 8 月定稿 917,875.19 對唔上。）
//   - 長工頂雞頭散更（settlementBrokerId≠B07）——唔算返工日，都唔會喺
//     呢層做任何扣款／賣假計算（雞頭自己出糧）。
//
// **刻意冇做**（老實列出，見 P2-版面重設計計劃.md §21）：
//   1. 賣假／頂位（1331 IC/兵 ±100 呢類逐盤逐職級價目表）——人手輸入
//      （見上面 (b)）。
//   2. `guard_leave_balances` 自動寫回——呢層淨係讀，唔 mutate；逐月點
//      樣更新結餘（AL carry／SL accrued）留返下一手，冪等風險未驗證前
//      唔敢自動寫。
//   3. 法定假日（SH）`statutoryHolidayPaidFrom=after_3_months` 嘅扣款
//      邏輯已經寫（睇 `computeShDeduction`），但 8 月試算冇法定假日可以
//      對照，**未經 oracle 驗證**，用嗰陣要人手覆核。
//   4. 「平均工資」表未搬入系統（7 月試算用嘅係計糧表 col M 快照）——
//      AL 離職結算／SL 4/5 一律 fallback 用「日薪＝月薪÷當月曆日數」
//      （同 `compute.ts` JSDoc 一致嘅 fallback 口徑），會喺 notes 標明。
import type { PrismaClient, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { writeAuditTx } from "@/lib/audit";
import { Conflict } from "@/lib/api/errors";
import { monthRange, monthStart as toMonthStart, monthLabel, n, round2 } from "@/lib/reports/money";
import { findInternalLongtermBrokerId } from "@/lib/pricing/longterm-settlement";
import { classifyLongtermShift } from "./shift-classify";
import { HK_STATUTORY_HOLIDAYS_2026 } from "./hk-holidays";
import {
  type ContractSegment,
  daysInMonth,
  toUtcDate,
  diffDaysInclusive,
  addMonths,
  dailyRateOnDate,
  contractSegmentForDate,
  computeNetBasic,
  computeNetBasicDaily,
  computeMpf,
  slAccrued,
  slSegmentVerdict,
  sl45Payment,
  alEntitlementProrata,
  alLeaverBalance,
  alLeaverPayout,
  computeGross,
  computeAutopay,
} from "./compute";

type PrismaLike = PrismaClient | Prisma.TransactionClient;

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

interface LongtermPayrollLineResult {
  guardId: string;
  guardName: string;
  contractSnapshot: Array<{ monthlySalary: number; effectiveFrom: string; effectiveTo: string | null }>;
  daysInMonth: number;
  employStart: string;
  employEnd: string;
  isLeaver: boolean;
  workDays: number;
  netBasic: number;
  otHours: number;
  otAmount: number;
  restDayPayment: number;
  npsh: number;
  nplDays: number;
  npslDays: number;
  deduction: number; // NPL/NPSL 合計扣款（負數）
  specialAllowance: number;
  otherAllowance: number;
  alPayment: number;
  sl45Amount: number;
  gross: number;
  mpfEe: number;
  mpfEr: number;
  mpfExemptReason: string | null;
  autopay: number;
  /** §14 規則 12 簽證形式長工（照出糧，passthrough 由雞頭結算扣返）。 */
  visaPassthrough: boolean;
  notes: string[];
  // §21 任務 4b(f)：`guard_leave_balances` 寫回用（唔喺 `LongtermPayrollLine`
  // 表出現，`recomputeLongtermPayroll()` persist 嗰陣先讀呢幾個欄
  // upsert `guard_leave_balances`；`buildLongtermPayrollInputs()` 本身
  // 淨係讀唔寫，保持純函數）。
  leaveBalanceWriteback: {
    alTakenCumulative: number; // 今年（calendar year）累積已放 AL（含今個月）
    slTakenCumulative: number; // 累積已攞 4/5 有薪病假日（含今個月）
    slAccruedAtMonthEnd: number; // 截至月尾嘅病假結餘 snapshot（做滿 1 個月起、每月 2 日、上限 120）
    alOpeningUsed: number; // 呢次計糧用嗰個「呢個月開始前」嘅 AL 累積（寫返做新嘅 alTakenOpening）
    slOpeningUsed: number; // 同上，SL 版
  };
}

export interface BuildLongtermPayrollResult {
  month: Date;
  daysInMonth: number;
  lines: LongtermPayrollLineResult[];
  totals: LongtermPayrollTotals;
  warnings: string[];
}

/** run 合計。`visaPassthrough`＝簽證形式長工（§14 規則 12）嘅部分——
 * 已經包喺 grossTotal／autopayTotal／mpf*Total 入面（公司真係要出呢筆
 * 糧），另外列出嚟俾月結「合併成本」剔走（雞頭結算扣返）。 */
interface LongtermPayrollTotals {
  grossTotal: number;
  autopayTotal: number;
  mpfEeTotal: number;
  mpfErTotal: number;
  guardCount: number;
  visaPassthrough: { guardCount: number; grossTotal: number; autopayTotal: number; mpfEeTotal: number; mpfErTotal: number };
}

function emptyTotals(): LongtermPayrollTotals {
  return { grossTotal: 0, autopayTotal: 0, mpfEeTotal: 0, mpfErTotal: 0, guardCount: 0, visaPassthrough: { guardCount: 0, grossTotal: 0, autopayTotal: 0, mpfEeTotal: 0, mpfErTotal: 0 } };
}

const UNPAID_LEAVE_CODES = new Set(["NL", "NPL"]);
const REST_DAY_CODES = new Set(["RD", "OFF"]);

/** 對數工具 note 前綴（P16b.3）：bank-reconcile 用呢個前綴數「有同日多來源衝突」嘅人。 */
export const ATTENDANCE_CONFLICT_PREFIX = "⚠ 同日多來源紀錄衝突：";

/**
 * P16b.3：同一人同一日有 ≥2 個來源（shift_records.source，例如 roster_upload／master_roster／payroll_only）
 * 而且各來源嘅「出勤代號」（班＝shift、假＝leaveCode；OT 唔計入比較）唔一致 → 回傳提示 note。
 * 只提示，唔影響 aggregate 揀邊條紀錄（計算公式不變）。
 */
export function attendanceConflictNote(srs: Array<{ workDate: Date; recordType: string; leaveCode: string | null; source: string | null }>): string | null {
  const byDate = new Map<string, Map<string, Set<string>>>();
  for (const r of srs) {
    const code = r.recordType === "shift" ? "班" : r.recordType === "leave" && r.leaveCode ? r.leaveCode : null;
    if (!code) continue;
    const d = r.workDate.toISOString().slice(5, 10);
    const bySrc = byDate.get(d) ?? new Map<string, Set<string>>();
    const set = bySrc.get(r.source ?? "（無來源）") ?? new Set<string>();
    set.add(code);
    bySrc.set(r.source ?? "（無來源）", set);
    byDate.set(d, bySrc);
  }
  const parts: string[] = [];
  for (const d of [...byDate.keys()].sort()) {
    const bySrc = byDate.get(d)!;
    if (bySrc.size < 2) continue;
    const sigs = [...bySrc.entries()].map(([src, set]) => [src, [...set].sort().join("＋")] as const).sort((a, b) => a[0].localeCompare(b[0]));
    if (new Set(sigs.map((x) => x[1])).size < 2) continue;
    parts.push(`${d}（${sigs.map(([src, sig]) => `${src} 代號 ${sig}`).join(" / ")}）`);
  }
  return parts.length ? `${ATTENDANCE_CONFLICT_PREFIX}${parts.join("、")}——系統按現行規則揀其中一條計，要人手核更表` : null;
}

/** 由一段（可能有多段合約重疊呢個月）嘅合約，計返 (a) 當月「合約覆蓋」
 * 嘅最早／最遲日期（clip 落月頭/月尾之前）。 */
function contractCoverage(segments: ContractSegment[], monthStartD: Date, monthEndD: Date): { start: Date; end: Date } {
  const earliest = segments.reduce((a, b) => (a.effectiveFrom.getTime() <= b.effectiveFrom.getTime() ? a : b));
  const openEnded = segments.some((s) => s.effectiveTo === null);
  let end = monthEndD;
  if (!openEnded) {
    const latestEnd = segments.reduce((a, b) => (a.effectiveTo!.getTime() >= b.effectiveTo!.getTime() ? a : b)).effectiveTo!;
    if (latestEnd.getTime() < end.getTime()) end = latestEnd;
  }
  const start = earliest.effectiveFrom.getTime() > monthStartD.getTime() ? earliest.effectiveFrom : monthStartD;
  return { start, end };
}

/** 法定假日（SH）扣款——`statutoryHolidayPaidFrom==='after_3_months'`
 * 且截至嗰日未做滿 3 個月先扣（未經 oracle 個案驗證，見檔頭「刻意冇做」
 * 第 3 點）。 */
function computeShDeduction(shDates: string[], segments: ContractSegment[], monthDaysCount: number, hireDate: Date | null, statutoryHolidayPaidFrom: string): { npsh: number; notes: string[] } {
  if (!shDates.length) return { npsh: 0, notes: [] };
  // §21 任務 4b(d)：更表 leaveCode=SH 嘅日子理應同官方法定假日一致——
  // 唔喺官方清單嘅就標低（資料質素信號，唔擋計算，見 hk-holidays.ts）。
  const unknownShDates = shDates.filter((d) => !HK_STATUTORY_HOLIDAYS_2026.includes(d));
  const dataQualityNote = unknownShDates.length ? [`⚠ leaveCode=SH 嘅 ${unknownShDates.join("、")} 唔喺 hk-holidays.ts 官方法定假日清單入面，可能係更表打錯代號，人手覆核`] : [];
  if (statutoryHolidayPaidFrom !== "after_3_months" || !hireDate) {
    return { npsh: 0, notes: [`法定假 ${shDates.join("、")}：有薪（${statutoryHolidayPaidFrom === "after_3_months" ? "冇入職日資料，保守當有薪" : "immediate"}），冇扣款`, ...dataQualityNote] };
  }
  const threeMonthMark = addMonths(hireDate, 3);
  let deduct = 0;
  const unpaidDates: string[] = [];
  for (const dISO of shDates) {
    const d = toUtcDate(dISO);
    if (d.getTime() < threeMonthMark.getTime()) {
      deduct += dailyRateOnDate(segments, d, monthDaysCount);
      unpaidDates.push(dISO);
    }
  }
  if (!unpaidDates.length) return { npsh: 0, notes: [`法定假 ${shDates.join("、")}：已做滿 3 個月，有薪，冇扣款`, ...dataQualityNote] };
  return {
    npsh: -round2(deduct),
    notes: [`法定假未做滿 3 個月（試用期未過 statutoryHolidayPaidFrom=after_3_months）：${unpaidDates.join("、")} 扣 -${round2(deduct).toFixed(2)}（未經 oracle 個案驗證，人手覆核）`, ...dataQualityNote],
  };
}

/**
 * 純讀取＋計算——冇任何 DB 寫入，方便測試／預覽（頁面「重算前預覽」
 * 都可以直接用呢個）。實際持久化由 `recomputeLongtermPayroll()` 做。
 */
export async function buildLongtermPayrollInputs(month: Date, client: PrismaLike = prisma, opts: { zeroOpening?: boolean } = {}): Promise<BuildLongtermPayrollResult> {
  const { start, end } = monthRange(month);
  const monthDaysCount = daysInMonth(start.getUTCFullYear(), start.getUTCMonth() + 1);
  const warnings: string[] = [];

  const contracts = await client.guardLongtermContract.findMany({
    where: { voidedAt: null, effectiveFrom: { lte: end }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: start } }] },
    orderBy: { effectiveFrom: "asc" },
  });
  const contractsByGuard = new Map<string, typeof contracts>();
  for (const c of contracts) {
    const arr = contractsByGuard.get(c.guardId) ?? [];
    arr.push(c);
    contractsByGuard.set(c.guardId, arr);
  }
  const guardIds = [...contractsByGuard.keys()];
  // §14 規則 9：年假年資「由長工合約入職日計、唔計轉長工前嘅散工段」——
  // `guards.hire_date` 可能係散工段開始日（Maxwell 導入淨係補空、唔覆蓋），
  // 所以年假 entitlement 用呢個人**最早一段長工合約**嘅生效日（Opus 5.5
  // 驗收修正；原本用 hire_date，散工轉長工嘅人離職會多補年假）。
  const firstContractByGuard = new Map<string, Date>();
  if (guardIds.length) {
    const firsts = await client.guardLongtermContract.groupBy({ by: ["guardId"], where: { guardId: { in: guardIds }, voidedAt: null }, _min: { effectiveFrom: true } });
    for (const f of firsts) if (f._min.effectiveFrom) firstContractByGuard.set(f.guardId, toUtcDate(f._min.effectiveFrom));
  }
  if (!guardIds.length) {
    return { month: start, daysInMonth: monthDaysCount, lines: [], totals: emptyTotals(), warnings };
  }

  const guards = await client.guard.findMany({ where: { id: { in: guardIds } } });
  const guardById = new Map(guards.map((g) => [g.id, g]));

  const internalLongtermBrokerId = await findInternalLongtermBrokerId(client as never);
  if (!internalLongtermBrokerId) {
    warnings.push("揾唔到 kind=internal_longterm（B07）嘅結算單位——全部長工返工日會計做 0，請先設定 B07");
  }

  const shiftRecords = await client.shiftRecord.findMany({
    where: { guardId: { in: guardIds }, workDate: { gte: start, lte: end }, status: { not: "cancelled" } },
    select: { guardId: true, workDate: true, recordType: true, leaveCode: true, otHours: true, settlementBrokerId: true, source: true },
  });
  const shiftsByGuard = new Map<string, typeof shiftRecords>();
  for (const r of shiftRecords) {
    const arr = shiftsByGuard.get(r.guardId) ?? [];
    arr.push(r);
    shiftsByGuard.set(r.guardId, arr);
  }

  const inputs = await client.longtermPayrollInput.findMany({ where: { month: start, guardId: { in: guardIds }, voidedAt: null, status: "confirmed" } }); // P9.1：草稿未確認唔計糧
  const inputsByGuard = new Map<string, typeof inputs>();
  for (const i of inputs) {
    const arr = inputsByGuard.get(i.guardId) ?? [];
    arr.push(i);
    inputsByGuard.set(i.guardId, arr);
  }

  // Opus 5.5 驗收修正（跨年）：病假結餘同離職年假 entitlement 都係由入職日
  // 起計成段服務期（§14 規則 9），所以「已放」都要係成段服務期累積——
  // 今年未有記錄就接上一年（最近一年）嘅累積做 opening，唔可以每年 1 月
  // 歸零（歸零會令病假結餘虛高、離職年假多補）。
  const balances = await client.guardLeaveBalance.findMany({ where: { guardId: { in: guardIds }, year: { lte: start.getUTCFullYear() } }, orderBy: { year: "desc" } });
  const balanceByGuard = new Map<string, (typeof balances)[number]>();
  for (const b of balances) if (!balanceByGuard.has(b.guardId)) balanceByGuard.set(b.guardId, b);

  // §21 任務 4b(f)：「呢個月嘅 opening（開始嗰陣嘅）已放 AL／SL」——
  // 正常順序（`asOfMonth` 冇記錄或者 < 呢個月）就用最新嘅 `alTaken`／
  // `slTaken`（上個月結算完嘅累積）；同一個月重算（`asOfMonth` ==
  // 呢個月，即 void 舊 run 建新 run 嗰種冪等重算）要用返
  // `alTakenOpening`／`slTakenOpening`（呢個月開始前嘅累積），唔可以
  // 用已經計咗一次「呢個月」嘅 `alTaken`／`slTaken`，否則會愈計愈多。
  function openingLeaveTaken(guardId: string): { al: number; sl: number } {
    const b = balanceByGuard.get(guardId);
    if (!b || opts.zeroOpening) return { al: 0, sl: 0 }; // zeroOpening（P15.1 legacy 回滾專用）：以 0 起算攞「呢個月新增」日數
    if (b.year === start.getUTCFullYear() && b.asOfMonth && b.asOfMonth.getTime() === start.getTime()) {
      return { al: n(b.alTakenOpening), sl: n(b.slTakenOpening) };
    }
    return { al: n(b.alTaken), sl: n(b.slTaken) };
  }

  // §21 任務 4b(b)：平均工資——SL 4/5／AL 離職結算派彩優先用呢張表（月
  // 就住嗰個月），冇記錄先 fallback「日薪＝月薪/當月曆日數」（見下面
  // 兩處用 `avgWageByGuard.get(guardId)`）。
  const avgWages = await client.guardAvgWage.findMany({ where: { guardId: { in: guardIds }, month: start, voidedAt: null } });
  const avgWageByGuard = new Map(avgWages.map((w) => [w.guardId, { value: n(w.avgDailyWage), source: w.source }]));

  const lines: LongtermPayrollLineResult[] = [];

  for (const guardId of guardIds) {
    const guard = guardById.get(guardId);
    if (!guard) continue;

    const isVisa = !!guard.visaSponsoredByBrokerId;

    const rawSegs = contractsByGuard.get(guardId)!;
    const segments: ContractSegment[] = rawSegs.map((s) => ({
      monthlySalary: n(s.monthlySalary),
      effectiveFrom: toUtcDate(s.effectiveFrom),
      effectiveTo: s.effectiveTo ? toUtcDate(s.effectiveTo) : null,
      payBasis: s.payBasis,
      dailyRate: s.dailyRate != null ? n(s.dailyRate) : null,
    }));

    const guardInputs = inputsByGuard.get(guardId) ?? [];
    const leaverInput = guardInputs.find((i) => i.kind === "leaver_settlement");

    const coverage = contractCoverage(segments, start, end);
    let employStart = coverage.start;
    let employEnd = coverage.end;
    // ★ isLeaver 唔可以淨係睇 employEnd<monthEnd——離職日啱啱好係嗰個月
    // 最後一日（例如 31 號個月 7/31 離職）嘅話 employEnd 會同 monthEnd
    // 相等，但呢個人依然係「呢個月離職」，AL 結算唔可以漏計。改用「有冇
    // 明確離職日喺呢個月範圍內」判斷。
    let explicitLeaveDate: Date | null = null;
    if (guard.leaveDate) {
      const ld = toUtcDate(guard.leaveDate);
      if (ld.getTime() <= end.getTime()) explicitLeaveDate = ld;
      if (ld.getTime() < employEnd.getTime()) employEnd = ld;
    }
    if (leaverInput?.dateFrom) {
      const leaverDateOverride = toUtcDate(leaverInput.dateFrom);
      if (leaverDateOverride.getTime() <= end.getTime()) explicitLeaveDate = leaverDateOverride;
      if (leaverDateOverride.getTime() < employEnd.getTime()) employEnd = leaverDateOverride;
    }
    if (guard.hireDate) {
      const hd = toUtcDate(guard.hireDate);
      if (hd.getTime() > employStart.getTime()) employStart = hd;
    }

    const notes: string[] = [];
    if (employStart.getTime() > employEnd.getTime()) {
      warnings.push(`${guard.nameZh}：合約／在職日期喺 ${monthLabel(start)} 冇覆蓋（例如簽咗約但未上班就取消），跳過——鐵則「從未受僱，唔出糧」`);
      continue;
    }

    const isLeaver = explicitLeaveDate !== null;
    if (employStart.getTime() > start.getTime() || employEnd.getTime() < end.getTime()) {
      notes.push(`在職日子：${iso(employStart)}→${iso(employEnd)}（共 ${diffDaysInclusive(employStart, employEnd)} 日），Net Basic 按 月薪/${monthDaysCount}×日數`);
    }
    const midMonthChanges = segments.filter((s) => s.effectiveFrom.getTime() > start.getTime() && s.effectiveFrom.getTime() <= end.getTime());
    for (const chg of midMonthChanges) {
      notes.push(`月中轉約／調薪：生效 ${iso(chg.effectiveFrom)}，新月薪 ${chg.monthlySalary}——A-9b 按日拆兩截`);
    }

    // --------------------------------------------------------------- (a)
    const srs = shiftsByGuard.get(guardId) ?? [];
    const ownPostDates = new Set<string>();
    let rescueCount = 0;
    let otHours = 0;
    const otByDate = new Map<string, number>();
    const leaveDatesByCode = new Map<string, Set<string>>();
    for (const r of srs) {
      const dISO = iso(r.workDate);
      if (r.recordType === "shift") {
        const kind = classifyLongtermShift(r.settlementBrokerId, internalLongtermBrokerId);
        if (kind === "own") {
          ownPostDates.add(dISO);
        } else if (kind === "cover") {
          rescueCount += 1; // §14 規則 2：幫雞頭頂散更，唔當長工返工日
        } else {
          ownPostDates.add(dISO);
          notes.push(`${dISO} 正更冇 settlement_broker_id，保守當自己崗位計返工日（要人手覆核）`);
        }
      } else if (r.recordType === "ot") {
        const h = n(r.otHours);
        otHours += h;
        otByDate.set(dISO, (otByDate.get(dISO) ?? 0) + h);
      } else if (r.recordType === "leave" && r.leaveCode) {
        const code = REST_DAY_CODES.has(r.leaveCode) ? "RD" : UNPAID_LEAVE_CODES.has(r.leaveCode) ? "NL" : r.leaveCode;
        const set = leaveDatesByCode.get(code) ?? new Set<string>();
        set.add(dISO);
        leaveDatesByCode.set(code, set);
      }
    }
    if (isVisa) {
      notes.push(`★ 簽證形式長工（§14 規則 12）：人工照計、照 autopay＋MPF；呢筆（Autopay＋MPF 僱主）每月喺贊助雞頭結算扣返公司（系統外現金扣減）${rescueCount ? `；佢喺雞頭盤嘅 ${rescueCount} 更由雞頭自己對數出糧，唔當長工返工日` : ""}`);
    } else if (rescueCount > 0) notes.push(`幫雞頭頂散更 ${rescueCount} 更：已由雞頭現金結算，唔當長工返工日、唔喺呢層扣/計錢`);
    const conflictNote = attendanceConflictNote(srs);
    if (conflictNote) notes.push(conflictNote);
    const workDays = ownPostDates.size;

    // §21 任務 4b(a)：日薪制長工特判——揀返 employEnd 嗰日所屬合約段，
    // payBasis="daily" 就 Net Basic＝dailyRate×workDays（唔跟曆日比例；
    // 同 s07 `daily_rate_staff` 分支一致），否則跟原有月薪按日拆邏輯。
    const segAtEmployEnd = contractSegmentForDate(segments, employEnd);
    const netBasic =
      segAtEmployEnd.payBasis === "daily" && segAtEmployEnd.dailyRate != null
        ? computeNetBasicDaily(segAtEmployEnd.dailyRate, workDays)
        : computeNetBasic(segments, employStart, employEnd, monthDaysCount);
    if (segAtEmployEnd.payBasis === "daily" && segAtEmployEnd.dailyRate != null) {
      notes.push(`日薪制（${segAtEmployEnd.dailyRate.toFixed(2)}/更）：Net Basic = ${segAtEmployEnd.dailyRate.toFixed(2)} × ${workDays} 更 = ${netBasic.toFixed(2)}`);
    }

    const wh = rawSegs.find((s) => s.shiftHours != null)?.shiftHours ? n(rawSegs.find((s) => s.shiftHours != null)!.shiftHours) : 12;
    let otAmount = 0;
    for (const [dISO, hours] of otByDate) {
      otAmount += (dailyRateOnDate(segments, toUtcDate(dISO), monthDaysCount) / wh) * hours;
    }
    otAmount = round2(otAmount);
    if (otHours > 0) notes.push(`OT ${otHours} 小時 → ${otAmount.toFixed(2)}（逐日日薪/${wh}小時×時數，跟返嗰日所屬合約）`);

    const nplDates = [...(leaveDatesByCode.get("NL") ?? [])].sort();
    const isDailyBasis = segAtEmployEnd.payBasis === "daily" && segAtEmployEnd.dailyRate != null;
    let nplDeduct = 0;
    // 日薪制：Net Basic 本身已經係「每更價×返工更數」，冇返工嗰日本來就冇
    // 錢，再扣一次會雙重扣（Opus 5.5 驗收修正）。
    if (!isDailyBasis) for (const dISO of nplDates) nplDeduct += dailyRateOnDate(segments, toUtcDate(dISO), monthDaysCount);
    nplDeduct = -round2(nplDeduct);
    if (nplDates.length) notes.push(isDailyBasis ? `無薪假 ${nplDates.length} 日（${nplDates.join("、")}）：日薪制，冇返工冇錢，唔另扣` : `無薪假 ${nplDates.length} 日（${nplDates.join("、")}）：扣 ${nplDeduct.toFixed(2)}`);

    // --------------------------------------------------------------- SL（(a)+(b) 夾埋）
    const slDatesFromRoster = new Set(leaveDatesByCode.get("SL") ?? []);
    const slSegmentInputs = guardInputs.filter((i) => i.kind === "leave" && i.dateFrom).sort((a, b) => (a.dateFrom! < b.dateFrom! ? -1 : 1));
    let slDeduct = 0;
    let sl45Total = 0;
    let npslDaysCount = 0;
    const slCoveredDates = new Set<string>();
    const priorPaidSl = openingLeaveTaken(guardId).sl;
    let usedBal = priorPaidSl;
    for (const seg of slSegmentInputs) {
      const segStart = toUtcDate(seg.dateFrom!);
      const segEnd = seg.dateTo ? toUtcDate(seg.dateTo) : segStart;
      const spanDays = diffDaysInclusive(segStart, segEnd);
      const segDatesActualSl: string[] = [];
      for (let t = segStart.getTime(); t <= segEnd.getTime(); t += 86400000) {
        const dISO = iso(new Date(t));
        if (slDatesFromRoster.has(dISO)) segDatesActualSl.push(dISO);
      }
      // 冇更表 SL 記錄可對照就 fallback 用全段日數——扣款同 4/5 都要用同一批
      // 日子（Opus 5.5 驗收修正：原本扣款淨係扣段頭 1 日、4/5 就照全段畀）。
      const segDates = segDatesActualSl.length ? segDatesActualSl : Array.from({ length: spanDays }, (_, k) => iso(new Date(segStart.getTime() + k * 86400000)));
      for (const dISO of segDates) slCoveredDates.add(dISO);
      const segDays = segDates.length;
      const accrued = guard.hireDate ? slAccrued(toUtcDate(guard.hireDate), segStart) : 0;
      const balance = round2(accrued - usedBal);
      const verdict = slSegmentVerdict(segDays, spanDays, balance, !!seg.doctorNoteVerified);
      let dedForSeg = 0;
      if (!isDailyBasis) for (const dISO of segDates) dedForSeg += dailyRateOnDate(segments, toUtcDate(dISO), monthDaysCount);
      slDeduct += dedForSeg;
      if (verdict.qualifies) {
        const avgWageEntry = avgWageByGuard.get(guardId);
        const avgWage = avgWageEntry ? avgWageEntry.value : dailyRateOnDate(segments, segStart, monthDaysCount); // 有 guard_avg_wages 就用嗰個月記錄，冇先 fallback 日薪
        const pay = sl45Payment(avgWage, segDays);
        sl45Total = round2(sl45Total + pay);
        usedBal += segDays;
        notes.push(
          `病假 ${iso(segStart)}–${iso(segEnd)}（${segDays} 日，連續 ${spanDays} 日）：${verdict.reason}（4/5 日薪口徑：${avgWageEntry ? `guard_avg_wages：${avgWageEntry.source}` : "冇平均工資記錄，fallback 日薪"}）`,
        );
      } else {
        npslDaysCount += segDays;
        notes.push(`病假 ${iso(segStart)}–${iso(segEnd)}（${segDays} 日，連續 ${spanDays} 日）：${verdict.reason}`);
      }
    }
    // 注：`usedBal` 呢陣已經係「累積到今個月尾」嘅絕對值（含今個月新增
    // 攞到嘅 4/5 日數），直接寫返 `guard_leave_balances.slTaken`（見低
    // 面 `leaveBalanceWriteback.slTakenCumulative`）。
    // Opus 5.5 驗收修正：更表 SL 日子冇被任何病假段輸入涵蓋（包括「有輸入
    // 但漏咗其中幾日」）——原本淨係「完全冇輸入」先扣，漏咗嗰幾日會靜靜
    // 哋當有薪出足。而家一律當無薪假扣（冇醫生紙段輸入＝唔合資格 4/5）。
    const uncoveredSl = [...slDatesFromRoster].filter((d) => !slCoveredDates.has(d)).sort();
    if (uncoveredSl.length) {
      notes.push(`更表有 ${uncoveredSl.length} 日 SL（${uncoveredSl.join("、")}）冇對應嘅 longterm_payroll_inputs（kind=leave）病假段輸入——4/5 判定要會計人手補打病假段，暫時當無薪假處理`);
      if (!isDailyBasis) for (const dISO of uncoveredSl) slDeduct += dailyRateOnDate(segments, toUtcDate(dISO), monthDaysCount);
      npslDaysCount += uncoveredSl.length;
    }
    slDeduct = -round2(slDeduct);

    // --------------------------------------------------------------- SH
    const shDates = [...(leaveDatesByCode.get("SH") ?? [])].sort();
    const shSeg = rawSegs.find((s) => toUtcDate(s.effectiveFrom).getTime() <= end.getTime());
    const shResult = computeShDeduction(shDates, segments, monthDaysCount, guard.hireDate ? toUtcDate(guard.hireDate) : null, shSeg?.statutoryHolidayPaidFrom ?? "immediate");
    notes.push(...shResult.notes);

    // --------------------------------------------------------------- (b) 津貼／扣款
    let specialAllowance = 0;
    let otherAllowance = 0;
    let manualDeduction = 0;
    for (const inp of guardInputs) {
      const amt = n(inp.amount);
      if (inp.kind === "special_allowance") {
        specialAllowance = round2(specialAllowance + amt);
        notes.push(`津貼（人手輸入）：${inp.note ?? "（冇備註）"} +${amt.toFixed(2)}`);
      } else if (inp.kind === "other_allowance") {
        otherAllowance = round2(otherAllowance + amt);
        notes.push(`其他津貼／賣假／頂位（人手輸入，§14 規則 9 價目表由會計對照）：${inp.note ?? "（冇備註）"} +${amt.toFixed(2)}`);
      } else if (inp.kind === "uniform") {
        otherAllowance = round2(otherAllowance + amt);
        notes.push(`制服（人手輸入）：${inp.note ?? "（冇備註）"} +${amt.toFixed(2)}`);
      } else if (inp.kind === "deduction") {
        manualDeduction = round2(manualDeduction - Math.abs(amt));
        notes.push(`扣款（人手輸入）：${inp.note ?? "（冇備註）"} -${Math.abs(amt).toFixed(2)}`);
      } else if (inp.kind === "contract_change") {
        notes.push(`轉約記錄（人手備註）：${inp.note ?? "（冇備註）"}`);
      }
    }

    // --------------------------------------------------------------- AL（在職唔扣唔補，離職先結算）
    // §21 任務 4b(f)：`alDatesThisMonth`／`priorAl` 唔止離職結算用——
    // 亦都係 `guard_leave_balances` 寫回（`alTaken`）嘅來源，所以喺
    // isLeaver 判斷之外都要計（在職長工都要儲「今年已放幾多日 AL」，
    // 等佢真係離職嗰個月先追溯得到準確結餘）。
    const alDatesThisMonth = [...(leaveDatesByCode.get("AL") ?? [])].filter((dISO) => toUtcDate(dISO).getTime() <= employEnd.getTime());
    const priorAl = openingLeaveTaken(guardId).al;
    const alTakenCumulative = round2(priorAl + alDatesThisMonth.length);
    let alPayment = 0;
    if (isLeaver) {
      const serviceStart = firstContractByGuard.get(guardId) ?? (guard.hireDate ? toUtcDate(guard.hireDate) : employStart); // 規則 9：AL entitlement 由長工合約入職日計，唔計轉長工前散工段
      const entitleYearDays = n(rawSegs.find((s) => toUtcDate(s.effectiveFrom).getTime() <= employEnd.getTime())?.annualLeaveDays ?? 7);
      const probationMonths = rawSegs.find((s) => toUtcDate(s.effectiveFrom).getTime() <= employEnd.getTime())?.probationMonths ?? guard.probationMonths ?? null;
      const hireDateForProbation = serviceStart; // 試用期跟長工合約（Maxwell Commencement）起計
      const entResult = alEntitlementProrata(entitleYearDays, serviceStart, employEnd, hireDateForProbation, probationMonths);
      const balance = alLeaverBalance(entResult.entitled, alTakenCumulative);
      if (leaverInput?.amount != null) {
        alPayment = n(leaverInput.amount);
        notes.push(`★ 離職補年假：人手輸入金額 ${alPayment.toFixed(2)}（${leaverInput.note ?? "會計已用終止僱傭合約薪酬計算表核實"}）`);
      } else {
        const avgWageEntry = avgWageByGuard.get(guardId);
        const avgWage = avgWageEntry ? avgWageEntry.value : dailyRateOnDate(segments, employEnd, monthDaysCount); // 有 guard_avg_wages 就用嗰個月記錄，冇先 fallback 日薪
        alPayment = alLeaverPayout(balance, avgWage);
        notes.push(
          `★ 離職補年假：${entResult.reason}；已放 ${alTakenCumulative.toFixed(2)} 日 → 結餘 ${balance.toFixed(2)} 日 × 日薪 ${avgWage.toFixed(2)}（${avgWageEntry ? `guard_avg_wages：${avgWageEntry.source}` : "冇平均工資記錄，fallback 日薪"}）＝ ${alPayment.toFixed(2)}`,
        );
      }
    }

    const gross = computeGross({
      netBasic,
      otAmount,
      restDayPayment: 0, // 賣假金額經 otherAllowance 人手輸入，呢個 phase 恆為 0
      npsh: shResult.npsh,
      nplDeduction: round2(nplDeduct + slDeduct + manualDeduction),
      sl45Amount: sl45Total,
      specialAllowance,
      otherAllowance,
      alPayment,
    });

    const dob = guard.dateOfBirth ? toUtcDate(guard.dateOfBirth) : null;
    const ageAtMonthEnd = dob ? (end.getTime() - dob.getTime()) / 86400000 / 365.25 : null;
    // §25.6：monthStart 傳 `start`（呢個月月首）畀 computeMpf() 判斷首月
    // 新規則（老闆 2026-09-28 追加決定 #3，只 monthStart>=2026-09-01 生效）。
    const mpfResult = computeMpf(gross, { ageAtMonthEnd, hireDate: guard.hireDate ? toUtcDate(guard.hireDate) : null, monthEnd: end, monthStart: start });
    if (mpfResult.exemptReason) {
      const label =
        mpfResult.exemptReason === "over65"
          ? "≥65 歲免供"
          : mpfResult.exemptReason === "under60days"
            ? "入職未滿 60 日免供"
            : mpfResult.exemptReason === "first_month_ee"
              ? "首月：員工免供、公司供 ER"
              : "Gross<7,100 僱員免供";
      notes.push(`MPF：${label}`);
    }
    const autopay = computeAutopay(gross, mpfResult.mpfEe);

    lines.push({
      guardId,
      guardName: guard.nameZh,
      contractSnapshot: rawSegs.map((s) => ({ monthlySalary: n(s.monthlySalary), effectiveFrom: iso(toUtcDate(s.effectiveFrom)), effectiveTo: s.effectiveTo ? iso(toUtcDate(s.effectiveTo)) : null })),
      daysInMonth: monthDaysCount,
      employStart: iso(employStart),
      employEnd: iso(employEnd),
      isLeaver,
      workDays,
      netBasic,
      otHours,
      otAmount,
      restDayPayment: 0,
      npsh: shResult.npsh,
      nplDays: nplDates.length,
      npslDays: npslDaysCount,
      deduction: round2(nplDeduct + slDeduct + manualDeduction),
      specialAllowance,
      otherAllowance,
      alPayment,
      sl45Amount: sl45Total,
      gross,
      mpfEe: mpfResult.mpfEe,
      mpfEr: mpfResult.mpfEr,
      mpfExemptReason: mpfResult.exemptReason,
      autopay,
      visaPassthrough: isVisa,
      notes,
      leaveBalanceWriteback: {
        alTakenCumulative,
        slTakenCumulative: round2(usedBal),
        slAccruedAtMonthEnd: guard.hireDate ? slAccrued(toUtcDate(guard.hireDate), end) : 0,
        alOpeningUsed: priorAl,
        slOpeningUsed: priorPaidSl,
      },
    });
  }

  const visaLines = lines.filter((l) => l.visaPassthrough);
  const totals: LongtermPayrollTotals = {
    grossTotal: round2(lines.reduce((a, l) => a + l.gross, 0)),
    autopayTotal: round2(lines.reduce((a, l) => a + l.autopay, 0)),
    mpfEeTotal: round2(lines.reduce((a, l) => a + l.mpfEe, 0)),
    mpfErTotal: round2(lines.reduce((a, l) => a + l.mpfEr, 0)),
    guardCount: lines.length,
    visaPassthrough: {
      guardCount: visaLines.length,
      grossTotal: round2(visaLines.reduce((a, l) => a + l.gross, 0)),
      autopayTotal: round2(visaLines.reduce((a, l) => a + l.autopay, 0)),
      mpfEeTotal: round2(visaLines.reduce((a, l) => a + l.mpfEe, 0)),
      mpfErTotal: round2(visaLines.reduce((a, l) => a + l.mpfEr, 0)),
    },
  };

  return { month: start, daysInMonth: monthDaysCount, lines, totals, warnings };
}

export interface RecomputeLongtermPayrollResult {
  runId: string;
  totals: BuildLongtermPayrollResult["totals"];
  warnings: string[];
}

/**
 * 持久化版本——冪等：同月重算先 void 舊嘅（未 void）run，先建新（唔覆蓋
 * 舊行，歷史留痕，同 `month_close_runs`／`reconcile_all_runs` 一致
 * pattern）。
 */
export async function recomputeLongtermPayroll(month: Date, actorUserId: string, ip: string | null = null): Promise<RecomputeLongtermPayrollResult> {
  const monthStartDate = toMonthStart(month);
  // Opus 5.5 驗收修正：假期結餘係「累積到最近結算月」嘅單一記錄——如果之後
  // 嘅月份已經計過（例如 9 月已經重算，再返轉頭重算 8 月），8 月讀到嘅
  // opening 已經包咗 8 月（甚至 9 月）嘅已放日數，會愈計愈多、寫壞結餘
  // （實測：每次倒轉重算 AL 已放 +1）。寧願擋住，唔好靜靜哋計錯。
  const later = await prisma.guardLeaveBalance.findFirst({ where: { asOfMonth: { gt: monthStartDate } }, orderBy: { asOfMonth: "desc" }, select: { asOfMonth: true } });
  if (later?.asOfMonth) {
    throw Conflict(`${monthLabel(later.asOfMonth)} 嘅長工糧已經計過（假期結餘已結轉到嗰個月），唔可以再重算 ${monthLabel(monthStartDate)}——否則病假／年假已放日數會重複累積。要改 ${monthLabel(monthStartDate)} 請搵系統管理員處理假期結餘後再重算`);
  }
  const built = await buildLongtermPayrollInputs(monthStartDate);

  return prisma.$transaction(
    async (tx) => {
      await tx.longtermPayrollRun.updateMany({
        where: { month: monthStartDate, voidedAt: null, status: { not: "void" } },
        data: { voidedAt: new Date(), voidedBy: actorUserId, status: "void" },
      });

      const run = await tx.longtermPayrollRun.create({
        data: {
          month: monthStartDate,
          status: "computed",
          createdBy: actorUserId,
          totalsJson: built.totals as unknown as Prisma.InputJsonValue,
        },
      });

      for (const line of built.lines) {
        await tx.longtermPayrollLine.create({
          data: {
            runId: run.id,
            guardId: line.guardId,
            contractSnapshot: line.contractSnapshot as unknown as Prisma.InputJsonValue,
            daysInMonth: line.daysInMonth,
            workDays: line.workDays,
            netBasic: line.netBasic,
            otHours: line.otHours,
            otAmount: line.otAmount,
            restDayPayment: line.restDayPayment,
            npsh: line.npsh,
            nplDays: line.nplDays,
            npslDays: line.npslDays,
            deduction: line.deduction,
            specialAllowance: line.specialAllowance,
            otherAllowance: line.otherAllowance,
            alPayment: line.alPayment,
            sl45Amount: line.sl45Amount,
            gross: line.gross,
            mpfEe: line.mpfEe,
            mpfEr: line.mpfEr,
            autopay: line.autopay,
            notesJson: line.notes as unknown as Prisma.InputJsonValue,
          },
        });
      }

      // §21 任務 4b(f)：`guard_leave_balances` 寫回——`leaveBalanceWriteback`
      // 入面嘅 `*Cumulative` 已經係「累積到今個月尾」嘅絕對值（唔係差
      // 量），`upsert...set` 唔係 increment。`alOpeningUsed`／
      // `slOpeningUsed`（呢次計糧實際用嗰個「開始前」數）寫返做新嘅
      // `*_opening`，`asOfMonth` 設做呢個月——保證：(a) 順序逐月結算，
      // 下個月讀到嘅 opening＝呢個月嘅 cumulative（同原本行為一致）；
      // (b) 同一個月重算兩次（run 冪等，void 舊建新），第二次讀
      // opening 讀返「呢個月開始前」嗰個舊 opening（唔係啱啱先寫低嗰個
      // 已經包咗呢個月嘅 cumulative），唔會愈計愈多——見
      // `openingLeaveTaken()`／`tests/longterm-payroll-aggregate.test.ts`
      // 「guard_leave_balances 寫回」呢組測試。年份跟 `monthStartDate`
      // 嘅日曆年（同 `guard_leave_balances.year` unique key 一致）。
      const balanceYear = monthStartDate.getUTCFullYear();
      // P15.1：寫回前先快照（每個 guard／year／month 只留第一次——同月重算唔覆蓋），作廢該月時回滾用。
      const priorRows = await tx.guardLeaveBalance.findMany({ where: { year: balanceYear, guardId: { in: built.lines.map((l) => l.guardId) } } });
      const priorByGuard = new Map(priorRows.map((r) => [r.guardId, r]));
      for (const line of built.lines) {
        const prior = priorByGuard.get(line.guardId);
        // 已經係本月狀態（legacy：P15 前計過、冇快照）→ 唔好影一個「已含本月」嘅快照，留俾 void 走 legacy 重建
        if (prior?.asOfMonth && prior.asOfMonth.getTime() === monthStartDate.getTime()) continue;
        await tx.guardLeaveBalanceHistory.upsert({
          where: { guardId_year_month: { guardId: line.guardId, year: balanceYear, month: monthStartDate } },
          create: prior
            ? { guardId: line.guardId, year: balanceYear, month: monthStartDate, existed: true, alTaken: prior.alTaken, slTaken: prior.slTaken, slAccrued: prior.slAccrued, asOfMonth: prior.asOfMonth, alTakenOpening: prior.alTakenOpening, slTakenOpening: prior.slTakenOpening }
            : { guardId: line.guardId, year: balanceYear, month: monthStartDate, existed: false },
          update: {},
        });
      }
      for (const line of built.lines) {
        const wb = line.leaveBalanceWriteback;
        await tx.guardLeaveBalance.upsert({
          where: { guardId_year: { guardId: line.guardId, year: balanceYear } },
          create: {
            guardId: line.guardId,
            year: balanceYear,
            alTaken: wb.alTakenCumulative,
            slTaken: wb.slTakenCumulative,
            slAccrued: wb.slAccruedAtMonthEnd,
            asOfMonth: monthStartDate,
            alTakenOpening: wb.alOpeningUsed,
            slTakenOpening: wb.slOpeningUsed,
          },
          update: {
            alTaken: wb.alTakenCumulative,
            slTaken: wb.slTakenCumulative,
            slAccrued: wb.slAccruedAtMonthEnd,
            asOfMonth: monthStartDate,
            alTakenOpening: wb.alOpeningUsed,
            slTakenOpening: wb.slOpeningUsed,
          },
        });
      }

      await writeAuditTx(tx, {
        actorUserId,
        tableName: "longterm_payroll_runs",
        rowId: run.id,
        action: "create",
        after: { month: monthLabel(monthStartDate), guardCount: built.totals.guardCount, grossTotal: built.totals.grossTotal, autopayTotal: built.totals.autopayTotal },
        ip,
      });

      return { runId: run.id, totals: built.totals, warnings: built.warnings };
    },
    { timeout: 120_000 },
  );
}
