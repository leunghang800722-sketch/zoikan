export function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <label className="block space-y-1">
      <span className="block text-sm text-zk-text-secondary">{label}</span>
      {children}
      {hint && <span className="block text-xs text-zk-faint">{hint}</span>}
    </label>
  );
}

// A7（Opus 整合驗收）：呢個 codebase 之前有三套幾乎一樣但唔完全一致嘅
// input 樣式（呢個 Field.tsx 嘅 `inputCls`、`roster/page.tsx` 同
// `reports/monthly-close/page.tsx` 各自嘅本地 `fieldCls`）——合一，統一
// 跟 README「表單控件」規格：padding 9px 12px、`1px solid #d1d5db`、
// 圓角 7px、13.5px，focus 時邊變主色＋加一圈淡藍 ring（同錯誤狀態嘅
// `box-shadow 0 0 0 3px` 精神一致，非錯誤狀態用主色淡 20% 透明度）。
// `roster/page.tsx`／`reports/monthly-close/page.tsx` 嘅本地 `fieldCls`
// 已刪走，改 import 呢度。
export const inputCls =
  "w-full rounded-[7px] border border-zk-input-border bg-white px-3 py-[9px] text-zk-base text-zk-text focus:border-zk-primary focus:outline-none focus:ring-[3px] focus:ring-zk-primary/20";
export const selectCls = inputCls;
