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

/** 顯示層改名（老闆 2026-09-12）：「安員」一律顯示做「保安員」。權限模組 key
 * （安員／自己安員）同角色名（安員）係內部識別，唔改，只喺顯示時經呢個對照。 */
export function uiLabel(s: string): string {
  return s.replace(/(?<!保)安員/g, "保安員");
}

const ZH_WEEKDAY = ["日", "一", "二", "三", "四", "五", "六"];

/** WP-R3：日期切換 chip 用「2026-07-15（三）」（README §02）。`dateStr`
 * 一律當 UTC 日期解讀（同 `buildShortfall()` 嘅 dayStart 口徑一致）。 */
export function fmtDateWeekday(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return dateStr;
  return `${dateStr}（${ZH_WEEKDAY[d.getUTCDay()]}）`;
}

/** WP-R3：手機首頁問候用「7 月 15 日（三）」（README §21）。 */
export function fmtMonthDayWeekday(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return dateStr;
  return `${d.getUTCMonth() + 1} 月 ${d.getUTCDate()} 日（${ZH_WEEKDAY[d.getUTCDay()]}）`;
}

/** WP-R3：`dateStr` ± `delta` 日，一律 UTC 運算（避免 DST／時區令跨月/
 * 跨年出錯）。 */
export function addDaysStr(dateStr: string, delta: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

/** WP-R3：今日日期（本地時區）YYYY-MM-DD——首頁日期 chip 預設值。 */
export function todayLocalStr(): string {
  const d = new Date();
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

/** WP-R3：手機首頁問候語——按時段早晨／午安／晚安（README §21）。 */
export function greetingWord(d = new Date()): string {
  const h = d.getHours();
  if (h < 12) return "早晨";
  if (h < 18) return "午安";
  return "晚安";
}

/** WP-R3：「2026-07」→「2026 年 7 月」（雞頭首頁 kicker，README §25）。 */
export function fmtYearMonthZh(month: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) return month;
  return `${m[1]} 年 ${Number(m[2])} 月`;
}
