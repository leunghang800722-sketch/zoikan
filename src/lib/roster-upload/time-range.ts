// WP-ROSTER-UPLOAD Phase B-0（§15.3 第 2 項）：時段字串正規化——獨立、
// 純函數、零 DB 依賴，俾 `match.ts` 嘅 `matchShiftType()` 用嚟收窄「同盤
// 同代號有幾個 `shift_types`（唔同開工時間）」呢類 ambiguous 案例（8 月
// 748 格）。
//
// 更表檔案 Time 欄寫法唔統一（"0700-1900"／"07:00-19:00"／"0700 - 1900"
// ／"1930-0730" 跨午夜／"7:00-19:00" 單位數鐘頭／"0700~1900"／
// "0700 to 1900"），呢個函數統一正規化做 "HHMM-HHMM"（24 小時制、四位
// 數字），啱先可以同 `shift_types.start_time`/`end_time`（DB Time 欄，
// 由 `shiftTypeTimeSlot()` 算做同一套格式）逐字比對。
//
// 跨午夜（例如 1930-0730）唔使特別處理——純粹字面 "HHMM-HHMM" 比對，
// 唔計時長，兩邊寫法一致就會啱（`shift_types` 嘅 start_time／end_time
// 一樣係跨午夜嘅「開工鐘」「收工鐘」字面值，唔係經過日跨界運算嘅
// duration）。解唔到（格式亂七八糟／唔存在嘅鐘數）就 return null，call
// site 當「呢格冇時段資訊可以收窄」，唔會估。
const TIME_RANGE_RE = /^(\d{1,2}):?(\d{2})-(\d{1,2}):?(\d{2})$/;

export function normalizeTimeRange(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw
    .trim()
    .replace(/[–—~～]/g, "-") // 長短破折號／全形半形波浪號 → "-"
    .replace(/\s*(?:to|至)\s*/gi, "-") // "0700 to 1900" / "0700至1900"
    .replace(/\s+/g, ""); // 去晒中間空白（例如 "0700 - 1900"）
  const m = TIME_RANGE_RE.exec(cleaned);
  if (!m) return null;
  const [, h1, min1, h2, min2] = m;
  const hh1 = Number(h1);
  const hh2 = Number(h2);
  const mm1 = Number(min1);
  const mm2 = Number(min2);
  if (hh1 > 23 || hh2 > 23 || mm1 > 59 || mm2 > 59) return null;
  return `${String(hh1).padStart(2, "0")}${min1}-${String(hh2).padStart(2, "0")}${min2}`;
}

/** `shift_types.start_time`/`end_time`（`@db.Time`，Prisma 讀返嚟嘅
 * Date 冇時區意義，直接用 UTC getter 攞返 wall-clock 鐘數——同
 * `src/lib/roster-export.ts` `fmtTime()` 一致做法，呢度獨立寫一份，
 * 保持呢個 module 零 DB 依賴、唔同 roster-export.ts 耦合）→
 * "HHMM-HHMM"，方便同 `normalizeTimeRange()` 嘅輸出逐字比對。任何一邊
 * 冇值就 return null（呢個更別冇齊開工／收工時間，冧唔到）。 */
export function shiftTypeTimeSlot(startTime: Date | null | undefined, endTime: Date | null | undefined): string | null {
  if (!startTime || !endTime) return null;
  const fmt = (d: Date) => `${String(d.getUTCHours()).padStart(2, "0")}${String(d.getUTCMinutes()).padStart(2, "0")}`;
  return `${fmt(startTime)}-${fmt(endTime)}`;
}
