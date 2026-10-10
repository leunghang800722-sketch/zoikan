"use client";
// P3-3.2：全站唯一嘅月份選擇器——「‹ 月份 ›」＋原生 `<input type="month">`。
// 以前 16 個頁面各寫一套（5 種寫法，只有 3 頁讀網址月份）。而家：
//   - `useMonthState()`：月份來源次序 URL `?month=` → sessionStorage["zk.month"] → 頁面預設；
//     改變時同時更新 URL（history.replaceState，唔加 history 紀錄）同 sessionStorage，
//     所以換頁、換報表 tab 都跟住同一個月。
//   - `<MonthPicker>`：純顯示，受控（value／onChange）。
// 表單入面嘅月份欄（開更表、新增配額、雞頭掛盤）唔屬呢個元件。
import { useCallback, useEffect, useState } from "react";
import { addMonthsStr, currentMonthStr } from "@/lib/ui/format";
import { isValidMonth, readInitialMonth, rememberMonth } from "@/lib/ui/month-store";

/** 頁面用嘅 state hook：回 `[month, setMonth]`。`defaultMonth` 係冇 URL／sessionStorage 時用（預設本月）。 */
export function useMonthState(defaultMonth?: string): [string, (m: string) => void] {
  const fallback = defaultMonth ?? currentMonthStr();
  // SSR／首次 client render 一律用 fallback（避免 hydration mismatch）；mount 後 effect 先切去 URL／sessionStorage 嘅月。
  const [month, setMonthState] = useState<string>(fallback);

  useEffect(() => {
    const r = readInitialMonth(fallback);
    if (r.source !== "default") {
      setMonthState(r.month);
      // 由 sessionStorage 還原嘅，URL 補返 ?month=（分享／重新整理都一致）；URL 本身帶嘅就記入 sessionStorage。
      rememberMonth(r.month, { syncUrl: true });
    }
    // 只係 mount 跑一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setMonth = useCallback((m: string) => {
    setMonthState(m);
    if (isValidMonth(m)) rememberMonth(m, { syncUrl: true });
  }, []);

  return [month, setMonth];
}

export interface MonthPickerProps {
  value: string;
  onChange: (month: string) => void;
  /** 前綴標籤（例：「月份」「生效月」）。 */
  label?: string;
  /** 輸入框 testid。 */
  testId?: string;
  ariaLabel?: string;
  /** 容許清空（例：價目「生效月」係篩選，空＝全部）。 */
  allowEmpty?: boolean;
  className?: string;
}

export function MonthPicker({ value, onChange, label, testId, ariaLabel = "月份", allowEmpty = false, className }: MonthPickerProps) {
  const base = isValidMonth(value) ? value : currentMonthStr();
  return (
    <div className={`inline-flex items-center gap-1 rounded-md border border-zk-border bg-white px-2 py-[3px] text-[13px] text-[#334155] ${className ?? ""}`} data-month-picker="">
      {label && <span className="text-xs text-zk-faint">{label}</span>}
      <button type="button" aria-label="上一個月" className="px-1 text-zk-faint hover:text-zk-text" onClick={() => onChange(addMonthsStr(base, -1))}>
        ‹
      </button>
      <input
        type="month"
        data-testid={testId}
        aria-label={ariaLabel}
        value={value}
        onChange={(e) => {
          const v = e.target.value;
          if (v === "" && !allowEmpty) return; // 原生 month 清空會回 ""，月份欄唔接受
          onChange(v);
        }}
        className="w-[118px] border-0 bg-transparent p-0 py-0.5 text-[13px] text-[#334155] outline-none"
      />
      <button type="button" aria-label="下一個月" className="px-1 text-zk-faint hover:text-zk-text" onClick={() => onChange(addMonthsStr(base, 1))}>
        ›
      </button>
    </div>
  );
}
