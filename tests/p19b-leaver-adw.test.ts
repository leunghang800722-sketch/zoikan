// P19b：離職月結算——平均工資（ADW）EO 自動計、優先次序、離職者導航卡條件。全部假數（月薪 20,000／15,000，假名「測試甲」）。
import { describe, it, expect, afterAll } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { buildLongtermPayrollInputs, recomputeLongtermPayroll } from "@/lib/longterm-payroll/aggregate";
import { evaluateOtRule, computeEoAdw, resolveAlDailyRate, eoPeriodFrom, eoPeriodMonths, type AdwMonthData } from "@/lib/longterm-payroll/adw";
import { listLeaverAdwPending } from "@/lib/longterm-payroll/leaver-adw-pending";
import { stepPrecheck } from "@/lib/month-close/one-click";
import { round2 } from "@/lib/reports/money";

const d = (s: string) => new Date(`${s}T00:00:00Z`);
const AUG = d("2026-08-01");

afterAll(async () => {
  await clearAll();
  await prisma.$disconnect();
});

async function base() {
  await clearAll();
  const site = await prisma.site.create({ data: { canonicalName: `測試盤-${Math.random().toString(36).slice(2, 8)}`, clientName: "測試客戶", billingModel: "per_shift", createdBy: "test" } });
  const st = await prisma.shiftType.create({ data: { siteId: site.id, code: "N", hours: 12, createdBy: "test" } });
  const role = await prisma.role.findFirstOrThrow({ where: { name: "老闆" } });
  const user = await prisma.user.create({ data: { name: "測試老闆", tel: `9${Math.floor(1000000 + Math.random() * 8999999)}`, passwordHash: "x", roleId: role.id, createdBy: "test" } });
  return { site, st, actorUserId: user.id };
}
async function mkLeaver(opts: { hire: string; leave: string; salary: number; dob: string; actor: string; name?: string; hireContract?: string }) {
  const g = await prisma.guard.create({ data: { nameZh: opts.name ?? "測試甲", employmentType: "longterm_autopay", hireDate: d(opts.hire), leaveDate: d(opts.leave), dateOfBirth: d(opts.dob), createdBy: "test" } });
  await prisma.guardLongtermContract.create({ data: { guardId: g.id, monthlySalary: opts.salary, effectiveFrom: d(opts.hireContract ?? opts.hire), effectiveTo: null, statutoryHolidayPaidFrom: "immediate", source: "manual", createdBy: opts.actor } });
  return g;
}
async function leave(guardId: string, site: { id: string }, st: { id: string }, date: string, code: "NL" | "SL") {
  return prisma.shiftRecord.create({ data: { workDate: d(date), siteId: site.id, shiftTypeId: st.id, guardId, recordType: "leave", leaveCode: code, createdBy: "test" } });
}
/** 直接插一條歷史糧線（假數）。 */
async function seedHistoryLine(guardId: string, actor: string, month: string, vals: { netBasic: number; deduction?: number; nplDays?: number; salary?: number }) {
  const run = await prisma.longtermPayrollRun.create({ data: { month: d(month), status: "confirmed", createdBy: actor } });
  const dim = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
  await prisma.longtermPayrollLine.create({
    data: {
      runId: run.id, guardId, contractSnapshot: [{ monthlySalary: vals.salary ?? vals.netBasic, effectiveFrom: "2025-01-01", effectiveTo: null }], daysInMonth: dim, netBasic: vals.netBasic,
      deduction: vals.deduction ?? 0, nplDays: vals.nplDays ?? 0, gross: vals.netBasic + (vals.deduction ?? 0), autopay: vals.netBasic,
    },
  });
}

describe("P19b 離職月公式結構（沿用規則 9）", () => {
  it("① 月薪 20,000、5/1 入職、8/31 離職、8 月 5 日無薪假、≥65 歲：基本 20,000、扣 20,000×5/31、年假 2.36 日、MPF 0", async () => {
    const { site, st, actorUserId } = await base();
    const g = await mkLeaver({ hire: "2026-05-01", leave: "2026-08-31", salary: 20000, dob: "1955-01-01", actor: actorUserId });
    for (const day of ["03", "04", "05", "06", "07"]) await leave(g.id, site, st, `2026-08-${day}`, "NL");
    const line = (await buildLongtermPayrollInputs(AUG)).lines[0];
    expect(line.netBasic).toBe(20000);
    expect(line.deduction).toBe(-round2((20000 * 5) / 31));
    // 年假日數 round2(7×123/365)=2.36；歷史唔齊→維持月薪÷31
    const rate = 20000 / 31;
    expect(line.alPayment).toBe(round2(2.36 * rate));
    expect(line.alDailyRateBasis).toBe("fallback_monthly");
    expect(line.mpfEe).toBe(0);
    expect(line.mpfEr).toBe(0);
    expect(line.mpfExemptReason).toBe("over65");
    expect(line.gross).toBe(round2(20000 - (20000 * 5) / 31 + line.alPayment));
  });

  it("② 月薪 15,000、6/1 入職、8/31 離職、2 日未確認病假：扣 15,000×2/31、年假 1.76 日", async () => {
    const { site, st, actorUserId } = await base();
    const g = await mkLeaver({ hire: "2026-06-01", leave: "2026-08-31", salary: 15000, dob: "1985-01-01", actor: actorUserId });
    await leave(g.id, site, st, "2026-08-10", "SL");
    await leave(g.id, site, st, "2026-08-11", "SL");
    const line = (await buildLongtermPayrollInputs(AUG)).lines[0];
    expect(line.netBasic).toBe(15000);
    expect(line.deduction).toBe(-round2((15000 * 2) / 31));
    expect(line.sl45Amount).toBe(0);
    expect(line.alPayment).toBe(round2(1.76 * (15000 / 31)));
  });
});

describe("P19b ADW 優先次序（四層）", () => {
  const otRule = { included: true, reason: "constant" as const, avgOt: 0, avgWagesExOt: 0, ratio: 0, monthsWithOt: 0, monthsCounted: 12 };
  const eoOk = { otRule, adw: 700, basis: "computed_eo" as const, periodFrom: "2025-09-01", periodTo: "2026-08-31", daysCounted: 365, disregardedDays: 0, wages: 255500, historyIncomplete: false, monthsMissing: [] };
  const eoBad = { ...eoOk, basis: "fallback_monthly" as const, historyIncomplete: true, monthsMissing: ["2025-09"] };
  it("人手金額 ＞ guard_avg_wages ＞ EO（完整）＞ 月薪÷日數", () => {
    expect(resolveAlDailyRate({ manualAmount: 500, imported: 800, eo: eoOk, monthlyFallback: 600 })).toEqual({ rate: null, basis: "manual_amount", needsConfirm: false });
    expect(resolveAlDailyRate({ manualAmount: null, imported: 800, eo: eoOk, monthlyFallback: 600 })).toEqual({ rate: 800, basis: "imported", needsConfirm: false });
    expect(resolveAlDailyRate({ manualAmount: null, imported: null, eo: eoOk, monthlyFallback: 600 })).toEqual({ rate: 700, basis: "computed_eo", needsConfirm: false });
    expect(resolveAlDailyRate({ manualAmount: null, imported: null, eo: eoBad, monthlyFallback: 600 })).toEqual({ rate: 600, basis: "fallback_monthly", needsConfirm: true });
    expect(resolveAlDailyRate({ manualAmount: null, imported: null, eo: null, monthlyFallback: 600 })).toEqual({ rate: 600, basis: "fallback_monthly", needsConfirm: true });
  });

  it("S1：EO adw ≤0（wages 負數／0）→ fallback_monthly＋needsConfirm", () => {
    for (const wages of [-100, 0]) {
      const eo = { ...eoOk, adw: round2(wages / 365), wages };
      expect(resolveAlDailyRate({ manualAmount: null, imported: null, eo, monthlyFallback: 600 })).toEqual({ rate: 600, basis: "fallback_monthly", needsConfirm: true });
    }
  });

  it("aggregate：guard_avg_wages 記錄 → imported；人手金額 → manual_amount", async () => {
    const { actorUserId } = await base();
    const g = await mkLeaver({ hire: "2026-05-01", leave: "2026-08-31", salary: 20000, dob: "1985-01-01", actor: actorUserId });
    await prisma.guardAvgWage.create({ data: { guardId: g.id, month: AUG, avgDailyWage: 700, source: "測試" } });
    let line = (await buildLongtermPayrollInputs(AUG)).lines[0];
    expect(line.alDailyRateBasis).toBe("imported");
    expect(line.alPayment).toBe(round2(2.36 * 700));
    await prisma.longtermPayrollInput.create({ data: { month: AUG, guardId: g.id, kind: "leaver_settlement", amount: 1234.5, dateFrom: "2026-08-31", status: "confirmed", createdBy: actorUserId } });
    line = (await buildLongtermPayrollInputs(AUG)).lines[0];
    expect(line.alDailyRateBasis).toBe("manual_amount");
    expect(line.alPayment).toBe(1234.5);
  });
});

describe("P19b EO 平均工資計算（純函數）", () => {
  const sal = () => 20000;
  function fullYear(): Record<string, AdwMonthData> {
    const out: Record<string, AdwMonthData> = {};
    for (let m = 0; m < 12; m++) {
      const dt = new Date(Date.UTC(2025, 8 + m, 1));
      out[dt.toISOString().slice(0, 7)] = { wages: 20000, disregardedDays: 0 };
    }
    return out;
  }
  it("期間＝離職日前 12 個月（含離職日）", () => {
    expect(eoPeriodFrom(d("2020-01-01"), d("2026-08-31")).toISOString().slice(0, 10)).toBe("2025-09-01");
    expect(eoPeriodMonths(d("2020-01-01"), d("2026-08-31")).length).toBe(12);
    expect(eoPeriodFrom(d("2026-05-01"), d("2026-08-31")).toISOString().slice(0, 10)).toBe("2026-05-01"); // 短過 12 個月由服務起點
  });
  it("12 個月齊：工資 240,000 ÷ 365 日（2025-09 至 2026-08）", () => {
    const r = computeEoAdw({ serviceStart: d("2020-01-01"), leaveDate: d("2026-08-31"), monthData: fullYear(), monthlySalaryForMonth: sal });
    expect(r.basis).toBe("computed_eo");
    expect(r.historyIncomplete).toBe(false);
    expect(r.daysCounted).toBe(365);
    expect(r.wages).toBe(240000);
    expect(r.adw).toBe(round2(240000 / 365));
  });
  it("不獲全薪日子剔走：8 月 5 日無薪假（工資已扣 20000×5/31）→ 分母 360", () => {
    const md = fullYear();
    md["2026-08"] = { wages: round2(20000 - (20000 * 5) / 31), disregardedDays: 5 };
    const r = computeEoAdw({ serviceStart: d("2020-01-01"), leaveDate: d("2026-08-31"), monthData: md, monthlySalaryForMonth: sal });
    expect(r.disregardedDays).toBe(5);
    expect(r.daysCounted).toBe(360);
    expect(r.adw).toBe(round2((240000 - (20000 * 5) / 31) / 360));
  });
  it("服務期短過 12 個月：由服務起點計（5/1–8/31 共 123 日）", () => {
    const md: Record<string, AdwMonthData> = { "2026-05": { wages: 20000, disregardedDays: 0 }, "2026-06": { wages: 20000, disregardedDays: 0 }, "2026-07": { wages: 20000, disregardedDays: 0 }, "2026-08": { wages: 20000, disregardedDays: 0 } };
    const r = computeEoAdw({ serviceStart: d("2026-05-01"), leaveDate: d("2026-08-31"), monthData: md, monthlySalaryForMonth: sal });
    expect(r.daysCounted).toBe(123);
    expect(r.adw).toBe(round2(80000 / 123));
    expect(r.historyIncomplete).toBe(false);
  });
  it("離職日 8/15：邊界月 2025-08 只計 8/16 起，工資按日比例", () => {
    const md = fullYear();
    md["2025-08"] = { wages: 20000, disregardedDays: 0 };
    delete md["2026-08"];
    md["2026-08"] = { wages: round2((20000 * 15) / 31), disregardedDays: 0 };
    const r = computeEoAdw({ serviceStart: d("2020-01-01"), leaveDate: d("2026-08-15"), monthData: md, monthlySalaryForMonth: sal });
    expect(r.periodFrom).toBe("2025-08-16");
    expect(r.daysCounted).toBe(365);
  });
  it("歷史唔齊：缺月份用合約月薪補入，標 historyIncomplete，basis=fallback_monthly", () => {
    const md = fullYear();
    delete md["2025-12"];
    const r = computeEoAdw({ serviceStart: d("2020-01-01"), leaveDate: d("2026-08-31"), monthData: md, monthlySalaryForMonth: sal });
    expect(r.historyIncomplete).toBe(true);
    expect(r.monthsMissing).toEqual(["2025-12"]);
    expect(r.basis).toBe("fallback_monthly");
    expect(r.wages).toBe(240000); // 補入 20000
  });
});

describe("P19b.4 平均工資口徑（勞工處定義）：加班費條件計入、津貼一律計入", () => {
  const sal = () => 20000;
  /** 12 個月（2025-09 至 2026-08），每月底薪 20,000，ot[i] 為該月加班費。 */
  function year(ot: number[], allowance = 0): Record<string, AdwMonthData> {
    const out: Record<string, AdwMonthData> = {};
    for (let m = 0; m < 12; m++) {
      const k = new Date(Date.UTC(2025, 8 + m, 1)).toISOString().slice(0, 7);
      out[k] = { wages: 20000 + allowance + ot[m], ot: ot[m], disregardedDays: 0 };
    }
    return out;
  }
  const run = (md: Record<string, AdwMonthData>) => computeEoAdw({ serviceStart: d("2020-01-01"), leaveDate: d("2026-08-31"), monthData: md, monthlySalaryForMonth: sal });

  it("OT 每月都有（固定性質）→ 計入", () => {
    const r = run(year(Array(12).fill(500)));
    expect(r.otRule.reason).toBe("constant");
    expect(r.otRule.included).toBe(true);
    expect(r.wages).toBe(12 * 20500);
  });
  it("OT 只有部分月但平均 ≥20% → 計入", () => {
    const r = run(year([8000, 8000, 8000, 0, 0, 0, 0, 0, 0, 0, 0, 0])); // 平均 2000 ÷ 20000 = 10%…下面用更大
    expect(r.otRule.reason).toBe("excluded"); // 10% 未夠
    const r2 = run(year([16000, 16000, 16000, 0, 0, 0, 0, 0, 0, 0, 0, 0])); // 平均 4000／20000 = 20%
    expect(r2.otRule.reason).toBe("ge_20pct");
    const r3 = run(year([20000, 20000, 20000, 0, 0, 0, 0, 0, 0, 0, 0, 0])); // 25%
    expect(r3.otRule.included).toBe(true);
    expect(r3.wages).toBe(12 * 20000 + 60000);
  });
  it("OT 部分月且 <20% → 全部剔除", () => {
    const r = run(year([1000, 0, 1000, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
    expect(r.otRule.included).toBe(false);
    expect(r.otRule.monthsWithOt).toBe(2);
    expect(r.wages).toBe(240000);
    expect(r.adw).toBe(round2(240000 / 365));
  });
  it("無 OT → 剔除（無影響）、ratio 0", () => {
    const r = run(year(Array(12).fill(0)));
    expect(r.otRule.reason).toBe("excluded");
    expect(r.otRule.ratio).toBe(0);
    expect(r.wages).toBe(240000);
  });
  it("制服等津貼一律計入（唔受 OT 規則影響）", () => {
    const r = run(year(Array(12).fill(0), 300));
    expect(r.wages).toBe(12 * 20300);
  });
  it("邊界：ratio 恰好 20% → 計入", () => {
    const o = evaluateOtRule([{ wages: 12000, ot: 2000, disregardedDays: 0 }, { wages: 10000, ot: 0, disregardedDays: 0 }]); // avgOt 1000／avgExOt 10000 = 10%… 
    expect(o.included).toBe(false);
    const e = evaluateOtRule([{ wages: 12000, ot: 2000, disregardedDays: 0 }]); // 2000／10000
    expect(e.ratio).toBe(0.2);
    expect(e.reason).toBe("constant");
    const e2 = evaluateOtRule([{ wages: 14000, ot: 4000, disregardedDays: 0 }, { wages: 10000, ot: 0, disregardedDays: 0 }]); // avgOt 2000／avgExOt 10000
    expect(e2.ratio).toBe(0.2);
    expect(e2.reason).toBe("ge_20pct");
  });
  it("aggregate 把 otRule 寫入 al_adw_json 同備註", async () => {
    const { actorUserId } = await base();
    const g = await mkLeaver({ hire: "2026-05-01", leave: "2026-08-31", salary: 20000, dob: "1985-01-01", actor: actorUserId });
    for (const m of ["2026-05-01", "2026-06-01", "2026-07-01"]) await seedHistoryLine(g.id, actorUserId, m, { netBasic: 20000 });
    const line = (await buildLongtermPayrollInputs(AUG)).lines[0];
    expect(line.alAdw?.otRule?.reason).toBe("excluded");
    expect(line.notes.some((n) => n.includes("加班費剔除"))).toBe(true);
  });
});

describe("P19b aggregate 接入 EO 自動計＋導航卡條件", () => {
  it("歷史齊（5/1 入職，5–7 月糧線＋8 月本月）→ computed_eo，唔出卡", async () => {
    const { actorUserId } = await base();
    const g = await mkLeaver({ hire: "2026-05-01", leave: "2026-08-31", salary: 20000, dob: "1985-01-01", actor: actorUserId });
    for (const m of ["2026-05-01", "2026-06-01", "2026-07-01"]) await seedHistoryLine(g.id, actorUserId, m, { netBasic: 20000 });
    const line = (await buildLongtermPayrollInputs(AUG)).lines[0];
    expect(line.alDailyRateBasis).toBe("computed_eo");
    expect(line.alAdw?.eo?.daysCounted).toBe(123);
    expect(line.alAdw?.rateUsed).toBe(round2(80000 / 123));
    expect(line.alPayment).toBe(round2(2.36 * round2(80000 / 123)));
    expect(line.alAdw?.needsConfirm).toBe(false);
  });

  it("歷史齊但有不獲全薪日子（7 月 4 日 NPL 已扣、8 月 3 日 NPL）→ 剔走", async () => {
    const { actorUserId, site, st } = await base();
    const g = await mkLeaver({ hire: "2026-05-01", leave: "2026-08-31", salary: 20000, dob: "1985-01-01", actor: actorUserId });
    await seedHistoryLine(g.id, actorUserId, "2026-05-01", { netBasic: 20000 });
    await seedHistoryLine(g.id, actorUserId, "2026-06-01", { netBasic: 20000 });
    await seedHistoryLine(g.id, actorUserId, "2026-07-01", { netBasic: 20000, deduction: -round2((20000 * 4) / 31), nplDays: 4 });
    for (const day of ["03", "04", "05"]) await leave(g.id, site, st, `2026-08-${day}`, "NL");
    const line = (await buildLongtermPayrollInputs(AUG)).lines[0];
    const eo = line.alAdw!.eo!;
    expect(eo.disregardedDays).toBe(7);
    expect(eo.daysCounted).toBe(123 - 7);
    expect(eo.wages).toBe(round2(80000 - (20000 * 7) / 31));
    expect(line.alDailyRateBasis).toBe("computed_eo");
  });

  it("歷史唔齊（缺 6 月）→ fallback_monthly，金額＝現行月薪÷31；出卡；輸入平均工資＋重算後卡消失", async () => {
    const { actorUserId } = await base();
    const g = await mkLeaver({ hire: "2026-05-01", leave: "2026-08-31", salary: 20000, dob: "1985-01-01", actor: actorUserId });
    await seedHistoryLine(g.id, actorUserId, "2026-05-01", { netBasic: 20000 });
    await seedHistoryLine(g.id, actorUserId, "2026-07-01", { netBasic: 20000 });
    const built = (await buildLongtermPayrollInputs(AUG)).lines[0];
    expect(built.alDailyRateBasis).toBe("fallback_monthly");
    expect(built.alAdw?.eo?.monthsMissing).toEqual(["2026-06"]);
    expect(built.alPayment).toBe(round2(2.36 * (20000 / 31)));

    expect((await listLeaverAdwPending(AUG)).items).toHaveLength(0); // 未重算（無 run）→ 冇卡
    await recomputeLongtermPayroll(AUG, actorUserId);
    const pending = await listLeaverAdwPending(AUG);
    expect(pending.pending_count).toBe(1);
    expect(pending.items[0].guard_name).toBe("測試甲");
    expect(pending.items[0].basis).toBe("fallback_monthly");
    expect(pending.items[0].history_incomplete).toBe(true);
    expect(pending.items[0].daily_rate_used).toBe(round2(20000 / 31));

    // 輸入平均工資（現有 avg-wages 路徑寫 guard_avg_wages）→ 卡轉為「已輸入待重算」
    await prisma.guardAvgWage.create({ data: { guardId: g.id, month: AUG, avgDailyWage: 700, source: "終止僱傭合約薪酬計算表" } });
    const saved = await listLeaverAdwPending(AUG);
    expect(saved.pending_count).toBe(0);
    expect(saved.awaiting_recompute_count).toBe(1);
    expect(saved.items[0].saved_awaiting_recompute).toBe(true);

    // 重算後套用 → basis imported → 卡消失
    await recomputeLongtermPayroll(AUG, actorUserId);
    const after = await listLeaverAdwPending(AUG);
    expect(after.items).toHaveLength(0);
    const rows = await prisma.$queryRaw<Array<{ b: string }>>`SELECT al_daily_rate_basis AS b FROM longterm_payroll_lines l JOIN longterm_payroll_runs r ON r.id = l.run_id WHERE r.voided_at IS NULL AND r.month = DATE '2026-08-01' AND l.guard_id = ${g.id}`;
    expect(rows.map((r) => r.b)).toEqual(["imported"]);
  });

  it("一鍵結算 precheck 加 warning（唔 halt、唔阻鎖）", async () => {
    const { actorUserId } = await base();
    await mkLeaver({ hire: "2026-05-01", leave: "2026-08-31", salary: 20000, dob: "1985-01-01", actor: actorUserId });
    await recomputeLongtermPayroll(AUG, actorUserId);
    const r = await stepPrecheck(AUG, actorUserId, null);
    expect(r.halt).toBeUndefined();
    expect(r.numbers.leaverAdwPending).toBe(1);
    expect(r.warnings.some((w) => w.includes("離職者年假補償未有平均工資記錄"))).toBe(true);
  });

  it("在職者（非離職）唔出卡、basis 為 null", async () => {
    const { actorUserId } = await base();
    const g = await prisma.guard.create({ data: { nameZh: "測試乙", employmentType: "longterm_autopay", hireDate: d("2020-01-01"), dateOfBirth: d("1985-01-01"), createdBy: "test" } });
    await prisma.guardLongtermContract.create({ data: { guardId: g.id, monthlySalary: 15000, effectiveFrom: d("2020-01-01"), effectiveTo: null, statutoryHolidayPaidFrom: "immediate", source: "manual", createdBy: actorUserId } });
    const line = (await buildLongtermPayrollInputs(AUG)).lines[0];
    expect(line.alDailyRateBasis).toBeNull();
    await recomputeLongtermPayroll(AUG, actorUserId);
    expect((await listLeaverAdwPending(AUG)).items).toHaveLength(0);
  });
});
