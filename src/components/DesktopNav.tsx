"use client";
// WP-R1：桌面左欄（README「桌面外殼 · 左欄」）——216px 固定、分組導航、
// active 樣式跟 `usePathname()`（更表索引 `/roster` 同編輯器
// `/roster/[site]/[month]` 共用「更表」active，見 `isLinkActive()`，
// 抽咗去 `@/lib/ui/nav-active.ts` 同 `MobileNav.tsx` 共用）、底部用戶
// 區。呢個要係 client component 先攞到 `usePathname()`；連結分組／
// badge 數字由 `(app)/layout.tsx`（server component）fetch 好傳落嚟。
//
// R1 驗收修正：斷點由 `md`（768）改 `lg`（1024）——README「桌面外殼
// （≥ 1024px）」／「手機外殼（375px）」中間嗰段（768–1023px）設計上
// 都算「手機外殼」（漢堡＋抽屜），呢個 `<aside>` 淨係喺 `≥ lg` 先顯示。
import { usePathname, useSearchParams } from "next/navigation";
import type { NavGroup } from "@/lib/rbac/nav";
import { LogoutButton } from "@/components/LogoutButton";
import { isLinkActive } from "@/lib/ui/nav-active";
// P2 整合驗收①：全部連結改用 `GuardedLink`（唔係原生 `next/link`）——更表
// 編輯器有未儲存改動時撳呢度任何連結，會經 `unsaved-guard` store 問一句
// 先跳（見 `@/components/ui/GuardedLink`）。
import { GuardedLink } from "@/components/ui/GuardedLink";

function initials(name: string): string {
  return name.trim().slice(0, 2);
}

export function DesktopNav({
  groups,
  userName,
  roleLabel,
  badges,
}: {
  groups: NavGroup[];
  userName: string;
  roleLabel: string;
  badges: Record<string, number>;
}) {
  const pathname = usePathname();
  const search = useSearchParams();

  return (
    <aside className="sticky top-0 hidden h-screen w-[216px] shrink-0 flex-col border-r border-zk-border bg-white px-3 py-3 lg:flex">
      <div className="mb-2.5 flex items-center gap-2 px-1.5">
        <div className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-[7px] bg-zk-primary text-zk-base font-bold text-white">在</div>
        <div className="text-zk-md font-bold text-zk-text">在勤</div>
      </div>

      <nav className="flex flex-1 flex-col overflow-y-auto">
        {groups.map((g) => (
          <div key={g.title || "_top"} className="mb-1.5">
            {g.title && <div className="px-2 pb-0.5 text-zk-2xs font-semibold leading-[14px] tracking-[.06em] text-zk-faint">{g.title}</div>}
            <div className="flex flex-col">
              {g.links.map((l) => {
                const active = isLinkActive(pathname, l.href, search);
                const badge = badges[l.href];
                return (
                  <GuardedLink
                    key={l.href}
                    href={l.href}
                    data-testid={`nav-${l.href.split("&month=")[0]}`}
                    className={`flex items-center justify-between rounded-md px-2 py-[3px] text-zk-base leading-[19px] ${
                      active ? "bg-zk-primary-tint-soft font-semibold text-zk-primary-dark" : "font-normal text-zk-text-secondary hover:bg-zk-surface"
                    }`}
                  >
                    {l.label}
                    {!!badge && (
                      <span className="rounded-[9px] bg-zk-danger-tint px-1.5 py-px text-zk-2xs font-semibold text-zk-danger-dark">{badge}</span>
                    )}
                  </GuardedLink>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      <div className="mt-auto flex items-center gap-2.5 border-t border-zk-border pt-2.5 pl-1.5">
        <div className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-full bg-[#e0e7ff] text-xs font-semibold text-[#3730a3]">
          {initials(userName)}
        </div>
        <div className="min-w-0">
          <div className="truncate text-zk-sm font-semibold text-zk-text">{userName}</div>
          <div className="flex items-center gap-1.5 text-zk-xs text-zk-muted">
            <span>{roleLabel}</span>
            <span>·</span>
            <GuardedLink href="/change-password" className="text-zk-primary">
              改密碼
            </GuardedLink>
            <span>·</span>
            <span title="登出會同時登出所有裝置"><LogoutButton className="p-0 text-zk-xs font-normal text-zk-muted underline-offset-2 hover:text-zk-text-secondary hover:underline" /></span>
          </div>
        </div>
      </div>
    </aside>
  );
}
