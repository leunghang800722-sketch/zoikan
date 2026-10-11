// P13.6：全站「返回」。standalone PWA 冇瀏覽器返回掣，手機頂欄自己提供。
// 自己記 sessionStorage 嘅頁面 stack（NavHistoryTracker 寫）：有上一頁就 router.back()，
// 冇（例如由主畫面直接開深層 link）就去父路徑，再冇就去 `/`。
const KEY = "zk-nav-stack";
const MAX = 50;

export function readStack(): string[] {
  try {
    const raw = window.sessionStorage.getItem(KEY);
    const a = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(a) ? a.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}
function writeStack(a: string[]) {
  try {
    window.sessionStorage.setItem(KEY, JSON.stringify(a.slice(-MAX)));
  } catch {
    /* sessionStorage 唔可用就算 */
  }
}

/** 頁面變咗（pathname＋search）：返去上上一頁＝pop；否則 push（同一頁唔重複）。 */
export function trackPath(rawPath: string): void {
  const path = rawPath.split("?")[0]!; // 防禦：query 可能帶姓名／員工編號，絕不寫入 storage
  const s = readStack();
  if (s.length >= 2 && s[s.length - 2] === path) s.pop();
  else if (s[s.length - 1] !== path) s.push(path);
  writeStack(s);
}

// 有自己 index 頁嘅一級路徑：深層頁返去呢個 index。其餘一律返 `/`。
const INDEXED = new Set(["roster", "roster-uploads", "feedback", "guards", "month-close", "brokers", "sites", "users", "quotas", "rate-cards", "triage", "notifications"]);

export function parentPath(pathname: string): string {
  const segs = pathname.split("?")[0]!.split("/").filter(Boolean);
  if (segs.length <= 1) return "/";
  return INDEXED.has(segs[0]!) ? `/${segs[0]}` : "/";
}

export function hasPrevious(): boolean {
  return typeof window !== "undefined" && window.history.length > 1 && readStack().length >= 2;
}

/** `fallback`：冇上一頁時去邊（預設父路徑）。 */
export function goBack(router: { back: () => void; push: (href: string) => void }, pathname: string, fallback?: string): void {
  if (hasPrevious()) router.back();
  else router.push(fallback ?? parentPath(pathname));
}
