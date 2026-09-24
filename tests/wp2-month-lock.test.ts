// P1-WP2 §D 月份鎖定測試：locked 嘅月份任何寫入拒絕（403+audit）；解鎖要
// 專門權限（糧務:void）；鎖定後嘅月結鎖定/解鎖流程本身都留痕。
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { POST as shiftRecordCreate } from "@/app/api/shift-records/route";
import { POST as monthCloseLock } from "@/app/api/month-closes/[id]/lock/route";
import { POST as monthCloseUnlock } from "@/app/api/month-closes/[id]/unlock/route";

function req(url: string, cookie: string, method: string, body?: unknown) {
  return new Request(url, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
}

describe("WP2 月份鎖定", () => {
  let fx: Wp2Fixture;
  let ownerCookie: string;
  let supervisorCookie: string;

  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    ownerCookie = await sessionCookieForUser(fx.userIds["老闆"]);
    supervisorCookie = await sessionCookieForUser(fx.userIds["主管"]);
  });

  it("已鎖定月份（2026-06）寫入 shift_records 拒絕 403，並寫 audit", async () => {
    const before = await prisma.auditLog.count({ where: { action: "permission_denied", tableName: "shift_records" } });
    const res = await shiftRecordCreate(
      req("http://test.local/api/shift-records", ownerCookie, "POST", {
        work_date: "2026-06-15",
        site_id: fx.site.id,
        shift_type_id: fx.shiftType.id,
        guard_id: fx.guardA.id,
        record_type: "shift",
      }),
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("month_locked");
    const after = await prisma.auditLog.count({ where: { action: "permission_denied", tableName: "shift_records" } });
    expect(after).toBe(before + 1);
  });

  it("未鎖定月份（2026-08）寫入 shift_records 成功", async () => {
    const res = await shiftRecordCreate(
      req("http://test.local/api/shift-records", ownerCookie, "POST", {
        work_date: "2026-08-15",
        site_id: fx.site.id,
        shift_type_id: fx.shiftType.id,
        guard_id: fx.guardA.id,
        record_type: "shift",
      }),
    );
    expect(res.status).toBe(201);
  });

  it("主管冇糧務:void 權限，解鎖已鎖定月份會 403（設計文件§5.1「月結鎖定/解鎖」主管✗）", async () => {
    const res = await monthCloseUnlock(req(`http://test.local/api/month-closes/${fx.lockedMonthCloseId}`, supervisorCookie, "POST", { reason: "test" }), {
      params: Promise.resolve({ id: fx.lockedMonthCloseId }),
    });
    expect(res.status).toBe(403);
  });

  it("老闆解鎖之後可以寫入，解鎖本身留 audit(action=unlock_month)", async () => {
    const unlockRes = await monthCloseUnlock(req(`http://test.local/api/month-closes/${fx.lockedMonthCloseId}`, ownerCookie, "POST", { reason: "要補漏單" }), {
      params: Promise.resolve({ id: fx.lockedMonthCloseId }),
    });
    expect(unlockRes.status).toBe(200);
    // P1-WP4：audit_log 係 append-only（唔會俾 clearAll() 刪走），成個
    // `npx vitest run` session 入面而家有第二個檔案（tests/wp4-reports.
    // test.ts）都會製造 tableName="month_closes" action="unlock_month"
    // 嘅記錄——冇 rowId scope／orderBy 嘅 findFirstOrThrow() 喺全套件一齊
    // 跑嗰陣可能執到第二個檔案留低嘅舊記錄（唔係呢個 test 自己嗰條），
    // 加返 rowId scope＋按時間降序令佢實執到自己啱啱寫嗰一條。
    const auditRow = await prisma.auditLog.findFirstOrThrow({
      where: { tableName: "month_closes", rowId: fx.lockedMonthCloseId, action: "unlock_month" },
      orderBy: { createdAt: "desc" },
    });
    expect((auditRow.after as { unlock_reason: string }).unlock_reason).toBe("要補漏單");

    const writeRes = await shiftRecordCreate(
      req("http://test.local/api/shift-records", ownerCookie, "POST", {
        work_date: "2026-06-16",
        site_id: fx.site.id,
        shift_type_id: fx.shiftType.id,
        guard_id: fx.guardA.id,
        record_type: "shift",
      }),
    );
    expect(writeRes.status).toBe(201);
  });

  it("鎖定一個未鎖嘅月份會生效，之後嗰個月寫入即刻拒", async () => {
    const mc = await prisma.monthClose.create({ data: { month: fx.unlockedMonth, createdBy: "test" } });
    // B1-6（規則 10）：呢個 fixture 冇幫 fx.site 起更表上載，鎖定會俾
    // 「未上載」擋——呢個 test 淨係測「鎖咗之後寫入拒」，唔係測 B1-6，
    // 用老闆 force=true 跳過（同 wp4-reports.test.ts 一致做法）。
    const lockRes = await monthCloseLock(req(`http://test.local/api/month-closes/${mc.id}`, ownerCookie, "POST", { force: true }), {
      params: Promise.resolve({ id: mc.id }),
    });
    expect(lockRes.status).toBe(200);

    const writeRes = await shiftRecordCreate(
      req("http://test.local/api/shift-records", ownerCookie, "POST", {
        work_date: "2026-08-20",
        site_id: fx.site.id,
        shift_type_id: fx.shiftType.id,
        guard_id: fx.guardA.id,
        record_type: "shift",
      }),
    );
    expect(writeRes.status).toBe(403);
  });
});
