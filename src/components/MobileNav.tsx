"use client";
// 老闆手機版 bug（2026-09-13）：`< md`（768px）時左欄固定 `<aside>` 收埋做
// 漢堡抽屜——頂部一條 header（漢堡掣＋「在勤」＋用戶名／角色），撳漢堡
// 由左滑出抽屜（含全部導航連結、改密碼、登出），撳連結／遮罩／Esc 關。
// `md` 以上呢個 component 淨係 render 一個 `md:hidden` 嘅空殼（drawer 都
// 喺入面但成個包住嘅 div display:none，唔會擋到桌面版固定 `<aside>`）。
//
// `(app)/layout.tsx` 仍然係 server component——links／用戶名／角色顯示文字
// 呢啲數據由嗰邊 fetch 好再傳落嚟，呢個 component 淨係管抽屜開關嘅 client
// state。
import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { LogoutButton } from "@/components/LogoutButton";
import type { NavLink } from "@/lib/rbac/nav";

export function MobileNav({ links, userName, roleLabel }: { links: NavLink[]; userName: string; roleLabel: string }) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

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

  return (
    <div className="md:hidden">
      <header className="flex items-center gap-3 border-b border-gray-200 bg-gray-50 px-4 py-3">
        <button
          type="button"
          data-testid="mobile-nav-hamburger"
          aria-label="開啟導航選單"
          onClick={() => setOpen(true)}
          className="shrink-0 rounded p-1.5 text-gray-700 hover:bg-gray-200"
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <line x1="3" y1="6" x2="21" y2="6" />
            <line x1="3" y1="12" x2="21" y2="12" />
            <line x1="3" y1="18" x2="21" y2="18" />
          </svg>
        </button>
        <div className="min-w-0 flex-1 text-xs font-medium uppercase tracking-wide text-gray-400">在勤</div>
        <div className="shrink-0 text-right text-xs">
          <div className="font-medium text-gray-900">{userName}</div>
          <div className="text-gray-500">{roleLabel}</div>
        </div>
      </header>

      {open && (
        <>
          <div
            data-testid="mobile-nav-overlay"
            aria-hidden="true"
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-40 bg-black/40"
          />
          <div
            role="dialog"
            aria-label="導航選單"
            data-testid="mobile-nav-drawer"
            className="fixed inset-y-0 left-0 z-50 flex w-64 max-w-[80vw] flex-col gap-4 overflow-y-auto bg-gray-50 p-4 shadow-xl"
          >
            <div>
              <div className="text-xs font-medium uppercase tracking-wide text-gray-400">在勤</div>
              <div className="mt-1 text-sm font-medium text-gray-900">{userName}</div>
              <div className="text-xs text-gray-500">{roleLabel}</div>
            </div>

            <nav className="flex flex-1 flex-col gap-0.5 text-sm">
              {links.map((l) => (
                <Link
                  key={l.href}
                  href={l.href}
                  onClick={() => setOpen(false)}
                  className="rounded px-2 py-1.5 text-gray-700 hover:bg-gray-200"
                >
                  {l.label}
                </Link>
              ))}
            </nav>

            <div className="flex flex-col gap-2 border-t border-gray-200 pt-3 text-sm">
              <Link
                href="/change-password"
                onClick={() => setOpen(false)}
                className="rounded px-2 py-1.5 text-blue-700 hover:bg-gray-200"
              >
                改密碼
              </Link>
              <LogoutButton />
            </div>
          </div>
        </>
      )}
    </div>
  );
}
