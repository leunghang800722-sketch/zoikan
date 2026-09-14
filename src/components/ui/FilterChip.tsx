// WP-R1 共用元件：頁首 filter chip（README「頁首模式」）——白底、灰
// 邊、圓角 6px；標籤淡灰＋值深灰＋尾「▾」。包住一個 `<select>` 或
// `<input type="month">` 等原生控件，自己重設 border/outline 混入 chip。
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
      className={`flex items-center gap-1.5 rounded-md border border-zk-border bg-white px-2.5 py-[6px] text-[13px] text-[#334155] ${className ?? ""}`}
    >
      <span className="text-xs text-zk-faint">{label}</span>
      <span className="[&_select]:cursor-pointer [&_select]:border-0 [&_select]:bg-transparent [&_select]:p-0 [&_select]:text-[13px] [&_select]:text-[#334155] [&_select]:outline-none [&_input]:border-0 [&_input]:bg-transparent [&_input]:p-0 [&_input]:text-[13px] [&_input]:text-[#334155] [&_input]:outline-none">
        {children}
      </span>
      {showCaret && <span className="text-[10px] text-zk-faint">▾</span>}
    </div>
  );
}
