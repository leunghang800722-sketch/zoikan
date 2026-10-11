"use client";
// P13.6：記低頁面 stack（sessionStorage），俾 goBack 判斷有冇上一頁。放喺 (app)/layout。
import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { trackPath } from "@/lib/ui/back-nav";

export function NavHistoryTracker() {
  const pathname = usePathname();
  useEffect(() => {
    // 只記 pathname（query 可能帶姓名／員工編號，唔入 storage）
    trackPath(pathname);
  }, [pathname]);
  return null;
}
