// WP-R1 驗收修正：桌面左欄（`DesktopNav.tsx`）同手機抽屜
// （`MobileNav.tsx`）本來各自複製一份 active 判斷邏輯，容易兩邊飄
// 開（例如更表索引 `/roster` 同編輯器 `/roster/[site]/[month]` 呢種
// 特例，之前得 DesktopNav 有做，MobileNav 冇跟）。抽出嚟做單一
// source of truth，兩個 component 都 import 呢個。
export function isLinkActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  if (pathname === href) return true;
  // 更表索引與編輯器共用「更表」active（README「Interactions」）。
  if (href === "/roster") return pathname.startsWith("/roster");
  return pathname.startsWith(`${href}/`);
}

// A3（Opus 整合驗收）：`/guards`（保安員）／`/rate-cards`（價目）呢兩條
// 連結，雞頭 session 睇嘅係「我的」組，內部角色睇嘅係「主檔」組（見
// `src/lib/rbac/nav.ts` 嘅 `BROKER_GROUP_ORDER`/`INTERNAL_GROUP_ORDER`）
// ——但呢兩頁本身係 client component（"use client"），冇辦法直接 import
// `nav.ts`（嗰檔用 `next/headers`，係 server-only API，client component
// 入面 import 會喺 build 爆）。呢個 helper 特登喺呢個 client-safe 檔度
// 抄一份靜態對照（純 href → kicker 字面值，唔係邏輯），等頁首 kicker
// 跟返導航分組一致；`nav.ts` 分組表改嘅話，呢度要跟手改（兩邊都有
// 註解互相指返對方）。
const INTERNAL_KICKER_BY_HREF: Record<string, string> = {
  "/roster": "排更",
  "/quotas": "排更",
  "/approvals": "排更",
  "/sites": "主檔",
  "/guards": "主檔",
  "/brokers": "主檔",
  "/rate-cards": "主檔",
  "/reports/gross-margin": "財務",
  "/reports/monthly-close": "財務",
  "/reports/payroll": "財務",
  "/reports/shortfall": "財務",
  "/users": "系統",
  "/roles": "系統",
  "/audit-log": "系統",
};
const BROKER_KICKER_BY_HREF: Record<string, string> = {
  "/": "排更",
  "/roster": "排更",
  "/quotas": "排更",
  "/my-receivable": "我的",
  "/guards": "我的",
  "/rate-cards": "我的",
};

/** 跟 `nav.ts` 嘅導航分組畀返呢條 href 嘅 kicker 字面值——`isBroker` 揀
 * 用邊份對照表。搵唔到就回空字串（同 `PageHeader` 其他頁面冇 kicker
 * 嘅寫法一致，唔會顯示奇怪字樣）。 */
export function kickerFor(href: string, isBroker: boolean): string {
  return (isBroker ? BROKER_KICKER_BY_HREF : INTERNAL_KICKER_BY_HREF)[href] ?? "";
}
