// WP-R1 共用元件：所有頁面共用嘅頁首（README「頁首模式」）——
// kicker（分組名）→ H1 → 可選副題；右邊 filters／actions slot。
// R2／R3 逐頁改版時直接用呢個 component，唔使逐頁砌返成套樣式。
import type { ReactNode } from "react";

export interface PageHeaderProps {
  /** 12.5px 灰字，一般係分組名（例：「排更」「財務」）。 */
  kicker?: string;
  title: string;
  /** 13px 灰字副題，一行講清頁面用途。 */
  subtitle?: string;
  /** 右邊 filter chips／按鈕——自己 flex-wrap 排。 */
  actions?: ReactNode;
}

export function PageHeader({ kicker, title, subtitle, actions }: PageHeaderProps) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div>
        {kicker && <div className="text-[12.5px] text-zk-muted">{kicker}</div>}
        <h1 className="mt-0.5 text-[22px] font-bold tracking-[-0.01em] text-zk-text">{title}</h1>
        {subtitle && <div className="mt-1 text-[13px] text-zk-muted">{subtitle}</div>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
