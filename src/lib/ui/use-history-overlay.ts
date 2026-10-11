"use client";
// P13.5：覆蓋層（Drawer／對話框／手機抽屜／AI 側欄）入瀏覽器 history。
// 根因：「加到主畫面」standalone PWA 冇瀏覽器返回掣，Android 系統返回／iOS 手勢會直接離開成頁，
// 因為覆蓋層唔喺 history。開覆蓋層 pushState（同一 URL）；返回＝popstate → 關覆蓋層（頁面唔郁）。
// 嵌套：每層帶 depth，popstate 後 history depth 細過自己先關自己（後開先關）。
// UI 關閉（✕／遲啲先答）一律經 `close()`：自己 entry 喺頂就 history.back()（由 popstate 去關），否則直接 onClose。
import { useCallback, useEffect, useRef } from "react";

const active = new Set<string>(); // 而家開緊嘅 overlay key
let globalInstalled = false;

interface OverlayState {
  zkOverlay?: string;
  zkDepth?: number;
}
const stateOf = (): OverlayState => (typeof window !== "undefined" ? ((window.history.state as OverlayState | null) ?? {}) : {});

// 停用咗嘅 entry（overlay 已經用 UI／導航關咗，剩低同 URL 嘅舊 entry）：撞到就自動再 back 一格跳過。
function installGlobal() {
  if (globalInstalled || typeof window === "undefined") return;
  globalInstalled = true;
  window.addEventListener("popstate", () => {
    const s = stateOf();
    if (s.zkOverlay && !active.has(s.zkOverlay)) window.history.back();
  });
}

export function useHistoryOverlay(open: boolean, onClose: () => void, key: string, enabled = true): { close: () => void; closeForNavigation: () => void } {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const skipBack = useRef(false);
  const closing = useRef(false); // 已經發出 history.back()，等 popstate（防 dblclick 返兩格）

  useEffect(() => {
    if (!open || !enabled || typeof window === "undefined") return;
    installGlobal();
    const depth = active.size + 1;
    active.add(key);
    window.history.pushState({ zkOverlay: key, zkDepth: depth }, "", window.location.href);
    let popped = false;
    skipBack.current = false;
    closing.current = false;
    const onPop = () => {
      const s = stateOf();
      if ((s.zkDepth ?? 0) < depth && !popped) {
        popped = true;
        closing.current = false;
        onCloseRef.current();
      }
    };
    window.addEventListener("popstate", onPop);
    return () => {
      window.removeEventListener("popstate", onPop);
      active.delete(key);
      // 自己 entry 仲喺頂（例如程式直接 setOpen(false)）→ 清走；導航離開 (closeForNavigation) 就留低俾 installGlobal 跳過
      if (!popped && !skipBack.current && stateOf().zkOverlay === key) window.history.back();
    };
  }, [open, enabled, key]);

  const close = useCallback(() => {
    if (closing.current) return;
    if (enabled && stateOf().zkOverlay === key) {
      closing.current = true;
      window.history.back();
    } else onCloseRef.current();
  }, [enabled, key]);
  const closeForNavigation = useCallback(() => {
    skipBack.current = true;
    onCloseRef.current();
  }, []);
  return { close, closeForNavigation };
}
