// 顯示用嘅小 helper——欄位因為 field-group gate 可能喺 response 度完全
// 唔存在（例如主管冇「收客價:view」就見唔到 client_rate），呢種情況同
// 「值本身係 null/undefined」用同一個「—」表示，UI 唔使分辨呢兩種狀況。
export function fmt(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  return String(v);
}

export function fmtMoney(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  const n = typeof v === "number" ? v : Number(v);
  if (Number.isNaN(n)) return String(v);
  return n.toLocaleString("zh-HK", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

export function fmtDate(v: unknown): string {
  if (!v) return "—";
  const s = String(v);
  return s.length >= 10 ? s.slice(0, 10) : s;
}

export function fmtDateTime(v: unknown): string {
  if (!v) return "—";
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) return String(v);
  return d.toLocaleString("zh-HK", { hour12: false });
}

/** 許可證喺 60 日內或已過期——安員名冊高亮用。 */
export function isExpiringSoon(dateStr: unknown, withinDays = 60): boolean {
  if (!dateStr) return false;
  const d = new Date(String(dateStr));
  if (Number.isNaN(d.getTime())) return false;
  const diffDays = (d.getTime() - Date.now()) / 86_400_000;
  return diffDays <= withinDays;
}

export function isExpired(dateStr: unknown): boolean {
  if (!dateStr) return false;
  const d = new Date(String(dateStr));
  if (Number.isNaN(d.getTime())) return false;
  return d.getTime() < Date.now();
}
