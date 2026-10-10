// WP-R1 共用元件：首頁／各報表用嘅 KPI 卡（README「共用元件 · KPI
// 卡」）。`href` 存在時成張卡可撳（跳去相關頁）；`tone="danger"` 令大數
// 變紅（尚欠一類警示數字）；`children` 係卡底部嘅額外 slot（例如尚欠
// 逐盤 pill 列）。
import type { ReactNode } from "react";
import Link from "next/link";

export interface KpiCardProps {
  label: string;
  value: ReactNode;
  note?: ReactNode;
  href?: string;
  tone?: "default" | "danger";
  children?: ReactNode;
  className?: string;
}

export function KpiCard({ label, value, note, href, tone = "default", children, className }: KpiCardProps) {
  const inner = (
    <>
      <div className="text-xs text-zk-muted">{label}</div>
      <div className="mt-1 flex items-baseline gap-2">
        <span className={`text-zk-2xl leading-[1.1] font-bold lg:text-zk-2xl ${tone === "danger" ? "text-zk-danger" : "text-zk-text"}`}>{value}</span>
      </div>
      {note && <div className="mt-1.5 text-xs text-zk-muted">{note}</div>}
      {children}
    </>
  );

  const cls = `flex flex-col rounded-[10px] border border-zk-border bg-white px-3.5 py-3 lg:px-[18px] lg:py-4 ${className ?? ""}`;

  if (href) {
    return (
      <Link href={href} className={`${cls} cursor-pointer transition-colors hover:bg-zk-header`}>
        {inner}
      </Link>
    );
  }
  return <div className={cls}>{inner}</div>;
}
