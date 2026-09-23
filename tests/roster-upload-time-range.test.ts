// WP-ROSTER-UPLOAD Phase B-0（§15.3 第 2 項）：`normalizeTimeRange()`／
// `shiftTypeTimeSlot()` 獨立單元測試——零 DB 依賴，8 種常見更表 Time 欄
// 寫法都要正規化做同一個 "HHMM-HHMM"。
import { describe, it, expect } from "vitest";
import { normalizeTimeRange, shiftTypeTimeSlot } from "@/lib/roster-upload/time-range";

describe("normalizeTimeRange：8 種寫法", () => {
  it("1. 0700-1900（冇冒號、冇空白）", () => {
    expect(normalizeTimeRange("0700-1900")).toBe("0700-1900");
  });
  it("2. 07:00-19:00（有冒號）", () => {
    expect(normalizeTimeRange("07:00-19:00")).toBe("0700-1900");
  });
  it("3. 0700 - 1900（連字符前後有空白）", () => {
    expect(normalizeTimeRange("0700 - 1900")).toBe("0700-1900");
  });
  it("4. 07:00 - 19:00（有冒號又有空白）", () => {
    expect(normalizeTimeRange("07:00 - 19:00")).toBe("0700-1900");
  });
  it("5. 1930-0730（跨午夜，純字面比對唔計時長）", () => {
    expect(normalizeTimeRange("1930-0730")).toBe("1930-0730");
  });
  it("6. 7:00-19:00（單位數鐘頭冇補零）", () => {
    expect(normalizeTimeRange("7:00-19:00")).toBe("0700-1900");
  });
  it("7. 0700~1900（波浪號）", () => {
    expect(normalizeTimeRange("0700~1900")).toBe("0700-1900");
  });
  it("8. 0700 to 1900（英文 to）", () => {
    expect(normalizeTimeRange("0700 to 1900")).toBe("0700-1900");
  });

  it("解唔到嘅格式／唔存在嘅鐘數 → null（唔准估）", () => {
    expect(normalizeTimeRange("成日")).toBeNull();
    expect(normalizeTimeRange("2500-1900")).toBeNull();
    expect(normalizeTimeRange("0700-1961")).toBeNull();
    expect(normalizeTimeRange(null)).toBeNull();
    expect(normalizeTimeRange("")).toBeNull();
  });
});

describe("shiftTypeTimeSlot：DB Time 欄 → HHMM-HHMM", () => {
  it("正常一對 start/end", () => {
    const start = new Date(Date.UTC(1970, 0, 1, 7, 0, 0));
    const end = new Date(Date.UTC(1970, 0, 1, 19, 0, 0));
    expect(shiftTypeTimeSlot(start, end)).toBe("0700-1900");
  });
  it("任何一邊冇值 → null", () => {
    expect(shiftTypeTimeSlot(null, new Date())).toBeNull();
    expect(shiftTypeTimeSlot(new Date(), null)).toBeNull();
  });
  it("同 normalizeTimeRange() 輸出一致，可以逐字比對", () => {
    const start = new Date(Date.UTC(1970, 0, 1, 19, 30, 0));
    const end = new Date(Date.UTC(1970, 0, 1, 7, 30, 0));
    expect(shiftTypeTimeSlot(start, end)).toBe(normalizeTimeRange("1930-0730"));
  });
});
