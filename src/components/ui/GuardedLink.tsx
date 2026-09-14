"use client";
// P2 整合驗收①：包一層 `next/link`，撳落去之前問返 `confirmLeaveIfUnsaved()`
// （`@/lib/ui/unsaved-guard`）——更表編輯器有未儲存改動時，撳呢種連結會
// 有 `window.confirm` 攔截，取消就 `preventDefault()` 唔跳。全站導航連結
// （`DesktopNav`／`MobileNav`／更表麵包屑）用呢個代替原生 `Link`。
import Link, { type LinkProps } from "next/link";
import { forwardRef, type AnchorHTMLAttributes, type MouseEvent, type ReactNode } from "react";
import { confirmLeaveIfUnsaved } from "@/lib/ui/unsaved-guard";

type GuardedLinkProps = LinkProps &
  Omit<AnchorHTMLAttributes<HTMLAnchorElement>, keyof LinkProps> & {
    children?: ReactNode;
  };

export const GuardedLink = forwardRef<HTMLAnchorElement, GuardedLinkProps>(function GuardedLink(
  { onClick, ...props },
  ref,
) {
  return (
    <Link
      {...props}
      ref={ref}
      onClick={(e: MouseEvent<HTMLAnchorElement>) => {
        if (!confirmLeaveIfUnsaved()) {
          e.preventDefault();
          return;
        }
        onClick?.(e);
      }}
    />
  );
});
