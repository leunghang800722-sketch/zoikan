// WP-R1：左欄／手機抽屜導航分組（`src/lib/rbac/nav.ts` 嘅
// `groupNavLinks()`）——純函數 unit test，唔使起 DB／session（同
// `getNavLinks()` 嘅權限邏輯完全分開，見嗰個 function 頭嘅註解）。
import { describe, expect, it } from "vitest";
import { getNavLinks, getViewGrants, groupNavLinks, type NavLink } from "@/lib/rbac/nav";
import { MODULES, ROLE_NAMES, isGrantedByDefault, type Module, type RoleName } from "@/lib/rbac/matrix";
import type { CurrentSession } from "@/lib/auth/current-session";
import { clearAll, prisma } from "./lib/db";

// 老闆／主管／會計全部 module 都 grant（出廠矩陣）時 `getNavLinks()`
// 會回嘅完整連結（唔包 /roles，等落面 case 分開測「冇連結嘅組唔顯示」）。
const FULL_INTERNAL_LINKS: NavLink[] = [
  { href: "/", label: "首頁" },
  { href: "/roster", label: "更表" },
  { href: "/quotas", label: "配額" },
  { href: "/approvals", label: "審批隊列" },
  { href: "/sites", label: "盤" },
  { href: "/guards", label: "保安員" },
  { href: "/brokers", label: "雞頭" },
  { href: "/rate-cards", label: "價目" },
  { href: "/reports/gross-margin", label: "毛利即時表" },
  { href: "/reports/monthly-close", label: "月結工作台" },
  { href: "/reports/payroll", label: "糧明細" },
  { href: "/reports/shortfall", label: "尚欠總覽" },
  { href: "/users", label: "用戶管理" },
  { href: "/roles", label: "角色權限管理" },
  { href: "/audit-log", label: "操作紀錄" },
];

const BROKER_LINKS: NavLink[] = [
  { href: "/", label: "首頁" },
  { href: "/roster", label: "更表" },
  { href: "/quotas", label: "配額" },
  { href: "/my-receivable", label: "本月應收" },
  { href: "/guards", label: "保安員" },
  { href: "/rate-cards", label: "價目" },
];

describe("groupNavLinks（WP-R1 左欄分組，純顯示層）", () => {
  it("老闆（全部 module 都 grant）：5 組——首頁（冇標題）／排更／主檔／財務／系統", () => {
    const groups = groupNavLinks("老闆", FULL_INTERNAL_LINKS);
    expect(groups.map((g) => g.title)).toEqual(["", "排更", "主檔", "財務", "系統"]);

    expect(groups[0].links.map((l) => l.label)).toEqual(["首頁"]);
    expect(groups[1].links.map((l) => l.label)).toEqual(["更表", "配額", "審批隊列"]);
    expect(groups[2].links.map((l) => l.label)).toEqual(["盤", "保安員", "雞頭", "價目"]);
    expect(groups[3].links.map((l) => l.label)).toEqual(["毛利即時表", "月結工作台", "糧明細", "尚欠總覽"]);
    expect(groups[4].links.map((l) => l.label)).toEqual(["用戶管理", "角色權限管理", "操作紀錄"]);
  });

  it("雞頭：只有 2 組——排更（首頁／更表／配額）／我的（本月應收／保安員／價目）", () => {
    const groups = groupNavLinks("雞頭", BROKER_LINKS);
    expect(groups.map((g) => g.title)).toEqual(["排更", "我的"]);
    expect(groups[0].links.map((l) => l.label)).toEqual(["首頁", "更表", "配額"]);
    expect(groups[1].links.map((l) => l.label)).toEqual(["本月應收", "保安員", "價目"]);
  });

  it("冇連結嘅組唔顯示（例：主管冇「用戶管理」view，「系統」組整組消失）", () => {
    const linksWithoutSystem = FULL_INTERNAL_LINKS.filter((l) => !["/users", "/roles", "/audit-log"].includes(l.href));
    const groups = groupNavLinks("主管", linksWithoutSystem);
    expect(groups.map((g) => g.title)).toEqual(["", "排更", "主檔", "財務"]);
  });

  it("雞頭冇任何連結時（極端情況）：回空陣列，唔會出現得個標題冇項目嘅組", () => {
    const groups = groupNavLinks("雞頭", []);
    expect(groups).toEqual([]);
  });

  it("同一 module（出街價）喺內部角色連去 /rate-cards 擺「主檔」，雞頭連去 /my-receivable 擺「我的」——冇撞組", () => {
    const bossGroups = groupNavLinks("老闆", FULL_INTERNAL_LINKS);
    const mainGroup = bossGroups.find((g) => g.title === "主檔");
    expect(mainGroup?.links.some((l) => l.href === "/rate-cards")).toBe(true);

    const brokerGroups = groupNavLinks("雞頭", BROKER_LINKS);
    const mineGroup = brokerGroups.find((g) => g.title === "我的");
    expect(mineGroup?.links.some((l) => l.href === "/my-receivable")).toBe(true);
    expect(mineGroup?.links.some((l) => l.href === "/rate-cards")).toBe(true);
  });

  // R1 驗收修正：分組表（INTERNAL_GROUP_ORDER/BROKER_GROUP_ORDER）同
  // `getNavLinks()` 係兩份獨立維護嘅清單，之前如果分組表漏列一個
  // href，個連結會靜靜哋喺導航消失，冇任何測試會爆。加返呢條：真係用
  // `getNavLinks()`（老闆、全部 module 都 grant）計出嚟嘅連結，逐條
  // 核對喺 `groupNavLinks()` 嘅結果度都揾到，確保兩份清單冚得住。
  it("getNavLinks 老闆全部 href 都出現喺分組結果（分組表冚晒 getNavLinks 出嘅連結，唔會靜靜消失）", async () => {
    const allGrants = Object.fromEntries(MODULES.map((m) => [m, true])) as Record<Module, boolean>;
    const fakeSession = {
      userId: "u1",
      tel: "90000001",
      name: "老闆",
      roleId: "r1",
      roleName: "老闆",
      baseRole: "老闆",
      brokerId: null,
      guardId: null,
      payoutApprovalLimit: null,
      tokenVersion: 0,
      loggedInAt: new Date().toISOString(),
      mustChangePwd: false,
    } as unknown as CurrentSession;

    const links = await getNavLinks(fakeSession, allGrants);
    const groups = groupNavLinks("老闆", links);
    const groupedHrefs = new Set(groups.flatMap((g) => g.links.map((l) => l.href)));

    expect(links.length).toBeGreaterThan(0);
    for (const l of links) {
      expect(groupedHrefs.has(l.href)).toBe(true);
    }
  });

  it("分組表冇列出嘅 href（未知連結）落尾組「其他」，唔會靜靜消失", () => {
    const linksWithUnknown: NavLink[] = [...FULL_INTERNAL_LINKS, { href: "/some-new-page", label: "新頁面" }];
    const groups = groupNavLinks("老闆", linksWithUnknown);
    const last = groups[groups.length - 1];
    expect(last.title).toBe("其他");
    expect(last.links.map((l) => l.href)).toEqual(["/some-new-page"]);
  });
});

// A10（Opus 整合驗收）：`getViewGrants()` 之前唔理 baseRole 一律打
// `GET /api/roles/:id/permissions`，但呢個 endpoint 要求「用戶管理:
// view」——主管/會計/雞頭/安員呢 4 個 base_role 喺 matrix.ts 硬性 deny
// 咗成個「用戶管理」module，即係呢個 fetch 對呢 4 個角色**一定** 403，
// 每次都經 `requirePermission()` 寫一行 `permission_denied` audit——
// 一個頁面（layout+page 各打一次）就兩行，操作紀錄俾呢啲必敗嘅內部
// fetch 洗版。而家淨係老闆先真係打呢個 fetch，其餘 4 個角色直接用出廠
// 矩陣 fallback，連 `cookies()`/`headers()`（next/headers，冇 request
// context 會例外）都唔會掂到。
describe("getViewGrants（A10：非老闆角色唔再打必定 403 嘅 /api/roles/:id/permissions）", () => {
  function fakeSession(baseRole: RoleName, roleId: string): CurrentSession {
    return {
      userId: "u-fake",
      tel: "90000000",
      name: "假用戶",
      roleId,
      roleName: baseRole,
      baseRole,
      brokerId: null,
      guardId: null,
      payoutApprovalLimit: null,
      tokenVersion: 0,
      loggedInAt: new Date().toISOString(),
      mustChangePwd: false,
    } as unknown as CurrentSession;
  }

  it.each(ROLE_NAMES.filter((r) => r !== "老闆"))(
    "%s：唔會拋錯（證明冇喺 next/headers 冇 request context 之下都試過打 fetch），結果等於出廠矩陣 fallback",
    async (roleName) => {
      const role = await prisma.role.findFirstOrThrow({ where: { name: roleName } });
      const grants = await getViewGrants(fakeSession(roleName, role.id));
      const expected = Object.fromEntries(MODULES.map((m) => [m, isGrantedByDefault(roleName, m, "view")])) as Record<Module, boolean>;
      expect(grants).toEqual(expected);
    },
  );

  it("雞頭：呼叫 getViewGrants() 之後 audit_log 冇新增 permission_denied 行（fetch 完全冇打出，`requirePermission()` 唔會被觸發）", async () => {
    await clearAll();
    const role = await prisma.role.findFirstOrThrow({ where: { name: "雞頭" } });
    const before = await prisma.auditLog.count({ where: { action: "permission_denied" } });
    await getViewGrants(fakeSession("雞頭", role.id));
    await getViewGrants(fakeSession("雞頭", role.id));
    await getViewGrants(fakeSession("雞頭", role.id));
    const after = await prisma.auditLog.count({ where: { action: "permission_denied" } });
    expect(after).toBe(before);
  });
});
