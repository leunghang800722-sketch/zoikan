// WP-R1 共用元件：通知橫幅（README「共用元件 · 通知橫幅」）——鎖定／
// 警告、資訊、錯誤三種，左邊 8px 圓點，右邊可選 action slot（例如「去
// 月結工作台」連結）。
import type { ReactNode } from "react";

export type NoticeVariant = "warning" | "info" | "error";

const VARIANT_STYLE: Record<NoticeVariant, { bg: string; border: string; fg: string; dot: string }> = {
  warning: { bg: "var(--zk-warning-bg)", border: "var(--zk-warning-border)", fg: "var(--zk-warning-dark)", dot: "var(--zk-warning)" },
  info: { bg: "var(--zk-primary-tint-soft)", border: "var(--zk-primary-tint)", fg: "var(--zk-primary-deep)", dot: "var(--zk-primary)" },
  error: { bg: "var(--zk-danger-bg)", border: "var(--zk-danger-border)", fg: "var(--zk-danger-dark)", dot: "var(--zk-danger)" },
};

export interface NoticeProps {
  variant: NoticeVariant;
  children: ReactNode;
  action?: ReactNode;
  className?: string;
}

export function Notice({ variant, children, action, className }: NoticeProps) {
  const s = VARIANT_STYLE[variant];
  return (
    <div
      className={`flex items-center gap-2.5 rounded-md border px-3 py-2 text-zk-sm ${className ?? ""}`}
      style={{ background: s.bg, borderColor: s.border, color: s.fg }}
    >
      <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: s.dot }} />
      <span className="flex-1">{children}</span>
      {action && <span className="shrink-0">{action}</span>}
    </div>
  );
}
