// P1-WP4：新報表 route 嘅權限／field-gate／雞頭 403／月鎖／DTO 覆蓋。
// 用返 tests/fixtures/wp2-fixture.ts 嗰份假數據（site/guardA/guardB/
// brokerA/brokerB，2026-08 兩條 confirmed shift_records，client_rate=999
// guard_wage=700 broker_fee=50 各一條）。
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { GET as getGrossMargin } from "@/app/api/reports/gross-margin/route";
import { GET as getShortfall } from "@/app/api/reports/shortfall/route";
import { GET as getMonthlyClose } from "@/app/api/reports/monthly-close/route";
import { GET as getPayroll } from "@/app/api/reports/payroll/route";
import { GET as getMyReceivable } from "@/app/api/reports/my-receivable/route";
import { POST as generateMonthClose } from "@/app/api/month-closes/[id]/generate/route";
import { POST as lockMonthClose } from "@/app/api/month-closes/[id]/lock/route";
import { POST as unlockMonthClose } from "@/app/api/month-closes/[id]/unlock/route";
import { findKeysDeep, findSubstringInValuesDeep } from "@/lib/api/serialize";
import { BROKER_FORBIDDEN_KEYS } from "@/lib/broker-isolation";

function req(url: string, cookie: string, method = "GET", body?: unknown) {
  return new Request(url, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
}

describe("P1-WP4：報表 route", () => {
  let fx: Wp2Fixture;
  let ownerCookie: string;
  let supervisorCookie: string;
  let accountantCookie: string;
  let brokerACookie: string;

  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    ownerCookie = await sessionCookieForUser(fx.userIds["老闆"]);
    supervisorCookie = await sessionCookieForUser(fx.userIds["主管"]);
    accountantCookie = await sessionCookieForUser(fx.userIds["會計"]);
    brokerACookie = await sessionCookieForUser(fx.userIds["雞頭"]);
  });

  // -------------------------------------------------------------------------
  describe("毛利即時表（GET /api/reports/gross-margin）", () => {
    it("老闆睇：見到正確嘅逐盤營業額／成本／毛利（999+999=1998 revenue，750+750=1500 cost）", async () => {
      const res = await getGrossMargin(req("http://test.local/api/reports/gross-margin?month=2026-08", ownerCookie));
      expect(res.status).toBe(200);
      const body = await res.json();
      const site = body.sites.find((s: { site_id: string }) => s.site_id === fx.site.id);
      expect(site).toBeTruthy();
      expect(site.shifts).toBe(2);
      expect(Number(site.revenue)).toBe(1998);
      expect(Number(site.cost)).toBe(1500);
      expect(Number(site.profit)).toBe(498);
    });

    it("雞頭：毛利即時表 module 硬性 deny → 403", async () => {
      const res = await getGrossMargin(req("http://test.local/api/reports/gross-margin?month=2026-08", brokerACookie));
      expect(res.status).toBe(403);
    });

    it("主管：出廠冇「毛利即時表:view」（off by default）→ 403", async () => {
      const res = await getGrossMargin(req("http://test.local/api/reports/gross-margin?month=2026-08", supervisorCookie));
      expect(res.status).toBe(403);
    });

    it("field-gate：會計冇「收客價:view」就見唔到 revenue/profit/margin_pct，但仲見到 cost（出街價照有）", async () => {
      // 會計出廠有收客價:view，呢度直接手動 revoke 嚟測 field-gate 機制本身
      // （5 個出廠角色冇一個係「有毛利即時表:view 但冇收客價:view」嘅組合，
      // 要人手切先測到呢條分支）。
      const clientRatePerm = await prisma.permission.findFirstOrThrow({ where: { module: "收客價", action: "view" } });
      await prisma.rolePermission.updateMany({ where: { roleId: fx.roleIds["會計"], permissionId: clientRatePerm.id }, data: { granted: false } });

      const res = await getGrossMargin(req("http://test.local/api/reports/gross-margin?month=2026-08", accountantCookie));
      expect(res.status).toBe(200);
      const body = await res.json();
      const site = body.sites.find((s: { site_id: string }) => s.site_id === fx.site.id);
      expect(site.revenue).toBeUndefined();
      expect(site.profit).toBeUndefined();
      expect(site.margin_pct).toBeUndefined();
      expect(Number(site.cost)).toBe(1500);
      expect(body.totals.revenue).toBeUndefined();
      expect(Number(body.totals.cost)).toBeGreaterThan(0);
    });

    it("export=1 冇「毛利即時表:export」→ 403（老闆有，會計出廠都有）", async () => {
      const exportPerm = await prisma.permission.findFirstOrThrow({ where: { module: "毛利即時表", action: "export" } });
      await prisma.rolePermission.updateMany({ where: { roleId: fx.roleIds["會計"], permissionId: exportPerm.id }, data: { granted: false } });
      const res = await getGrossMargin(req("http://test.local/api/reports/gross-margin?month=2026-08&export=1", accountantCookie));
      expect(res.status).toBe(403);
    });
  });

  // -------------------------------------------------------------------------
  describe("尚欠總覽（GET /api/reports/shortfall）", () => {
    it("主管睇：出廠有「尚欠總覽:view」（設計文件「開俾全部主管」）→ 200", async () => {
      const res = await getShortfall(req("http://test.local/api/reports/shortfall?date=2026-08-01", supervisorCookie));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.today.some((s: { site_id: string }) => s.site_id === fx.site.id)).toBe(true);
      expect(body.month_progress).toBeTruthy();
    });

    it("雞頭：尚欠總覽硬性 deny → 403", async () => {
      const res = await getShortfall(req("http://test.local/api/reports/shortfall?date=2026-08-01", brokerACookie));
      expect(res.status).toBe(403);
    });
  });

  // -------------------------------------------------------------------------
  describe("月結總表 + 月結工作台（generate/lock/unlock）", () => {
    it("老闆：GET monthly-close 見到正確數字，雞頭 403", async () => {
      const res = await getMonthlyClose(req("http://test.local/api/reports/monthly-close?month=2026-08", ownerCookie));
      expect(res.status).toBe(200);
      const body = await res.json();
      const row = body.main_rows.find((r: { site_id: string }) => r.site_id === fx.site.id);
      expect(Number(row.revenue)).toBe(1998);

      const brokerRes = await getMonthlyClose(req("http://test.local/api/reports/monthly-close?month=2026-08", brokerACookie));
      expect(brokerRes.status).toBe(403);
    });

    it("generate → 冇差異就直接鎖定成功，audit_log 有 lock_month 記錄", async () => {
      const genRes = await generateMonthClose(req("http://test.local/api/month-closes/2026-08/generate", ownerCookie, "POST"), { params: Promise.resolve({ id: "2026-08" }) });
      expect(genRes.status).toBe(200);
      const genBody = await genRes.json();
      expect(genBody.reconciliation.has_diff).toBe(false);
      const monthCloseId = genBody.month_close.id;

      // B1-6（規則 10）：呢個 fixture 冇幫 fx.site 起更表上載，鎖定會俾「未上載」擋——呢個 test 淨係測「有 generate 對數冇差異就鎖到」，唔係測 B1-6，用老闆 force=true 跳過。
      const lockRes = await lockMonthClose(req(`http://test.local/api/month-closes/${monthCloseId}/lock`, ownerCookie, "POST", { force: true }), { params: Promise.resolve({ id: monthCloseId }) });
      expect(lockRes.status).toBe(200);

      const audit = await prisma.auditLog.findFirst({ where: { tableName: "month_closes", rowId: monthCloseId, action: "lock_month" }, orderBy: { createdAt: "desc" } });
      expect(audit).toBeTruthy();
      const after = audit!.after as Record<string, unknown>;
      expect(after.locked_at).toBeTruthy();
      expect(after.reconciliation_summary).toBeTruthy();

      // 鎖定之後寫入被拒（月鎖機制，WP2 已驗證；呢度淨係再確認鎖定本身
      // 真係生效咗）——嘗試喺呢個月加一條 daily_requirement 應該 403。
      const { POST: createDailyReq } = await import("@/app/api/daily-requirements/route");
      const dr = await createDailyReq(
        req("http://test.local/api/daily-requirements", ownerCookie, "POST", { site_id: fx.site.id, shift_type_id: fx.shiftType.id, work_date: "2026-08-15", headcount_required: 5 }),
      );
      expect(dr.status).toBe(403);

      // 解鎖要填原因
      const unlockNoReason = await unlockMonthClose(req(`http://test.local/api/month-closes/${monthCloseId}/unlock`, ownerCookie, "POST", {}), { params: Promise.resolve({ id: monthCloseId }) });
      expect(unlockNoReason.status).toBe(400);
      const unlockOk = await unlockMonthClose(req(`http://test.local/api/month-closes/${monthCloseId}/unlock`, ownerCookie, "POST", { reason: "測試解鎖" }), { params: Promise.resolve({ id: monthCloseId }) });
      expect(unlockOk.status).toBe(200);
    });

    it("有紅色差異（非 confirmed 記錄計咗入營業額）：鎖定冇 override_reason → 400，有先鎖到", async () => {
      // 加一條 status=draft 嘅 shift_record（唔應該計入 confirmed-only 口徑，
      // 但 buildMonthlyClose() 本身唔篩 status，會揪到規則1 嘅 diff）。
      await prisma.shiftRecord.create({
        data: {
          workDate: new Date(Date.UTC(2026, 7, 5)),
          siteId: fx.site.id,
          shiftTypeId: fx.shiftType.id,
          guardId: fx.guardA.id,
          settlementBrokerId: fx.brokerA.id,
          operationalBrokerId: fx.brokerA.id,
          recordType: "shift",
          status: "draft",
          clientRateSnapshot: 500,
          guardWageSnapshot: 300,
          brokerFeeSnapshot: 20,
          createdBy: "test-fixture:wp4-diff",
        },
      });

      const genRes = await generateMonthClose(req("http://test.local/api/month-closes/2026-08/generate", ownerCookie, "POST"), { params: Promise.resolve({ id: "2026-08" }) });
      const genBody = await genRes.json();
      expect(genBody.reconciliation.has_diff).toBe(true);
      const monthCloseId = genBody.month_close.id;

      const lockNoReason = await lockMonthClose(req(`http://test.local/api/month-closes/${monthCloseId}/lock`, ownerCookie, "POST", {}), { params: Promise.resolve({ id: monthCloseId }) });
      expect(lockNoReason.status).toBe(400);

      // B1-6：同上，force=true 跳過未上載更表嘅擋鎖（呢個 test 焦點係
      // §6.3 紅色差異 override_reason 嗰個閘，唔係 B1-6）。
      const lockWithReason = await lockMonthClose(
        req(`http://test.local/api/month-closes/${monthCloseId}/lock`, ownerCookie, "POST", { override_reason: "測試已知差異，老闆確認可以先鎖", force: true }),
        { params: Promise.resolve({ id: monthCloseId }) },
      );
      expect(lockWithReason.status).toBe(200);

      const audit = await prisma.auditLog.findFirst({ where: { tableName: "month_closes", rowId: monthCloseId, action: "lock_month" }, orderBy: { createdAt: "desc" } });
      const after = audit!.after as Record<string, unknown>;
      expect(after.override_reason).toBe("測試已知差異，老闆確認可以先鎖");
    });

    it("主管：generate 都冇「月結總表:view」→ 403", async () => {
      const res = await generateMonthClose(req("http://test.local/api/month-closes/2026-08/generate", supervisorCookie, "POST"), { params: Promise.resolve({ id: "2026-08" }) });
      expect(res.status).toBe(403);
    });
  });

  // -------------------------------------------------------------------------
  describe("糧明細報表（GET /api/reports/payroll）", () => {
    it("老闆睇：逐雞頭金額正確（brokerA/brokerB 各 1 更，700+50=750）", async () => {
      const res = await getPayroll(req("http://test.local/api/reports/payroll?month=2026-08", ownerCookie));
      expect(res.status).toBe(200);
      const body = await res.json();
      const a = body.totals.find((t: { broker_id: string }) => t.broker_id === fx.brokerA.id);
      expect(Number(a.amount)).toBe(750);
      expect(a.shifts).toBe(1);
    });

    it("雞頭：糧明細硬性 deny → 403", async () => {
      const res = await getPayroll(req("http://test.local/api/reports/payroll?month=2026-08", brokerACookie));
      expect(res.status).toBe(403);
    });
  });

  // -------------------------------------------------------------------------
  describe("雞頭「本月應收」（GET /api/reports/my-receivable）", () => {
    it("雞頭A睇自己：見到自己嗰條（750），零 client_rate、零 brokerB 資料", async () => {
      const res = await getMyReceivable(req("http://test.local/api/reports/my-receivable?month=2026-08", brokerACookie));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.total).toBe(750);
      expect(body.days.length).toBe(1);
      expect(body.days[0].amount).toBe(750);

      // 硬性規則1：零 client_rate*／毛利／其他 broker 資料。
      const forbidden = findKeysDeep(body, [...BROKER_FORBIDDEN_KEYS]);
      expect(forbidden).toEqual([]);
      const brokerBLeak = findSubstringInValuesDeep(body, [fx.brokerB.id]);
      expect(brokerBLeak).toEqual([]);
    });

    it("老闆（非雞頭角色）打呢個 route → 403（設計俾雞頭專用）", async () => {
      const res = await getMyReceivable(req("http://test.local/api/reports/my-receivable?month=2026-08", ownerCookie));
      expect(res.status).toBe(403);
    });
  });
});
