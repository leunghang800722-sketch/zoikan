"use client";
// 老闆手機版 bug（2026-09-13）：`< lg`（1024px）時左欄固定 `<aside>` 收埋做
// 漢堡抽屜——頂部一條 header（漢堡掣＋「在勤」＋用戶頭像），撳漢堡由左
// 滑出抽屜（含分組導航、改密碼、登出），撳連結／遮罩／Esc 關。
//
// WP-R1：外觀跟 README「手機外殼」重做——頂欄白底 border-bottom、漢堡
// 3 條 20×2px 深色線；抽屜 280px、遮罩 `rgba(15,23,42,.45)`、shadow、
// 頂部頭像＋名＋角色、同桌面一樣分組導航、底部改密碼／登出。行為（開
// 關／Esc／撳連結自動關）同 testid 全部保留。
//
// R1 驗收修正：斷點由 `md`（768）改 `lg`（1024），同 `DesktopNav.tsx`
// 對齊（README「<1024 建議左欄收起變抽屜」）；每條 `<Link>`（含「改
// 密碼」）加返 `onClick={() => setOpen(false)}`——原本淨係靠
// `usePathname()` 變化嗰個 effect 關抽屜，撳「當前頁」（pathname 不變，
// 例如喺 `/roster` 撳抽屜入面嘅「更表」）就唔會觸發嗰個 effect，抽屜
// 會賴喺度唔收；顯式 onClick 就算 pathname 冇變都照關。active 判斷同
// `DesktopNav.isLinkActive()` 共用同一個 export（`@/lib/ui/nav-active`）。
//
// `(app)/layout.tsx` 仍然係 server component——分組連結／用戶名／角色
// 顯示文字／badge 數字呢啲數據由嗰邊 fetch 好再傳落嚟，呢個 component
// 淨係管抽屜開關嘅 client state。
import { useEffect, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { LogoutButton } from "@/components/LogoutButton";
import { isLinkActive } from "@/lib/ui/nav-active";
import type { NavGroup } from "@/lib/rbac/nav";
// P2 整合驗收①：連結全部改用 `GuardedLink`——更表有未儲存改動時撳抽屜
// 連結會經 `unsaved-guard` store 問一句先跳（`GuardedLink` 內部處理）。
import { GuardedLink } from "@/components/ui/GuardedLink";

// P2 整合驗收④：跟原型，更表編輯器（`/roster/<site>/<month>`）自己有專屬
// 手機頁首（見 `RosterEditor.tsx` compact 頁首），唔要呢個全站頂欄再疊一
// 層（雙層頁首、53px＋66px），所以呢個 route 底下 `< lg` 完全唔 render
// 呢個 component（連漢堡都冇）。淨係更表「索引」頁（`/roster`，冇
// site/month path segment）唔受影響，照常顯示全站頂欄。
const ROSTER_EDITOR_PATH = /^\/roster\/[^/]+\/[^/]+$/;

function initials(name: string): string {
  return name.trim().slice(0, 2);
}

export function MobileNav({
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
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const search = useSearchParams();

  // 撳連結跳轉之後（pathname 變咗）自動關抽屜。
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  // Esc 關閉。
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  if (ROSTER_EDITOR_PATH.test(pathname ?? "")) return null;

  return (
    <div className="lg:hidden">
      <header className="flex items-center gap-3 border-b border-zk-border bg-white px-4 pt-2.5 pb-3">
        <button
          type="button"
          data-testid="mobile-nav-hamburger"
          aria-label="開啟導航選單"
          onClick={() => setOpen(true)}
          className="flex shrink-0 flex-col gap-[4px] p-1"
        >
          <span className="h-0.5 w-5 bg-zk-text" />
          <span className="h-0.5 w-5 bg-zk-text" />
          <span className="h-0.5 w-5 bg-zk-text" />
        </button>
        <div className="min-w-0 flex-1 text-zk-md font-bold text-zk-text">在勤</div>
        <div className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-full bg-[#e0e7ff] text-xs font-semibold text-[#3730a3]">
          {initials(userName)}
        </div>
      </header>

      {open && (
        <>
          <div
            data-testid="mobile-nav-overlay"
            aria-hidden="true"
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-40 bg-[rgba(15,23,42,.45)]"
          />
          <div
            role="dialog"
            aria-label="導航選單"
            data-testid="mobile-nav-drawer"
            className="fixed inset-y-0 left-0 z-50 flex w-[280px] max-w-[80vw] flex-col overflow-y-auto bg-white px-3.5 pt-14 pb-5 shadow-[8px_0_30px_rgba(0,0,0,.2)]"
          >
            <div className="mb-[18px] flex items-center gap-2.5 px-1.5">
              <div className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-full bg-[#e0e7ff] text-xs font-semibold text-[#3730a3]">
                {initials(userName)}
              </div>
              <div>
                <div className="text-zk-base font-semibold text-zk-text">{userName}</div>
                <div className="text-zk-xs text-zk-muted">{roleLabel}</div>
              </div>
            </div>

            <nav className="flex flex-1 flex-col overflow-y-auto">
              {groups.map((g) => (
                <div key={g.title || "_top"} className="mb-3">
                  {g.title && <div className="px-2 pb-1.5 text-zk-2xs font-semibold tracking-[.06em] text-zk-faint">{g.title}</div>}
                  <div className="flex flex-col">
                    {g.links.map((l) => {
                      const active = isLinkActive(pathname, l.href, search);
                      const badge = badges[l.href];
                      return (
                        <GuardedLink
                          key={l.href}
                          href={l.href}
                          data-testid={`mnav-${l.href.split("&month=")[0]}`}
                          onClick={() => setOpen(false)}
                          className={`flex items-center justify-between rounded-md px-2 py-2.5 text-zk-md ${
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

            <div className="flex flex-col gap-0.5 border-t border-zk-border pt-3">
              <GuardedLink href="/change-password" onClick={() => setOpen(false)} className="rounded-md px-2 py-2.5 text-zk-md text-zk-primary">
                改密碼
              </GuardedLink>
              <LogoutButton className="rounded-md px-2 py-2.5 text-left text-zk-md text-zk-text-secondary" />
              <div className="px-2 text-zk-xs text-zk-faint">登出會同時登出所有裝置</div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
