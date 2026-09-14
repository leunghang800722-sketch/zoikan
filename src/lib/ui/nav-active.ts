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
