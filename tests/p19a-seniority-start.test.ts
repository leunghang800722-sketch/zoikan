// P19a：長工年資起點＝最早一段未作廢長工合約生效日（MPF 僱員供款豁免、法定假 3 個月規則）。
import { describe, it, expect, afterAll } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { buildLongtermPayrollInputs } from "@/lib/longterm-payroll/aggregate";

const SEP_MONTH = new Date(Date.UTC(2026, 8, 1));
const AUG_MONTH = new Date(Date.UTC(2026, 7, 1));

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
async function sh(guardId: string, site: { id: string }, st: { id: string }, date: string) {
  return prisma.shiftRecord.create({ data: { workDate: new Date(date), siteId: site.id, shiftTypeId: st.id, guardId, recordType: "leave", leaveCode: "SH", createdBy: "test" } });
}
async function mk(hire: string, contractFrom: string, salary: number, actor: string, shFrom: "immediate" | "after_3_months" = "after_3_months") {
  const g = await prisma.guard.create({ data: { nameZh: `測試-${hire}-${contractFrom}`, employmentType: "longterm_autopay", hireDate: new Date(hire), dateOfBirth: new Date("1985-01-01"), createdBy: "test" } });
  await prisma.guardLongtermContract.create({ data: { guardId: g.id, monthlySalary: salary, effectiveFrom: new Date(contractFrom), effectiveTo: null, statutoryHolidayPaidFrom: shFrom, source: "manual", createdBy: actor } });
  return g;
}

describe("P19a 年資起點", () => {
  it("(a) 散工 7/29 入職、9/1 轉長工：9 月 MPF EE=0（首月）、9/26 法定假（after_3_months）扣", async () => {
    const { site, st, actorUserId } = await base();
    const g = await mk("2026-07-29", "2026-09-01", 15000, actorUserId);
    await sh(g.id, site, st, "2026-09-26");
    const line = (await buildLongtermPayrollInputs(SEP_MONTH)).lines[0];
    expect(line.mpfEe).toBe(0);
    expect(line.mpfExemptReason).toBe("first_month_ee");
    expect(line.mpfEr).toBeGreaterThan(0);
    expect(line.npsh).toBeLessThan(0);
    expect(line.notes.some((n) => n.includes("年資起點：長工合約 2026-09-01（散工段唔計）"))).toBe(true);
  });

  it("(b) 長工合約＝入職日嘅人行為不變（hire 2020 照扣 MPF、法定假唔扣；無額外 note）", async () => {
    const { site, st, actorUserId } = await base();
    const g = await mk("2020-01-01", "2020-01-01", 15000, actorUserId);
    await sh(g.id, site, st, "2026-09-26");
    const line = (await buildLongtermPayrollInputs(SEP_MONTH)).lines[0];
    expect(line.mpfEe).toBe(750);
    expect(line.npsh).toBe(0);
    expect(line.notes.some((n) => n.includes("年資起點"))).toBe(false);
  });

  it("(c) 2025 年散工入職、2026-09 轉長工：9 月法定假扣、MPF EE=0", async () => {
    const { site, st, actorUserId } = await base();
    const g = await mk("2025-03-01", "2026-09-01", 19000, actorUserId);
    await sh(g.id, site, st, "2026-09-26");
    const line = (await buildLongtermPayrollInputs(SEP_MONTH)).lines[0];
    expect(line.npsh).toBeLessThan(0);
    expect(line.mpfEe).toBe(0);
  });

  it("(d) 8 月：長工合約＝入職日（新人 8/10）行為不變 under60days 全免", async () => {
    const { actorUserId } = await base();
    await mk("2026-08-10", "2026-08-10", 15500, actorUserId);
    const line = (await buildLongtermPayrollInputs(AUG_MONTH)).lines[0];
    expect(line.mpfExemptReason).toBe("under60days");
    expect(line.mpfEe).toBe(0);
    expect(line.mpfEr).toBe(0);
  });
});
