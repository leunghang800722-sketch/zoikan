"use client";
// 2026-09-13 安全網：部署後舊分頁仍載住舊版程式，撳去新頁面會因為舊 chunk 已唔存在而
// 卡住（畫面空白／無限載入）。捕捉呢類錯誤自動整頁重載一次（sessionStorage 防止無限循環）。
import { useEffect } from "react";

const PATTERN = /ChunkLoadError|Loading chunk|Failed to fetch dynamically imported module|Importing a module script failed/i;

export function ChunkErrorReload() {
  useEffect(() => {
    const reloadOnce = (msg: string) => {
      if (!PATTERN.test(msg)) return;
      try {
        if (sessionStorage.getItem("zk_chunk_reload") === "1") return;
        sessionStorage.setItem("zk_chunk_reload", "1");
      } catch {
        /* ignore */
      }
      window.location.reload();
    };
    const onError = (e: ErrorEvent) => reloadOnce(String(e.message || e.error?.message || ""));
    const onRejection = (e: PromiseRejectionEvent) => reloadOnce(String((e.reason && (e.reason.message || e.reason)) || ""));
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    // 正常載入成功後清 flag，令下次部署再可以重載一次
    const t = setTimeout(() => { try { sessionStorage.removeItem("zk_chunk_reload"); } catch { /* ignore */ } }, 10_000);
    return () => { window.removeEventListener("error", onError); window.removeEventListener("unhandledrejection", onRejection); clearTimeout(t); };
  }, []);
  return null;
}
