// WP-LTPAY §21 任務 5d：`/api/longterm/payroll/:month`
// （GET／`recompute`／`autopay`）integration test——RBAC＋重算掣真係
// call 到 `recomputeLongtermPayroll()`＋autopay CSV 產生（缺銀行資料嘅人
// 唔出現喺檔案，audit 記低下載）。
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { GET as getPayrollMonth } from "@/app/api/longterm/payroll/[month]/route";
import { POST as recomputePayroll } from "@/app/api/longterm/payroll/[month]/recompute/route";
import { GET as getAutopay } from "@/app/api/longterm/payroll/[month]/autopay/route";

function req(url: string, cookie: string, method = "GET", body?: unknown) {
  return new Request(url, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
}
const params = (month: string) => ({ params: Promise.resolve({ month }) });

describe("/api/longterm/payroll/:month", () => {
  let fx: Wp2Fixture;
  let ownerCookie: string;
  let supervisorCookie: string;
  let b07Id: string;

  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    ownerCookie = await sessionCookieForUser(fx.userIds["老闆"]);
    supervisorCookie = await sessionCookieForUser(fx.userIds["主管"]);
    const b07 = await prisma.broker.create({ data: { code: "TEST-B07-ROUTE", name: "測試內部長工桶", kind: "internal_longterm", settlementType: "salary", createdBy: "test" } });
    b07Id = b07.id;
  });

  async function makeLongtermGuard(bankAccountNo: string | null) {
    const guard = await prisma.guard.create({
      data: {
        nameZh: `測試長工-payroll-${Math.random().toString(36).slice(2, 6)}`,
        employmentType: "longterm_autopay",
        hireDate: new Date("2020-01-01"),
        bankAccountNo,
        bankPayeeName: bankAccountNo ? "測試收款人" : null,
        bankName: bankAccountNo ? "測試銀行" : null,
        createdBy: "test",
      },
    });
    await prisma.guardLongtermContract.create({
      data: { guardId: guard.id, monthlySalary: 15000, effectiveFrom: new Date("2020-01-01"), effectiveTo: null, source: "manual", createdBy: fx.userIds["老闆"] },
    });
    for (let d = 1; d <= 26; d++) {
      await prisma.shiftRecord.create({
        data: { workDate: new Date(Date.UTC(2026, 7, d)), siteId: fx.site.id, shiftTypeId: fx.shiftType.id, guardId: guard.id, settlementBrokerId: b07Id, operationalBrokerId: b07Id, recordType: "shift", createdBy: "test" },
      });
    }
    return guard;
  }

  it("主管 403（GET／recompute／autopay 全部）", async () => {
    expect((await getPayrollMonth(req("http://test.local/api/longterm/payroll/2026-08", supervisorCookie), params("2026-08"))).status).toBe(403);
    expect((await recomputePayroll(req("http://test.local/api/longterm/payroll/2026-08/recompute", supervisorCookie, "POST"), params("2026-08"))).status).toBe(403);
    expect((await getAutopay(req("http://test.local/api/longterm/payroll/2026-08/autopay", supervisorCookie), params("2026-08"))).status).toBe(403);
  });

  it("未計過——GET 回 run:null／lines:[]", async () => {
    const res = await getPayrollMonth(req("http://test.local/api/longterm/payroll/2026-08", ownerCookie), params("2026-08"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.run).toBeNull();
    expect(body.lines).toEqual([]);
  });

  it("撳「重算本月」真係計出嚟——GET 見到逐人結算行", async () => {
    await makeLongtermGuard("6001234567");

    const recomputeRes = await recomputePayroll(req("http://test.local/api/longterm/payroll/2026-08/recompute", ownerCookie, "POST"), params("2026-08"));
    expect(recomputeRes.status).toBe(200);
    const recomputeBody = await recomputeRes.json();
    expect(recomputeBody.totals.guard_count).toBe(1);

    const res = await getPayrollMonth(req("http://test.local/api/longterm/payroll/2026-08", ownerCookie), params("2026-08"));
    const body = await res.json();
    expect(body.run).not.toBeNull();
    expect(body.lines.length).toBe(1);
    expect(body.lines[0].work_days).toBe(26);
    expect(body.lines[0].guard_name).toContain("測試長工-payroll");
  });

  it("唔啱嘅月份格式 → 400", async () => {
    const res = await getPayrollMonth(req("http://test.local/api/longterm/payroll/not-a-month", ownerCookie), params("not-a-month"));
    expect(res.status).toBe(400);
  });

  it("鎖定月份重算 → 403（Locked）", async () => {
    const res = await recomputePayroll(req("http://test.local/api/longterm/payroll/2026-06/recompute", ownerCookie, "POST"), params("2026-06"));
    expect(res.status).toBe(403);
  });

  it("未計過長工糧撳「下載 autopay」→ 400", async () => {
    const res = await getAutopay(req("http://test.local/api/longterm/payroll/2026-08/autopay", ownerCookie), params("2026-08"));
    expect(res.status).toBe(400);
  });

  it("autopay CSV：有銀行資料先出現，缺銀行資料嘅人剔走＋preview 列出邊個缺；audit 記低下載", async () => {
    const withBank = await makeLongtermGuard("6009999999");
    const withoutBank = await makeLongtermGuard(null);
    await recomputePayroll(req("http://test.local/api/longterm/payroll/2026-08/recompute", ownerCookie, "POST"), params("2026-08"));

    const previewRes = await getAutopay(req("http://test.local/api/longterm/payroll/2026-08/autopay?preview=1", ownerCookie), params("2026-08"));
    expect(previewRes.status).toBe(200);
    const preview = await previewRes.json();
    expect(preview.row_count).toBe(1);
    expect(preview.missing_bank_info.length).toBe(1);
    expect(preview.format_verified).toBe(false);

    const csvRes = await getAutopay(req("http://test.local/api/longterm/payroll/2026-08/autopay", ownerCookie), params("2026-08"));
    expect(csvRes.status).toBe(200);
    expect(csvRes.headers.get("content-type")).toContain("text/csv");
    const csv = await csvRes.text();
    const lines = csv.trim().split("\r\n");
    expect(lines[0]).toBe("bank_code,account_no,payee_name,amount,reference");
    expect(lines.length).toBe(2); // header + 1 row（withoutBank 剔走）
    expect(lines[1]).toContain("6009999999");
    expect(csv).not.toContain(withoutBank.id);

    const auditRows = await prisma.auditLog.findMany({ where: { action: "export_download", tableName: "longterm_payroll_runs" } });
    expect(auditRows.length).toBe(2); // preview 一次 + 真下載一次
    void withBank;
  });
});
