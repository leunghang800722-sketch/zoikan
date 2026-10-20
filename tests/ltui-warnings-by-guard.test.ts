// LT-UI：recompute 之後 run.totals_json additive 存逐人警告代碼；GET /api/longterm/payroll/:month 拆出 warnings_by_guard（只 code），totals 保持原形。
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { recomputeLongtermPayroll } from "@/lib/longterm-payroll/aggregate";
import { GET as payrollGet } from "@/app/api/longterm/payroll/[month]/route";

const D = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));

describe("LT-UI warnings_by_guard", () => {
  let fx: Wp2Fixture;
  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
  });
  it("疑似再入職（人卡離職日早過現行合約鏈起點）→ warnings_by_guard 有 rehire_suspected；冇警告嘅人唔出；totals 唔含 warningsByGuard；回應冇姓名", async () => {
    const site = await prisma.site.create({ data: { canonicalName: "測試LT-UI盤", clientName: "測試客", billingModel: "per_shift", createdBy: "t" } });
    const st = await prisma.shiftType.create({ data: { siteId: site.id, code: "N", hours: 12, createdBy: "t" } });
    const b07 = await prisma.broker.create({ data: { code: "T-B07-LTUI", name: "測試內部長工桶", kind: "internal_longterm", settlementType: "salary", createdBy: "t" } });
    const mk = async (name: string, leave: Date | null, contractFrom: Date) => {
      const g = await prisma.guard.create({ data: { nameZh: name, employmentType: "longterm_autopay", hireDate: D(2020, 1, 1), leaveDate: leave, createdBy: "t" } });
      await prisma.guardLongtermContract.create({ data: { guardId: g.id, monthlySalary: 15500, effectiveFrom: contractFrom, annualLeaveDays: 7, source: "manual", createdBy: fx.userIds["老闆"] } });
      for (let d = 1; d <= 5; d++) await prisma.shiftRecord.create({ data: { workDate: D(2027, 3, d), siteId: site.id, shiftTypeId: st.id, guardId: g.id, settlementBrokerId: b07.id, operationalBrokerId: b07.id, recordType: "shift", createdBy: "t" } });
      return g;
    };
    const rehire = await mk("測試再入職甲", D(2027, 1, 15), D(2027, 2, 1));
    const plain = await mk("測試正常乙", null, D(2020, 1, 1));
    await recomputeLongtermPayroll(D(2027, 3, 1), fx.userIds["老闆"], null);
    const cookie = await sessionCookieForUser(fx.userIds["老闆"]);
    const res = await payrollGet(new Request("http://test.local/api/longterm/payroll/2027-03", { headers: { cookie } }), { params: Promise.resolve({ month: "2027-03" }) });
    const j = (await res.json()) as { warnings_by_guard: Array<{ guard_id: string; codes: string[] }>; totals: Record<string, unknown> };
    expect(j.warnings_by_guard.find((w) => w.guard_id === rehire.id)?.codes).toContain("rehire_suspected");
    expect(j.warnings_by_guard.find((w) => w.guard_id === plain.id)).toBeUndefined();
    expect(Object.keys(j.totals)).not.toContain("warnings_by_guard");
    expect(Object.keys(j.totals)).not.toContain("warningsByGuard");
    expect(JSON.stringify(j.warnings_by_guard)).not.toContain("測試");
  });
});
