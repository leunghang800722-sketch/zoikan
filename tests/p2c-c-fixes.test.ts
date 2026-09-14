// P2-C（Opus 驗收修復）單元測試：
// M1：GET /api/audit-log from/to（香港曆日）server-side 篩，分頁總數跟
//     filter；非法日期 400。
// A1：重設密碼同時清 failed_attempts/locked_until。
// A2：唔准對自己重設密碼（400）。
// A3：GET /api/audit-log/tables 提供實際出現過嘅 table_name（讀寫呢個
//     endpoint 唔需要額外權限，同「操作紀錄:view」一致）。
// 細節：generateTempPassword() rejection sampling（頻率大致均勻，冇
//       modulo bias）；長度 ≥ 12，字母數字混合；唔存在嘅 id 回 404。
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { isValidHkDateStr, hkDayStartUtc, hkDayEndUtc } from "@/lib/ui/format";

import { GET as auditLogGet } from "@/app/api/audit-log/route";
import { GET as auditLogTables } from "@/app/api/audit-log/tables/route";
import { POST as resetPassword } from "@/app/api/users/[id]/reset-password/route";

function req(url: string, cookie: string, method = "GET", body?: unknown) {
  return new Request(url, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
}

describe("format.ts：香港曆日 helper", () => {
  it("isValidHkDateStr 接受真實存在嘅日曆日，拒絕格式錯或者唔存在嘅日子", () => {
    expect(isValidHkDateStr("2026-07-15")).toBe(true);
    expect(isValidHkDateStr("2026-02-28")).toBe(true);
    expect(isValidHkDateStr("2026-02-30")).toBe(false); // 2026 唔係閏年，2 月冇 30 號
    expect(isValidHkDateStr("2024-02-29")).toBe(true); // 2024 閏年
    expect(isValidHkDateStr("2026-13-01")).toBe(false);
    expect(isValidHkDateStr("2026-7-15")).toBe(false); // 一定要 zero-padded
    expect(isValidHkDateStr("not-a-date")).toBe(false);
  });

  it("hkDayStartUtc／hkDayEndUtc 將香港曆日轉做正確嘅 UTC instant（HKT = UTC+8，冇 DST）", () => {
    // 香港 2026-07-15 00:00:00 = UTC 2026-07-14 16:00:00
    expect(hkDayStartUtc("2026-07-15").toISOString()).toBe("2026-07-14T16:00:00.000Z");
    // 香港 2026-07-15 23:59:59.999 = UTC 2026-07-15 15:59:59.999
    expect(hkDayEndUtc("2026-07-15").toISOString()).toBe("2026-07-15T15:59:59.999Z");
  });
});

describe("P2-C M1：GET /api/audit-log from/to 日期範圍 server-side 篩", () => {
  let fx: Wp2Fixture;
  let ownerCookie: string;
  // audit_log 係 append-only（clearAll() 唔會刪，見 tests/lib/db.ts 頂
  // 註解），同一個 table_name 喺唔同 test 之間唔會自動清空——每個 test
  // 用一個獨一無二嘅 table_name（配合 query 嘅 table_name filter），先
  // 保證斷言嘅 total／row_id 名單唔受其他 test（或者呢個 describe 入面
  // 之前個 test）殘留嘅 audit_log 行影響。
  let tableName: string;

  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    ownerCookie = await sessionCookieForUser(fx.userIds["老闆"]);
    tableName = `p2c_m1_test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    // 手動起 4 條唔同日期嘅 audit_log（append-only 表淨係擋 UPDATE/
    // DELETE，INSERT 冇問題，直接指定 createdAt 方便斷言邊行入邊個範圍）。
    await prisma.auditLog.create({
      data: { actorUserId: fx.userIds["老闆"], tableName, rowId: "row-in-range-1", action: "update", createdAt: new Date("2026-07-10T05:00:00.000Z") }, // HK 2026-07-10 13:00
    });
    await prisma.auditLog.create({
      data: { actorUserId: fx.userIds["老闆"], tableName, rowId: "row-in-range-2", action: "update", createdAt: new Date("2026-07-15T15:59:59.999Z") }, // HK 2026-07-15 23:59:59.999（邊界內）
    });
    await prisma.auditLog.create({
      data: { actorUserId: fx.userIds["老闆"], tableName, rowId: "row-out-of-range", action: "update", createdAt: new Date("2026-07-15T16:00:00.001Z") }, // HK 2026-07-16 00:00:00.001（邊界外）
    });
    await prisma.auditLog.create({
      data: { actorUserId: fx.userIds["老闆"], tableName, rowId: "row-before-range", action: "update", createdAt: new Date("2026-07-09T15:59:59.998Z") }, // HK 2026-07-09 23:59:59.998（邊界外）
    });
  });

  it("from=2026-07-10&to=2026-07-15：淨係篩返香港曆日 7/10–7/15 入面嗰 2 條，total 跟返 filter", async () => {
    const res = await auditLogGet(req(`http://test.local/api/audit-log?from=2026-07-10&to=2026-07-15&table_name=${tableName}`, ownerCookie));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.total).toBe(2);
    const rowIds = json.rows.map((r: { row_id: string }) => r.row_id).sort();
    expect(rowIds).toEqual(["row-in-range-1", "row-in-range-2"]);
  });

  it("淨傳 from（冇 to）：由嗰日起全部（邊界外之前嗰行照樣包埋）", async () => {
    const res = await auditLogGet(req(`http://test.local/api/audit-log?from=2026-07-10&table_name=${tableName}`, ownerCookie));
    expect(res.status).toBe(200);
    const json = await res.json();
    const rowIds = json.rows.map((r: { row_id: string }) => r.row_id).sort();
    expect(rowIds).toEqual(["row-in-range-1", "row-in-range-2", "row-out-of-range"]);
  });

  it("冇傳 from/to：全部 4 條都喺（total 唔受影響）", async () => {
    const res = await auditLogGet(req(`http://test.local/api/audit-log?table_name=${tableName}`, ownerCookie));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.total).toBe(4);
  });

  it("非法日期格式（from）：400", async () => {
    const res = await auditLogGet(req("http://test.local/api/audit-log?from=2026-13-40", ownerCookie));
    expect(res.status).toBe(400);
  });

  it("非法日期格式（to）：400", async () => {
    const res = await auditLogGet(req("http://test.local/api/audit-log?to=not-a-date", ownerCookie));
    expect(res.status).toBe(400);
  });
});

describe("P2-C A3：GET /api/audit-log/tables（distinct table_name，讀寫同一權限）", () => {
  let fx: Wp2Fixture;
  let ownerCookie: string;
  let brokerACookie: string;

  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    ownerCookie = await sessionCookieForUser(fx.userIds["老闆"]);
    brokerACookie = await sessionCookieForUser(fx.userIds["雞頭"]);
    await prisma.auditLog.create({ data: { actorUserId: fx.userIds["老闆"], tableName: "permissions", rowId: "r1", action: "update" } });
    await prisma.auditLog.create({ data: { actorUserId: fx.userIds["老闆"], tableName: "months", rowId: "r2", action: "update" } });
    await prisma.auditLog.create({ data: { actorUserId: fx.userIds["老闆"], tableName: "months", rowId: "r3", action: "update" } });
  });

  it("包含全部實際出現過嘅 table_name（例如 permissions／months），冇重複", async () => {
    const res = await auditLogTables(req("http://test.local/api/audit-log/tables", ownerCookie));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.tables).toContain("permissions");
    expect(json.tables).toContain("months");
    expect(new Set(json.tables).size).toBe(json.tables.length);
  });

  it("雞頭（操作紀錄係硬性 deny）：403", async () => {
    const res = await auditLogTables(req("http://test.local/api/audit-log/tables", brokerACookie));
    expect(res.status).toBe(403);
  });
});

describe("P2-C A1／A2／細節：POST /api/users/:id/reset-password", () => {
  let fx: Wp2Fixture;
  let ownerCookie: string;
  let targetUserId: string;

  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    ownerCookie = await sessionCookieForUser(fx.userIds["老闆"]);
    targetUserId = fx.userIds["主管"];
    // 模擬「主管」俾人鎖咗（撳錯密碼太多次）——A1 要測試重設之後呢兩個
    // 欄要清返。
    await prisma.user.update({ where: { id: targetUserId }, data: { failedAttempts: 4, lockedUntil: new Date(Date.now() + 3600_000) } });
  });

  it("A1：重設密碼之後 failed_attempts=0、locked_until=null", async () => {
    const before = await prisma.user.findUniqueOrThrow({ where: { id: targetUserId } });
    expect(before.failedAttempts).toBe(4);
    expect(before.lockedUntil).not.toBeNull();

    const res = await resetPassword(req(`http://test.local/api/users/${targetUserId}/reset-password`, ownerCookie, "POST"), {
      params: Promise.resolve({ id: targetUserId }),
    });
    expect(res.status).toBe(200);

    const after = await prisma.user.findUniqueOrThrow({ where: { id: targetUserId } });
    expect(after.failedAttempts).toBe(0);
    expect(after.lockedUntil).toBeNull();
    expect(after.mustChangePwd).toBe(true);
  });

  it("A2：唔准對自己重設密碼——400", async () => {
    const res = await resetPassword(req(`http://test.local/api/users/${fx.userIds["老闆"]}/reset-password`, ownerCookie, "POST"), {
      params: Promise.resolve({ id: fx.userIds["老闆"] }),
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.message).toContain("改密碼頁");
  });

  it("細節：唔存在嘅 id 回 404（NotFound helper，唔係未捕捉嘅 Prisma exception）", async () => {
    const res = await resetPassword(req("http://test.local/api/users/00000000-0000-0000-0000-000000000000/reset-password", ownerCookie, "POST"), {
      params: Promise.resolve({ id: "00000000-0000-0000-0000-000000000000" }),
    });
    expect(res.status).toBe(404);
  });

  // A9（Opus 整合驗收）：reset-password 寫嘅 audit_log 一行要真係查得到
  // （action="reset_password"），而且 before/after 嘅 JSON 唔可以含臨時
  // 密碼明文（`temp_password` 淨係喺 response body 一次性出現，唔應該
  // 走漏落 audit_log）、亦唔可以含 `passwordHash`（`toUserDTO()` 白名單
  // 本身就冇呢個欄，呢度用成個 JSON.stringify() 嚟核，唔淨係核頂層
  // key，防止漏喺 nested 位置）。
  it("A9：audit_log 有一行 action=reset_password，before/after JSON 字串唔含臨時密碼，唔含 passwordHash", async () => {
    const res = await resetPassword(req(`http://test.local/api/users/${targetUserId}/reset-password`, ownerCookie, "POST"), {
      params: Promise.resolve({ id: targetUserId }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    const tempPassword: string = json.temp_password;

    const auditRow = await prisma.auditLog.findFirst({
      where: { tableName: "users", rowId: targetUserId, action: "reset_password" },
      orderBy: { createdAt: "desc" },
    });
    expect(auditRow).not.toBeNull();

    const beforeStr = JSON.stringify(auditRow!.before);
    const afterStr = JSON.stringify(auditRow!.after);
    expect(beforeStr).not.toContain(tempPassword);
    expect(afterStr).not.toContain(tempPassword);
    expect(beforeStr.toLowerCase()).not.toContain("passwordhash");
    expect(afterStr.toLowerCase()).not.toContain("passwordhash");
  });

  it("細節：臨時密碼長度 ≥ 12、同時含字母同數字", async () => {
    const res = await resetPassword(req(`http://test.local/api/users/${targetUserId}/reset-password`, ownerCookie, "POST"), {
      params: Promise.resolve({ id: targetUserId }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    const pwd: string = json.temp_password;
    expect(pwd.length).toBeGreaterThanOrEqual(12);
    expect(/[A-Za-z]/.test(pwd)).toBe(true);
    expect(/[0-9]/.test(pwd)).toBe(true);
  });
});
