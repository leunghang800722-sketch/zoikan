// P1-WP3：認證殼左欄導航——邊條連結顯示取決於呢個角色嘅「view」權限。
//
// 折衷做法（見 P1-WP3 任務指示）：
//   1. 先用 DEFAULT_MATRIX（出廠預設）做 fallback。
//   2. 再試打一次 `GET /api/roles/:id/permissions`，用返呢個角色實際
//      （可能俾老闆喺角色權限頁改過）嘅 105 格矩陣覆蓋 view 呢個 action。
//
// 已知限制：`/api/roles/:id/permissions` 本身要求呼叫者有「用戶管理:view」
// ——喺 matrix.ts 呢個 module 對主管/會計/雞頭/保安員 4 個 base_role 全部
// 硬性 deny（uniformRow(D)），亦即淨係老闆先可以成功打呢個 endpoint（連
// 老闆自己都好，因為五個出廠角色冇一個可以「開放」呢粒硬性 deny 格）。
// 所以對呢 4 個 base_role 嚟講，呢個 fetch 一定 403，會靜靜哋 fallback
// 返出廠預設矩陣——即係話「老闆事後幫呢個角色開咗一格出廠係○嘅權限
// （例如幫會計開審批:view）」呢種客製化，喺呢 4 個角色自己登入嗰陣，
// 導航列暫時反映唔到（要老闆用角色權限管理頁對照確認）。呢個係現有
// API 權限模型嘅結構性限制，唔係呢頁漏做。
//
// P3-1.2（附錄 b A-5／B-11）：老闆分支唔再 loopback `fetch` 自己個
// `/api/roles/:id/permissions`，改直讀 DB（用 P3-1.1 嘅 per-request 權限
// Set，一條查詢），並用 react `cache()` 包住——同一個 render 內 layout＋
// page＋TriageHomeNotice 共用同一個結果。語意同 API 嗰個 cell 一樣：
// `granted && !hard_denied`。
import { cache } from "react";
import { MODULES, isGrantedByDefault, type Module } from "./matrix";
import type { CurrentSession } from "../auth/current-session";
import { groupOrderFor, schemaFor, type BadgeKey } from "../nav/schema";
import { loadPermissionSet, permissionSetHas, type AuthedSession } from "./requirePermission";

/** WP-AI2：側欄 AI 助手嘅入口 tab 同呢個左欄導航列一樣，用「呢個角色
 * 有冇 `助手:view`」決定顯示（唔顯示 = DOM 零元素，唔係淨係 CSS
 * 隱藏）——輸出返成個 grants 表等 `(app)/layout.tsx` 可以一次 fetch
 * 拎晒（唔使為咗助手 tab 再打多一次 `/api/roles/:id/permissions`）。 */
export const getViewGrants = cache(async function getViewGrants(session: CurrentSession): Promise<Record<Module, boolean>> {
  const fallback = Object.fromEntries(MODULES.map((m) => [m, isGrantedByDefault(session.baseRole, m, "view")])) as Record<Module, boolean>;

  // A10（Opus 整合驗收）：非老闆 4 個 base_role 一律用出廠矩陣 fallback
  // （「用戶管理:view」對佢哋硬性 deny，舊版 loopback 必 403 兼寫
  // permission_denied audit）。老闆先讀角色實際（可能被客製化過）權限。
  if (session.baseRole !== "老闆") return fallback;

  // P3-1.2：直讀 DB。失敗唔再靜靜 fallback（B-11）——寫 console.error 方便追查，
  // 然後先 fallback（導航寧可顯示出廠預設，都唔好令整頁 500）。
  try {
    const set = await loadPermissionSet(session as unknown as AuthedSession);
    return Object.fromEntries(MODULES.map((m) => [m, permissionSetHas(session as unknown as AuthedSession, set, m, "view")])) as Record<Module, boolean>;
  } catch (e) {
    console.error("[nav] getViewGrants 讀角色權限失敗，用出廠預設矩陣", e instanceof Error ? e.message : e);
    return fallback;
  }
});

export interface NavLink {
  href: string;
  label: string;
  /** 所屬組（由 NAV_SCHEMA 派生，見 `@/lib/nav/schema`）。 */
  group: string;
  badge?: BadgeKey;
}

/** P3-3.1：連結清單由 NAV_SCHEMA 派生；顯示與否仍然全部由 `grants[module]` 決定（權限邏輯不變）。
 * 保安員（base role「安員」）只有首頁。 */
export async function getNavLinks(session: CurrentSession, prefetchedGrants?: Record<Module, boolean>): Promise<NavLink[]> {
  const grants = prefetchedGrants ?? (await getViewGrants(session));
  const links: NavLink[] = [];
  for (const e of schemaFor(session.baseRole)) {
    if (session.baseRole === "安員" && e.href !== "/") continue;
    if (e.onlyBaseRole && session.baseRole !== e.onlyBaseRole) continue;
    let href = e.href;
    if (e.module !== "always") {
      const mods = Array.isArray(e.module) ? e.module : [e.module];
      const granted = mods.filter((m) => grants[m]);
      if (granted.length === 0) continue;
      // 多 module 連結：主 module（第一個）冇 grant 就改連去第一個有 grant 嘅替代 href。
      if (!grants[mods[0]!] && e.hrefByModule) {
        const alt = granted.map((m) => e.hrefByModule![m]).find((h) => !!h);
        if (alt) href = alt;
      }
    }
    links.push({ href, label: e.label, group: e.group, ...(e.badge ? { badge: e.badge } : {}) });
  }
  return links;
}

// 分組顯示（純顯示層）：按 NAV_SCHEMA 嘅組次序，冇連結嘅組唔顯示。
export interface NavGroup {
  /** 空字串＝冇組標題（例：頂部「首頁」）。 */
  title: string;
  links: NavLink[];
}

/** 純函數（冇 DB／網絡）。`links` 已經係 `getNavLinks()` 篩選完嘅結果；組名由每條 link 自帶（schema 派生）。
 * schema 之外嘅 link（理論上唔會出現）落尾組「其他」，等漏咗登記一眼睇到。 */
export function groupNavLinks(baseRole: string, links: NavLink[]): NavGroup[] {
  const order = groupOrderFor(baseRole);
  const groups: NavGroup[] = [];
  for (const title of order) {
    const groupLinks = links.filter((l) => l.group === title);
    if (groupLinks.length > 0) groups.push({ title, links: groupLinks });
  }
  const leftover = links.filter((l) => !order.includes(l.group));
  if (leftover.length > 0) groups.push({ title: "其他", links: leftover });
  return groups;
}
