"use client";
// P13.6：記低頁面 stack（sessionStorage），俾 goBack 判斷有冇上一頁。放喺 (app)/layout。
import { useEffect } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { trackPath } from "@/lib/ui/back-nav";

export function NavHistoryTracker() {
  const pathname = usePathname();
  const search = useSearchParams();
  const q = search.toString();
  useEffect(() => {
    trackPath(`${pathname}${q ? `?${q}` : ""}`);
  }, [pathname, q]);
  return null;
}
