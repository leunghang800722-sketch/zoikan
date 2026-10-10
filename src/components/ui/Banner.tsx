// P3-4.2：提示唯一元件（取代舊 `Notice`）。
// - `message` 字串：舊用法（padding 大一點、14px）；亦可以用 children＋action。
// - `compact`：圓點＋12.5px 嘅「通知橫幅」外觀（舊 Notice 樣式），有 action slot（例如「去處理 ›」）。
import type { HTMLAttributes, ReactNode } from "react";

export type BannerKind = "info" | "success" | "warning" | "error";

const KIND_CLS: Record<BannerKind, { box: string; dot: string }> = {
  info: { box: "border-zk-primary/30 bg-zk-primary-tint-soft text-zk-primary-deep", dot: "bg-zk-primary" },
  success: { box: "border-zk-success/30 bg-zk-success-bg text-zk-success-dark", dot: "bg-zk-success" },
  warning: { box: "border-zk-warning-border bg-zk-warning-bg text-zk-warning-dark", dot: "bg-zk-warning" },
  error: { box: "border-zk-danger-border bg-zk-danger-bg text-zk-danger-dark", dot: "bg-zk-danger" },
};

export interface BannerProps extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  kind: BannerKind;
  /** 舊 API：字串（null／空＝唔出）。 */
  message?: string | null;
  children?: ReactNode;
  /** 右邊 action slot（例如連結）。 */
  action?: ReactNode;
  /** 圓點＋細字外觀（舊 Notice）。 */
  compact?: boolean;
}

export function Banner({ kind, message, children, action, compact, className, ...rest }: BannerProps) {
  const body = children ?? message;
  if (body === null || body === undefined || body === "" || body === false) return null;
  const k = KIND_CLS[kind];
  if (compact) {
    return (
      <div className={`flex items-center gap-2.5 rounded-md border px-3 py-2 text-zk-sm ${k.box} ${className ?? ""}`} {...rest}>
        <span className={`h-2 w-2 shrink-0 rounded-full ${k.dot}`} />
        <span className="flex-1">{body}</span>
        {action && <span className="shrink-0">{action}</span>}
      </div>
    );
  }
  return (
    <div className={`rounded border px-3 py-2 text-sm ${action ? "flex items-center gap-2.5" : ""} ${k.box} ${className ?? ""}`} {...rest}>
      {action ? <span className="flex-1">{body}</span> : body}
      {action && <span className="shrink-0">{action}</span>}
    </div>
  );
}

/** 表單欄位旁嘅單行錯誤字（取代手寫 `text-red-*`）。 */
export function FieldError({ children, className }: { children: ReactNode; className?: string }) {
  if (!children) return null;
  return <p className={`text-zk-sm text-zk-danger ${className ?? ""}`} role="alert">{children}</p>;
}
