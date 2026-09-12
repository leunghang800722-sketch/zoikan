// Opus 對抗式驗收第二輪 R3：冇 `roster_layout` 模板嘅盤 GET
// roster-export 一律 409 `{error:"no_roster_layout"}`（雞頭同內部角色
// 一致對待，唔係權限問題）——之前會靜靜哋跌落 `buildGenericRosterWorkbook()`
// 出一份用戶唔知係「冧牌」版本嘅殘缺/空檔。順便驗埋 `GET /api/sites`／
// `/api/sites/:id` 嘅 `has_roster_layout` 衍生欄（俾 UI 顯示提示用）。
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { GET as rosterExport } from "@/app/api/sites/[id]/roster-export/route";
import { GET as sitesList } from "@/app/api/sites/route";
import { GET as siteGetOne } from "@/app/api/sites/[id]/route";

function req(url: string, cookie: string) {
  return new Request(url, { headers: { cookie } });
}

const MONTH = "2026-08"; // fx.unlockedMonth

describe("Opus 對抗式驗收第二輪 R3：冇 roster_layout 嘅盤匯出 409", () => {
  let fx: Wp2Fixture;
  let ownerCookie: string;
  let brokerACookie: string;

  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    ownerCookie = await sessionCookieForUser(fx.userIds["老闆"]);
    brokerACookie = await sessionCookieForUser(fx.userIds["雞頭"]);
  });

  afterAll(async () => {
    await clearAll();
    await prisma.$disconnect();
  });

  it("內部角色（老闆）：fx.site 冇 roster_layout → 409 no_roster_layout", async () => {
    const dbSite = await prisma.site.findUniqueOrThrow({ where: { id: fx.site.id } });
    expect(dbSite.rosterLayout).toBeNull(); // fixture 本身冇設，測試前提要成立

    const res = await rosterExport(req(`http://test.local/api/sites/${fx.site.id}/roster-export?month=${MONTH}`, ownerCookie), {
      params: Promise.resolve({ id: fx.site.id }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("no_roster_layout");
  });

  it("雞頭（老闆已開咗佢 更表匯出:export）：同一個盤（自己有份）冇 roster_layout → 一樣 409 no_roster_layout（唔係權限問題，同內部角色一致）", async () => {
    // 「更表匯出」module 雞頭出廠 off（route 頂註解），要老闆開咗先至
    // 過到 requirePermission 嗰關，先至測到 R3 個 409 check 本身（唔係
    // 俾 403 permission-deny 假陽性咁走漏咗）。
    const permission = await prisma.permission.findUniqueOrThrow({ where: { module_action: { module: "更表匯出", action: "export" } } });
    await prisma.rolePermission.update({
      where: { roleId_permissionId: { roleId: fx.roleIds["雞頭"], permissionId: permission.id } },
      data: { granted: true },
    });
    const res = await rosterExport(req(`http://test.local/api/sites/${fx.site.id}/roster-export?month=${MONTH}`, brokerACookie), {
      params: Promise.resolve({ id: fx.site.id }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("no_roster_layout");
  });

  it("有 roster_layout 嘅盤：照樣 200，出到 xlsx（正面對照組，確認 R3 冇連累正常情況）", async () => {
    await prisma.site.update({
      where: { id: fx.site.id },
      data: { rosterLayout: { layout: "standard", sections: [{ kind: "blank", rows: 1 }] } },
    });
    const res = await rosterExport(req(`http://test.local/api/sites/${fx.site.id}/roster-export?month=${MONTH}`, ownerCookie), {
      params: Promise.resolve({ id: fx.site.id }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("spreadsheetml");
  });

  it("GET /api/sites（內部角色）：has_roster_layout 準確反映 rosterLayout 有冇值", async () => {
    const otherSite = await prisma.site.create({
      data: { canonicalName: "測試盤R3-有模板", clientName: "測試客戶R3", billingModel: "per_shift", createdBy: "test-r3", rosterLayout: { layout: "standard", sections: [] } },
    });
    const res = await sitesList(req("http://test.local/api/sites", ownerCookie));
    expect(res.status).toBe(200);
    const body = await res.json();
    const rows = body.rows as Array<{ id: string; has_roster_layout: boolean }>;
    const fxRow = rows.find((r) => r.id === fx.site.id);
    const otherRow = rows.find((r) => r.id === otherSite.id);
    expect(fxRow?.has_roster_layout).toBe(false);
    expect(otherRow?.has_roster_layout).toBe(true);
  });

  it("GET /api/sites/:id（雞頭）：has_roster_layout 都出到（俾雞頭前端一樣顯示提示）", async () => {
    const res = await siteGetOne(req(`http://test.local/api/sites/${fx.site.id}`, brokerACookie), { params: Promise.resolve({ id: fx.site.id }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.has_roster_layout).toBe(false);
    // 雞頭白名單本身唔應該漏咗任何內部專用欄（防禦性 sanity）。
    expect("client_name" in body).toBe(false);
  });
});
