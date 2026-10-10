// WP-R1 驗收修正：桌面左欄（`DesktopNav.tsx`）同手機抽屜（`MobileNav.tsx`）
// 共用嘅 active 判斷（單一 source of truth）。
// P3-3.1：連結 href 可帶 query（例：`/roster-uploads?tab=fix`），`search` 係當前
// URL 嘅 query；頁首 kicker 搬去 `@/lib/nav/schema` 派生，呢度只 re-export。
;

export function isLinkActive(pathname: string, href: string, search?: URLSearchParams | null): boolean {
  const [path, query] = href.split("?");
  const p = path ?? href;
  if (query) {
    // 帶 query 嘅連結：路徑相同且 query 全部吻合先 active。
    if (pathname !== p) return false;
    const want = new URLSearchParams(query);
    for (const [k, v] of want) if (k !== "month" && search?.get(k) !== v) return false; // month 係動態（導覽帶上個月），唔比較
    return true;
  }
  if (p === "/") return pathname === "/";
  // 更表上載：`?tab=fix` 嗰條有自己連結，唔雙重 active。
  if (p === "/roster-uploads") {
    if (pathname === "/roster-uploads") return search?.get("tab") !== "fix";
    return pathname.startsWith("/roster-uploads/");
  }
  if (pathname === p) return true;
  // 更表索引與編輯器共用「更表」active（README「Interactions」）；唔搶「更表上載」。
  if (p === "/roster") return pathname.startsWith("/roster/");
  // 「報表」：五份報表共用 active；尚欠總覽已搬去首頁（redirect）。
  if (p === "/reports/monthly-close" || p === "/reports/gross-margin" || p === "/reports/payroll" || p === "/reports/longterm-payroll") {
    return pathname.startsWith("/reports/") && pathname !== "/reports/shortfall";
  }
  return pathname.startsWith(`${p}/`);
}
