// P3-1.1：per-request 權限 Set——同一 request（同一 session 物件）內
// 500 行 field-group gate 只觸發 1 條 role_permissions 查詢；語意同逐行查一致。
import { describe, it, expect, beforeEach, vi } from "vitest";

// 用事件 log 計 role_permissions 查詢數：喺 `@/lib/db` 載入前先放一個帶 query log 嘅
// PrismaClient 入 globalThis 單例（src/lib/db.ts 非 production 會沿用）。
const queries = await vi.hoisted(async () => {
  const { PrismaClient } = await import("@prisma/client");
  const list: string[] = [];
  const client = new PrismaClient({ log: [{ emit: "event", level: "query" }] });
  (client as unknown as { $on: (e: string, cb: (q: { query: string }) => void) => void }).$on("query", (q) => list.push(q.query));
  (globalThis as unknown as { prisma: unknown }).prisma = client;
  return list;
});
import { clearAll } from "./lib/db";
const rpQueries = () => queries.filter((q) => q.includes('"role_permissions"')).length;
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { prisma } from "@/lib/db";
import { requirePermission, hasPermission, loadPermissionSet } from "@/lib/rbac/requirePermission";
import { applyFieldGroupGate, applyFieldGroupGateToList } from "@/lib/api/field-groups";
import { GET as sitesList } from "@/app/api/sites/route";

function req(url: string, cookie: string) {
  return new Request(url, { headers: { cookie } });
}

describe("P3-1.1 per-request 權限 Set", () => {
  let fx: Wp2Fixture;
  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
  });

  it("500 行 applyFieldGroupGateToList 只查 1 次 role_permissions", async () => {
    const cookie = await sessionCookieForUser(fx.userIds["主管"]);
    const before = rpQueries();
    const session = await requirePermission(req("http://test.local/x", cookie), "安員", "view");
    const rows = Array.from({ length: 500 }, (_, i) => ({ id: String(i), hkid: "A1234567", bank_name: "x", monthly_salary: 1 }));
    const out = await applyFieldGroupGateToList(session, "guards", { rows, total: 500, skip: 0, take: 500 });
    expect(out.rows).toHaveLength(500);
    // 之後再逐行 + hasPermission，仍然冇新查詢
    for (let i = 0; i < 50; i++) {
      await applyFieldGroupGate(session, "guards", rows[i]!);
      await hasPermission(session, "出街價", "view");
    }
    expect(rpQueries() - before).toBe(1); // 整個 request（含 requirePermission）1 條
  });

  it("語意不變：主管冇出街價／個人資料／銀行資料 view 就剝欄；老闆全見", async () => {
    const boss = await requirePermission(req("http://test.local/x", await sessionCookieForUser(fx.userIds["老闆"])), "安員", "view");
    const sup = await requirePermission(req("http://test.local/x", await sessionCookieForUser(fx.userIds["主管"])), "安員", "view");
    const row = { id: "1", hkid: "A1234567", bank_name: "b", monthly_salary: 5 };
    for (const [s, role] of [[boss, "老闆"], [sup, "主管"]] as const) {
      const set = await loadPermissionSet(s);
      const got = await applyFieldGroupGate(s, "guards", row);
      expect("monthly_salary" in got).toBe(await hasPermission(s, "出街價", "view"));
      expect("hkid" in got).toBe(await hasPermission(s, "安員個人資料", "view"));
      expect("bank_name" in got).toBe(await hasPermission(s, "安員銀行資料", "view"));
      expect(set.has("安員:view")).toBe(true);
      if (role === "老闆") expect(Object.keys(got).sort()).toEqual(Object.keys(row).sort());
    }
  });

  it("每個 request 重新讀：改權限後新 session 即時生效", async () => {
    const cookie = await sessionCookieForUser(fx.userIds["主管"]);
    const s1 = await requirePermission(req("http://test.local/x", cookie), "安員", "view");
    expect(await hasPermission(s1, "糧務", "view")).toBe(false);
    const perm = await prisma.permission.findUniqueOrThrow({ where: { module_action: { module: "糧務", action: "view" } } });
    await prisma.rolePermission.updateMany({ where: { roleId: s1.roleId, permissionId: perm.id }, data: { granted: true } });
    const s2 = await requirePermission(req("http://test.local/x", cookie), "安員", "view");
    expect(await hasPermission(s2, "糧務", "view")).toBe(true);
  });

  it("GET /api/sites（多行）整個 request 嘅 role_permissions 查詢 ≤ 2", async () => {
    const cookie = await sessionCookieForUser(fx.userIds["主管"]);
    const before = rpQueries();
    const res = await sitesList(req("http://test.local/api/sites?take=500", cookie));
    expect(res.status).toBe(200);
    expect(rpQueries() - before).toBeLessThanOrEqual(2);
  });
});

// P3-1.2：老闆 getViewGrants 直讀 DB（唔再 loopback fetch；冇 request context 都得）。
import { getViewGrants } from "@/lib/rbac/nav";
import { MODULES } from "@/lib/rbac/matrix";
import type { CurrentSession } from "@/lib/auth/current-session";

describe("P3-1.2 getViewGrants 老闆直讀 DB", () => {
  it("老闆：結果 = role_permissions 嘅 view 格（granted && 非硬性 deny），並反映客製化；全程只 1 條 role_permissions 查詢", async () => {
    await clearAll();
    const fx = await seedWp2Fixture();
    const role = await prisma.role.findFirstOrThrow({ where: { name: "老闆" } });
    const sess = { userId: fx.userIds["老闆"], tel: "x", name: "x", roleId: role.id, roleName: "老闆", baseRole: "老闆", brokerId: null, guardId: null, payoutApprovalLimit: null, tokenVersion: 0, loggedInAt: new Date().toISOString(), mustChangePwd: false } as unknown as CurrentSession;
    const before = rpQueries();
    const grants = await getViewGrants(sess);
    expect(rpQueries() - before).toBe(1);
    expect(grants["盤"]).toBe(true);
    // 客製化：老闆角色關掉「配額:view」→ 新 session 物件即時反映
    const perm = await prisma.permission.findUniqueOrThrow({ where: { module_action: { module: "配額", action: "view" } } });
    await prisma.rolePermission.updateMany({ where: { roleId: role.id, permissionId: perm.id }, data: { granted: false } });
    const grants2 = await getViewGrants({ ...sess });
    expect(grants2["配額"]).toBe(false);
    expect(Object.keys(grants2).sort()).toEqual([...MODULES].sort());
  });
});
