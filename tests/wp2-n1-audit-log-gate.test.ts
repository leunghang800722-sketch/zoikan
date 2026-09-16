// Opus 對抗式驗收第三輪 N1（必修）：audit_log 側 channel。
//
// 威脅模型：writeAudit() 之前 before/after 直接塞成個 Prisma row，
// GET /api/audit-log 冇 DTO 冇 gate——就算 field-group gate 喺其他 route
// 做齊，audit_log 自己都可能漏晒 client_rate/monthly_fee/revenue/
// password_hash/otp_secret 呢類唔應該喺冇對應權限之下見到嘅資料。
//
// (a) 寫入：writeAudit() 而家自動經 table_name → DTO 對照表（見
//     src/lib/api/audit-dto.ts）先存，唔再係原始 Prisma row。
// (b) 讀出：GET /api/audit-log 而家按 table_name 再行一次
//     applyFieldGroupGate(讀者嘅 session)——收客價/出街價 view 冇齊就剝。
// (c) 雞頭喺 matrix.ts「操作紀錄」係 uniformRow(D)，永遠 403。
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { findKeysDeep } from "@/lib/api/serialize";

import { GET as auditLogGet } from "@/app/api/audit-log/route";
import { POST as rateCardCreate } from "@/app/api/rate-cards/route";
import { PATCH as siteUpdate } from "@/app/api/sites/[id]/route";
import { POST as specialItemCreate } from "@/app/api/special-items/route";
import { POST as userCreate } from "@/app/api/users/route";

function req(url: string, cookie: string, method = "GET", body?: unknown) {
  return new Request(url, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
}

const SENSITIVE_KEYS = ["monthly_fee", "client_rate", "client_rate_snapshot", "revenue", "password_hash", "otp_secret"];

async function grantAuditLogView(roleId: string) {
  const permission = await prisma.permission.findUniqueOrThrow({ where: { module_action: { module: "操作紀錄", action: "view" } } });
  await prisma.rolePermission.update({
    where: { roleId_permissionId: { roleId, permissionId: permission.id } },
    data: { granted: true },
  });
}

describe("WP2 N1：audit_log 側 channel（DTO + field-group gate）", () => {
  let fx: Wp2Fixture;
  let ownerCookie: string;
  let supervisorCookie: string;
  let brokerACookie: string;

  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    ownerCookie = await sessionCookieForUser(fx.userIds["老闆"]);
    supervisorCookie = await sessionCookieForUser(fx.userIds["主管"]);
    brokerACookie = await sessionCookieForUser(fx.userIds["雞頭"]);

    // 製造幾條會喺 before/after 帶敏感欄嘅 audit_log 記錄。
    const rcRes = await rateCardCreate(
      req("http://test.local/api/rate-cards", ownerCookie, "POST", {
        site_id: fx.site.id,
        effective_from: "2026-08-01",
        billing_model: "per_shift",
        client_rate: 999,
        guard_wage: 700,
        broker_fee: 60,
      }),
    );
    expect(rcRes.status).toBe(201);

    const siteRes = await siteUpdate(req(`http://test.local/api/sites/${fx.site.id}`, ownerCookie, "PATCH", { monthly_fee: 88888 }), {
      params: Promise.resolve({ id: fx.site.id }),
    });
    expect(siteRes.status).toBe(200);

    const itemRes = await specialItemCreate(
      req("http://test.local/api/special-items", ownerCookie, "POST", { month: "2026-08-01", kind: "other", revenue: 12345, cost: 0 }),
    );
    expect(itemRes.status).toBe(201);

    // clearAll() 唔會刪 users（audit_log 嘅 append-only FK 令佢淨係可以
    // 重設 6 個全域 fixture 用戶，見 tests/lib/db.ts 頂註解）——呢度手動
    // 開嘅額外測試帳號會跨 test 留低，所以電話一定要每次唔同，唔可以
    // 用固定字面值（否則第二個 test 開始就會 409 撞號）。
    const uniqueTel = `900${Date.now() % 100000}`;
    const userRes = await userCreate(
      req("http://test.local/api/users", ownerCookie, "POST", {
        name: "測試N1",
        tel: uniqueTel,
        password: "Passw0rdN1",
        role_id: fx.roleIds["安員"],
      }),
    );
    expect(userRes.status).toBe(201);
  });

  it("主管開「操作紀錄:view」但冇「收客價」／「出街價」view：GET audit-log 遞歸搜敏感 key 零命中", async () => {
    await grantAuditLogView(fx.roleIds["主管"]);
    const res = await auditLogGet(req("http://test.local/api/audit-log", supervisorCookie));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(findKeysDeep(json, SENSITIVE_KEYS)).toEqual([]);
  });

  it("老闆（全部 grant）：GET audit-log 見到齊 client_rate／monthly_fee／revenue（唔會被過度剝）", async () => {
    const res = await auditLogGet(req("http://test.local/api/audit-log", ownerCookie));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(findKeysDeep(json, ["client_rate", "monthly_fee", "revenue"]).length).toBeGreaterThan(0);
    // password_hash／otp_secret 就算老闆都唔應該見到——呢兩個欄由
    // toUserDTO() 嘅白名單結構性剝走（Opus 驗收殘留3），唔受任何角色
    // 權限影響。
    expect(findKeysDeep(json, ["password_hash", "otp_secret"])).toEqual([]);
  });

  it("雞頭：操作紀錄係硬性 deny，GET audit-log 永遠 403", async () => {
    const res = await auditLogGet(req("http://test.local/api/audit-log", brokerACookie));
    expect(res.status).toBe(403);
  });

  it("audit_log.before／after 喺 DB 入面本身已經係 DTO（snake_case，唔係原始 Prisma camelCase row）", async () => {
    const row = await prisma.auditLog.findFirstOrThrow({ where: { tableName: "rate_cards", action: "create" } });
    const after = row.after as Record<string, unknown>;
    expect(after.client_rate).toBe("999");
    expect(after.clientRate).toBeUndefined();
  });
});
