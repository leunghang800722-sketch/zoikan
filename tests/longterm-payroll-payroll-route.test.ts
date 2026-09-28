// WP-LTPAY §21 任務 5d → WP-BOSS5 §25.4：`/api/longterm/payroll/:month`
// （GET／`recompute`／`autopay`）integration test——RBAC＋重算掣真係
// call 到 `recomputeLongtermPayroll()`＋autopay BOCHK Payroll Editor xlsx
// 產生（缺銀行資料/銀行編號嘅人唔出現喺檔案，列入「缺資料」sheet，
// audit 記低下載）。
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { GET as getPayrollMonth } from "@/app/api/longterm/payroll/[month]/route";
import { POST as recomputePayroll } from "@/app/api/longterm/payroll/[month]/recompute/route";
import { GET as getAutopay } from "@/app/api/longterm/payroll/[month]/autopay/route";
import ExcelJS from "exceljs";

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

  async function makeLongtermGuard(bankAccountNo: string | null, bankCode: string | null = "004") {
    const guard = await prisma.guard.create({
      data: {
        nameZh: `測試長工-payroll-${Math.random().toString(36).slice(2, 6)}`,
        employmentType: "longterm_autopay",
        hireDate: new Date("2020-01-01"),
        bankAccountNo,
        bankPayeeName: bankAccountNo ? "TEST PAYEE" : null,
        bankName: bankAccountNo ? "測試銀行" : null,
        // WP-BOSS5 §25.4：xlsx 要 bank_code（3 位 HKICL 編號）先出到
        // 「Payroll Editor 明細」；bankPayeeName 用純英文（HKICL 字元）
        // 先唔會落去「缺資料」sheet。
        bankCode: bankAccountNo ? bankCode : null,
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

  it("autopay xlsx（BOCHK Payroll Editor 格式）：有齊銀行資料先出現，缺資料嘅人剔走列入「缺資料」sheet＋preview 列出邊個缺；audit 記低下載", async () => {
    const withBank = await makeLongtermGuard("6009999999", "004");
    const withoutAccount = await makeLongtermGuard(null);
    const withoutBankCode = await makeLongtermGuard("6008888888", null);
    await recomputePayroll(req("http://test.local/api/longterm/payroll/2026-08/recompute", ownerCookie, "POST"), params("2026-08"));

    const previewRes = await getAutopay(req("http://test.local/api/longterm/payroll/2026-08/autopay?preview=1", ownerCookie), params("2026-08"));
    expect(previewRes.status).toBe(200);
    const preview = await previewRes.json();
    expect(preview.row_count).toBe(1);
    expect(preview.missing.length).toBe(2);
    expect(preview.format_verified).toBe(true);
    expect(preview.format_source).toContain("BOCHK Payroll (Payment Type) Editor");

    const xlsxRes = await getAutopay(req("http://test.local/api/longterm/payroll/2026-08/autopay", ownerCookie), params("2026-08"));
    expect(xlsxRes.status).toBe(200);
    expect(xlsxRes.headers.get("content-type")).toContain("spreadsheetml");
    expect(xlsxRes.headers.get("content-disposition")).toContain(".xlsx");
    expect(xlsxRes.headers.get("X-Format-Verified")).toBe("true");
    const buf = Buffer.from(await xlsxRes.arrayBuffer());
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual(["Payroll Editor 明細", "檔頭資料", "缺資料"]);

    const detail = wb.getWorksheet("Payroll Editor 明細")!;
    expect(detail.getCell(1, 1).value).toBe("編號 No.");
    expect(detail.getCell(1, 2).value).toBe("員工賬戶銀行編號 Employee A/C Bank Code");
    expect(detail.getCell(2, 2).value).toBe("004");
    expect(detail.getCell(2, 3).value).toBe("BBAN");
    expect(detail.getCell(2, 4).value).toBe("6009999999");
    expect(String(detail.getCell(2, 7).value)).toContain("LT202608-");
    expect(detail.rowCount).toBe(2); // header + 1 row（withoutAccount／withoutBankCode 剔走）

    const headerSheet = wb.getWorksheet("檔頭資料")!;
    expect(headerSheet.getCell(4, 2).value).toBe("HKD");
    expect(headerSheet.getCell(5, 2).value).toBe(1);

    const missingSheet = wb.getWorksheet("缺資料")!;
    expect(missingSheet.rowCount).toBe(3); // header + 2 缺資料

    const auditRows = await prisma.auditLog.findMany({ where: { action: "export_download", tableName: "longterm_payroll_runs" } });
    expect(auditRows.length).toBe(2); // preview 一次 + 真下載一次
    void withBank;
    void withoutAccount;
    void withoutBankCode;
  });
});
