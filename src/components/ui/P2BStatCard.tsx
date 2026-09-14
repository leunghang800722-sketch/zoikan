// P2-B 共用元件：財務報表頁嘅 stat 卡（README §11/§12「3 張 stat 卡
// （`auto-fit minmax(180px,1fr)`，22px/700）」）——同首頁 `KpiCard.tsx`
// 唔同（嗰個大數係 28–30px，係首頁 KPI 專用嘅字級），P2-B 呢批報表頁
// stat 卡字級細一級（22px/700），所以獨立開個 component，唔改
// `KpiCard.tsx`（避免影響首頁）。
import type { ReactNode } from "react";

export interface P2BStatCardProps {
  label: string;
  value: ReactNode;
  note?: ReactNode;
  tone?: "default" | "danger" | "warning" | "muted";
  className?: string;
}

const TONE_CLS: Record<NonNullable<P2BStatCardProps["tone"]>, string> = {
  default: "text-zk-text",
  danger: "text-[#dc2626]",
  warning: "text-[#c2410c]",
  muted: "text-zk-muted",
};

export function P2BStatCard({ label, value, note, tone = "default", className }: P2BStatCardProps) {
  return (
    <div className={`flex flex-col rounded-[10px] border border-zk-border bg-white px-3.5 py-3 md:px-[18px] md:py-4 ${className ?? ""}`}>
      <div className="text-xs text-zk-muted">{label}</div>
      <div className={`mt-1 text-[22px] leading-[1.15] font-bold ${TONE_CLS[tone]}`}>{value}</div>
      {note && <div className="mt-1.5 text-xs text-zk-muted">{note}</div>}
    </div>
  );
}
