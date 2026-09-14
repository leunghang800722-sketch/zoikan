// WP-R1 共用元件：資料表（README「共用元件 · 資料表」）。呢度唔做
// 泛型 `<DataTable>` component（每頁欄位形狀差太遠），淨係出一組 class
// 常數俾 R2／R3 逐頁砌 `<table>` 時套用，keep 晒視覺一致；同一個
// `EmptyState` component 俾冇資料嘅表用。
import type { ReactNode } from "react";

/** README「共用元件 · 資料表」：內層 `min-width = max(560px, 欄數 ×
 * 118px)`——欄多嘅表（例如糧明細）568px 淨係得返幾欄闊，數字會迫到
 * 窄晒；呢個 helper 計出嗰頁實際欄數應有嘅 min-width，用法：
 *
 *   <div className={tableCls.wrap}>
 *     <table className={tableCls.table} style={{ minWidth: tableMinWidth(colCount) }}>
 *
 * （`tableCls.table` 本身仍然保留 `min-w-[560px]` 做冇傳 style 時嘅
 * 保底值；欄數多過 ~5 欄嘅表建議都傳呢個 style 覆蓋。） */
export function tableMinWidth(colCount: number): number {
  return Math.max(560, colCount * 118);
}

export const tableCls = {
  /** 外框：白底、邊、圓角、橫向捲。 */
  wrap: "overflow-x-auto rounded-lg border border-zk-border bg-white",
  table: "w-full min-w-[560px] border-collapse text-[13px]",
  /** 表頭 cell（靠左）。數字欄自己加 `text-right`。 */
  th: "whitespace-nowrap border-b border-zk-border bg-zk-header px-3.5 py-[9px] text-left text-[11.5px] font-semibold text-zk-muted",
  thNum: "whitespace-nowrap border-b border-zk-border bg-zk-header px-3.5 py-[9px] text-right text-[11.5px] font-semibold text-zk-muted",
  /** 資料 cell（靠左，名稱欄額外加 `font-medium`）。 */
  td: "border-b border-[#f1f5f9] px-3.5 py-2.5 text-zk-text",
  tdNum: "border-b border-[#f1f5f9] px-3.5 py-2.5 text-right text-zk-text tabular-nums",
  tdMuted: "border-b border-[#f1f5f9] px-3.5 py-2.5 text-zk-faint",
  /** 資料行：hover 底色；可撳行額外加 `cursor-pointer`。 */
  rowHover: "hover:bg-zk-header",
  /** 警示行（尚欠／低毛利）：整行淡紅底。 */
  warnRow: "bg-[#fef2f2]",
  /** 合計行（foot）。 */
  foot: "border-t border-zk-border bg-zk-header font-bold",
};

export interface EmptyStateProps {
  title: string;
  description?: string;
  cta?: ReactNode;
}

export function EmptyState({ title, description, cta }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
      <div className="h-10 w-10 rounded-[10px] bg-zk-surface" />
      <div className="text-sm font-semibold text-zk-text">{title}</div>
      {description && <div className="max-w-[380px] text-[12.5px] leading-relaxed text-zk-muted">{description}</div>}
      {cta && <div className="mt-1.5">{cta}</div>}
    </div>
  );
}
