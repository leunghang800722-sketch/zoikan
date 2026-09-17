// WP-R1 共用元件：狀態／更別／雞頭 pill（README「共用元件 · 資料表」）。
// variant="broker" 時必須連 `color` 一齊用（見 `@/lib/ui/broker-color`
// 嘅 `brokerColor()`），其餘 variant 用固定色。
import type { ReactNode } from "react";

export type PillVariant = "success" | "neutral" | "warning" | "shift" | "monthly" | "broker" | "danger";

const VARIANT_STYLE: Record<Exclude<PillVariant, "broker">, { bg: string; fg: string }> = {
  success: { bg: "#ecfdf5", fg: "#047857" },
  neutral: { bg: "#f1f5f9", fg: "#475569" },
  warning: { bg: "#fff7ed", fg: "#c2410c" },
  shift: { bg: "#dbeafe", fg: "#1e40af" },
  monthly: { bg: "#ede9fe", fg: "#5b21b6" },
  // WP-PII：牌照／平安卡已過期 pill 用——同表格 warnRow 底色 `#fef2f2`
  // 一致嘅紅色系（見 DataTable.tsx `tableCls.warnRow`）。
  danger: { bg: "#fef2f2", fg: "#dc2626" },
};

export interface PillProps {
  variant: PillVariant;
  children: ReactNode;
  /** `variant="broker"` 時嘅底/字色（見 `brokerColor()`）；其餘 variant 忽略。 */
  color?: { bg: string; fg: string };
  className?: string;
}

export function Pill({ variant, children, color, className }: PillProps) {
  const style = variant === "broker" ? (color ?? { bg: "#f1f5f9", fg: "#475569" }) : VARIANT_STYLE[variant];
  return (
    <span
      className={`inline-flex items-center rounded-[10px] px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap ${className ?? ""}`}
      style={{ background: style.bg, color: style.fg }}
    >
      {children}
    </span>
  );
}
