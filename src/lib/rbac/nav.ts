// P1-WP3：認證殼左欄導航——邊條連結顯示取決於呢個角色嘅「view」權限。
//
// 折衷做法（見 P1-WP3 任務指示）：
//   1. 先用 DEFAULT_MATRIX（出廠預設）做 fallback。
//   2. 再試打一次 `GET /api/roles/:id/permissions`，用返呢個角色實際
//      （可能俾老闆喺角色權限頁改過）嘅 105 格矩陣覆蓋 view 呢個 action。
//
// 已知限制：`/api/roles/:id/permissions` 本身要求呼叫者有「用戶管理:view」
// ——喺 matrix.ts 呢個 module 對主管/會計/雞頭/安員 4 個 base_role 全部
// 硬性 deny（uniformRow(D)），亦即淨係老闆先可以成功打呢個 endpoint（連
// 老闆自己都好，因為五個出廠角色冇一個可以「開放」呢粒硬性 deny 格）。
// 所以對呢 4 個 base_role 嚟講，呢個 fetch 一定 403，會靜靜哋 fallback
// 返出廠預設矩陣——即係話「老闆事後幫呢個角色開咗一格出廠係○嘅權限
// （例如幫會計開審批:view）」呢種客製化，喺呢 4 個角色自己登入嗰陣，
// 導航列暫時反映唔到（要老闆用角色權限管理頁對照確認）。呢個係現有
// API 權限模型嘅結構性限制，唔係呢頁漏做。
import { cookies, headers } from "next/headers";
import { MODULES, isGrantedByDefault, type Module } from "./matrix";
import type { CurrentSession } from "../auth/current-session";

interface PermissionCell {
  module: string;
  action: string;
  granted: boolean;
  hard_denied: boolean;
}

/** WP-AI2：側欄 AI 助手嘅入口 tab 同呢個左欄導航列一樣，用「呢個角色
 * 有冇 `助手:view`」決定顯示（唔顯示 = DOM 零元素，唔係淨係 CSS
 * 隱藏）——輸出返成個 grants 表等 `(app)/layout.tsx` 可以一次 fetch
 * 拎晒（唔使為咗助手 tab 再打多一次 `/api/roles/:id/permissions`）。 */
export async function getViewGrants(session: CurrentSession): Promise<Record<Module, boolean>> {
  const fallback = Object.fromEntries(MODULES.map((m) => [m, isGrantedByDefault(session.baseRole, m, "view")])) as Record<Module, boolean>;

  try {
    const [cookieStore, headerStore] = await Promise.all([cookies(), headers()]);
    const host = headerStore.get("host");
    if (!host) return fallback;
    const proto = headerStore.get("x-forwarded-proto") ?? (host.startsWith("localhost") || host.startsWith("127.0.0.1") ? "http" : "https");
    const cookieHeader = cookieStore
      .getAll()
      .map((c) => `${c.name}=${c.value}`)
      .join("; ");

    const res = await fetch(`${proto}://${host}/api/roles/${session.roleId}/permissions`, {
      headers: { cookie: cookieHeader },
      cache: "no-store",
    });
    if (!res.ok) return fallback;
    const data = (await res.json()) as { cells: PermissionCell[] };
    const real: Partial<Record<Module, boolean>> = {};
    for (const cell of data.cells) {
      if (cell.action === "view") real[cell.module as Module] = cell.granted && !cell.hard_denied;
    }
    return Object.fromEntries(MODULES.map((m) => [m, real[m] ?? fallback[m]])) as Record<Module, boolean>;
  } catch {
    return fallback;
  }
}

export interface NavLink {
  href: string;
  label: string;
}

export async function getNavLinks(session: CurrentSession, prefetchedGrants?: Record<Module, boolean>): Promise<NavLink[]> {
  const grants = prefetchedGrants ?? (await getViewGrants(session));
  const links: NavLink[] = [];
  const push = (href: string, label: string, mod: Module) => {
    if (grants[mod]) links.push({ href, label });
  };

  // WP-R1：「首頁」（dashboard，內部角色＝尚欠總覽式歡迎頁、雞頭＝自己
  // 嘅 4 KPI 首頁）唔對應任何 module 權限格——凡已登入嘅用戶都見得到，
  // 一律加返（唔經 push()，唔使揀 module）。
  links.push({ href: "/", label: "首頁" });

  push("/roster", "更表", "更表");
  push("/quotas", "配額", "配額");
  push("/approvals", "審批隊列", "審批");
  push("/sites", "盤", "盤");
  // 雞頭端睇自己安員用「自己安員」module；內部角色用「安員」——兩者
  // 都連去同一個 /guards 路徑，API 自己會 scope（見 src/app/api/guards）。
  push("/guards", "保安員", session.baseRole === "雞頭" ? "自己安員" : "安員");
  push("/brokers", "雞頭", "雞頭");
  push("/rate-cards", "價目", "出街價");
  // P1-WP4：報表 module——每份報表獨立一行權限（設計文件§5.0）。雞頭端
  // 「本月應收」都經「出街價」呢個雞頭出廠已有嘅 module（§6.2），連去
  // 獨立路徑 /my-receivable，唔會撞 /rate-cards（內部角色嘅價目管理）。
  if (session.baseRole === "雞頭") {
    push("/my-receivable", "本月應收", "出街價");
  } else {
    push("/reports/gross-margin", "毛利即時表", "毛利即時表");
    push("/reports/monthly-close", "月結工作台", "月結總表");
    push("/reports/payroll", "糧明細", "糧明細");
  }
  push("/reports/shortfall", "尚欠總覽", "尚欠總覽");
  push("/users", "用戶管理", "用戶管理");
  push("/roles", "角色權限管理", "用戶管理");
  push("/audit-log", "操作紀錄", "操作紀錄");

  return links;
}

// ---------------------------------------------------------------------------
// WP-R1：左欄／手機抽屜嘅分組顯示——設計稿（README「桌面外殼」）將
// `getNavLinks()` 已經算好嘅連結按主題分堆（排更／主檔／財務／系統，
// 雞頭端排更／我的），純粹顯示層，唔改 `getNavLinks()` 嗰套權限邏輯：
// 一個角色見唔見到某條連結，仍然全部由上面 push() 嗰句決定；呢度淨係
// 決定「見到嘅連結擺去邊組」，冇連結嘅組唔顯示（見 groupNavLinks()
// 尾嗰個 filter）。用 href 對照（唔用 module）——因為同一個 module
// 喺唔同角色會連去唔同 href（例如「出街價」module 內部角色係
// /rate-cards 擺喺「主檔」，雞頭係 /my-receivable 擺喺「我的」）。
export interface NavGroup {
  /** 空字串＝冇組標題（例：頂部「首頁」）。 */
  title: string;
  links: NavLink[];
}

const INTERNAL_GROUP_ORDER: { title: string; hrefs: string[] }[] = [
  { title: "", hrefs: ["/"] },
  { title: "排更", hrefs: ["/roster", "/quotas", "/approvals"] },
  { title: "主檔", hrefs: ["/sites", "/guards", "/brokers", "/rate-cards"] },
  { title: "財務", hrefs: ["/reports/gross-margin", "/reports/monthly-close", "/reports/payroll", "/reports/shortfall"] },
  { title: "系統", hrefs: ["/users", "/roles", "/audit-log"] },
];

const BROKER_GROUP_ORDER: { title: string; hrefs: string[] }[] = [
  { title: "排更", hrefs: ["/", "/roster", "/quotas"] },
  { title: "我的", hrefs: ["/my-receivable", "/guards", "/rate-cards"] },
];

/** 純函數（冇 DB／網絡）——`baseRole` 淨係用嚟揀「雞頭 vs 內部角色」
 * 呢個分組版面，唔重新判斷權限（`links` 入面已經係 `getNavLinks()`
 * 篩選完嘅結果）。方便 unit test（唔使起 DB／mock session）。 */
export function groupNavLinks(baseRole: string, links: NavLink[]): NavGroup[] {
  const order = baseRole === "雞頭" ? BROKER_GROUP_ORDER : INTERNAL_GROUP_ORDER;
  const byHref = new Map(links.map((l) => [l.href, l]));
  const groups: NavGroup[] = [];
  for (const g of order) {
    const groupLinks = g.hrefs.map((h) => byHref.get(h)).filter((l): l is NavLink => l !== undefined);
    if (groupLinks.length > 0) groups.push({ title: g.title, links: groupLinks });
  }
  return groups;
}
