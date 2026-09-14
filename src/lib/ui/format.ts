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

// R3 驗收 A1 修正：`todayLocalStr()`／`greetingWord()` 原本用
// `Date.getTimezoneOffset()`／`Date.getHours()`——呢兩個都係跑呢段
// code 嗰部機嘅本地時區（SSR 喺正式站容器係 UTC，瀏覽器係用戶本地
// 時區），令 server render 同 client hydrate 出嚟嘅字串唔一致
// （hydration failed），亦令 HK 00:00–08:00「今日」計錯一日、18:00
// 後問候語計錯（因為個「本地」根本唔係香港時間）。修法：全部固定用
// `Asia/Hong_Kong`（同 `src/lib/ai/system-prompt.ts:29`
// `hongKongToday()` 同一個做法），唔理跑喺邊個時區嘅機——server 同
// client 對住同一個 `Date`（或者相差幾百毫秒嘅 `Date.now()`）一定算
// 出同一個字串，唔會再 hydration mismatch。`now` 做參數方便 unit test
// 注入固定時間（覆蓋 UTC 16:30＝HK 翌日 00:30 呢類跨日邊界）。
const HK_TIME_ZONE = "Asia/Hong_Kong";

function hkParts(now: Date): { year: string; month: string; day: string; hour: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: HK_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23", // 唔用 hour12——避免部分環境將午夜輸出做 "24" 而唔係 "00"
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return { year: get("year"), month: get("month"), day: get("day"), hour: Number(get("hour")) };
}

/** WP-R3：今日日期（香港時區，唔跟 SSR/瀏覽器各自嘅本地時區）
 * YYYY-MM-DD——首頁日期 chip 預設值。 */
export function todayLocalStr(now: Date = new Date()): string {
  const { year, month, day } = hkParts(now);
  return `${year}-${month}-${day}`;
}

/** WP-R3：手機首頁問候語——按香港時間時段早晨／午安／晚安（README
 * §21）。 */
export function greetingWord(now: Date = new Date()): string {
  const { hour } = hkParts(now);
  if (hour < 12) return "早晨";
  if (hour < 18) return "午安";
  return "晚安";
}

/** R3 驗收 A1：雞頭首頁 `currentMonth()` 原本用 `Date.getFullYear()`／
 * `getMonth()`（本地時區），同 `todayLocalStr()` 一樣有 hydration
 * mismatch 問題——搬呢度統一用香港時區，`BrokerDashboard.tsx` 改叫呢個
 * 函數。 */
export function currentMonthStr(now: Date = new Date()): string {
  const { year, month } = hkParts(now);
  return `${year}-${month}`;
}

/** WP-R3：「2026-07」→「2026 年 7 月」（雞頭首頁 kicker，README §25）。 */
export function fmtYearMonthZh(month: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) return month;
  return `${m[1]} 年 ${Number(m[2])} 月`;
}

/** B8：雞頭首頁月份切換 chip 用——「2026-07」± `delta` 個月，一律當
 * UTC 月份運算（避免 DST／時區令跨年出錯，同 `addDaysStr()` 同一個
 * 理由）。 */
export function addMonthsStr(month: string, delta: number): string {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) return month;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
