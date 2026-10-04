// 主檔搜尋支援身份證號：GET /api/guards?q=——淨 session 有「安員個人資料:view」先用 q 配 hkid。合成資料。
import { describe, it, expect, beforeEach, vi } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { GET as guardsList } from "@/app/api/guards/route";
import { hkidSearchKey } from "@/lib/guards/identity";

const HKID = "A1234563"; // 合法 check digit：A123456(3)

describe("GET /api/guards?q= 身份證號", () => {
  let fx: Wp2Fixture;
  let owner: string;
  let supervisor: string;
  let broker: string;
  const search = async (cookie: string, q: string) => {
    const res = await guardsList(new Request(`http://t/api/guards?q=${encodeURIComponent(q)}`, { headers: { cookie } }));
    expect(res.status).toBe(200);
    return res.json() as Promise<{ rows: { id: string; hkid?: string | null }[]; total: number }>;
  };
  const searchHeader = async (cookie: string, q: string) => {
    const res = await guardsList(new Request("http://t/api/guards", { headers: { cookie, "x-guard-search": encodeURIComponent(q) } }));
    expect(res.status).toBe(200);
    return res.json() as Promise<{ rows: { id: string }[] }>;
  };
  const setSupervisorPii = async (granted: boolean) => {
    const permission = await prisma.permission.findUniqueOrThrow({ where: { module_action: { module: "安員個人資料", action: "view" } } });
    await prisma.rolePermission.upsert({
      where: { roleId_permissionId: { roleId: fx.roleIds["主管"], permissionId: permission.id } },
      update: { granted },
      create: { roleId: fx.roleIds["主管"], permissionId: permission.id, granted },
    });
  };
  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    owner = await sessionCookieForUser(fx.userIds["老闆"]);
    supervisor = await sessionCookieForUser(fx.userIds["主管"]);
    broker = await sessionCookieForUser(fx.userIds["雞頭"]);
    await prisma.guard.update({ where: { id: fx.guardA.id }, data: { hkid: HKID } });
  });

  it("key 正規化：括號／空格／全形／細楷；少過 4 位唔當 hkid", () => {
    expect(hkidSearchKey("a123456(3)")).toBe(HKID);
    expect(hkidSearchKey(" Ａ１２３４５６（３） ")).toBe(HKID);
    expect(hkidSearchKey("A12")).toBeNull();
    expect(hkidSearchKey("測試")).toBeNull();
  });

  it("有權限：完整號／帶括號／細楷／部分（≥4 位）都搵到，列表 hkid 仍然遮罩", async () => {
    for (const q of [HKID, "A123456(3)", "a123456(3)", "a 123456 (3)", "2345", "A1234"]) {
      const r = await search(owner, q);
      expect(r.rows.map((x) => x.id)).toContain(fx.guardA.id);
      expect(r.total).toBe(r.rows.length);
      expect(JSON.stringify(r)).not.toContain(HKID);
    }
    expect((await search(owner, "999999")).rows.length).toBe(0);
  });

  it("header 路徑（x-guard-search，encodeURIComponent）：有權限搵到、帶括號／全形都得；header 優先過 ?q=；壞編碼 400；冇權限／雞頭搵唔到", async () => {
    expect((await searchHeader(owner, "A123456(3)")).rows.map((x) => x.id)).toContain(fx.guardA.id);
    expect((await searchHeader(owner, "ａ１２３４５６（３）")).rows.map((x) => x.id)).toContain(fx.guardA.id);
    expect((await searchHeader(owner, "測試安員甲")).rows.map((x) => x.id)).toEqual([fx.guardA.id]);
    const both = await guardsList(new Request("http://t/api/guards?q=zzzz", { headers: { cookie: owner, "x-guard-search": encodeURIComponent(HKID) } }));
    expect((await both.json()).rows.map((x: { id: string }) => x.id)).toContain(fx.guardA.id);
    const bad = await guardsList(new Request("http://t/api/guards", { headers: { cookie: owner, "x-guard-search": "%E0%A4%A" } }));
    expect(bad.status).toBe(400);
    expect((await searchHeader(broker, HKID)).rows.length).toBe(0);
    await setSupervisorPii(false);
    expect((await searchHeader(supervisor, HKID)).rows.length).toBe(0);
  });

  it("少過 4 位唔當 hkid 搜", async () => {
    expect((await search(owner, "A12")).rows.map((x) => x.id)).not.toContain(fx.guardA.id);
    expect((await search(owner, "345")).rows.map((x) => x.id)).not.toContain(fx.guardA.id);
  });

  it("主管關咗「安員個人資料」搵唔到；開返就搵到", async () => {
    await setSupervisorPii(false);
    expect((await search(supervisor, HKID)).rows.length).toBe(0);
    expect((await search(supervisor, "A1234")).rows.length).toBe(0);
    await setSupervisorPii(true);
    expect((await search(supervisor, HKID)).rows.map((x) => x.id)).toContain(fx.guardA.id);
  });

  it("雞頭搵唔到（硬性 deny）", async () => {
    expect((await search(broker, HKID)).rows.length).toBe(0);
  });

  it("冇權限用戶現有搜尋（姓名／電話）結果不變", async () => {
    await setSupervisorPii(false);
    expect((await search(supervisor, "測試安員甲")).rows.map((x) => x.id)).toEqual([fx.guardA.id]);
  });

  it("搜尋字串唔入 audit／console", async () => {
    const before = await prisma.auditLog.count();
    const spies = (["log", "info", "warn", "error"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    await search(owner, HKID);
    const logged = JSON.stringify(spies.flatMap((s) => s.mock.calls));
    spies.forEach((s) => s.mockRestore());
    expect(logged).not.toContain(HKID);
    expect(await prisma.auditLog.count()).toBe(before); // 搜尋唔寫 audit
  });
});
