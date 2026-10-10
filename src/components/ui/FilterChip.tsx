// WP-R1 共用元件：頁首 filter chip（README「頁首模式」）——白底、灰
// 邊、圓角 6px；標籤淡灰＋值深灰＋尾「▾」。包住一個 `<select>` 或
// 原生月份控件，自己重設 border/outline 混入 chip。
import type { ReactNode } from "react";

export interface FilterChipProps {
  label: string;
  children: ReactNode;
  /** 有啲 chip（例如月份切換嘅 ‹ › chip）唔想要「▾」尾巴。預設 true。 */
  showCaret?: boolean;
  className?: string;
}

export function FilterChip({ label, children, showCaret = true, className }: FilterChipProps) {
  return (
    <div
      className={`flex items-center gap-1.5 rounded-md border border-zk-border bg-white px-2.5 py-[6px] text-zk-base text-zk-text-secondary ${className ?? ""}`}
    >
      <span className="text-xs text-zk-faint">{label}</span>
      <span className="[&_select]:cursor-pointer [&_select]:border-0 [&_select]:bg-transparent [&_select]:p-0 [&_select]:text-zk-base [&_select]:text-zk-text-secondary [&_select]:outline-none [&_input]:border-0 [&_input]:bg-transparent [&_input]:p-0 [&_input]:text-zk-base [&_input]:text-zk-text-secondary [&_input]:outline-none">
        {children}
      </span>
      {showCaret && <span className="text-zk-2xs text-zk-faint">▾</span>}
    </div>
  );
}
