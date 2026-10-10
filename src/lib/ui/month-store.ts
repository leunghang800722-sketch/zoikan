// P3-3.2：全站共用嘅「揀咗邊個月」——來源次序：URL `?month=` → sessionStorage["zk.month"] →
// 頁面預設（通常本月，香港時區）。純函數（storage／location 注入）方便 unit test。
export const MONTH_STORAGE_KEY = "zk.month";
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export function isValidMonth(v: unknown): v is string {
  return typeof v === "string" && MONTH_RE.test(v);
}

export interface MonthStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function readStoredMonth(storage: MonthStorageLike | null | undefined): string | null {
  try {
    const v = storage?.getItem(MONTH_STORAGE_KEY) ?? null;
    return isValidMonth(v) ? v : null;
  } catch {
    return null;
  }
}

export function writeStoredMonth(storage: MonthStorageLike | null | undefined, month: string): void {
  if (!isValidMonth(month)) return;
  try {
    storage?.setItem(MONTH_STORAGE_KEY, month);
  } catch {
    // sessionStorage 唔可用（私隱模式等）：靜靜忽略，URL 照用
  }
}

/** 來源次序：URL → sessionStorage → fallback。 */
export function resolveMonth(args: { urlMonth: string | null; storedMonth: string | null; fallback: string }): { month: string; source: "url" | "storage" | "default" } {
  if (isValidMonth(args.urlMonth)) return { month: args.urlMonth, source: "url" };
  if (isValidMonth(args.storedMonth)) return { month: args.storedMonth, source: "storage" };
  return { month: args.fallback, source: "default" };
}

/** 將 `month` 寫入 href 嘅 query（保留其他 query／hash），冇改動就回原 href。 */
export function hrefWithMonth(href: string, month: string): string {
  const u = new URL(href, "http://x.invalid");
  if (u.searchParams.get("month") === month) return href;
  u.searchParams.set("month", month);
  return u.pathname + u.search + u.hash;
}

function safeSession(): MonthStorageLike | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

/** 記住月份：sessionStorage ＋（`syncUrl`）`history.replaceState` 更新 URL（唔加 history、唔觸發 RSC 重載）。 */
export function rememberMonth(month: string, opts: { syncUrl?: boolean } = {}): void {
  if (typeof window === "undefined" || !isValidMonth(month)) return;
  writeStoredMonth(safeSession(), month);
  if (opts.syncUrl) {
    const next = hrefWithMonth(window.location.pathname + window.location.search + window.location.hash, month);
    if (next !== window.location.pathname + window.location.search + window.location.hash) window.history.replaceState(null, "", next);
  }
}

/** 客戶端讀 URL＋sessionStorage 解出該用嘅月份（SSR 回 fallback）。 */
export function readInitialMonth(fallback: string): { month: string; source: "url" | "storage" | "default" } {
  if (typeof window === "undefined") return { month: fallback, source: "default" };
  return resolveMonth({
    urlMonth: new URLSearchParams(window.location.search).get("month"),
    storedMonth: readStoredMonth(safeSession()),
    fallback,
  });
}
