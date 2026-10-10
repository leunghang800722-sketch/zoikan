// WP-LTPAY Phase 2 §21 任務 3a：`buildLongtermPayrollInputs()` /
// `recomputeLongtermPayroll()` DB 整合測試——合成保安員／盤／雞頭（唔用
// 真名/真工號/真電話/真月薪），覆蓋任務書 3e 要求嘅場景：正常在職、
// 月中轉約、離職結算、病假 4 日有紙 vs 3 日、MPF 三種免供、年假試用期
// 邊界。
import { describe, it, expect, afterAll } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { buildLongtermPayrollInputs, recomputeLongtermPayroll } from "@/lib/longterm-payroll/aggregate";

const AUG = (d: number) => new Date(Date.UTC(2026, 7, d));
const AUG_MONTH = new Date(Date.UTC(2026, 7, 1));
const AUG_DAYS = 31;

afterAll(async () => {
  await clearAll();
  await prisma.$disconnect();
});

async function makeFixtureBase() {
  await clearAll();
  const site = await prisma.site.create({ data: { canonicalName: `測試長工盤-${Math.random().toString(36).slice(2, 8)}`, clientName: "測試客戶", billingModel: "per_shift", createdBy: "test" } });
  const st = await prisma.shiftType.create({ data: { siteId: site.id, code: "N", hours: 12, createdBy: "test" } });
  const b07 = await prisma.broker.create({ data: { code: `T-B07-${Math.random().toString(36).slice(2, 6)}`, name: "測試內部長工桶", kind: "internal_longterm", settlementType: "salary", createdBy: "test" } });
  const brokerK = await prisma.broker.create({ data: { code: `T-K-${Math.random().toString(36).slice(2, 6)}`, name: "測試外判雞頭", kind: "broker", settlementType: "cash", createdBy: "test" } });
  const role = await prisma.role.findFirstOrThrow({ where: { name: "老闆" } });
  const user = await prisma.user.create({ data: { name: "測試老闆", tel: `9${Math.floor(1000000 + Math.random() * 8999999)}`, passwordHash: "x", roleId: role.id, createdBy: "test" } });
  return { site, st, b07, brokerK, actorUserId: user.id };
}

async function makeOwnPostShift(guardId: string, site: { id: string }, st: { id: string }, b07: { id: string }, date: Date) {
  return prisma.shiftRecord.create({ data: { workDate: date, siteId: site.id, shiftTypeId: st.id, guardId, settlementBrokerId: b07.id, operationalBrokerId: b07.id, recordType: "shift", createdBy: "test" } });
}
async function makeLeave(guardId: string, site: { id: string }, st: { id: string }, date: Date, code: "RD" | "AL" | "SL" | "NL" | "NPL" | "OFF" | "SH") {
  return prisma.shiftRecord.create({ data: { workDate: date, siteId: site.id, shiftTypeId: st.id, guardId, recordType: "leave", leaveCode: code, createdBy: "test" } });
}

describe("buildLongtermPayrollInputs：正常長工全月在職", () => {
  it("冇合約嘅保安員唔出現喺結果度；有合約嘅全月 Net Basic = 月薪，workDays 計返工日、唔計 RD", async () => {
    const { site, st, b07, actorUserId } = await makeFixtureBase();
    const guard = await prisma.guard.create({ data: { nameZh: "測試長工-正常", employmentType: "longterm_autopay", hireDate: new Date("2020-01-01"), createdBy: "test" } });
    await prisma.guardLongtermContract.create({ data: { guardId: guard.id, monthlySalary: 15500, effectiveFrom: new Date("2020-01-01"), effectiveTo: null, annualLeaveDays: 7, source: "manual", createdBy: actorUserId } });
    for (let d = 1; d <= 26; d++) await makeOwnPostShift(guard.id, site, st, b07, AUG(d));
    for (const d of [27, 28, 29, 30, 31]) await makeLeave(guard.id, site, st, AUG(d), "RD");

    const result = await buildLongtermPayrollInputs(AUG_MONTH);
    expect(result.lines.length).toBe(1);
    const line = result.lines[0];
    expect(line.workDays).toBe(26);
    expect(line.netBasic).toBe(15500);
    expect(line.gross).toBe(15500);
    expect(line.autopay).toBe(round2(15500 - Math.min(15500 * 0.05, 1500)));
    expect(line.isLeaver).toBe(false);
  });

  it("長工用假期幫雞頭頂散更（settlement≠B07）——嗰日唔當返工日，唔扣唔計", async () => {
    const { site, st, b07, brokerK, actorUserId } = await makeFixtureBase();
    const guard = await prisma.guard.create({ data: { nameZh: "測試長工-頂更", employmentType: "longterm_autopay", hireDate: new Date("2020-01-01"), createdBy: "test" } });
    await prisma.guardLongtermContract.create({ data: { guardId: guard.id, monthlySalary: 15500, effectiveFrom: new Date("2020-01-01"), effectiveTo: null, source: "manual", createdBy: actorUserId } });
    for (let d = 1; d <= 20; d++) await makeOwnPostShift(guard.id, site, st, b07, AUG(d));
    // 3 更幫雞頭 K 頂更（現金結算，唔經呢層）
    await prisma.shiftRecord.create({ data: { workDate: AUG(21), siteId: site.id, shiftTypeId: st.id, guardId: guard.id, settlementBrokerId: brokerK.id, operationalBrokerId: brokerK.id, recordType: "shift", createdBy: "test" } });

    const result = await buildLongtermPayrollInputs(AUG_MONTH);
    const line = result.lines[0];
    expect(line.workDays).toBe(20); // 頂更嗰日唔計
    expect(line.netBasic).toBe(15500); // 全月在職，Net Basic 唔受返工日影響
    expect(line.notes.some((n) => n.includes("幫雞頭頂散更"))).toBe(true);
  });
});

describe("buildLongtermPayrollInputs：月中轉約（A-9b 按日拆兩截）", () => {
  it("生效日之前用舊合約、當日起用新合約，Net Basic 按日拆", async () => {
    const { actorUserId } = await makeFixtureBase();
    const guard = await prisma.guard.create({ data: { nameZh: "測試長工-轉約", employmentType: "longterm_autopay", hireDate: new Date("2020-01-01"), createdBy: "test" } });
    // 8/1-8/15 舊薪 15000；8/16-月尾 新薪 16000（生效 8/16）
    await prisma.guardLongtermContract.create({ data: { guardId: guard.id, monthlySalary: 15000, effectiveFrom: new Date("2020-01-01"), effectiveTo: new Date("2026-08-15"), source: "manual", createdBy: actorUserId } });
    await prisma.guardLongtermContract.create({ data: { guardId: guard.id, monthlySalary: 16000, effectiveFrom: new Date("2026-08-16"), effectiveTo: null, source: "manual", createdBy: actorUserId } });

    const result = await buildLongtermPayrollInputs(AUG_MONTH);
    const line = result.lines[0];
    const expected = round2((15000 / AUG_DAYS) * 15 + (16000 / AUG_DAYS) * 16);
    expect(line.netBasic).toBe(expected);
    expect(line.notes.some((n) => n.includes("月中轉約"))).toBe(true);
  });
});

describe("buildLongtermPayrollInputs：離職結算", () => {
  it("guards.leaveDate 喺月中——employEnd 收窄，AL 結餘按比例自動計算", async () => {
    const { actorUserId } = await makeFixtureBase();
    const guard = await prisma.guard.create({ data: { nameZh: "測試長工-離職", employmentType: "longterm_autopay", hireDate: new Date("2024-01-01"), leaveDate: new Date("2026-08-20"), probationMonths: 1, createdBy: "test" } });
    await prisma.guardLongtermContract.create({ data: { guardId: guard.id, monthlySalary: 15000, effectiveFrom: new Date("2024-01-01"), effectiveTo: null, annualLeaveDays: 7, probationMonths: 1, source: "manual", createdBy: actorUserId } });

    const result = await buildLongtermPayrollInputs(AUG_MONTH);
    const line = result.lines[0];
    expect(line.isLeaver).toBe(true);
    expect(line.employEnd).toBe("2026-08-20");
    expect(line.netBasic).toBe(round2((15000 / AUG_DAYS) * 20));
    expect(line.alPayment).toBeGreaterThan(0); // 過咗試用期、服務 >2 年，理應有結餘
    expect(line.notes.some((n) => n.includes("離職補年假"))).toBe(true);
  });

  it("longterm_payroll_inputs kind=leaver_settlement 有 amount——覆蓋自動計算（會計已用終止合約薪酬計算表核實）", async () => {
    const { actorUserId } = await makeFixtureBase();
    const guard = await prisma.guard.create({ data: { nameZh: "測試長工-離職手動", employmentType: "longterm_autopay", hireDate: new Date("2024-01-01"), createdBy: "test" } });
    await prisma.guardLongtermContract.create({ data: { guardId: guard.id, monthlySalary: 15000, effectiveFrom: new Date("2024-01-01"), effectiveTo: null, annualLeaveDays: 7, source: "manual", createdBy: actorUserId } });
    await prisma.longtermPayrollInput.create({ data: { month: AUG_MONTH, guardId: guard.id, kind: "leaver_settlement", amount: 3488.5, dateFrom: "2026-08-15", note: "終止僱傭合約薪酬計算表核實", createdBy: actorUserId } });

    const result = await buildLongtermPayrollInputs(AUG_MONTH);
    const line = result.lines[0];
    expect(line.employEnd).toBe("2026-08-15");
    expect(line.alPayment).toBe(3488.5);
    expect(line.notes.some((n) => n.includes("人手輸入金額"))).toBe(true);
  });

  it("簽咗約但未上班就取消（employStart > employEnd）——跳過唔出糧", async () => {
    const { actorUserId } = await makeFixtureBase();
    const guard = await prisma.guard.create({ data: { nameZh: "測試長工-未上班", employmentType: "longterm_autopay", hireDate: new Date("2026-08-15"), leaveDate: new Date("2026-08-05"), createdBy: "test" } });
    await prisma.guardLongtermContract.create({ data: { guardId: guard.id, monthlySalary: 15000, effectiveFrom: new Date("2026-08-15"), effectiveTo: null, source: "manual", createdBy: actorUserId } });

    const result = await buildLongtermPayrollInputs(AUG_MONTH);
    expect(result.lines.length).toBe(0);
    expect(result.warnings.some((w) => w.includes("從未受僱"))).toBe(true);
  });
});

describe("buildLongtermPayrollInputs：病假 4/5（連續 ≥4 日 + 醫生紙 + 結餘夠）", () => {
  it("連續 4 日、有醫生紙、結餘夠——qualifies，有 4/5 津貼", async () => {
    const { site, st, actorUserId } = await makeFixtureBase();
    const guard = await prisma.guard.create({ data: { nameZh: "測試長工-病假4日", employmentType: "longterm_autopay", hireDate: new Date("2024-01-01"), createdBy: "test" } });
    await prisma.guardLongtermContract.create({ data: { guardId: guard.id, monthlySalary: 15500, effectiveFrom: new Date("2024-01-01"), effectiveTo: null, source: "manual", createdBy: actorUserId } });
    await prisma.guardLeaveBalance.create({ data: { guardId: guard.id, year: 2026, slAccrued: 0, slTaken: 0 } });
    for (const d of [5, 6, 7, 8]) await makeLeave(guard.id, site, st, AUG(d), "SL");
    await prisma.longtermPayrollInput.create({ data: { month: AUG_MONTH, guardId: guard.id, kind: "leave", dateFrom: "2026-08-05", dateTo: "2026-08-08", doctorNoteVerified: true, createdBy: actorUserId } });

    const result = await buildLongtermPayrollInputs(AUG_MONTH);
    const line = result.lines[0];
    expect(line.sl45Amount).toBeGreaterThan(0);
    expect(line.npslDays).toBe(0);
    const expectedPay = round2((15500 / AUG_DAYS) * 0.8 * 4);
    expect(line.sl45Amount).toBe(expectedPay);
  });

  it("連續得 3 日——spanDays<4，唔 qualify，全部當無薪假扣日薪、冇津貼", async () => {
    const { site, st, actorUserId } = await makeFixtureBase();
    const guard = await prisma.guard.create({ data: { nameZh: "測試長工-病假3日", employmentType: "longterm_autopay", hireDate: new Date("2024-01-01"), createdBy: "test" } });
    await prisma.guardLongtermContract.create({ data: { guardId: guard.id, monthlySalary: 15500, effectiveFrom: new Date("2024-01-01"), effectiveTo: null, source: "manual", createdBy: actorUserId } });
    await prisma.guardLeaveBalance.create({ data: { guardId: guard.id, year: 2026, slAccrued: 0, slTaken: 0 } });
    for (const d of [5, 6, 7]) await makeLeave(guard.id, site, st, AUG(d), "SL");
    await prisma.longtermPayrollInput.create({ data: { month: AUG_MONTH, guardId: guard.id, kind: "leave", dateFrom: "2026-08-05", dateTo: "2026-08-07", doctorNoteVerified: true, createdBy: actorUserId } });

    const result = await buildLongtermPayrollInputs(AUG_MONTH);
    const line = result.lines[0];
    expect(line.sl45Amount).toBe(0);
    expect(line.npslDays).toBe(3);
    const expectedDeduct = round2((15500 / AUG_DAYS) * 3);
    expect(line.deduction).toBeLessThanOrEqual(-expectedDeduct + 0.01);
  });

  it("連續 4 日但冇醫生紙（doctorNoteVerified=false）——一樣全部當無薪假", async () => {
    const { site, st, actorUserId } = await makeFixtureBase();
    const guard = await prisma.guard.create({ data: { nameZh: "測試長工-病假冇紙", employmentType: "longterm_autopay", hireDate: new Date("2024-01-01"), createdBy: "test" } });
    await prisma.guardLongtermContract.create({ data: { guardId: guard.id, monthlySalary: 15500, effectiveFrom: new Date("2024-01-01"), effectiveTo: null, source: "manual", createdBy: actorUserId } });
    for (const d of [5, 6, 7, 8]) await makeLeave(guard.id, site, st, AUG(d), "SL");
    await prisma.longtermPayrollInput.create({ data: { month: AUG_MONTH, guardId: guard.id, kind: "leave", dateFrom: "2026-08-05", dateTo: "2026-08-08", doctorNoteVerified: false, createdBy: actorUserId } });

    const result = await buildLongtermPayrollInputs(AUG_MONTH);
    const line = result.lines[0];
    expect(line.sl45Amount).toBe(0);
    expect(line.npslDays).toBe(4);
  });
});

describe("buildLongtermPayrollInputs：MPF 三種免供", () => {
  it("≥65 歲——EE/ER 全免", async () => {
    const { actorUserId } = await makeFixtureBase();
    const guard = await prisma.guard.create({ data: { nameZh: "測試長工-65歲", employmentType: "longterm_autopay", hireDate: new Date("2010-01-01"), dateOfBirth: new Date("1960-01-01"), createdBy: "test" } });
    await prisma.guardLongtermContract.create({ data: { guardId: guard.id, monthlySalary: 15500, effectiveFrom: new Date("2010-01-01"), effectiveTo: null, source: "manual", createdBy: actorUserId } });
    const result = await buildLongtermPayrollInputs(AUG_MONTH);
    const line = result.lines[0];
    expect(line.mpfEe).toBe(0);
    expect(line.mpfEr).toBe(0);
    expect(line.mpfExemptReason).toBe("over65");
  });

  it("入職未滿 60 日——EE/ER 全免", async () => {
    const { actorUserId } = await makeFixtureBase();
    const guard = await prisma.guard.create({ data: { nameZh: "測試長工-新人", employmentType: "longterm_autopay", hireDate: new Date("2026-08-10"), createdBy: "test" } });
    await prisma.guardLongtermContract.create({ data: { guardId: guard.id, monthlySalary: 15500, effectiveFrom: new Date("2026-08-10"), effectiveTo: null, source: "manual", createdBy: actorUserId } });
    const result = await buildLongtermPayrollInputs(AUG_MONTH);
    const line = result.lines[0];
    expect(line.mpfEe).toBe(0);
    expect(line.mpfEr).toBe(0);
    expect(line.mpfExemptReason).toBe("under60days");
  });

  it("Gross<7,100——淨係 EE 免，ER 照供", async () => {
    const { actorUserId } = await makeFixtureBase();
    const guard = await prisma.guard.create({ data: { nameZh: "測試長工-低薪", employmentType: "longterm_autopay", hireDate: new Date("2020-01-01"), createdBy: "test" } });
    await prisma.guardLongtermContract.create({ data: { guardId: guard.id, monthlySalary: 6000, effectiveFrom: new Date("2020-01-01"), effectiveTo: null, source: "manual", createdBy: actorUserId } });
    const result = await buildLongtermPayrollInputs(AUG_MONTH);
    const line = result.lines[0];
    expect(line.mpfEe).toBe(0);
    expect(line.mpfEr).toBe(round2(Math.min(6000 * 0.05, 1500)));
    expect(line.mpfExemptReason).toBe("low_gross");
  });

  it("正常在職、Gross≥7,100、未滿 65、入職 >60 日——EE=ER=min(Gross×5%,1500)", async () => {
    const { actorUserId } = await makeFixtureBase();
    const guard = await prisma.guard.create({ data: { nameZh: "測試長工-正常MPF", employmentType: "longterm_autopay", hireDate: new Date("2020-01-01"), dateOfBirth: new Date("1985-01-01"), createdBy: "test" } });
    await prisma.guardLongtermContract.create({ data: { guardId: guard.id, monthlySalary: 40000, effectiveFrom: new Date("2020-01-01"), effectiveTo: null, source: "manual", createdBy: actorUserId } });
    const result = await buildLongtermPayrollInputs(AUG_MONTH);
    const line = result.lines[0];
    expect(line.mpfEe).toBe(1500);
    expect(line.mpfEr).toBe(1500);
    expect(line.mpfExemptReason).toBe(null);
  });
});

describe("buildLongtermPayrollInputs：年假試用期邊界（§14 規則 9）", () => {
  it("試用期滿嗰日離職——當日唔算過咗，entitlement=0（老闆 2026-09-23 邊界）", async () => {
    const { actorUserId } = await makeFixtureBase();
    // 1 個月試用期，入職 7/1，試用期完結 8/1；離職日設做 7/31（完結日前一日）
    const guard = await prisma.guard.create({ data: { nameZh: "測試長工-試用期滿即走", employmentType: "longterm_autopay", hireDate: new Date("2026-07-01"), leaveDate: new Date("2026-07-31"), probationMonths: 1, createdBy: "test" } });
    await prisma.guardLongtermContract.create({ data: { guardId: guard.id, monthlySalary: 15000, effectiveFrom: new Date("2026-07-01"), effectiveTo: null, annualLeaveDays: 7, probationMonths: 1, source: "manual", createdBy: actorUserId } });

    const result = await buildLongtermPayrollInputs(new Date(Date.UTC(2026, 6, 1)));
    expect(result.lines.length).toBe(1);
    const line = result.lines[0];
    expect(line.employEnd).toBe("2026-07-31");
    expect(line.alPayment).toBe(0);
    expect(line.notes.some((n) => n.includes("試用期未過"))).toBe(true);
  });

  it("試用期完結日當日離職（過咗）——entitlement > 0", async () => {
    const { actorUserId } = await makeFixtureBase();
    const guard = await prisma.guard.create({ data: { nameZh: "測試長工-試用期過", employmentType: "longterm_autopay", hireDate: new Date("2026-07-01"), leaveDate: new Date("2026-08-01"), probationMonths: 1, createdBy: "test" } });
    await prisma.guardLongtermContract.create({ data: { guardId: guard.id, monthlySalary: 15000, effectiveFrom: new Date("2026-07-01"), effectiveTo: null, annualLeaveDays: 7, probationMonths: 1, source: "manual", createdBy: actorUserId } });

    const result = await buildLongtermPayrollInputs(AUG_MONTH);
    const line = result.lines[0];
    expect(line.employEnd).toBe("2026-08-01");
    expect(line.alPayment).toBeGreaterThan(0);
  });

  it("未過試用期就離職——entitlement 恆 0，alPayment=0", async () => {
    const { actorUserId } = await makeFixtureBase();
    const guard = await prisma.guard.create({ data: { nameZh: "測試長工-試用期內走", employmentType: "longterm_autopay", hireDate: new Date("2026-08-01"), leaveDate: new Date("2026-08-15"), probationMonths: 3, createdBy: "test" } });
    await prisma.guardLongtermContract.create({ data: { guardId: guard.id, monthlySalary: 15000, effectiveFrom: new Date("2026-08-01"), effectiveTo: null, annualLeaveDays: 7, probationMonths: 3, source: "manual", createdBy: actorUserId } });

    const result = await buildLongtermPayrollInputs(AUG_MONTH);
    const line = result.lines[0];
    expect(line.alPayment).toBe(0);
    expect(line.notes.some((n) => n.includes("試用期未過"))).toBe(true);
  });
});

describe("buildLongtermPayrollInputs：人手輸入項（津貼／扣款）", () => {
  it("special_allowance／other_allowance／deduction 逐項加減 Gross", async () => {
    const { actorUserId } = await makeFixtureBase();
    const guard = await prisma.guard.create({ data: { nameZh: "測試長工-津貼扣款", employmentType: "longterm_autopay", hireDate: new Date("2020-01-01"), createdBy: "test" } });
    await prisma.guardLongtermContract.create({ data: { guardId: guard.id, monthlySalary: 15500, effectiveFrom: new Date("2020-01-01"), effectiveTo: null, source: "manual", createdBy: actorUserId } });
    await prisma.longtermPayrollInput.create({ data: { month: AUG_MONTH, guardId: guard.id, kind: "special_allowance", amount: 1000, note: "全勤獎", createdBy: actorUserId } });
    await prisma.longtermPayrollInput.create({ data: { month: AUG_MONTH, guardId: guard.id, kind: "other_allowance", amount: 300, note: "頂位津貼（人手對照價目表）", createdBy: actorUserId } });
    await prisma.longtermPayrollInput.create({ data: { month: AUG_MONTH, guardId: guard.id, kind: "deduction", amount: 200, note: "制服費扣減", createdBy: actorUserId } });

    const result = await buildLongtermPayrollInputs(AUG_MONTH);
    const line = result.lines[0];
    expect(line.specialAllowance).toBe(1000);
    expect(line.otherAllowance).toBe(300);
    expect(line.gross).toBe(round2(15500 + 1000 + 300 - 200));
  });
});

describe("buildLongtermPayrollInputs：§21 任務 4b(a) 日薪制長工特判（payBasis=daily）", () => {
  it("Net Basic = dailyRate × 實際返工更數（唔跟曆日比例）", async () => {
    const { site, st, b07, actorUserId } = await makeFixtureBase();
    const guard = await prisma.guard.create({ data: { nameZh: "測試長工-日薪制", employmentType: "longterm_autopay", hireDate: new Date("2020-01-01"), createdBy: "test" } });
    await prisma.guardLongtermContract.create({
      data: { guardId: guard.id, monthlySalary: 600, payBasis: "daily", dailyRate: 600, effectiveFrom: new Date("2020-01-01"), effectiveTo: null, source: "manual", createdBy: actorUserId },
    });
    for (const d of [1, 2, 3, 4, 5, 8, 9, 10, 11, 12]) await makeOwnPostShift(guard.id, site, st, b07, AUG(d));

    const result = await buildLongtermPayrollInputs(AUG_MONTH);
    const line = result.lines[0];
    expect(line.workDays).toBe(10);
    expect(line.netBasic).toBe(6000);
    expect(line.notes.some((n) => n.includes("日薪制"))).toBe(true);
  });
});

describe("buildLongtermPayrollInputs：§21 任務 4b(b) 平均工資表（guard_avg_wages）", () => {
  it("有 guard_avg_wages 記錄——SL 4/5 用嗰個數，唔 fallback 日薪", async () => {
    const { site, st, actorUserId } = await makeFixtureBase();
    const guard = await prisma.guard.create({ data: { nameZh: "測試長工-平均工資SL", employmentType: "longterm_autopay", hireDate: new Date("2024-01-01"), createdBy: "test" } });
    await prisma.guardLongtermContract.create({ data: { guardId: guard.id, monthlySalary: 15500, effectiveFrom: new Date("2024-01-01"), effectiveTo: null, source: "manual", createdBy: actorUserId } });
    await prisma.guardLeaveBalance.create({ data: { guardId: guard.id, year: 2026, slAccrued: 0, slTaken: 0 } });
    await prisma.guardAvgWage.create({ data: { guardId: guard.id, month: AUG_MONTH, avgDailyWage: 900, source: "test：人手輸入" } });
    for (const d of [5, 6, 7, 8]) await makeLeave(guard.id, site, st, AUG(d), "SL");
    await prisma.longtermPayrollInput.create({ data: { month: AUG_MONTH, guardId: guard.id, kind: "leave", dateFrom: "2026-08-05", dateTo: "2026-08-08", doctorNoteVerified: true, createdBy: actorUserId } });

    const result = await buildLongtermPayrollInputs(AUG_MONTH);
    const line = result.lines[0];
    const expectedPay = round2(900 * 0.8 * 4); // 900 ≠ 15500/31，證明真係用咗 guard_avg_wages
    expect(line.sl45Amount).toBe(expectedPay);
    expect(line.notes.some((n) => n.includes("guard_avg_wages"))).toBe(true);
  });

  it("有 guard_avg_wages 記錄——離職補年假用嗰個數", async () => {
    const { actorUserId } = await makeFixtureBase();
    const guard = await prisma.guard.create({ data: { nameZh: "測試長工-平均工資AL", employmentType: "longterm_autopay", hireDate: new Date("2024-01-01"), leaveDate: new Date("2026-08-20"), probationMonths: 1, createdBy: "test" } });
    await prisma.guardLongtermContract.create({ data: { guardId: guard.id, monthlySalary: 15000, effectiveFrom: new Date("2024-01-01"), effectiveTo: null, annualLeaveDays: 7, probationMonths: 1, source: "manual", createdBy: actorUserId } });
    await prisma.guardAvgWage.create({ data: { guardId: guard.id, month: AUG_MONTH, avgDailyWage: 800, source: "test：人手輸入" } });

    const result = await buildLongtermPayrollInputs(AUG_MONTH);
    const line = result.lines[0];
    expect(line.notes.some((n) => n.includes("guard_avg_wages") && n.includes("800"))).toBe(true);
  });
});

describe("recomputeLongtermPayroll：§21 任務 4b(f) guard_leave_balances 寫回", () => {
  it("run 完成後 alTaken／slTaken／slAccrued／asOfMonth 寫入 guard_leave_balances，同一個月重算兩次唔會愈計愈多（冪等）", async () => {
    const { site, st, actorUserId } = await makeFixtureBase();
    const guard = await prisma.guard.create({ data: { nameZh: "測試長工-結餘寫回", employmentType: "longterm_autopay", hireDate: new Date("2024-01-01"), createdBy: "test" } });
    await prisma.guardLongtermContract.create({ data: { guardId: guard.id, monthlySalary: 15500, effectiveFrom: new Date("2024-01-01"), effectiveTo: null, source: "manual", createdBy: actorUserId } });
    // 上個月結轉：alTaken/slTaken=2/1（asOfMonth=7 月，模擬「7 月已經跑完
    // 一次寫低咗」）。
    await prisma.guardLeaveBalance.create({ data: { guardId: guard.id, year: 2026, alTaken: 2, alTakenOpening: 1, slAccrued: 0, slTaken: 1, slTakenOpening: 0, asOfMonth: new Date(Date.UTC(2026, 6, 1)) } });
    await makeLeave(guard.id, site, st, AUG(10), "AL");
    for (const d of [5, 6, 7, 8]) await makeLeave(guard.id, site, st, AUG(d), "SL");
    await prisma.longtermPayrollInput.create({ data: { month: AUG_MONTH, guardId: guard.id, kind: "leave", dateFrom: "2026-08-05", dateTo: "2026-08-08", doctorNoteVerified: true, createdBy: actorUserId } });

    await recomputeLongtermPayroll(AUG_MONTH, actorUserId, null);
    const balanceAfterFirst = await prisma.guardLeaveBalance.findUniqueOrThrow({ where: { guardId_year: { guardId: guard.id, year: 2026 } } });
    expect(Number(balanceAfterFirst.alTaken)).toBe(3); // 8 月開始前（＝7 月尾）2 + 8 月 1 日 AL
    expect(Number(balanceAfterFirst.slTaken)).toBe(5); // 8 月開始前 1 + 8 月攞到 4/5 嘅 4 日
    expect(Number(balanceAfterFirst.alTakenOpening)).toBe(2); // 新 opening＝8 月開始前嗰個 2（唔係啱啱寫低嘅 3）
    expect(Number(balanceAfterFirst.slTakenOpening)).toBe(1);
    expect(balanceAfterFirst.asOfMonth?.toISOString().slice(0, 10)).toBe("2026-08-01");

    // 同一個月（8 月）重算第二次——longterm_payroll_runs void 舊建新，
    // shift_records／inputs 冇變。應該讀返 asOfMonth==8月 嘅 opening
    // （2／1），唔係已經包咗 8 月嘅 alTaken（3／5），先至唔會 3+1=4。
    await recomputeLongtermPayroll(AUG_MONTH, actorUserId, null);
    const balanceAfterSecond = await prisma.guardLeaveBalance.findUniqueOrThrow({ where: { guardId_year: { guardId: guard.id, year: 2026 } } });
    expect(Number(balanceAfterSecond.alTaken)).toBe(3);
    expect(Number(balanceAfterSecond.slTaken)).toBe(5);
    expect(Number(balanceAfterSecond.alTakenOpening)).toBe(2); // opening 都唔變
    expect(Number(balanceAfterSecond.slTakenOpening)).toBe(1);
  });

  it("順序結算落去下個月——下個月讀到嘅 opening＝呢個月嘅 cumulative（同原本行為一致，唔係讀 alTakenOpening）", async () => {
    const { site, st, actorUserId } = await makeFixtureBase();
    const guard = await prisma.guard.create({ data: { nameZh: "測試長工-跨月結轉", employmentType: "longterm_autopay", hireDate: new Date("2024-01-01"), createdBy: "test" } });
    await prisma.guardLongtermContract.create({ data: { guardId: guard.id, monthlySalary: 15500, effectiveFrom: new Date("2024-01-01"), effectiveTo: null, source: "manual", createdBy: actorUserId } });
    await makeLeave(guard.id, site, st, AUG(10), "AL");

    await recomputeLongtermPayroll(AUG_MONTH, actorUserId, null);
    const afterAug = await prisma.guardLeaveBalance.findUniqueOrThrow({ where: { guardId_year: { guardId: guard.id, year: 2026 } } });
    expect(Number(afterAug.alTaken)).toBe(1);

    const SEP_MONTH = new Date(Date.UTC(2026, 8, 1));
    await makeLeave(guard.id, site, st, new Date(Date.UTC(2026, 8, 3)), "AL");
    await recomputeLongtermPayroll(SEP_MONTH, actorUserId, null);
    const afterSep = await prisma.guardLeaveBalance.findUniqueOrThrow({ where: { guardId_year: { guardId: guard.id, year: 2026 } } });
    expect(Number(afterSep.alTaken)).toBe(2); // 8 月 1 日 + 9 月 1 日
    expect(Number(afterSep.alTakenOpening)).toBe(1); // 9 月開始前＝8 月尾嘅 1
    expect(afterSep.asOfMonth?.toISOString().slice(0, 10)).toBe("2026-09-01");
  });
});

describe("recomputeLongtermPayroll：持久化＋冪等", () => {
  it("寫 run／lines；同月重算 void 舊 run、建新 run（唔重複疊加）", async () => {
    const { actorUserId } = await makeFixtureBase();
    const guard = await prisma.guard.create({ data: { nameZh: "測試長工-持久化", employmentType: "longterm_autopay", hireDate: new Date("2020-01-01"), createdBy: "test" } });
    await prisma.guardLongtermContract.create({ data: { guardId: guard.id, monthlySalary: 15500, effectiveFrom: new Date("2020-01-01"), effectiveTo: null, source: "manual", createdBy: actorUserId } });

    const first = await recomputeLongtermPayroll(AUG_MONTH, actorUserId, null);
    expect(first.totals.guardCount).toBe(1);
    const runsAfterFirst = await prisma.longtermPayrollRun.findMany({ where: { month: AUG_MONTH } });
    expect(runsAfterFirst.length).toBe(1);
    expect(runsAfterFirst[0].status).toBe("computed");

    const second = await recomputeLongtermPayroll(AUG_MONTH, actorUserId, null);
    expect(second.runId).not.toBe(first.runId);
    const runsAfterSecond = await prisma.longtermPayrollRun.findMany({ where: { month: AUG_MONTH } });
    expect(runsAfterSecond.length).toBe(2);
    expect(runsAfterSecond.find((r) => r.id === first.runId)?.status).toBe("void");
    expect(runsAfterSecond.find((r) => r.id === second.runId)?.status).toBe("computed");

    const lines = await prisma.longtermPayrollLine.findMany({ where: { runId: second.runId } });
    expect(lines.length).toBe(1);
    expect(Number(lines[0].netBasic)).toBe(15500);
  });

  it("簽證形式長工（visaSponsoredByBrokerId 有值）——§14 規則 12 照出糧（照入 run、照供 MPF），totals.visaPassthrough 另列；雞頭盤嘅更唔當返工日、唔寫「幫雞頭頂散更」", async () => {
    const { site, st, brokerK, actorUserId } = await makeFixtureBase();
    const guard = await prisma.guard.create({ data: { nameZh: "測試長工-簽證形式", employmentType: "longterm_autopay", hireDate: new Date("2020-01-01"), visaSponsoredByBrokerId: brokerK.id, createdBy: "test" } });
    await prisma.guardLongtermContract.create({ data: { guardId: guard.id, monthlySalary: 18800, effectiveFrom: new Date("2020-01-01"), effectiveTo: null, source: "manual", createdBy: actorUserId } });
    for (const d of [1, 2, 3]) await prisma.shiftRecord.create({ data: { workDate: AUG(d), siteId: site.id, shiftTypeId: st.id, guardId: guard.id, settlementBrokerId: brokerK.id, operationalBrokerId: brokerK.id, recordType: "shift", createdBy: "test" } });

    const result = await buildLongtermPayrollInputs(AUG_MONTH);
    expect(result.lines.length).toBe(1);
    const line = result.lines[0];
    expect(line.visaPassthrough).toBe(true);
    expect(line.workDays).toBe(0);
    expect(line.gross).toBe(18800);
    expect(line.mpfEr).toBe(940);
    expect(line.notes.some((n) => n.includes("簽證形式長工"))).toBe(true);
    expect(line.notes.some((n) => n.includes("幫雞頭頂散更"))).toBe(false);
    expect(result.totals.visaPassthrough.guardCount).toBe(1);
    expect(result.totals.visaPassthrough.autopayTotal).toBe(line.autopay);
  });
});

describe("Opus 5.5 驗收修正：病假段／假期結餘邊界", () => {
  it("病假段輸入覆蓋嘅日子更表冇 SL（更表寫返工）——扣晒全段日數，唔係淨係扣段頭 1 日", async () => {
    const { site, st, b07, actorUserId } = await makeFixtureBase();
    const guard = await prisma.guard.create({ data: { nameZh: "測試長工-病假段無更表SL", employmentType: "longterm_autopay", hireDate: new Date("2024-01-01"), createdBy: "test" } });
    await prisma.guardLongtermContract.create({ data: { guardId: guard.id, monthlySalary: 15500, effectiveFrom: new Date("2024-01-01"), effectiveTo: null, source: "manual", createdBy: actorUserId } });
    for (const d of [19, 20]) await makeOwnPostShift(guard.id, site, st, b07, AUG(d));
    await prisma.longtermPayrollInput.create({ data: { month: AUG_MONTH, guardId: guard.id, kind: "leave", dateFrom: "2026-08-19", dateTo: "2026-08-20", doctorNoteVerified: false, createdBy: actorUserId } });

    const line = (await buildLongtermPayrollInputs(AUG_MONTH)).lines[0];
    expect(line.npslDays).toBe(2);
    expect(line.deduction).toBe(-round2((15500 / AUG_DAYS) * 2));
    expect(line.gross).toBe(round2(15500 - (15500 / AUG_DAYS) * 2));
  });

  it("更表 SL 日子有部分冇被病假段輸入涵蓋——漏咗嗰啲當無薪假扣，唔會靜靜哋出足", async () => {
    const { site, st, actorUserId } = await makeFixtureBase();
    const guard = await prisma.guard.create({ data: { nameZh: "測試長工-病假漏段", employmentType: "longterm_autopay", hireDate: new Date("2024-01-01"), createdBy: "test" } });
    await prisma.guardLongtermContract.create({ data: { guardId: guard.id, monthlySalary: 15500, effectiveFrom: new Date("2024-01-01"), effectiveTo: null, source: "manual", createdBy: actorUserId } });
    for (const d of [5, 6, 7, 8, 20]) await makeLeave(guard.id, site, st, AUG(d), "SL");
    await prisma.longtermPayrollInput.create({ data: { month: AUG_MONTH, guardId: guard.id, kind: "leave", dateFrom: "2026-08-05", dateTo: "2026-08-08", doctorNoteVerified: true, createdBy: actorUserId } });

    const line = (await buildLongtermPayrollInputs(AUG_MONTH)).lines[0];
    expect(line.sl45Amount).toBe(round2((15500 / AUG_DAYS) * 0.8 * 4));
    expect(line.npslDays).toBe(1); // 8/20 冇段輸入
    expect(line.deduction).toBe(-round2((15500 / AUG_DAYS) * 5)); // 5 日全部先扣，4 日再畀 4/5
    expect(line.notes.some((n) => n.includes("2026-08-20"))).toBe(true);
  });

  it("跨年：今年未有結餘記錄就接上一年累積做 opening（唔會每年 1 月歸零令病假結餘虛高）", async () => {
    const { site, st, actorUserId } = await makeFixtureBase();
    const JAN = new Date(Date.UTC(2027, 0, 1));
    const guard = await prisma.guard.create({ data: { nameZh: "測試長工-跨年", employmentType: "longterm_autopay", hireDate: new Date("2026-05-01"), createdBy: "test" } });
    await prisma.guardLongtermContract.create({ data: { guardId: guard.id, monthlySalary: 15500, effectiveFrom: new Date("2026-05-01"), effectiveTo: null, source: "manual", createdBy: actorUserId } });
    // 2026 年已經攞咗 10 日有薪病假；2027-01-11 開始嘅 4 日病假要食結餘：
    // accrued(2026-05-01→2027-01-11)＝8 個完整月×2＝16 − 已用 10 ＝ 6 ≥ 4 → qualify。
    // 如果 1 月歸零就會變 16 ≥ 4 一樣 qualify——所以用 14 日令分別出現：16−14＝2 < 4 → 唔 qualify。
    await prisma.guardLeaveBalance.create({ data: { guardId: guard.id, year: 2026, slTaken: 14, alTaken: 3, asOfMonth: new Date(Date.UTC(2026, 11, 1)) } });
    for (const d of [11, 12, 13, 14]) await makeLeave(guard.id, site, st, new Date(Date.UTC(2027, 0, d)), "SL");
    await prisma.longtermPayrollInput.create({ data: { month: JAN, guardId: guard.id, kind: "leave", dateFrom: "2027-01-11", dateTo: "2027-01-14", doctorNoteVerified: true, createdBy: actorUserId } });

    const line = (await buildLongtermPayrollInputs(JAN)).lines[0];
    expect(line.sl45Amount).toBe(0);
    expect(line.npslDays).toBe(4);
    expect(line.leaveBalanceWriteback.alOpeningUsed).toBe(3);
    expect(line.leaveBalanceWriteback.slOpeningUsed).toBe(14);
  });

  it("年假年資由最早一段長工合約計，唔計 guards.hire_date 嘅散工段（§14 規則 9）", async () => {
    const { actorUserId } = await makeFixtureBase();
    // hire_date 2020（散工段開始）；長工合約 2026-05-01 先開始；8/31 離職、冇試用期。
    const guard = await prisma.guard.create({ data: { nameZh: "測試長工-散轉長", employmentType: "longterm_autopay", hireDate: new Date("2020-01-01"), leaveDate: new Date("2026-08-31"), createdBy: "test" } });
    await prisma.guardLongtermContract.create({ data: { guardId: guard.id, monthlySalary: 15500, effectiveFrom: new Date("2026-05-01"), effectiveTo: null, annualLeaveDays: 7, source: "manual", createdBy: actorUserId } });
    const line = (await buildLongtermPayrollInputs(AUG_MONTH)).lines[0];
    // 5/1→8/31 共 123 日 × 7/365 = 2.36 日 × 日薪 15500/31
    expect(line.alPayment).toBe(round2(round2((7 * 123) / 365) * (15500 / AUG_DAYS)));
  });

  it("後一個月已經計過（假期結餘結轉咗）——再重算前一個月會 409 擋住，唔會重複累積", async () => {
    const { site, st, actorUserId } = await makeFixtureBase();
    const guard = await prisma.guard.create({ data: { nameZh: "測試長工-倒轉重算", employmentType: "longterm_autopay", hireDate: new Date("2024-01-01"), createdBy: "test" } });
    await prisma.guardLongtermContract.create({ data: { guardId: guard.id, monthlySalary: 15500, effectiveFrom: new Date("2024-01-01"), effectiveTo: null, source: "manual", createdBy: actorUserId } });
    await makeLeave(guard.id, site, st, AUG(10), "AL");
    await recomputeLongtermPayroll(AUG_MONTH, actorUserId, null);
    await recomputeLongtermPayroll(new Date(Date.UTC(2026, 8, 1)), actorUserId, null);
    await expect(recomputeLongtermPayroll(AUG_MONTH, actorUserId, null)).rejects.toMatchObject({ status: 409 });
    const b = await prisma.guardLeaveBalance.findUniqueOrThrow({ where: { guardId_year: { guardId: guard.id, year: 2026 } } });
    expect(Number(b.alTaken)).toBe(1);
  });

  it("日薪制：無薪假唔另扣（冇返工本來冇錢）", async () => {
    const { site, st, b07, actorUserId } = await makeFixtureBase();
    const g1 = await prisma.guard.create({ data: { nameZh: "測試長工-日薪NPL", employmentType: "longterm_autopay", hireDate: new Date("2020-01-01"), createdBy: "test" } });
    await prisma.guardLongtermContract.create({ data: { guardId: g1.id, monthlySalary: 600, payBasis: "daily", dailyRate: 600, effectiveFrom: new Date("2020-01-01"), effectiveTo: null, source: "manual", createdBy: actorUserId } });
    for (const d of [1, 2, 3]) await makeOwnPostShift(g1.id, site, st, b07, AUG(d));
    await makeLeave(g1.id, site, st, AUG(4), "NPL");
    const lines = (await buildLongtermPayrollInputs(AUG_MONTH)).lines;
    const l1 = lines.find((l) => l.guardId === g1.id)!;
    expect(l1.netBasic).toBe(1800);
    expect(l1.deduction).toBe(0);
  });
});

function round2(x: number): number {
  return Math.round((x + 1e-9) * 100) / 100;
}
