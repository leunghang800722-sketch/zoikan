"use client";
// WP-RECONCILE-UI（§33.3 D）：deep link `?focus=<id>`——只做高亮＋捲到，唔觸發任何寫入。
import { useEffect, useRef, useState } from "react";

export const FOCUS_CLS = "bg-yellow-50 outline outline-2 -outline-offset-2 outline-zk-primary";

/** 讀 URL `?focus=`（掛載後讀，避免 SSR hydration 不一致）。 */
export function useFocusParam(name = "focus"): string | null {
  const [v, setV] = useState<string | null>(null);
  useEffect(() => {
    const f = new URLSearchParams(window.location.search).get(name);
    setV(f && f.trim() ? f.trim() : null);
  }, [name]);
  return v;
}

/** 資料載入後（ready）捲到 `[data-focus-key="<value>"]`（桌面表／手機卡二揀一，取可見嗰個）。 */
export function useScrollToFocus(value: string | null, ready: boolean): void {
  const done = useRef<string | null>(null);
  useEffect(() => {
    if (!value || !ready || done.current === value) return;
    const els = [...document.querySelectorAll<HTMLElement>(`[data-focus-key="${CSS.escape(value)}"]`)];
    const el = els.find((e) => e.getClientRects().length > 0);
    if (!el) return;
    done.current = value;
    el.scrollIntoView({ block: "center" });
  }, [value, ready]);
}
