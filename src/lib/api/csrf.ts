// P6.4：CSRF defense-in-depth（主防線仍然係 session cookie SameSite=lax）。
// 非 GET／HEAD／OPTIONS 嘅 /api 請求檢查 `Sec-Fetch-Site`／`Origin`：
//   - 有 `Sec-Fetch-Site`（現代瀏覽器必定帶，無法由頁面 JS 偽造）：
//     只有 `same-origin` 或 `none`（用戶直接輸入網址／書籤）放行；`same-site`、`cross-site` 一律拒。
//   - 冇 `Sec-Fetch-Site` 但有 `Origin`：Origin 嘅 host 要等於請求 Host（或 X-Forwarded-Host）；
//     `Origin: null` 拒。
//   - 兩個 header 都冇 → 非瀏覽器 client（curl、server-to-server、腳本、Playwright request API）
//     照放行——呢類 client 冇「瀏覽器自動帶 cookie」嘅 CSRF 風險，攻擊者控制唔到。
// 純函數，Edge／Node 通用；由 src/middleware.ts 對 /api/* 套用（涵蓋所有 route，唔使逐條改）。
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export type CsrfVerdict = { ok: true } | { ok: false; reason: string };

export function checkCsrf(method: string, headers: { get(name: string): string | null }): CsrfVerdict {
  if (SAFE_METHODS.has(method.toUpperCase())) return { ok: true };

  const fetchSite = headers.get("sec-fetch-site");
  if (fetchSite) {
    const v = fetchSite.toLowerCase();
    if (v === "same-origin" || v === "none") return { ok: true };
    return { ok: false, reason: `sec-fetch-site=${v}` };
  }

  const origin = headers.get("origin");
  if (origin !== null) {
    let originHost: string;
    try {
      originHost = new URL(origin).host.toLowerCase();
    } catch {
      return { ok: false, reason: "origin_invalid" };
    }
    const hosts = [headers.get("x-forwarded-host"), headers.get("host")]
      .filter((h): h is string => !!h)
      .flatMap((h) => h.split(",").map((x) => x.trim().toLowerCase()));
    if (hosts.includes(originHost)) return { ok: true };
    return { ok: false, reason: "origin_mismatch" };
  }

  return { ok: true };
}
