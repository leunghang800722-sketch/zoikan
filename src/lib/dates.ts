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
