// P1-WP3：認證殼左欄導航——邊條連結顯示取決於呢個角色嘅「view」權限。
//
// 折衷做法（見 P1-WP3 任務指示）：
//   1. 先用 DEFAULT_MATRIX（出廠預設）做 fallback。
//   2. 再試打一次 `GET /api/roles/:id/permissions`，用返呢個角色實際
//      （可能俾老闆喺角色權限頁改過）嘅 95 格矩陣覆蓋 view 呢個 action。
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

async function getViewGrants(session: CurrentSession): Promise<Record<Module, boolean>> {
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

export async function getNavLinks(session: CurrentSession): Promise<NavLink[]> {
  const grants = await getViewGrants(session);
  const links: NavLink[] = [];
  const push = (href: string, label: string, mod: Module) => {
    if (grants[mod]) links.push({ href, label });
  };

  push("/roster", "更表", "更表");
  push("/quotas", "配額", "配額");
  push("/approvals", "審批隊列", "審批");
  push("/sites", "盤", "盤");
  // 雞頭端睇自己安員用「自己安員」module；內部角色用「安員」——兩者
  // 都連去同一個 /guards 路徑，API 自己會 scope（見 src/app/api/guards）。
  push("/guards", "安員", session.baseRole === "雞頭" ? "自己安員" : "安員");
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
