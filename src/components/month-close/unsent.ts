// WP-MC-UI：送出失敗（尤其 unmount／路由離開避唔到）嘅題目記低喺 sessionStorage，
// 月結頁載入時提示「有 N 題未送出，請重新答」。淨係存題目 id／標題／選項（冇 PII）。
const KEY = "mc-unsent";
export interface UnsentItem {
  id: string;
  title: string;
  option: string;
}

function read(): UnsentItem[] {
  try {
    const raw = window.sessionStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as UnsentItem[]) : [];
  } catch {
    return [];
  }
}
function write(list: UnsentItem[]) {
  try {
    if (list.length === 0) window.sessionStorage.removeItem(KEY);
    else window.sessionStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* sessionStorage 唔可用就算 */
  }
}
export function recordUnsent(it: UnsentItem) {
  write([...read().filter((x) => x.id !== it.id), it]);
}
export function clearUnsent(id: string) {
  write(read().filter((x) => x.id !== id));
}
export function takeUnsent(): UnsentItem[] {
  const l = read();
  write([]);
  return l;
}
