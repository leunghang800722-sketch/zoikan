// WP-LTPAY Phase 2（§14 規則 9）：長工月薪糧計算引擎單元測試——純函數，
// 冇 DB 依賴。逐條規則對應 `src/lib/longterm-payroll/compute.ts` JSDoc
// 引用嘅 oracle（8 月試算 `s07_longterm_payroll.py`／`boss_answers.py`）。
// 鐵則：測試數據一律合成人物／合成金額，唔用任何真實長工姓名／工號／
// 真實月薪。
import { describe, it, expect } from "vitest";
import {
  round2,
  daysInMonth,
  toUtcDate,
  diffDaysInclusive,
  addMonths,
  contractSegmentForDate,
  dailyRateOnDate,
  computeNetBasic,
  computeNetBasicDaily,
  checkMpfExemption,
  computeMpf,
  slCompletedMonths,
  slAccrued,
  slSegmentVerdict,
  resolveRdNplConflicts,
  SL_CONFIRMED_SHORT_PAID,
  sl45Payment,
  probationEndDate,
  hasPassedProbation,
  alEntitlementProrata,
  alLeaverBalance,
  alLeaverPayout,
  computeGross,
  computeAutopay,
  MPF_CAP,
  MPF_MIN_GROSS,
  MPF_FIRST_MONTH_RULE_FROM,
  SL_ACCRUAL_PER_MONTH,
} from "@/lib/longterm-payroll/compute";

describe("round2", () => {
  it("四捨五入到 2 位小數，處理浮點臨界值", () => {
    expect(round2(1.005)).toBe(1.01);
    expect(round2(917875.194)).toBe(917875.19);
    expect(round2(-0.001)).toBe(-0);
  });
});

describe("daysInMonth", () => {
  it("8 月曆日數＝31（8 月試算口徑 AUG_DAYS）", () => {
    expect(daysInMonth(2026, 8)).toBe(31);
  });
  it("2 月（非閏年）＝28，4 月＝30", () => {
    expect(daysInMonth(2026, 2)).toBe(28);
    expect(daysInMonth(2026, 4)).toBe(30);
  });
});

describe("diffDaysInclusive / addMonths", () => {
  it("首尾同一日＝1 日", () => {
    expect(diffDaysInclusive(toUtcDate("2026-08-05"), toUtcDate("2026-08-05"))).toBe(1);
  });
  it("整段日數（含首尾）", () => {
    expect(diffDaysInclusive(toUtcDate("2026-08-01"), toUtcDate("2026-08-31"))).toBe(31);
  });
  it("加月處理月底邊界（1/31 加 1 個月 → 2/28，非閏年）", () => {
    expect(addMonths(toUtcDate("2026-01-31"), 1).toISOString().slice(0, 10)).toBe("2026-02-28");
  });
  it("正常加月", () => {
    expect(addMonths(toUtcDate("2026-08-01"), 1).toISOString().slice(0, 10)).toBe("2026-09-01");
  });
});

describe("Net Basic：日薪＝月薪÷當月曆日數，月中轉合約按日拆", () => {
  const monthDays = 31; // 8 月

  it("全月在職、冇轉約 ＝ 直接等於月薪", () => {
    const segs = [{ monthlySalary: 15500, effectiveFrom: toUtcDate("2026-01-01"), effectiveTo: null }];
    const net = computeNetBasic(segs, toUtcDate("2026-08-01"), toUtcDate("2026-08-31"), monthDays);
    expect(net).toBe(15500);
  });

  it("月中入職：8/10 入職，在職日數 22 日", () => {
    const segs = [{ monthlySalary: 15500, effectiveFrom: toUtcDate("2026-08-10"), effectiveTo: null }];
    const net = computeNetBasic(segs, toUtcDate("2026-08-10"), toUtcDate("2026-08-31"), monthDays);
    expect(net).toBe(round2((15500 / 31) * 22));
  });

  it("月中轉約（A-9b）：8/16 生效新合約，按日拆兩截", () => {
    const oldSalary = 15000;
    const newSalary = 16000;
    const segs = [
      { monthlySalary: oldSalary, effectiveFrom: toUtcDate("2026-01-01"), effectiveTo: toUtcDate("2026-08-15") },
      { monthlySalary: newSalary, effectiveFrom: toUtcDate("2026-08-16"), effectiveTo: null },
    ];
    const net = computeNetBasic(segs, toUtcDate("2026-08-01"), toUtcDate("2026-08-31"), monthDays);
    const expected = round2((oldSalary / 31) * 15 + (newSalary / 31) * 16);
    expect(net).toBe(expected);
    // 生效日之前用舊價、生效日當日起用新價——8/15 用舊，8/16 用新
    expect(dailyRateOnDate(segs, toUtcDate("2026-08-15"), monthDays)).toBe(oldSalary / 31);
    expect(dailyRateOnDate(segs, toUtcDate("2026-08-16"), monthDays)).toBe(newSalary / 31);
  });

  it("contractSegmentForDate 揀返嗰日所屬合約段", () => {
    const segs = [
      { monthlySalary: 15000, effectiveFrom: toUtcDate("2026-01-01"), effectiveTo: toUtcDate("2026-08-15") },
      { monthlySalary: 16000, effectiveFrom: toUtcDate("2026-08-16"), effectiveTo: null },
    ];
    expect(contractSegmentForDate(segs, toUtcDate("2026-08-01")).monthlySalary).toBe(15000);
    expect(contractSegmentForDate(segs, toUtcDate("2026-08-31")).monthlySalary).toBe(16000);
  });
});

describe("MPF（§14 規則 9）", () => {
  const monthEnd = toUtcDate("2026-08-31");

  it("正常人（Gross ≥7,100，<65 歲，入職 ≥60 日）＝ MIN(Gross×5%,1500) 各供", () => {
    const r = computeMpf(15000, { ageAtMonthEnd: 40, hireDate: toUtcDate("2020-01-01"), monthEnd });
    expect(r.mpfEe).toBe(750); // 15000*5%=750 < 1500 cap
    expect(r.mpfEr).toBe(750);
    expect(r.exemptReason).toBeNull();
  });

  it("封頂：Gross×5% > 1500 時封頂 1500", () => {
    const r = computeMpf(40000, { ageAtMonthEnd: 40, hireDate: toUtcDate("2020-01-01"), monthEnd });
    expect(r.mpfEe).toBe(MPF_CAP);
    expect(r.mpfEr).toBe(MPF_CAP);
  });

  it("Gross<7,100 ＝ 僱員免供，僱主照供", () => {
    const gross = MPF_MIN_GROSS - 1;
    const r = computeMpf(gross, { ageAtMonthEnd: 40, hireDate: toUtcDate("2020-01-01"), monthEnd });
    expect(r.mpfEe).toBe(0);
    expect(r.mpfEr).toBe(round2(gross * 0.05));
    expect(r.exemptReason).toBe("low_gross");
  });

  it("≥65 歲＝僱員僱主全免（唔理 Gross 幾多）", () => {
    const r = computeMpf(20000, { ageAtMonthEnd: 65, hireDate: toUtcDate("2000-01-01"), monthEnd });
    expect(r.mpfEe).toBe(0);
    expect(r.mpfEr).toBe(0);
    expect(r.exemptReason).toBe("over65");
  });

  it("入職未滿 60 日＝全免", () => {
    const r = computeMpf(20000, { ageAtMonthEnd: 30, hireDate: toUtcDate("2026-08-10"), monthEnd });
    expect(r.mpfEe).toBe(0);
    expect(r.mpfEr).toBe(0);
    expect(r.exemptReason).toBe("under60days");
  });

  it("剛好入職 60 日（含首尾）＝唔再免供", () => {
    // monthEnd 2026-08-31，入職 2026-07-03 → 60 日（含首尾）
    const hireDate = toUtcDate("2026-07-03");
    expect(diffDaysInclusive(hireDate, monthEnd)).toBe(60);
    const r = checkMpfExemption({ ageAtMonthEnd: 30, hireDate, monthEnd });
    expect(r.exempt).toBe(false);
  });
});

describe("MPF 首月（§25.6，老闆 2026-09-28 追加決定 #3；monthStart 分界＝MPF_FIRST_MONTH_RULE_FROM）", () => {
  it("常數＝2026-09-01", () => {
    expect(MPF_FIRST_MONTH_RULE_FROM).toBe("2026-09-01");
  });

  it("8 月（monthStart<分界）：入職未滿 60 日照舊全免（舊規則不變）", () => {
    const monthStart = toUtcDate("2026-08-01");
    const monthEnd = toUtcDate("2026-08-31");
    const hireDate = toUtcDate("2026-08-10"); // 入職未滿 60 日
    const r = computeMpf(20000, { ageAtMonthEnd: 30, hireDate, monthEnd, monthStart });
    expect(r.mpfEe).toBe(0);
    expect(r.mpfEr).toBe(0);
    expect(r.exemptReason).toBe("under60days");
  });

  it("9 月（monthStart>=分界）：入職日喺本月內＝首月——員工免供，公司照供 ER 5%（封頂 1500）", () => {
    const monthStart = toUtcDate("2026-09-01");
    const monthEnd = toUtcDate("2026-09-30");
    const hireDate = toUtcDate("2026-09-10"); // 入職日喺 9 月之內
    const r = computeMpf(20000, { ageAtMonthEnd: 30, hireDate, monthEnd, monthStart });
    expect(r.mpfEe).toBe(0);
    expect(r.mpfEr).toBe(round2(Math.min(20000 * 0.05, MPF_CAP)));
    expect(r.exemptReason).toBe("first_month_ee");
  });

  it("9 月：首月 ER 都要封頂 1500", () => {
    const monthStart = toUtcDate("2026-09-01");
    const monthEnd = toUtcDate("2026-09-30");
    const hireDate = toUtcDate("2026-09-01");
    const r = computeMpf(40000, { ageAtMonthEnd: 30, hireDate, monthEnd, monthStart });
    expect(r.mpfEe).toBe(0);
    expect(r.mpfEr).toBe(MPF_CAP);
    expect(r.exemptReason).toBe("first_month_ee");
  });

  it("9 月：入職日唔喺本月內（舊員工）＝跟正常規則（EE＋ER 都供，冇 60 日全免）", () => {
    const monthStart = toUtcDate("2026-09-01");
    const monthEnd = toUtcDate("2026-09-30");
    const hireDate = toUtcDate("2026-08-25"); // 上個月先入職，9 月已經係第二個月，唔算首月，8 月 30-31 日「未滿 60 日」舊規則唔再套用
    const r = computeMpf(20000, { ageAtMonthEnd: 30, hireDate, monthEnd, monthStart });
    expect(r.mpfEe).toBe(round2(20000 * 0.05));
    expect(r.mpfEr).toBe(round2(20000 * 0.05));
    expect(r.exemptReason).toBeNull();
  });

  it("9 月：Gross<7,100 淨係免 EE，同首月規則獨立（唔係首月嗰個先套用）", () => {
    const monthStart = toUtcDate("2026-09-01");
    const monthEnd = toUtcDate("2026-09-30");
    const hireDate = toUtcDate("2026-01-01"); // 舊員工
    const gross = MPF_MIN_GROSS - 1;
    const r = computeMpf(gross, { ageAtMonthEnd: 30, hireDate, monthEnd, monthStart });
    expect(r.mpfEe).toBe(0);
    expect(r.mpfEr).toBe(round2(gross * 0.05));
    expect(r.exemptReason).toBe("low_gross");
  });

  it("9 月：≥65 歲全免優先過首月規則", () => {
    const monthStart = toUtcDate("2026-09-01");
    const monthEnd = toUtcDate("2026-09-30");
    const hireDate = toUtcDate("2026-09-05"); // 首月入職但都已經 ≥65
    const r = computeMpf(20000, { ageAtMonthEnd: 65, hireDate, monthEnd, monthStart });
    expect(r.mpfEe).toBe(0);
    expect(r.mpfEr).toBe(0);
    expect(r.exemptReason).toBe("over65");
  });
});

describe("病假 4/5（§14 規則 9）", () => {
  it("WP-BOSS5 25.3：老闆 2026-09-28 確認每月累積 2 日，防手多改", () => {
    expect(SL_ACCRUAL_PER_MONTH).toBe(2);
  });

  it("做滿 1 個月先開始儲：未滿 1 個月＝0", () => {
    expect(slCompletedMonths(toUtcDate("2026-08-01"), toUtcDate("2026-08-20"))).toBe(0);
    expect(slAccrued(toUtcDate("2026-08-01"), toUtcDate("2026-08-20"))).toBe(0);
  });

  it("做滿 1 個月＝儲 2 日", () => {
    expect(slCompletedMonths(toUtcDate("2026-07-01"), toUtcDate("2026-08-15"))).toBe(1);
    expect(slAccrued(toUtcDate("2026-07-01"), toUtcDate("2026-08-15"))).toBe(2);
  });

  it("上限 120 日封頂", () => {
    // 服務 100 個月 × 2 日 = 200 日，封頂 120
    expect(slAccrued(toUtcDate("2018-01-01"), toUtcDate("2026-08-01"))).toBe(120);
  });

  it("連續 ≥4 日 + 結餘夠 + 有醫生紙 → 4/5 合資格", () => {
    const v = slSegmentVerdict(4, 4, 10, true);
    expect(v.qualifies).toBe(true);
  });

  it("P17.1：預設（SL_CONFIRMED_SHORT_PAID=true）連續得 3 日 <4 但醫生紙已人手確認 → 照出", () => {
    expect(SL_CONFIRMED_SHORT_PAID).toBe(true);
    const v = slSegmentVerdict(3, 3, 10, true);
    expect(v.qualifies).toBe(true);
    expect(v.reason).toMatch(/連續得 3 日/);
  });

  it("P17.1：confirmedShortPaid=false（舊規則）→ 短段即使確認都當無薪", () => {
    const v = slSegmentVerdict(3, 3, 10, true, false);
    expect(v.qualifies).toBe(false);
    expect(v.reason).toMatch(/連續得 3 日/);
  });

  it("P17.1：confirmedShortPaid=true（老闆規則）→ 短段已人手確認照出 4/5，說明文字註明未夠 4 日", () => {
    const v = slSegmentVerdict(3, 3, 10, true, true);
    expect(v.qualifies).toBe(true);
    expect(v.reason).toMatch(/連續得 3 日/);
    expect(v.reason).toMatch(/公司做法/);
  });

  it("P17.1：confirmedShortPaid=true 但醫生紙未確認 → 全部無薪（reason 兩樣都講）", () => {
    const v = slSegmentVerdict(3, 3, 10, false, true);
    expect(v.qualifies).toBe(false);
    expect(v.reason).toMatch(/連續得 3 日/);
    expect(v.reason).toMatch(/醫生病假紙/);
  });

  it("P17.1：confirmedShortPaid=true 短段已確認但結餘唔夠 → 仍然唔出（結餘限制保留）", () => {
    const v = slSegmentVerdict(3, 3, 1, true, true);
    expect(v.qualifies).toBe(false);
    expect(v.reason).toMatch(/結餘得 1 日/);
  });

  it("連續夠但結餘唔夠 → 唔合資格", () => {
    const v = slSegmentVerdict(5, 5, 2, true);
    expect(v.qualifies).toBe(false);
    expect(v.reason).toMatch(/結餘得 2 日/);
  });

  it("連續夠、結餘夠，但冇醫生紙 → 唔合資格", () => {
    const v = slSegmentVerdict(4, 4, 10, false);
    expect(v.qualifies).toBe(false);
    expect(v.reason).toMatch(/醫生病假紙/);
  });

  it("RD 夾喺中間：連續日數含 RD（由 caller 傳入 spanDays 已經計埋），segDays 淨係計真正 SL", () => {
    // 8/1 SL, 8/2 RD, 8/3 SL, 8/4 SL, 8/5 SL → span=5, segDays(真正SL)=4
    const v = slSegmentVerdict(4, 5, 10, true);
    expect(v.qualifies).toBe(true);
  });

  it("4/5 金額＝平均工資×0.8×日數", () => {
    expect(sl45Payment(500, 4)).toBe(1600);
  });
});

describe("年假（§14 規則 9，第十五節最終規則）", () => {
  it("試用期完結日＝入職日加試用期月數", () => {
    expect(probationEndDate(toUtcDate("2026-08-01"), 1)?.toISOString().slice(0, 10)).toBe("2026-09-01");
  });

  it("冇試用期（null）＝即刻生效", () => {
    expect(probationEndDate(toUtcDate("2026-08-01"), null)).toBeNull();
    expect(hasPassedProbation(toUtcDate("2026-08-01"), null, toUtcDate("2026-08-01"))).toBe(true);
  });

  it("★ 邊界：試用期滿嗰日（完結日當日）離職＝唔算過咗", () => {
    // 8/1 入職，1 個月試用期 → 完結日 9/1；8/31 離職（完結日前一日）＝未過
    expect(hasPassedProbation(toUtcDate("2026-08-01"), 1, toUtcDate("2026-08-31"))).toBe(false);
    // 9/1（完結日當日）＝已經過咗（>= 完結日）
    expect(hasPassedProbation(toUtcDate("2026-08-01"), 1, toUtcDate("2026-09-01"))).toBe(true);
  });

  it("試用期入面離職 ＝ entitlement 0", () => {
    const r = alEntitlementProrata(7, toUtcDate("2026-08-01"), toUtcDate("2026-08-20"), toUtcDate("2026-08-01"), 1);
    expect(r.entitled).toBe(0);
    expect(r.passedProbation).toBe(false);
  });

  it("過咗試用期＝由開始服務日追溯累積（唔係由試用期完結日計）", () => {
    // 開始服務日 2026-01-01，試用期 1 個月（完結 2026-02-01），離職 2026-09-15
    // 服務日數 = 1/1 → 9/15 = 258 日；entitlement = 7 × 258/365
    const serviceStart = toUtcDate("2026-01-01");
    const leaveDate = toUtcDate("2026-09-15");
    const svcDays = diffDaysInclusive(serviceStart, leaveDate);
    expect(svcDays).toBe(258);
    const r = alEntitlementProrata(7, serviceStart, leaveDate, serviceStart, 1);
    expect(r.passedProbation).toBe(true);
    expect(r.entitled).toBe(round2((7 * 258) / 365));
  });

  it("冇試用期（'No'／0／null）即刻生效，唔使等", () => {
    const r = alEntitlementProrata(7, toUtcDate("2026-05-01"), toUtcDate("2026-08-07"), toUtcDate("2026-05-01"), null);
    expect(r.passedProbation).toBe(true);
    expect(r.entitled).toBeGreaterThan(0);
  });

  it("離職年假結算＝結餘×平均工資", () => {
    const balance = alLeaverBalance(4.95, 4);
    expect(balance).toBe(0.95);
    expect(alLeaverPayout(balance, 835.71)).toBe(round2(0.95 * 835.71));
  });

  it("結餘唔可以為負（已放多過 entitlement 時封底 0）", () => {
    expect(alLeaverBalance(2, 5)).toBe(0);
  });
});

describe("Gross／Autopay 組裝", () => {
  it("Gross = Net Basic + OT + Rest Day Payment − NPSH − NPL/NPSL + 4/5 + 津貼 + 年假薪", () => {
    const gross = computeGross({
      netBasic: 15500,
      otAmount: 200,
      restDayPayment: 0,
      npsh: 0,
      nplDeduction: -500,
      sl45Amount: 0,
      specialAllowance: 1000,
      otherAllowance: 100,
      alPayment: 0,
    });
    expect(gross).toBe(round2(15500 + 200 + 0 + 0 - 500 + 0 + 1000 + 100 + 0));
  });

  it("Autopay = Gross − MPF(EE)", () => {
    expect(computeAutopay(16300, 750)).toBe(15550);
  });

  it("空 components 一律當 0", () => {
    expect(computeGross({ netBasic: 10000 })).toBe(10000);
  });
});

describe("§21 任務 4b(a) 日薪制長工特判：computeNetBasicDaily", () => {
  it("Net Basic = dailyRate × workDays（同 s07 daily_rate_staff 分支 net_basic=r2(rate*work_days) 一致）", () => {
    expect(computeNetBasicDaily(600, 20)).toBe(12000);
  });
  it("0 更 = 0", () => {
    expect(computeNetBasicDaily(600, 0)).toBe(0);
  });
});

describe("P17.5 同日 RD／NPL 衝突：每週一日例假", () => {
  it("(a) 8/2（週日）RD+NPL、同週（7/27–8/2，只計月內）冇其他 RD → 當 RD", () => {
    expect(resolveRdNplConflicts(["2026-08-02"], ["2026-08-02"])).toEqual({ asRd: ["2026-08-02"], asNpl: [] });
  });
  it("(b) 8/4 RD+NPL（+RD）、同週 8/9 有明確 RD → 當 NPL", () => {
    expect(resolveRdNplConflicts(["2026-08-04", "2026-08-09"], ["2026-08-04"])).toEqual({ asRd: [], asNpl: ["2026-08-04"] });
  });
  it("(c) 純 NPL 四日、冇 RD 標記 → 無衝突，唔補例假（呢個函數回空）", () => {
    expect(resolveRdNplConflicts([], ["2026-08-27", "2026-08-28", "2026-08-29", "2026-08-30"])).toEqual({ asRd: [], asNpl: [] });
  });
  it("(d) 月初第一週跨月份：只計月內日子——7 月尾嘅 RD 唔入數，8/1 衝突仍當 RD；8/3 起新一週獨立判斷", () => {
    // 8/1（週六）所屬週 7/27–8/2：月內資料淨係 8/1、8/2。8/2 係明確 RD → 8/1 衝突當 NPL
    expect(resolveRdNplConflicts(["2026-08-01", "2026-08-02"], ["2026-08-01"])).toEqual({ asRd: [], asNpl: ["2026-08-01"] });
    // 7 月嘅 RD 唔喺月內資料（caller 只傳月內日子）→ 8/1 當 RD
    expect(resolveRdNplConflicts(["2026-08-01"], ["2026-08-01"])).toEqual({ asRd: ["2026-08-01"], asNpl: [] });
    // 8/3（週一）屬下一週，同 8/2 唔同週
    expect(resolveRdNplConflicts(["2026-08-02", "2026-08-03"], ["2026-08-03"])).toEqual({ asRd: ["2026-08-03"], asNpl: [] });
  });
  it("同一週多日衝突而冇明確 RD：只最早一日當 RD，其餘當 NPL（保守：每週一日）", () => {
    expect(resolveRdNplConflicts(["2026-08-04", "2026-08-05"], ["2026-08-04", "2026-08-05"])).toEqual({ asRd: ["2026-08-04"], asNpl: ["2026-08-05"] });
  });
});
