"use client";
// P13.5：覆蓋層（Drawer／對話框／手機抽屜／AI 側欄）入瀏覽器 history。
// 根因：「加到主畫面」standalone PWA 冇瀏覽器返回掣，Android 系統返回／iOS 手勢會直接離開成頁，
// 因為覆蓋層唔喺 history。開覆蓋層 pushState（同一 URL）；返回＝popstate → 關覆蓋層（頁面唔郁）。
// 嵌套：每層帶 depth，popstate 後 history depth 細過自己先關自己（後開先關）。
// UI 關閉（✕／遲啲先答）一律經 `close()`：自己 entry 喺頂就 history.back()（由 popstate 去關），否則直接 onClose。
import { useCallback, useEffect, useRef } from "react";

const active = new Set<string>(); // 而家開緊嘅 overlay nonce（每次開生成，重新整理後舊 entry 嘅 nonce 唔會喺度）
let globalInstalled = false;

interface OverlayState {
  zkOverlay?: string;
  zkNonce?: string;
  zkDepth?: number;
}
const stateOf = (): OverlayState => (typeof window !== "undefined" ? ((window.history.state as OverlayState | null) ?? {}) : {});
const newNonce = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

// 停用咗嘅 entry（overlay 已經用 UI／導航關咗，或者重新整理前留低嘅舊 entry）：撞到就自動再 back 一格跳過。
function installGlobal() {
  if (globalInstalled || typeof window === "undefined") return;
  globalInstalled = true;
  window.addEventListener("popstate", () => {
    const s = stateOf();
    if (s.zkOverlay && !(s.zkNonce && active.has(s.zkNonce))) window.history.back();
  });
}

export function useHistoryOverlay(open: boolean, onClose: () => void, key: string, enabled = true): { close: () => void; closeForNavigation: () => void; restore: () => void } {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const skipBack = useRef(false);
  const closing = useRef(false); // 已經發出 history.back()，等 popstate（防 dblclick 返兩格）
  const nonceRef = useRef<string | null>(null);
  const poppedRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!open || !enabled || typeof window === "undefined") return;
    installGlobal();
    const nonce = newNonce();
    nonceRef.current = nonce;
    const depth = active.size + 1;
    active.add(nonce);
    window.history.pushState({ zkOverlay: key, zkNonce: nonce, zkDepth: depth }, "", window.location.href);
    poppedRef.current = false;
    skipBack.current = false;
    closing.current = false;
    const onPop = () => {
      const s = stateOf();
      // 自己 entry 唔再喺頂：頂層 nonce 唔係我，而且唔係疊喺我上面嘅嵌套層（depth 大過我）
      if (s.zkNonce !== nonce && (s.zkDepth ?? 0) <= depth && !poppedRef.current) {
        poppedRef.current = true;
        closing.current = false;
        if (timerRef.current) clearTimeout(timerRef.current);
        onCloseRef.current();
      }
    };
    window.addEventListener("popstate", onPop);
    return () => {
      window.removeEventListener("popstate", onPop);
      active.delete(nonce);
      if (timerRef.current) clearTimeout(timerRef.current);
      closing.current = false;
      // 自己 entry 仲喺頂（例如程式直接 setOpen(false)）→ 清走；導航離開 (closeForNavigation) 就留低俾 installGlobal 跳過
      if (!poppedRef.current && !skipBack.current && stateOf().zkNonce === nonce) window.history.back();
    };
  }, [open, enabled, key]);

  const close = useCallback(() => {
    if (closing.current) return;
    if (enabled && nonceRef.current && stateOf().zkNonce === nonceRef.current) {
      closing.current = true;
      window.history.back();
      // 保險：popstate 冇關到（例如退到嘅 entry 唔觸發）→ 重設並直接關，唔好卡死
      timerRef.current = setTimeout(() => {
        if (closing.current) {
          closing.current = false;
          onCloseRef.current();
        }
      }, 400);
    } else onCloseRef.current();
  }, [enabled]);
  // 返回已經關咗 entry、但 dialog 因為（例如送出失敗）決定唔關：重新 push 一條，令之後返回／UI 關閉照常
  const restore = useCallback(() => {
    const nonce = nonceRef.current;
    if (!enabled || !nonce || !poppedRef.current) return;
    poppedRef.current = false;
    window.history.pushState({ zkOverlay: key, zkNonce: nonce, zkDepth: 1 }, "", window.location.href);
  }, [enabled, key]);
  const closeForNavigation = useCallback(() => {
    skipBack.current = true;
    onCloseRef.current();
  }, []);
  return { close, closeForNavigation, restore };
}
