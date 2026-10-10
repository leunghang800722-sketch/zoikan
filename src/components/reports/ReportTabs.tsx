"use client";
// P3-3.4：報表五個 tab（月結總表／毛利／糧明細／長工糧／修正摘要）——五頁頂部共用，路徑不變。
// 按 grants 顯示（server layout 傳入）；換 tab 帶住當前 `?month=`（唔帶都得：月份經 useMonthState 由 sessionStorage 還原）。
import { usePathname, useSearchParams } from "next/navigation";
import { GuardedLink } from "@/components/ui/GuardedLink";
import { isValidMonth } from "@/lib/ui/month-store";

export const REPORT_TABS = [
  { href: "/reports/monthly-close", label: "月結總表", module: "月結總表" },
  { href: "/reports/gross-margin", label: "毛利", module: "毛利即時表" },
  { href: "/reports/payroll", label: "糧明細", module: "糧明細" },
  { href: "/reports/longterm-payroll", label: "長工糧", module: "長工糧" },
  { href: "/reports/ops-digest", label: "修正摘要", module: "月結總表" },
] as const;

export function ReportTabs({ visible }: { visible: string[] }) {
  const pathname = usePathname();
  const sp = useSearchParams();
  const month = sp.get("month");
  const tabs = REPORT_TABS.filter((t) => visible.includes(t.href));
  if (tabs.length < 2) return null;
  return (
    <nav aria-label="報表" data-testid="report-tabs" className="-mb-1 flex flex-wrap gap-1 border-b border-zk-border">
      {tabs.map((t) => {
        const active = pathname === t.href;
        const href = isValidMonth(month) ? `${t.href}?month=${month}` : t.href;
        return (
          <GuardedLink
            key={t.href}
            href={href}
            data-testid={`report-tab-${t.href.split("/").pop()}`}
            aria-current={active ? "page" : undefined}
            className={`-mb-px border-b-2 px-3.5 py-2 text-[13.5px] ${active ? "border-zk-primary font-semibold text-zk-primary-dark" : "border-transparent text-zk-text-secondary hover:text-zk-text"}`}
          >
            {t.label}
          </GuardedLink>
        );
      })}
    </nav>
  );
}
