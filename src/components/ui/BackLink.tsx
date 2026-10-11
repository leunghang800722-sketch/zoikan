"use client";
// P13.6：頁內「‹ 返回…」連結——有上一頁就 back，冇就去指定父頁（href）。
import { useRouter, usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { GuardedLink } from "@/components/ui/GuardedLink";
import { goBack } from "@/lib/ui/back-nav";

export function BackLink({ href, className, children, ...rest }: { href: string; className?: string; children: ReactNode; "data-testid"?: string; "aria-label"?: string }) {
  const router = useRouter();
  const pathname = usePathname();
  return (
    <GuardedLink
      href={href}
      className={className}
      {...rest}
      onClick={(e) => {
        if (e.defaultPrevented) return;
        e.preventDefault();
        goBack(router, pathname ?? "/", href);
      }}
    >
      {children}
    </GuardedLink>
  );
}
