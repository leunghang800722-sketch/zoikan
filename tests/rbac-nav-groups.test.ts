// P3-3.1：導覽列單一真相 NAV_SCHEMA（`src/lib/nav/schema.ts`）——連結清單、分組、
// 頁首 kicker 全部由 schema 派生。純函數／出廠矩陣 unit test，唔使起 DB／session
// （`getViewGrants` 嗰段除外）。
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { getNavLinks, getViewGrants, groupNavLinks, type NavLink } from "@/lib/rbac/nav";
import { BROKER_NAV, INTERNAL_NAV, OFF_NAV_PATHS, kickerFor } from "@/lib/nav/schema";
import { isLinkActive } from "@/lib/ui/nav-active";
import { MODULES, ROLE_NAMES, isGrantedByDefault, type Module, type RoleName } from "@/lib/rbac/matrix";
import type { CurrentSession } from "@/lib/auth/current-session";
import { clearAll, prisma } from "./lib/db";

function mk(baseRole: string): CurrentSession {
  return { userId: "u", roleId: "r", roleName: baseRole, baseRole, brokerId: null, guardId: null, payoutApprovalLimit: null, tokenVersion: 0, loggedInAt: new Date().toISOString(), mustChangePwd: false } as unknown as CurrentSession;
}
function factoryGrants(role: RoleName): Record<Module, boolean> {
  return Object.fromEntries(MODULES.map((m) => [m, isGrantedByDefault(role, m, "view")])) as Record<Module, boolean>;
}
const allGrants = Object.fromEntries(MODULES.map((m) => [m, true])) as Record<Module, boolean>;
async function navFor(role: RoleName) {
  const links = await getNavLinks(mk(role), factoryGrants(role));
  return { links, groups: groupNavLinks(role, links) };
}
// 修復連結動態帶上個月（`&month=YYYY-MM`），簽名比較時去走。
const sig = (groups: ReturnType<typeof groupNavLinks>) => groups.map((g) => `${g.title}:${g.links.map((l) => l.href.replace(/&month=\d{4}-\d{2}$/, "")).join(",")}`);

describe("NAV_SCHEMA 導覽（P3-3.1，出廠矩陣逐個角色）", () => {
  it("老闆：19 條、6 組（首頁／排更／對數／月結／資料／設定），次序同組內次序固定", async () => {
    const { links, groups } = await navFor("老闆");
    expect(links).toHaveLength(19);
    expect(groups.map((g) => g.title)).toEqual(["", "排更", "對數", "月結", "資料", "設定"]);
    expect(sig(groups)).toEqual([
      ":/",
      "排更:/roster,/quotas,/approvals,/whatsapp",
      "對數:/roster-uploads,/roster-uploads?tab=fix",
      "月結:/month-close,/triage,/reports/monthly-close",
      "資料:/sites,/guards,/brokers,/rate-cards",
      "設定:/users,/roles,/audit-log,/feedback,/settings/jobs",
    ]);
    expect(groups[3]!.links.map((l) => l.label)).toEqual(["一鍵結算", "待答問題", "報表"]);
  });

  it("老闆：修復連結帶上個月（香港時區）", async () => {
    const { links } = await navFor("老闆");
    expect(links.find((l) => l.label === "未配對保安員修復")!.href).toMatch(/^\/roster-uploads\?tab=fix&month=\d{4}-\d{2}$/);
  });

  it("主管：12 條（按出廠權限減——冇修復、報表、設定組）", async () => {
    const { links, groups } = await navFor("主管");
    expect(links).toHaveLength(12);
    expect(sig(groups)).toEqual([":/", "排更:/roster,/quotas,/approvals,/whatsapp", "對數:/roster-uploads", "月結:/month-close,/triage", "資料:/sites,/guards,/brokers,/rate-cards"]);
  });

  it("會計：12 條（有報表，冇審批、修復、設定組）", async () => {
    const { links, groups } = await navFor("會計");
    expect(links).toHaveLength(12);
    expect(sig(groups)).toEqual([":/", "排更:/roster,/quotas,/whatsapp", "對數:/roster-uploads", "月結:/month-close,/triage,/reports/monthly-close", "資料:/sites,/guards,/brokers,/rate-cards"]);
  });

  it("雞頭：6 條、3 組（首頁／排更／我的）；唔出 /brokers", async () => {
    const { links, groups } = await navFor("雞頭");
    expect(links).toHaveLength(6);
    expect(sig(groups)).toEqual([":/", "排更:/roster,/quotas", "我的:/my-receivable,/guards,/rate-cards"]);
    expect(links.map((l) => l.href)).not.toContain("/brokers");
    expect(links.find((l) => l.href === "/guards")!.label).toBe("我的保安員");
    // 即使「雞頭:view」被開，雞頭導覽都唔出 /brokers
    const opened = await getNavLinks(mk("雞頭"), { ...factoryGrants("雞頭"), 雞頭: true });
    expect(opened.map((l) => l.href)).not.toContain("/brokers");
  });

  it("保安員（安員）：只有首頁 1 條，即使 grants 全開", async () => {
    const { links } = await navFor("安員");
    expect(links.map((l) => l.href)).toEqual(["/"]);
    expect((await getNavLinks(mk("安員"), allGrants)).map((l) => l.href)).toEqual(["/"]);
  });

  it("「其他」組永遠唔出現（5 個角色，連同全 grant 嘅老闆）", async () => {
    for (const role of ROLE_NAMES) {
      const { groups } = await navFor(role);
      expect(groups.map((g) => g.title)).not.toContain("其他");
    }
    expect(groupNavLinks("老闆", await getNavLinks(mk("老闆"), allGrants)).map((g) => g.title)).not.toContain("其他");
  });

  it("schema 以外嘅 link 落尾組「其他」（登記漏咗一眼睇到）", () => {
    const links: NavLink[] = [{ href: "/", label: "首頁", group: "" }, { href: "/x", label: "新頁面", group: "未登記" }];
    const groups = groupNavLinks("老闆", links);
    expect(groups[groups.length - 1]).toEqual({ title: "其他", links: [{ href: "/x", label: "新頁面", group: "未登記" }] });
  });

  it("報表連結：冇「月結總表」但有「毛利即時表」→ 連去毛利頁；全部冇 → 不出", async () => {
    const base = { ...factoryGrants("老闆"), 月結總表: false, 毛利即時表: true, 糧明細: false, 長工糧: false };
    expect((await getNavLinks(mk("老闆"), base)).find((l) => l.label === "報表")!.href).toBe("/reports/gross-margin");
    const none = { ...base, 毛利即時表: false };
    expect((await getNavLinks(mk("老闆"), none)).some((l) => l.label === "報表")).toBe(false);
  });

  it("現場意見：只限老闆（會計即使有「助手」都唔出）", async () => {
    expect((await getNavLinks(mk("會計"), allGrants)).map((l) => l.href)).not.toContain("/feedback");
    expect((await getNavLinks(mk("老闆"), allGrants)).map((l) => l.href)).toContain("/feedback");
  });

  it("導覽拎走嘅路徑唔喺任何 schema（尚欠總覽、guard-fix、導入、4 份報表）", () => {
    const hrefs = new Set([...INTERNAL_NAV, ...BROKER_NAV].map((e) => e.href));
    for (const h of ["/reports/shortfall", "/guard-fix", "/guards/import", "/guards/new-from-docs", "/reports/gross-margin", "/reports/payroll", "/reports/longterm-payroll", "/reports/ops-digest"]) expect(hrefs.has(h)).toBe(false);
    expect(OFF_NAV_PATHS).toContain("/guard-fix");
  });

  it("schema 每條 href 都對應現有 page（href 掃描覆蓋 schema）", () => {
    const appDir = path.resolve(__dirname, "../src/app/(app)");
    for (const e of [...INTERNAL_NAV, ...BROKER_NAV]) {
      const p = e.href.split("?")[0]!;
      const file = p === "/" ? path.join(appDir, "page.tsx") : path.join(appDir, p.slice(1), "page.tsx");
      expect(fs.existsSync(file), e.href).toBe(true);
    }
    // hrefByModule 嘅替代連結同樣要存在
    for (const e of INTERNAL_NAV) for (const h of Object.values(e.hrefByModule ?? {})) expect(fs.existsSync(path.join(appDir, h!.slice(1), "page.tsx")), h).toBe(true);
  });

  it("kicker 由 schema 派生：導覽組名；報表五頁「月結 › 報表」；導入頁「資料」；雞頭版「我的」", () => {
    expect(kickerFor("/roster")).toBe("排更");
    expect(kickerFor("/roster-uploads?tab=fix")).toBe("對數");
    expect(kickerFor("/triage")).toBe("月結");
    expect(kickerFor("/reports/monthly-close")).toBe("月結 › 報表");
    expect(kickerFor("/reports/ops-digest")).toBe("月結 › 報表");
    expect(kickerFor("/guards/import")).toBe("資料");
    expect(kickerFor("/guards", false)).toBe("資料");
    expect(kickerFor("/guards", true)).toBe("我的");
    expect(kickerFor("/rate-cards", true)).toBe("我的");
    expect(kickerFor("/roles")).toBe("設定");
    expect(kickerFor("/settings/jobs")).toBe("設定");
    expect(kickerFor("/notifications")).toBe("帳號");
    expect(kickerFor("/nope")).toBe("");
  });

  it("isLinkActive：帶 query 嘅連結、更表上載 vs 修復、更表 vs 更表上載、報表族群", () => {
    const q = (s: string) => new URLSearchParams(s);
    expect(isLinkActive("/roster-uploads", "/roster-uploads?tab=fix", q("tab=fix"))).toBe(true);
    expect(isLinkActive("/roster-uploads", "/roster-uploads?tab=fix", q(""))).toBe(false);
    expect(isLinkActive("/roster-uploads", "/roster-uploads", q("tab=fix"))).toBe(false);
    expect(isLinkActive("/roster-uploads", "/roster-uploads", q("month=2026-09"))).toBe(true);
    expect(isLinkActive("/roster-uploads/abc/reconcile", "/roster-uploads", q(""))).toBe(true);
    expect(isLinkActive("/roster-uploads", "/roster", q(""))).toBe(false);
    expect(isLinkActive("/roster/s1/2026-09", "/roster", q(""))).toBe(true);
    expect(isLinkActive("/reports/payroll", "/reports/monthly-close", q(""))).toBe(true);
    expect(isLinkActive("/reports/shortfall", "/reports/monthly-close", q(""))).toBe(false);
    expect(isLinkActive("/guards/import", "/guards", q(""))).toBe(true);
    expect(isLinkActive("/", "/", q(""))).toBe(true);
    expect(isLinkActive("/guards", "/", q(""))).toBe(false);
  });
});

// A10（Opus 整合驗收）：`getViewGrants()` 之前唔理 baseRole 一律打
// `GET /api/roles/:id/permissions`，但呢個 endpoint 要求「用戶管理:
// view」——主管/會計/雞頭/保安員呢 4 個 base_role 喺 matrix.ts 硬性 deny
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
