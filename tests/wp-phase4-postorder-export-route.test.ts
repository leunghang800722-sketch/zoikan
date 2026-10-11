// §20.4 Phase 4：`GET /api/reports/postorder/:month` RBAC + audit
// integration test——老闆／會計可下載，主管出廠 403（可由老闆開）、
// 雞頭／保安員硬性 403；下載會寫 audit_log（action=export_download）。
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { GET as getPostorderExport } from "@/app/api/reports/postorder/[month]/route";
import ExcelJS from "exceljs";

function req(url: string, cookie: string) {
  return new Request(url, { headers: { cookie } });
}
const params = (month: string) => ({ params: Promise.resolve({ month }) });

describe("GET /api/reports/postorder/:month", () => {
  let fx: Wp2Fixture;
  let ownerCookie: string;
  let accountantCookie: string;
  let supervisorCookie: string;
  let brokerCookie: string;
  let guardCookie: string;

  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    ownerCookie = await sessionCookieForUser(fx.userIds["老闆"]);
    accountantCookie = await sessionCookieForUser(fx.userIds["會計"]);
    supervisorCookie = await sessionCookieForUser(fx.userIds["主管"]);
    brokerCookie = await sessionCookieForUser(fx.userIds["雞頭"]);
    guardCookie = await sessionCookieForUser(fx.userIds["安員"]);
  });

  it("主管／雞頭／保安員 403（出廠矩陣「月結總表」export 唔開）", async () => {
    for (const cookie of [supervisorCookie, brokerCookie, guardCookie]) {
      const res = await getPostorderExport(req("http://test.local/api/reports/postorder/2026-08", cookie), params("2026-08"));
      expect(res.status).toBe(403);
    }
  });

  it("老闆／會計 200，回一個有四個 sheet 嘅 xlsx，寫 audit_log", async () => {
    // audit_log append-only、跨檔唔清：用「之前已有幾多條」做基線（其他 test 檔，例如 P8.3 自動出檔，亦會經 postorder route 寫 export_download）
    const auditsBefore = await prisma.auditLog.count({ where: { action: "export_download", tableName: "shift_records" } });
    for (const cookie of [ownerCookie, accountantCookie]) {
      const res = await getPostorderExport(req("http://test.local/api/reports/postorder/2026-08", cookie), params("2026-08"));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("spreadsheetml");
      expect(res.headers.get("content-disposition")).toContain(".xlsx");
      const buf = Buffer.from(await res.arrayBuffer());
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(buf as unknown as ArrayBuffer);
      expect(wb.worksheets.map((w) => w.name)).toEqual(["Roster", "PostOrder", "Summary", "口徑說明"]);
    }

    const allAudits = await prisma.auditLog.findMany({ where: { action: "export_download", tableName: "shift_records" }, orderBy: { createdAt: "asc" } });
    const audits = allAudits.slice(auditsBefore);
    expect(audits.length).toBe(2);
    for (const a of audits) {
      const after = a.after as { month?: string };
      expect(after.month).toBe("2026-08");
    }
  });

  it("唔啱嘅月份格式 → 400", async () => {
    const res = await getPostorderExport(req("http://test.local/api/reports/postorder/not-a-month", ownerCookie), params("not-a-month"));
    expect(res.status).toBe(400);
  });
});
