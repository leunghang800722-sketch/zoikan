// P3-3.4：報表 tab 定義（server layout 同 client ReportTabs 共用；唔可以放喺 "use client" 檔，否則 server 端 import 到嘅係 client reference）。
export const REPORT_TABS = [
  { href: "/reports/monthly-close", label: "月結總表", module: "月結總表" },
  { href: "/reports/gross-margin", label: "毛利", module: "毛利即時表" },
  { href: "/reports/payroll", label: "糧明細", module: "糧明細" },
  { href: "/reports/longterm-payroll", label: "長工糧", module: "長工糧" },
  { href: "/reports/ops-digest", label: "修正摘要", module: "月結總表" },
] as const;
