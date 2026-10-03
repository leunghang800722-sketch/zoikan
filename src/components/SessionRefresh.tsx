"use client";
import { useEffect } from "react";

const KEY = "zoikan_session_refresh_at";
const MIN_GAP_MS = 6 * 60 * 60 * 1000; // 本機最多每 6 小時試一次（server 仲有 24 小時門檻）

/** 滑動續期觸發器：開頁／返前景時打 /api/auth/refresh。失敗一律靜默。 */
export function SessionRefresh() {
  useEffect(() => {
    function tick() {
      try {
        const last = Number(localStorage.getItem(KEY) ?? 0);
        if (Date.now() - last < MIN_GAP_MS) return;
        localStorage.setItem(KEY, String(Date.now()));
      } catch {
        // 無 localStorage 就每次都試（server 會自己節流）
      }
      void fetch("/api/auth/refresh", { method: "POST" }).catch(() => {});
    }
    tick();
    const onVis = () => {
      if (document.visibilityState === "visible") tick();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);
  return null;
}
