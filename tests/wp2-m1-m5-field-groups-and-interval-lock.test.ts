// Opus 對抗式驗收 M1/M2/M3/P4（中央 field-groups 機制）+ M4（糧務:void）
// + M5（rate_cards 生效區間月鎖）。
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { findKeysDeep } from "@/lib/api/serialize";

import { GET as shiftRecordsList } from "@/app/api/shift-records/route";
import { PATCH as shiftRecordUpdate } from "@/app/api/shift-records/[id]/route";
import { GET as sitesList } from "@/app/api/sites/route";
import { PATCH as siteUpdate } from "@/app/api/sites/[id]/route";
import { GET as specialItemsList } from "@/app/api/special-items/route";
import { PATCH as specialItemUpdate } from "@/app/api/special-items/[id]/route";
import { POST as specialItemVoid } from "@/app/api/special-items/[id]/void/route";
import { GET as monthClosesList } from "@/app/api/month-closes/route";
import { GET as rateCardsList } from "@/app/api/rate-cards/route";
import { POST as rateCardCreate } from "@/app/api/rate-cards/route";
import { PATCH as rateCardUpdate } from "@/app/api/rate-cards/[id]/route";
import { POST as rateCardVoid } from "@/app/api/rate-cards/[id]/void/route";

function req(url: string, cookie: string, method = "GET", body?: unknown) {
  return new Request(url, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
}

const CLIENT_RATE_KEYS = ["client_rate", "client_rate_snapshot", "monthly_fee", "revenue"];

describe("WP2 M1/M2/M3/P4：中央 field-groups 機制", () => {
  let fx: Wp2Fixture;
  let ownerCookie: string;
  let supervisorCookie: string;
  let accountantCookie: string;

  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    ownerCookie = await sessionCookieForUser(fx.userIds["老闆"]);
    supervisorCookie = await sessionCookieForUser(fx.userIds["主管"]);
    accountantCookie = await sessionCookieForUser(fx.userIds["會計"]);
  });

  it("主管 GET shift-records（list+單項）遞歸搜 key 零命中 CLIENT_RATE_FIELDS", async () => {
    const listRes = await shiftRecordsList(req("http://test.local/api/shift-records", supervisorCookie));
    expect(listRes.status).toBe(200);
    expect(findKeysDeep(await listRes.json(), CLIENT_RATE_KEYS)).toEqual([]);
  });

  it("主管 GET sites（list）遞歸搜 key 零命中 monthly_fee", async () => {
    const listRes = await sitesList(req("http://test.local/api/sites", supervisorCookie));
    expect(listRes.status).toBe(200);
    expect(findKeysDeep(await listRes.json(), CLIENT_RATE_KEYS)).toEqual([]);
  });

  it("主管 GET special-items（list）遞歸搜 key 零命中 revenue——P3 之後主管出廠「糧務:view」都係○，呢度手動開返嚟淨係測 field-group gate 本身（唔係測整條 permission 鏈）", async () => {
    // P3（Opus 對抗式驗收）：主管糧務 view/export 而家同糧明細一致，出廠
    // ○（off），所以主管預設連呢個 list 都攞唔到（403，屬於預期行為，
    // 已經喺 wp2-rbac-matrix.test.ts 覆蓋）。呢個 test 專門想證明「就算
    // 主管有咗糧務:view，冇收客價:view 都照樣剝 revenue」，所以直接喺
    // DB 開返 糧務:view 先（唔經 API，避免同「permission 鏈揸唔揸得到」
    // 呢個唔同嘅關注點混埋一齊）。
    const permission = await prisma.permission.findUniqueOrThrow({ where: { module_action: { module: "糧務", action: "view" } } });
    await prisma.rolePermission.update({
      where: { roleId_permissionId: { roleId: fx.roleIds["主管"], permissionId: permission.id } },
      data: { granted: true },
    });
    const item = await prisma.specialItem.create({ data: { month: fx.unlockedMonth, kind: "other", revenue: 5000, cost: 100, createdBy: "test" } });
    const listRes = await specialItemsList(req("http://test.local/api/special-items", supervisorCookie));
    expect(listRes.status).toBe(200);
    const json = await listRes.json();
    expect(findKeysDeep(json, CLIENT_RATE_KEYS)).toEqual([]);
    void item;
  });

  it("主管 GET month-closes（list）遞歸搜 key 零命中 CLIENT_RATE_FIELDS（月結鎖定狀態 field-group gate 本身）", async () => {
    // 規劃裁定（Opus 對抗式驗收第三輪，應修）：GET /api/month-closes 而家
    // 改用「更表:view」（主管出廠已經係 ✓），唔使再手動開「糧務:view」
    // 先入得嚟——但 field-group gate（收客價/出街價）唔受呢個轉換影響，
    // 呢個 test 淨係想證明 gate 本身仲生效。
    const listRes = await monthClosesList(req("http://test.local/api/month-closes", supervisorCookie));
    expect(listRes.status).toBe(200);
    expect(findKeysDeep(await listRes.json(), CLIENT_RATE_KEYS)).toEqual([]);
  });

  it("主管冇「糧務:view」但有出廠「更表:view」：GET month-closes 200，見到邊個月鎖咗（locked_at）", async () => {
    const permission = await prisma.permission.findUniqueOrThrow({ where: { module_action: { module: "糧務", action: "view" } } });
    const grant = await prisma.rolePermission.findUnique({ where: { roleId_permissionId: { roleId: fx.roleIds["主管"], permissionId: permission.id } } });
    expect(grant?.granted ?? false).toBe(false); // 出廠 P3 之後確認係 ○（off）
    const listRes = await monthClosesList(req("http://test.local/api/month-closes", supervisorCookie));
    expect(listRes.status).toBe(200);
    const body = (await listRes.json()) as { rows: Array<{ locked_at: string | null }> };
    expect(body.rows.some((r) => r.locked_at !== null)).toBe(true);
  });

  it("主管 GET rate-cards（list+單項）遞歸搜 key 零命中 client_rate", async () => {
    const listRes = await rateCardsList(req("http://test.local/api/rate-cards", supervisorCookie));
    expect(listRes.status).toBe(200);
    expect(findKeysDeep(await listRes.json(), CLIENT_RATE_KEYS)).toEqual([]);
  });

  it("主管 PATCH shift-records 帶 client_rate_snapshot → 403，DB 不變", async () => {
    const before = await prisma.shiftRecord.findUniqueOrThrow({ where: { id: fx.shiftRecordA.id } });
    const res = await shiftRecordUpdate(
      req(`http://test.local/api/shift-records/${fx.shiftRecordA.id}`, supervisorCookie, "PATCH", { client_rate_snapshot: 88888 }),
      { params: Promise.resolve({ id: fx.shiftRecordA.id }) },
    );
    expect(res.status).toBe(403);
    const after = await prisma.shiftRecord.findUniqueOrThrow({ where: { id: fx.shiftRecordA.id } });
    expect(after.clientRateSnapshot?.toString()).toBe(before.clientRateSnapshot?.toString());
  });

  it("主管 PATCH sites 帶 monthly_fee → 403，DB 不變", async () => {
    const before = await prisma.site.findUniqueOrThrow({ where: { id: fx.site.id } });
    const res = await siteUpdate(req(`http://test.local/api/sites/${fx.site.id}`, supervisorCookie, "PATCH", { monthly_fee: 99999 }), {
      params: Promise.resolve({ id: fx.site.id }),
    });
    expect(res.status).toBe(403);
    const after = await prisma.site.findUniqueOrThrow({ where: { id: fx.site.id } });
    expect(after.monthlyFee?.toString()).toBe(before.monthlyFee?.toString());
  });

  it("主管 PATCH special-items 帶 revenue → 403，DB 不變（主管冇「收客價:update」）", async () => {
    const item = await prisma.specialItem.create({ data: { month: fx.unlockedMonth, kind: "other", revenue: 100, createdBy: "test" } });
    const res = await specialItemUpdate(req(`http://test.local/api/special-items/${item.id}`, supervisorCookie, "PATCH", { revenue: 99999 }), {
      params: Promise.resolve({ id: item.id }),
    });
    expect(res.status).toBe(403);
    const after = await prisma.specialItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(after.revenue?.toString()).toBe("100");
  });

  it("會計 PATCH special-items 帶 revenue——按矩陣：會計「收客價:update」= off（○），出廠設定拒 403", async () => {
    // 設計文件§5.1「改收客價 ✓○○✗✗」——會計都係 ○（off by default），
    // 唔係 ✓，所以出廠設定一樣 403（同主管結果一致，呢個 test 專登驗證
    // 矩陣結果，唔係假設會計實際上✓）。
    const item = await prisma.specialItem.create({ data: { month: fx.unlockedMonth, kind: "other", revenue: 100, createdBy: "test" } });
    const res = await specialItemUpdate(req(`http://test.local/api/special-items/${item.id}`, accountantCookie, "PATCH", { revenue: 200 }), {
      params: Promise.resolve({ id: item.id }),
    });
    expect(res.status).toBe(403);
  });

  it("老闆 PATCH special-items 帶 revenue——老闆「收客價:update」=✓，成功", async () => {
    const item = await prisma.specialItem.create({ data: { month: fx.unlockedMonth, kind: "other", revenue: 100, createdBy: "test" } });
    const res = await specialItemUpdate(req(`http://test.local/api/special-items/${item.id}`, ownerCookie, "PATCH", { revenue: 200 }), {
      params: Promise.resolve({ id: item.id }),
    });
    expect(res.status).toBe(200);
  });
});

describe("WP2 M4：糧務:void 跟糧務:update", () => {
  let fx: Wp2Fixture;
  let ownerCookie: string;

  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    ownerCookie = await sessionCookieForUser(fx.userIds["老闆"]);
  });

  it("老闆 void special-item → 200，audit_log 有一行", async () => {
    const item = await prisma.specialItem.create({ data: { month: fx.unlockedMonth, kind: "other", cost: 50, createdBy: "test" } });
    const res = await specialItemVoid(req(`http://test.local/api/special-items/${item.id}`, ownerCookie, "POST", { reason: "打錯" }), {
      params: Promise.resolve({ id: item.id }),
    });
    expect(res.status).toBe(200);
    const audit = await prisma.auditLog.findFirst({ where: { tableName: "special_items", rowId: item.id, action: "void" } });
    expect(audit).toBeTruthy();
    const after = await prisma.specialItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(after.voidedAt).not.toBeNull();
  });
});

describe("WP2 M5：rate_cards 生效區間月鎖——Opus 兩條重現", () => {
  let fx: Wp2Fixture;
  let ownerCookie: string;

  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    ownerCookie = await sessionCookieForUser(fx.userIds["老闆"]);
  });

  it("重現1：create 一張 6/1–7/31 嘅卡（6月已鎖）→ 403，唔淨係睇 effective_from", async () => {
    const res = await rateCardCreate(
      req("http://test.local/api/rate-cards", ownerCookie, "POST", {
        site_id: fx.site.id,
        effective_from: "2026-06-01",
        effective_to: "2026-07-31",
        billing_model: "per_shift",
        client_rate: 500,
        guard_wage: 400,
      }),
    );
    expect(res.status).toBe(403);
  });

  it("重現2：PATCH 將一張原本淨係喺開放月嘅卡嘅 effective_to 伸入已鎖定嘅月 → 403", async () => {
    // 先鎖定 2026-09（一個新月份，同 fx.lockedMonth 分開，確保 test
    // 唔係靠 effective_from 本身就撞鎖）。
    await prisma.monthClose.create({ data: { month: new Date(Date.UTC(2026, 8, 1)), lockedAt: new Date(), lockedBy: fx.userIds["老闆"], createdBy: "test" } });

    const created = await prisma.rateCard.create({
      data: {
        siteId: fx.site.id,
        clientRate: 500,
        guardWage: 400,
        effectiveFrom: new Date(Date.UTC(2026, 7, 1)), // 2026-08-01，開放月
        effectiveTo: new Date(Date.UTC(2026, 7, 31)), // 2026-08-31，都仲喺開放月入面
        createdBy: "test",
      },
    });

    const patchRes = await rateCardUpdate(
      req(`http://test.local/api/rate-cards/${created.id}`, ownerCookie, "PATCH", { effective_to: "2026-09-15" }),
      { params: Promise.resolve({ id: created.id }) },
    );
    expect(patchRes.status).toBe(403);

    // DB 冇改
    const after = await prisma.rateCard.findUniqueOrThrow({ where: { id: created.id } });
    expect(after.effectiveTo?.toISOString().slice(0, 10)).toBe("2026-08-31");
  });

  it("void/unvoid 都用返成個區間判斷", async () => {
    await prisma.monthClose.create({ data: { month: new Date(Date.UTC(2026, 8, 1)), lockedAt: new Date(), lockedBy: fx.userIds["老闆"], createdBy: "test" } });
    const created = await prisma.rateCard.create({
      data: {
        siteId: fx.site.id,
        clientRate: 500,
        guardWage: 400,
        effectiveFrom: new Date(Date.UTC(2026, 7, 1)),
        effectiveTo: new Date(Date.UTC(2026, 8, 15)), // 伸入 9 月（已鎖定）
        createdBy: "test",
      },
    });
    const voidRes = await rateCardVoid(req(`http://test.local/api/rate-cards/${created.id}`, ownerCookie, "POST", { reason: "test" }), {
      params: Promise.resolve({ id: created.id }),
    });
    expect(voidRes.status).toBe(403);
  });
});
