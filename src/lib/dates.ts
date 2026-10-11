// P3-0.5（B-7）：server 用「香港時間月份」。預設月份（雞頭首頁、month-health、
// ops-digest、鎖月區間上界）用 UTC 月會令香港每月 1 號 00:00–07:59 當成上個月。
// 返回值同 `monthStart()` 一樣係「UTC 當月 1 號 00:00」嘅 Date（DB 月份欄口徑），
// 只係「邊個月」按香港日曆決定。唔改任何報表計算口徑。
const HK_TIME_ZONE = "Asia/Hong_Kong";

export function hkMonthStart(now: Date = new Date()): Date {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: HK_TIME_ZONE, year: "numeric", month: "2-digit" }).formatToParts(now);
  const year = Number(parts.find((p) => p.type === "year")?.value);
  const month = Number(parts.find((p) => p.type === "month")?.value);
  return new Date(Date.UTC(year, month - 1, 1));
}

// P7.1：香港時間分量（排程「每日 HH:mm」一律按香港時間）。香港 1979 年起冇夏令時，
// 固定 UTC+8，所以直接位移 8 小時再讀 UTC 欄位（唔使每次 Intl 格式化）。
export const HK_OFFSET_MS = 8 * 60 * 60 * 1000;

export interface HkParts {
  year: number;
  /** 1–12 */
  month: number;
  day: number;
  hour: number;
  minute: number;
  /** 0＝星期日 … 6＝星期六 */
  dow: number;
}

export function hkParts(date: Date = new Date()): HkParts {
  const d = new Date(date.getTime() + HK_OFFSET_MS);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: d.getUTCHours(), minute: d.getUTCMinutes(), dow: d.getUTCDay() };
}

/** 香港日曆嘅「YYYY-MM-DD」。 */
export function hkDateStr(date: Date = new Date()): string {
  const p = hkParts(date);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** 香港日曆「下個月」第一日（UTC 0 時 Date，DB 月份欄口徑）。 */
export function hkNextMonthStart(now: Date = new Date()): Date {
  const cur = hkMonthStart(now);
  return new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth() + 1, 1));
}
